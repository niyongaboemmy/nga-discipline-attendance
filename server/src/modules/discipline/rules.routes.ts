import { Router, Response } from 'express';
import { z } from 'zod';
import { getDb } from '../../database.js';
import { authMiddleware, AuthenticatedRequest } from '../../middleware/auth.js';
import { authorizePermission, selfOrPermission } from '../../middleware/authorize.js';
import { validateBody } from '../../shared/validation.js';
import { recordAudit } from '../../shared/audit.js';
import { resolveAcademicPeriod } from '../../utils/academicPeriod.js';
import { notifyUserExternal } from '../../utils/notifier.js';
import { SANCTIONS } from '../../utils/conduct.js';
import * as rulesRepo from './rules.repository.js';
import { generateStructuredContent, isAnyProviderConfigured } from '../../services/aiProviders/index.js';
import type { JSONSchema } from '../../services/aiProviders/index.js';
import { getStudentTermBalance, listTermBalances } from './ledger.service.js';

/**
 * Discipline rules catalog (B.1), permission-gated point adjustment (B.2),
 * and term-balance reads (B.0/B.3). Mounted at /api/discipline alongside
 * routes/discipline.ts (Express allows multiple routers on one prefix).
 */
const router = Router();
router.use(authMiddleware);

const ruleSchema = z.object({
  type: z.enum(['demerit', 'merit']),
  category: z.string().min(1).max(60),
  title: z.string().min(1).max(150),
  description: z.string().max(2000).optional().nullable(),
  defaultPoints: z.number().int().positive().max(100),
  fineAmount: z.number().min(0).max(1_000_000).optional(),
  severity: z.string().max(30).optional().nullable(),
});

const ruleUpdateSchema = ruleSchema.partial().extend({ isActive: z.boolean().optional() });

// --- Rules catalog CRUD (admin/manager only) ---

router.get('/rules', authorizePermission('DISCIPLINE_RULES_MANAGE', 'DISCIPLINE_LOG'), async (req: any, res: Response) => {
  const db = getDb();
  const { type, active } = req.query;
  try {
    const rules = await rulesRepo.listRules(db, {
      type: typeof type === 'string' ? type : undefined,
      isActive: active === 'true' ? true : active === 'false' ? false : undefined,
    });
    return res.json({ success: true, data: rules });
  } catch (error) {
    console.error('Error listing discipline rules:', error);
    return res.status(500).json({ success: false, message: 'Error fetching discipline rules.' });
  }
});

router.post('/rules', authorizePermission('DISCIPLINE_RULES_MANAGE'), validateBody(ruleSchema), async (req: any, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  const db = getDb();
  try {
    const rule = await rulesRepo.createRule(db, { ...req.body, createdBy: authReq.user!.id });
    await recordAudit(db, authReq.user!, 'discipline_rule.create', 'discipline_rule', rule.id, req.body);
    return res.status(201).json({ success: true, data: rule, message: 'Rule created.' });
  } catch (error: any) {
    console.error('Error creating discipline rule:', error);
    return res.status(500).json({ success: false, message: error.message || 'Error creating the rule.' });
  }
});

/**
 * Bulk rule import (spreadsheet upload).
 *
 * The client parses the workbook and posts plain JSON rows, so there's no
 * multipart/file handling here — it also means the user sees validation
 * errors against their own spreadsheet before anything is written.
 *
 * Rows are validated individually and reported per-row rather than failing
 * the whole upload on one bad cell: a 200-row sheet with two typos should
 * import 198 rows and tell you about the two, not reject everything.
 * Duplicates (same type + title as an existing rule, case-insensitively)
 * are skipped rather than erroring, so re-uploading a corrected sheet is
 * safe and idempotent.
 */
// Rows are deliberately `unknown` here: validating them against ruleSchema
// at the envelope level would fail the entire upload on one bad cell, which
// is exactly the behaviour this endpoint exists to avoid. Each row is
// validated individually below so the response can report per-row outcomes.
const ruleImportSchema = z.object({
  rules: z.array(z.unknown()).min(1).max(500),
});

