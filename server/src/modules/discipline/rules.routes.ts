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