/**
 * Draft rules from a natural-language prompt.
 *
 * Deliberately generates and returns only — nothing is written. The client
 * shows the drafts for review and commits the approved ones through
 * /rules/import, which is where validation and duplicate-skipping already
 * live. That keeps the AI strictly advisory: a model can't create a rule
 * without a human approving it.
 */
const AI_RULES_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    rules: {
      type: 'array',
      description: 'The generated discipline rules.',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', description: 'Either "demerit" (misconduct) or "merit" (positive behaviour).' },
          category: { type: 'string', description: 'Short grouping, e.g. Tardiness, Uniform, Service.' },
          title: { type: 'string', description: 'The rule itself, stated concisely.' },
          description: { type: 'string', description: 'One sentence clarifying when it applies.' },
          defaultPoints: { type: 'number', description: 'Whole number 1-100. Higher means more serious.' },
          fineAmount: { type: 'number', description: 'Monetary fine, or 0 when none applies.' },
          severity: { type: 'string', description: 'For demerits: minor|moderate|major. For merits: small|notable|outstanding.' },
        },
        required: ['type', 'category', 'title', 'description', 'defaultPoints', 'fineAmount', 'severity'],
      },
    },
  },
  required: ['rules'],
};

const aiDraftSchema = z.object({
  prompt: z.string().min(3).max(2000),
  count: z.number().int().min(1).max(25).optional(),
});

router.post(
  '/rules/ai-draft',
  authorizePermission('DISCIPLINE_RULES_MANAGE'),
  validateBody(aiDraftSchema),
  async (req: any, res: Response) => {
    const { prompt, count } = req.body as { prompt: string; count?: number };
    const db = getDb();

    if (!isAnyProviderConfigured()) {
      return res.status(503).json({
        success: false,
        message: 'AI drafting is not configured on this server.',
      });
    }

    try {
      // Existing titles let the model avoid proposing what's already there,
      // rather than the user discovering it only at the import step.
      const existing = await rulesRepo.listRules(db);
      const existingTitles = existing.slice(0, 120).map((r) => `${r.type}: ${r.title}`);

      const fullPrompt = [
        'You are helping a school administrator build a student discipline rules catalog.',
        `Generate ${count ?? 'an appropriate number of'} rule(s) for this request:`,
        `"""${prompt}"""`,
        '',
        'Requirements:',
        '- "type" must be exactly "demerit" or "merit".',
        '- "defaultPoints" is a whole number from 1 to 100, proportional to seriousness.',
        '- "fineAmount" is a number; use 0 when no fine applies.',
        '- "severity" must be one of minor|moderate|major for demerits, or small|notable|outstanding for merits.',
        '- "category" groups related rules; reuse the same category across similar rules.',
        '- Keep "title" short and specific; put the clarification in "description".',
        '- Write in the same language as the request.',
        existingTitles.length
          ? `\nThese rules already exist — do NOT duplicate them:\n${existingTitles.join('\n')}`
          : '',
      ].join('\n');

      const { data, providerUsed } = await generateStructuredContent<{ rules: any[] }>(
        {
          prompt: fullPrompt,
          schema: AI_RULES_SCHEMA,
          schemaName: 'discipline_rules',
          maxOutputTokens: 4000,
        },
      );

      // The model is untrusted input: normalise here, but let the same
      // ruleSchema used everywhere else decide what's actually valid, and
      // flag rather than silently drop anything it rejects.
      const drafts = (Array.isArray(data?.rules) ? data.rules : []).map((r: any, i: number) => {
        const candidate = {
          type: String(r?.type ?? '').toLowerCase().trim(),
          category: String(r?.category ?? '').trim(),
          title: String(r?.title ?? '').trim(),
          description: r?.description ? String(r.description).trim() : undefined,
          defaultPoints: Math.round(Number(r?.defaultPoints)),
          fineAmount: Number.isFinite(Number(r?.fineAmount)) ? Number(r.fineAmount) : 0,
          severity: r?.severity ? String(r.severity).trim() : undefined,
        };
        const parsed = ruleSchema.safeParse(candidate);
        return {
          index: i,
          rule: candidate,
          error: parsed.success
            ? null
            : parsed.error.issues.map((x) => `${x.path.join('.') || 'rule'}: ${x.message}`).join('; '),
          duplicate: existing.some(
            (e) => e.type === candidate.type && e.title.trim().toLowerCase() === candidate.title.toLowerCase()
          ),
        };
      });

      return res.json({
        success: true,
        data: { drafts, providerUsed },
        message: `Drafted ${drafts.length} rule${drafts.length === 1 ? '' : 's'}.`,
      });
    } catch (error: any) {
      const status = error?.status === 503 ? 503 : 500;
      console.error('Error drafting rules with AI:', error?.message);
      return res.status(status).json({
        success: false,
        message: error?.message || 'Could not draft rules right now.',
      });
    }
  }
);

router.post(
  '/rules/import',
  authorizePermission('DISCIPLINE_RULES_MANAGE'),
  async (req: any, res: Response) => {
    const authReq = req as AuthenticatedRequest;
    const db = getDb();

    const envelope = ruleImportSchema.safeParse(req.body);
    if (!envelope.success) {
      return res.status(400).json({
        success: false,
        message: 'Provide between 1 and 500 rows to import.',
      });
    }

    const rows = envelope.data.rules;
    const created: Array<{ row: number; title: string }> = [];
    const skipped: Array<{ row: number; title: string; reason: string }> = [];
    const errors: Array<{ row: number; message: string }> = [];

    try {
      const existing = await rulesRepo.listRules(db);
      // Track within-file duplicates too, not just clashes with the DB.
      const seen = new Set(
        existing.map((r) => `${r.type}::${r.title.trim().toLowerCase()}`)
      );

      await db.run('BEGIN');
      for (let i = 0; i < rows.length; i++) {
        // +2 so the number matches the spreadsheet row the user sees
        // (1-based, and row 1 is the header).
        const rowNumber = i + 2;
        const parsed = ruleSchema.safeParse(rows[i]);
        if (!parsed.success) {
          errors.push({
            row: rowNumber,
            message: parsed.error.issues
              .map((issue) => `${issue.path.join('.') || 'row'}: ${issue.message}`)
              .join('; '),
          });
          continue;
        }

        const rule = parsed.data;
        const key = `${rule.type}::${rule.title.trim().toLowerCase()}`;
        if (seen.has(key)) {
          skipped.push({ row: rowNumber, title: rule.title, reason: 'A rule with this type and title already exists.' });
          continue;
        }

        await rulesRepo.createRule(db, { ...rule, createdBy: authReq.user!.id });
        seen.add(key);
        created.push({ row: rowNumber, title: rule.title });
      }
      await db.run('COMMIT');

      if (created.length > 0) {
        await recordAudit(db, authReq.user!, 'discipline_rule.import', 'discipline_rule', null, {
          created: created.length,
          skipped: skipped.length,
          errors: errors.length,
        });
      }

      return res.json({
        success: true,
        data: { created, skipped, errors },
        message: `Imported ${created.length} rule${created.length === 1 ? '' : 's'}.`,
      });
    } catch (error: any) {
      await db.run('ROLLBACK').catch(() => undefined);
      console.error('Error importing discipline rules:', error);
      return res.status(500).json({ success: false, message: error.message || 'Error importing rules.' });
    }
  }
);

router.put('/rules/:id', authorizePermission('DISCIPLINE_RULES_MANAGE'), validateBody(ruleUpdateSchema), async (req: any, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  const db = getDb();
  const id = Number(req.params.id);
  try {
    const existing = await rulesRepo.getRule(db, id);
    if (!existing) return res.status(404).json({ success: false, message: 'Rule not found.' });

    const updated = await rulesRepo.updateRule(db, id, req.body);
    await recordAudit(db, authReq.user!, 'discipline_rule.update', 'discipline_rule', id, req.body, {
      previousValue: existing,
      newValue: updated,
    });
    return res.json({ success: true, data: updated, message: 'Rule updated.' });
  } catch (error: any) {
    console.error('Error updating discipline rule:', error);
    return res.status(500).json({ success: false, message: error.message || 'Error updating the rule.' });
  }
});

router.delete('/rules/:id', authorizePermission('DISCIPLINE_RULES_MANAGE'), async (req: any, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  const db = getDb();
  const id = Number(req.params.id);
  try {
    const existing = await rulesRepo.getRule(db, id);
    if (!existing) return res.status(404).json({ success: false, message: 'Rule not found.' });
    // Soft-delete: retiring a rule must never orphan discipline_records.rule_id
    // for past incidents, so this deactivates rather than deletes.
    const updated = await rulesRepo.updateRule(db, id, { isActive: false });
    await recordAudit(db, authReq.user!, 'discipline_rule.retire', 'discipline_rule', id, null);
    return res.json({ success: true, data: updated, message: 'Rule retired.' });
  } catch (error: any) {
    console.error('Error retiring discipline rule:', error);
    return res.status(500).json({ success: false, message: error.message || 'Error retiring the rule.' });
  }
});

router.get('/rules/:id/versions', authorizePermission('DISCIPLINE_RULES_MANAGE'), async (req: any, res: Response) => {
  const db = getDb();
  try {
    const versions = await rulesRepo.listRuleVersions(db, Number(req.params.id));
    return res.json({ success: true, data: versions });
  } catch (error) {
    console.error('Error listing rule versions:', error);
    return res.status(500).json({ success: false, message: 'Error fetching rule history.' });
  }
});

// --- Permission-gated point adjustment against a specific rule (B.2) ---

const adjustSchema = z.object({
  studentId: z.string().min(1),
  studentName: z.string().min(1),
  className: z.string().max(100).optional().nullable(),
  ruleId: z.number().int().positive(),
  incidentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD.'),
  description: z.string().max(3000).optional(),
  location: z.string().max(100).optional().nullable(),
  sanction: z.string().max(30).optional(),
  pointsOverride: z.number().int().positive().max(100).optional(),
});

router.post('/adjust', authorizePermission('DISCIPLINE_ADJUST'), validateBody(adjustSchema), async (req: any, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  const db = getDb();
  const actor = authReq.user!;
  const body = req.body as z.infer<typeof adjustSchema>;

  const rule = await rulesRepo.getRule(db, body.ruleId);
  if (!rule || !rule.is_active) {
    return res.status(400).json({ success: false, message: 'That discipline rule does not exist or is retired.' });
  }

  const points = body.pointsOverride ?? rule.default_points;
  const effectiveSanction = rule.type === 'demerit' ? (body.sanction || 'none') : 'none';
  // Same fixed vocabulary routes/discipline.ts enforces on POST / and /bulk —
  // without this, an arbitrary string could land in discipline_records.sanction
  // and silently fall through the client's SANCTION_LABEL lookup.
  if (!SANCTIONS.includes(effectiveSanction as any)) {
    return res.status(400).json({ success: false, message: `Invalid sanction '${effectiveSanction}'.` });
  }
  const { academicYearId, academicTermId } = resolveAcademicPeriod(authReq);

  try {
    await db.run('BEGIN TRANSACTION');
    const result = await db.run(
      `INSERT INTO discipline_records
         (student_id, student_name, class_name, type, category, severity, points, title, description,
          incident_date, location, sanction, logged_by, logged_by_name, academic_year_id, academic_term_id, rule_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      body.studentId, body.studentName, body.className ?? null, rule.type, rule.category, rule.severity,
      points, rule.title, body.description ?? '', body.incidentDate, body.location ?? null, effectiveSanction,
      actor.id, actor.name, academicYearId ?? null, academicTermId ?? null, rule.id
    );
    await recordAudit(
      db, actor, 'discipline.adjust', 'discipline_record', result.lastID ?? null,
      { studentId: body.studentId, ruleId: rule.id, ruleTitle: rule.title, points, type: rule.type },
      { required: true }
    );
    await db.run('COMMIT');

    const inserted = await db.get('SELECT * FROM discipline_records WHERE id = ?', result.lastID);

    await db.run(
      `INSERT INTO notifications (user_id, type, title, message) VALUES (?, 'system', ?, ?)`,
      body.studentId,
      rule.type === 'merit' ? `Merit awarded: ${rule.title}` : `Conduct notice: ${rule.title}`,
      `${rule.type === 'merit' ? 'You received a merit' : 'A demerit was recorded'} (${rule.category}, ${points} pts) on ${body.incidentDate}.`
    );
    await notifyUserExternal(
      db, body.studentId,
      rule.type === 'merit' ? `Merit awarded: ${rule.title}` : `Conduct notice: ${rule.title}`,
      `${rule.type === 'merit' ? 'You received a merit' : 'A demerit was recorded'} (${rule.category}, ${points} pts) on ${body.incidentDate}.`
    );

    // Same escalation routes/discipline.ts POST / sends — without it, major
    // incidents logged through the rules-catalog adjust flow would silently
    // never reach staff/admins the way legacy-logged ones do.
    if (rule.type === 'demerit' && rule.severity === 'major') {
      await db.run(
        `INSERT INTO notifications (user_id, type, title, message) VALUES ('all', 'system', ?, ?)`,
        `Major incident: ${body.studentName}`,
        `A major demerit (${rule.category}) was logged for ${body.studentName}: ${rule.title}.`
      );
    }

    return res.status(201).json({ success: true, data: inserted, message: 'Discipline adjustment recorded.' });
  } catch (error: any) {
    await db.run('ROLLBACK');
    console.error('Error recording discipline adjustment:', error);
    return res.status(500).json({ success: false, message: error.message || 'Error recording the adjustment.' });
  }
});

// --- Term balance reads (B.0/B.3) ---

router.get('/term-balance/me', authorizePermission('DISCIPLINE_VIEW_OWN'), async (req: any, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  const db = getDb();
  const { academicYearId, academicTermId } = resolveAcademicPeriod(authReq);
  try {
    const balance = await getStudentTermBalance(db, authReq.user!.id, academicYearId, academicTermId);
    return res.json({ success: true, data: balance });
  } catch (error) {
    console.error('Error fetching term balance:', error);
    return res.status(500).json({ success: false, message: 'Error fetching your term balance.' });
  }
});

router.get('/term-balance/:studentId', selfOrPermission('studentId', 'DISCIPLINE_VIEW_ALL'), async (req: any, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  const db = getDb();
  const { academicYearId, academicTermId } = resolveAcademicPeriod(authReq);
  try {
    const balance = await getStudentTermBalance(db, req.params.studentId, academicYearId, academicTermId);
    return res.json({ success: true, data: balance });
  } catch (error) {
    console.error('Error fetching student term balance:', error);
    return res.status(500).json({ success: false, message: 'Error fetching term balance.' });
  }
});

// --- B.4: roster-hierarchy statistics (all students with activity in the current term) ---

router.get('/stats', authorizePermission('DISCIPLINE_VIEW_ALL'), async (req: any, res: Response) => {
  const db = getDb();
  const { academicTermId } = resolveAcademicPeriod(req as AuthenticatedRequest);
  try {
    const balances = await listTermBalances(db, academicTermId);
    const atRisk = balances.filter((b) => b.balance < 70);
    return res.json({
      success: true,
      data: {
        studentCount: balances.length,
        averageBalance: balances.length
          ? Math.round(balances.reduce((sum, b) => sum + b.balance, 0) / balances.length)
          : 100,
        atRiskCount: atRisk.length,
        students: balances,
      },
    });
  } catch (error) {
    console.error('Error generating discipline stats:', error);
    return res.status(500).json({ success: false, message: 'Error generating discipline statistics.' });
  }
});

export default router;
