import { Router, Response } from 'express';
import { getDb } from '../database.js';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth.js';
import { authorizePermission, selfOrPermission } from '../middleware/authorize.js';
import {
  derivePoints,
  isValidCategory,
  computeConductScore,
  recordAudit,
  SANCTIONS,
  RECORD_STATUSES,
  DisciplineType,
  DEMERIT_POINTS,
  MERIT_POINTS,
  DEMERIT_CATEGORIES,
  MERIT_CATEGORIES,
} from '../utils/conduct.js';
import { notifyUserExternal } from '../utils/notifier.js';
import { resolveAcademicPeriod, resolveAcademicPeriodForDate } from '../utils/academicPeriod.js';
import { getRule } from '../modules/discipline/rules.repository.js';
import { getStudentTermBalance } from '../modules/discipline/ledger.service.js';
import {
  accessMode, classGroupOfStudent, requireAccess, shadowListLeak, studentScopeFilter, studentTarget,
} from '../access/policy.js';
import { sanctionDenied, sanctionForbidden } from '../access/sanctions.js';
import { notifyStaff } from '../access/notify.js';

const router = Router();

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Access control v2 target of a discipline record: its student + class group. */
async function recordTarget(req: any, recordId: unknown) {
  const rec = await getDb().get('SELECT student_id FROM discipline_records WHERE id = ? AND deleted_at IS NULL', recordId);
  if (!rec) return null;
  return studentTarget(rec.student_id, await classGroupOfStudent(req, String(rec.student_id)));
}

/** Staff escalation about a student: 'all' (legacy) or, under access v2
 *  enforce, the DISCIPLINE_REVIEW holders at the student's class group. */
function notifyDisciplineStaff(
  req: any,
  n: { kind: string; studentId: string; title: string; message: string; dedupeKey?: string }
) {
  return notifyStaff(getDb(), {
    kind: n.kind,
    type: 'system',
    title: n.title,
    message: n.message,
    dedupeKey: n.dedupeKey ?? null,
    cap: 'DISCIPLINE_REVIEW',
    target: async () => studentTarget(n.studentId, await classGroupOfStudent(req, n.studentId)),
  });
}

/**
 * Remediation D1 — nothing stopped the same incident being logged twice (each
 * time stacking points and firing a fresh notification). Flags an existing
 * non-deleted record for the same student, date, type and rule/title logged by
 * the same person. The caller can still force it through with `force: true`.
 */
async function findDuplicateIncident(
  db: any,
  opts: { studentId: string; incidentDate: string; type: string; ruleId: number | null; title: string; loggedBy: string }
): Promise<{ id: number } | undefined> {
  if (opts.ruleId != null) {
    return db.get(
      `SELECT id FROM discipline_records
        WHERE deleted_at IS NULL AND student_id = ? AND incident_date = ? AND type = ?
          AND rule_id = ? AND logged_by = ?`,
      opts.studentId, opts.incidentDate, opts.type, opts.ruleId, opts.loggedBy
    );
  }
  return db.get(
    `SELECT id FROM discipline_records
      WHERE deleted_at IS NULL AND student_id = ? AND incident_date = ? AND type = ?
        AND rule_id IS NULL AND lower(title) = lower(?) AND logged_by = ?`,
    opts.studentId, opts.incidentDate, opts.type, opts.title, opts.loggedBy
  );
}

/** Shared field-shape checks for single + bulk logging. Returns an error string or null. */
function validateIncidentFields(fields: { title: string; description: string; incidentDate: string; location: string | null; className: string | null }): string | null {
  if (!DATE_RE.test(String(fields.incidentDate))) return 'Invalid incidentDate. Expected YYYY-MM-DD.';
  if (String(fields.title).length > 150) return 'Title is too long (max 150 characters).';
  if (String(fields.description || '').length > 3000) return 'Description is too long (max 3000 characters).';
  if (fields.location && String(fields.location).length > 100) return 'Location is too long (max 100 characters).';
  if (fields.className && String(fields.className).length > 100) return 'Class name is too long (max 100 characters).';
  return null;
}

// Demerit-point threshold (over the lifetime of records) at which a student is
// flagged for follow-up. Mirrors the low-attendance escalation in attendance.ts.
const CONDUCT_FLAG_THRESHOLD = 15;

// Apply auth check on all discipline routes
router.use(authMiddleware);

/**
 * After demerits are logged, check whether a student's demerit points for the
 * *current term* have crossed the follow-up threshold and, if so, raise a
 * one-per-day escalation to staff/admins. Best-effort: never blocks the primary
 * write.
 *
 * Remediation D4: this used to `SUM(points)` across every term and include
 * dismissed records, so it fired on a figure that matched no conduct score
 * shown anywhere and never cleared. It now reads the same term-scoped,
 * dismissed-excluding ledger balance the student and staff actually see.
 */
async function triggerConductCheck(studentId: string, studentName: string, academicTermId?: number, req: any = null) {
  const db = getDb();
  try {
    const balance = await getStudentTermBalance(db, studentId, undefined, academicTermId);
    if (balance.demeritPoints < CONDUCT_FLAG_THRESHOLD) return;

    const today = new Date().toISOString().split('T')[0];
    const dedupeKey = `conduct_followup:${studentId}:${academicTermId ?? 'none'}:${today}`;
    const alreadyFlagged = await db.get(`SELECT 1 FROM notifications WHERE dedupe_key = ?`, dedupeKey);
    if (alreadyFlagged) return;

    await notifyDisciplineStaff(req, {
      kind: 'conduct_followup',
      studentId,
      title: `Conduct follow-up: ${studentName}`,
      message: `${studentName} has accumulated ${balance.demeritPoints} demerit points this term and may need a disciplinary follow-up.`,
      dedupeKey,
    });
  } catch (err) {
    console.error('Error in triggerConductCheck:', err);
  }
}

/**
 * Remediation D9 — the client hard-coded copies of these vocabularies with a
 * "mirrors the server" comment. Serve them so the log form can't drift.
 */
router.get('/config', (_req: any, res: Response) => {
  res.json({
    success: true,
    data: {
      demeritCategories: DEMERIT_CATEGORIES,
      meritCategories: MERIT_CATEGORIES,
      demeritTiers: DEMERIT_POINTS,
      meritTiers: MERIT_POINTS,
      sanctions: SANCTIONS,
      recordStatuses: RECORD_STATUSES,
    },
  });
});

// Log a discipline record — demerit or merit (Teacher/Admin only)
router.post('/', authorizePermission('DISCIPLINE_LOG'), async (req: any, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  const {
    studentId,
    studentName,
    className = null,
    type,
    category,
    severity,
    title,
    description = '',
    incidentDate,
    location = null,
    sanction = 'none',
    ruleId = null,
    force = false,
  } = req.body;

  // --- Validation (server is authoritative; client-supplied points are ignored) ---
  // severity is only required on the legacy (no-ruleId) path — a catalog
  // rule carries its own severity label (possibly none at all).
  if (!studentId || !studentName || !type || !title || !incidentDate || (ruleId == null && (!category || !severity))) {
    return res.status(400).json({
      success: false,
      message: 'Missing required fields: studentId, studentName, type, title, incidentDate, and (category + severity, or ruleId).',
    });
  }

  if (type !== 'demerit' && type !== 'merit') {
    return res.status(400).json({ success: false, message: "Invalid type. Expected 'demerit' or 'merit'." });
  }

  // Prefer the rules catalog (B.1) when a ruleId is supplied — it's the
  // governable source of truth for category/points/fine going forward, and
  // its default_points is what actually gets recorded (never the legacy
  // severity-tier derivation below). Falls back to the legacy hardcoded
  // tiers in utils/conduct.ts otherwise, so existing clients keep working.
  let resolvedRuleId: number | null = null;
  let resolvedCategory = category;
  let resolvedSeverity = severity;
  let points: number;
  if (ruleId != null) {
    const rule = await getRule(getDb(), Number(ruleId));
    if (!rule || !rule.is_active || rule.type !== type) {
      return res.status(400).json({ success: false, message: 'Invalid or retired ruleId for this discipline type.' });
    }
    resolvedRuleId = rule.id;
    resolvedCategory = rule.category;
    resolvedSeverity = rule.severity ?? null;
    points = rule.default_points;
  } else {
    if (!isValidCategory(type as DisciplineType, category)) {
      return res.status(400).json({ success: false, message: `Invalid category '${category}' for ${type}.` });
    }
    try {
      points = derivePoints(type as DisciplineType, severity);
    } catch (err: any) {
      return res.status(400).json({ success: false, message: err.message });
    }
  }

  const fieldError = validateIncidentFields({ title, description, incidentDate, location, className });
  if (fieldError) {
    return res.status(400).json({ success: false, message: fieldError });
  }

  // Sanctions only apply to demerits; merits are always 'none'.
  const effectiveSanction = type === 'demerit' ? sanction : 'none';
  if (!SANCTIONS.includes(effectiveSanction)) {
    return res.status(400).json({ success: false, message: `Invalid sanction '${sanction}'.` });
  }

  // Access control v2: the sanction ladder (access/sanctions.ts).
  const deniedCap = await sanctionDenied(req, effectiveSanction, [String(studentId)]);
  if (deniedCap) return sanctionForbidden(res, deniedCap);

  const db = getDb();
  const actor = authReq.user!;
  // Remediation X3: file under the term the incident date falls in.
  const { academicYearId, academicTermId } = await resolveAcademicPeriodForDate(
    db, incidentDate, resolveAcademicPeriod(authReq)
  );

  // Remediation D1: block an accidental re-submit of the same incident.
  if (!force) {
    const dup = await findDuplicateIncident(db, {
      studentId, incidentDate, type, ruleId: resolvedRuleId, title, loggedBy: actor.id,
    });
    if (dup) {
      return res.status(409).json({
        success: false,
        code: 'DUPLICATE_INCIDENT',
        message: 'You already logged this incident for this student on this date. Re-send with "force" to log it anyway.',
        data: { existingId: dup.id },
      });
    }
  }

  try {
    const result = await db.run(
      `INSERT INTO discipline_records
         (student_id, student_name, class_name, type, category, severity, points, title, description, incident_date, location, sanction, logged_by, logged_by_name, academic_year_id, academic_term_id, rule_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      studentId,
      studentName,
      className,
      type,
      resolvedCategory,
      resolvedSeverity,
      points,
      title,
      description,
      incidentDate,
      location,
      effectiveSanction,
      actor.id,
      actor.name,
      academicYearId ?? null,
      academicTermId ?? null,
      resolvedRuleId
    );

    const inserted = await db.get('SELECT * FROM discipline_records WHERE id = ?', result.lastID);

    await recordAudit(db, actor, 'discipline.create', 'discipline_record', result.lastID ?? null, {
      studentId,
      type,
      category: resolvedCategory,
      severity: resolvedSeverity,
      points,
      sanction: effectiveSanction,
    });

    // Notify the student (reuse the 'system' notification type to avoid a CHECK migration).
    const verb = type === 'merit' ? 'received a merit' : 'received a demerit';
    await db.run(
      `INSERT INTO notifications (user_id, type, title, message) VALUES (?, 'system', ?, ?)`,
      studentId,
      type === 'merit' ? `Merit awarded: ${title}` : `Conduct notice: ${title}`,
      `You ${verb} (${resolvedCategory}, ${points} pts) on ${incidentDate}. ${description || ''}`.trim()
    );

    // Escalate major demerits to staff/admins.
    if (type === 'demerit' && resolvedSeverity === 'major') {
      await notifyDisciplineStaff(req, {
        kind: 'major_incident',
        studentId: String(studentId),
        title: `Major incident: ${studentName}`,
        message: `A major demerit (${resolvedCategory}) was logged for ${studentName}: ${title}.`,
      });
    }

    // Notify the student externally (respects their preferences) and check
    // whether their cumulative demerits now warrant a follow-up.
    await notifyUserExternal(
      db,
      studentId,
      type === 'merit' ? `Merit awarded: ${title}` : `Conduct notice: ${title}`,
      `${type === 'merit' ? 'You received a merit' : 'A demerit was recorded'} (${resolvedCategory}, ${points} pts) on ${incidentDate}.`
    );
    if (type === 'demerit') await triggerConductCheck(studentId, studentName, academicTermId, req);

    return res.json({ success: true, data: inserted, message: 'Discipline record saved successfully.' });
  } catch (error: any) {
    console.error('Error saving discipline record:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Error occurred while saving the discipline record.',
    });
  }
});

// Log the SAME record against multiple students at once (Teacher/Admin only).
// e.g. a whole-class tardiness demerit. Points are derived server-side per record.
router.post('/bulk', authorizePermission('DISCIPLINE_LOG'), async (req: any, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  const {
    students, className = null, type, category, severity, title,
    description = '', incidentDate, location = null, sanction = 'none', ruleId = null,
  } = req.body;

  if (!Array.isArray(students) || students.length === 0 || !type || !title || !incidentDate || (ruleId == null && (!category || !severity))) {
    return res.status(400).json({
      success: false,
      message: 'Missing required fields: students[], type, title, incidentDate, and (category + severity, or ruleId).',
    });
  }
  if (type !== 'demerit' && type !== 'merit') {
    return res.status(400).json({ success: false, message: "Invalid type. Expected 'demerit' or 'merit'." });
  }
  // Remediation D1/D6: de-dupe the roster before doing any work — the same
  // student listed twice would otherwise be logged twice in one call.
  const seen = new Set<string>();
  const uniqueStudents: Array<{ studentId: string; studentName: string }> = [];
  for (const s of students) {
    if (!s?.studentId || !s?.studentName) {
      return res.status(400).json({ success: false, message: 'Each student needs studentId and studentName.' });
    }
    if (seen.has(s.studentId)) continue;
    seen.add(s.studentId);
    uniqueStudents.push({ studentId: String(s.studentId), studentName: String(s.studentName) });
  }
  if (uniqueStudents.length > 100) {
    return res.status(400).json({ success: false, message: 'Too many students in one batch (max 100).' });
  }

  let resolvedRuleId: number | null = null;
  let resolvedCategory = category;
  let resolvedSeverity = severity;
  let points: number;
  if (ruleId != null) {
    const rule = await getRule(getDb(), Number(ruleId));
    if (!rule || !rule.is_active || rule.type !== type) {
      return res.status(400).json({ success: false, message: 'Invalid or retired ruleId for this discipline type.' });
    }
    resolvedRuleId = rule.id;
    resolvedCategory = rule.category;
    resolvedSeverity = rule.severity ?? null;
    points = rule.default_points;
  } else {
    if (!isValidCategory(type as DisciplineType, category)) {
      return res.status(400).json({ success: false, message: `Invalid category '${category}' for ${type}.` });
    }
    try {
      points = derivePoints(type as DisciplineType, severity);
    } catch (err: any) {
      return res.status(400).json({ success: false, message: err.message });
    }
  }

  const bulkFieldError = validateIncidentFields({ title, description, incidentDate, location, className });
  if (bulkFieldError) {
    return res.status(400).json({ success: false, message: bulkFieldError });
  }
  const effectiveSanction = type === 'demerit' ? sanction : 'none';
  if (!SANCTIONS.includes(effectiveSanction)) {
    return res.status(400).json({ success: false, message: `Invalid sanction '${sanction}'.` });
  }

  const bulkDeniedCap = await sanctionDenied(req, effectiveSanction, uniqueStudents.map((u) => u.studentId));
  if (bulkDeniedCap) return sanctionForbidden(res, bulkDeniedCap);

  const db = getDb();
  const actor = authReq.user!;
  const { academicYearId, academicTermId } = await resolveAcademicPeriodForDate(
    db, incidentDate, resolveAcademicPeriod(authReq)
  );

  // Skip students who already have this exact incident logged by this actor
  // (unless forced) rather than failing the whole batch.
  const force = req.body.force === true;
  const targets: Array<{ studentId: string; studentName: string }> = [];
  let skipped = 0;
  for (const s of uniqueStudents) {
    if (!force) {
      const dup = await findDuplicateIncident(db, {
        studentId: s.studentId, incidentDate, type, ruleId: resolvedRuleId, title, loggedBy: actor.id,
      });
      if (dup) { skipped += 1; continue; }
    }
    targets.push(s);
  }

  if (targets.length === 0) {
    return res.status(409).json({
      success: false,
      code: 'DUPLICATE_INCIDENT',
      message: 'Every selected student already has this incident logged. Re-send with "force" to log it anyway.',
      data: { skipped },
    });
  }

  const notify: Array<{ studentId: string; studentName: string }> = [];

  try {
    await db.run('BEGIN TRANSACTION');
    const insertedIds: number[] = [];
    for (const s of targets) {
      const result = await db.run(
        `INSERT INTO discipline_records
           (student_id, student_name, class_name, type, category, severity, points, title, description, incident_date, location, sanction, logged_by, logged_by_name, academic_year_id, academic_term_id, rule_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        s.studentId, s.studentName, className, type, resolvedCategory, resolvedSeverity, points,
        title, description, incidentDate, location, effectiveSanction, actor.id, actor.name,
        academicYearId ?? null, academicTermId ?? null, resolvedRuleId
      );
      insertedIds.push(result.lastID!);
      notify.push(s);
    }

    await recordAudit(db, actor, 'discipline.create', 'discipline_record', null, {
      bulk: true, count: insertedIds.length, skipped, type, category: resolvedCategory, severity: resolvedSeverity, points,
    }, { required: true });

    await db.run('COMMIT');

    // Remediation D6: notification fan-out runs after the commit, not inside
    // the critical transaction.
    for (const s of notify) {
      await db.run(
        `INSERT INTO notifications (user_id, type, title, message) VALUES (?, 'system', ?, ?)`,
        s.studentId,
        type === 'merit' ? `Merit awarded: ${title}` : `Conduct notice: ${title}`,
        `${type === 'merit' ? 'You received a merit' : 'A demerit was recorded'} (${resolvedCategory}, ${points} pts) on ${incidentDate}.`
      );
    }

    // Run conduct checks outside the transaction.
    if (type === 'demerit') {
      for (const s of notify) await triggerConductCheck(s.studentId, s.studentName, academicTermId, req);
    }

    return res.json({
      success: true,
      data: { count: insertedIds.length, skipped },
      message: skipped > 0
        ? `Logged ${insertedIds.length} record${insertedIds.length === 1 ? '' : 's'}; skipped ${skipped} already logged.`
        : `Logged ${insertedIds.length} record${insertedIds.length === 1 ? '' : 's'}.`,
    });
  } catch (error: any) {
    await db.run('ROLLBACK');
    console.error('Error saving bulk discipline records:', error);
    return res.status(500).json({ success: false, message: error.message || 'Error saving bulk records.' });
  }
});

// List discipline records with filters + pagination (Teacher/Admin only)
router.get('/', authorizePermission('DISCIPLINE_VIEW_ALL'), async (req: any, res: Response) => {
  const { studentId, type, severity, status, category, dateFrom, dateTo, search } = req.query;
  const db = getDb();
  const { academicTermId } = resolveAcademicPeriod(req as AuthenticatedRequest);

  let where = ' WHERE deleted_at IS NULL';
  const params: any[] = [];

  if (academicTermId != null) {
    where += ' AND (academic_term_id = ? OR academic_term_id IS NULL)';
    params.push(academicTermId);
  }
  if (studentId) { where += ' AND student_id = ?'; params.push(studentId); }
  if (type) { where += ' AND type = ?'; params.push(type); }
  if (severity) { where += ' AND severity = ?'; params.push(severity); }
  if (status) { where += ' AND status = ?'; params.push(status); }
  if (category) { where += ' AND category = ?'; params.push(category); }
  if (dateFrom) { where += ' AND incident_date >= ?'; params.push(dateFrom); }
  if (dateTo) { where += ' AND incident_date <= ?'; params.push(dateTo); }
  if (search) {
    where += ' AND (student_name LIKE ? OR student_id LIKE ? OR title LIKE ?)';
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }

  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), 200);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

  try {
    // Access control v2 (enforce): only students in the caller's scope.
    const v2 = await studentScopeFilter(req, 'DISCIPLINE_VIEW_ALL', 'detail', async () =>
      (await db.all(`SELECT DISTINCT student_id FROM discipline_records${where}`, ...params)).map((r: any) => String(r.student_id))
    );
    if (v2) { where += ` AND ${v2.sql}`; params.push(...v2.params); }

    const totalRow = await db.get(`SELECT COUNT(*) as count FROM discipline_records${where}`, ...params);
    const records = await db.all(
      `SELECT * FROM discipline_records${where} ORDER BY incident_date DESC, created_at DESC LIMIT ? OFFSET ?`,
      ...params, limit, offset
    );
    shadowListLeak(req, 'DISCIPLINE_VIEW_ALL', 'detail', records.map((r: any) => ({ studentId: r.student_id })));

    return res.json({ success: true, data: records, total: totalRow.count });
  } catch (error) {
    console.error('Error fetching discipline records:', error);
    return res.status(500).json({ success: false, message: 'Error fetching discipline records.' });
  }
});

// Discipline overview analytics (Teacher/Admin only)
router.get('/overview', authorizePermission('DISCIPLINE_VIEW_ALL'), async (req: any, res: Response) => {
  const db = getDb();
  const { academicTermId } = resolveAcademicPeriod(req as AuthenticatedRequest);
  let periodFilter = ' AND deleted_at IS NULL'
    + (academicTermId != null ? ' AND (academic_term_id = ? OR academic_term_id IS NULL)' : '');
  const periodParams: any[] = academicTermId != null ? [academicTermId] : [];

  try {
    // Access control v2 (enforce): every figure below covers only students in
    // the caller's scope. Shadow counts the students v2 would leave out.
    const v2 = await studentScopeFilter(req, 'DISCIPLINE_VIEW_ALL', 'detail', async () =>
      (await db.all(`SELECT DISTINCT student_id FROM discipline_records WHERE 1=1${periodFilter}`, ...periodParams)).map((r: any) => String(r.student_id))
    );
    if (v2) { periodFilter += ` AND ${v2.sql}`; periodParams.push(...v2.params); }
    if (accessMode() === 'shadow') {
      const seen = await db.all(`SELECT DISTINCT student_id FROM discipline_records WHERE 1=1${periodFilter}`, ...periodParams);
      shadowListLeak(req, 'DISCIPLINE_VIEW_ALL', 'detail', seen.map((r: any) => ({ studentId: r.student_id })));
    }

    const totals = await db.get(
      `SELECT
         COUNT(*) as total,
         SUM(CASE WHEN type = 'demerit' THEN 1 ELSE 0 END) as demerits,
         SUM(CASE WHEN type = 'merit' THEN 1 ELSE 0 END) as merits,
         SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) as open,
         SUM(CASE WHEN status = 'under_review' THEN 1 ELSE 0 END) as under_review
       FROM discipline_records WHERE 1=1${periodFilter}`,
      ...periodParams
    );

    const byCategory = await db.all(
      `SELECT category, type, COUNT(*) as count
       FROM discipline_records
       WHERE 1=1${periodFilter}
       GROUP BY category, type
       ORDER BY count DESC`,
      ...periodParams
    );

    const bySeverity = await db.all(
      `SELECT type, severity, COUNT(*) as count
       FROM discipline_records
       WHERE 1=1${periodFilter}
       GROUP BY type, severity`,
      ...periodParams
    );

    // 7-day trend of records logged per day.
    const trends = await db.all(
      `SELECT incident_date as date,
         SUM(CASE WHEN type = 'demerit' THEN 1 ELSE 0 END) as demerits,
         SUM(CASE WHEN type = 'merit' THEN 1 ELSE 0 END) as merits
       FROM discipline_records
       WHERE 1=1${periodFilter}
       GROUP BY incident_date
       ORDER BY incident_date DESC
       LIMIT 7`,
      ...periodParams
    );
    const trendStats = trends.reverse();

    // Students with the most demerit points (net negative attention).
    const topDemerits = await db.all(
      `SELECT student_id, student_name,
         SUM(points) as demerit_points,
         COUNT(*) as count
       FROM discipline_records
       WHERE type = 'demerit'${periodFilter}
       GROUP BY student_id
       ORDER BY demerit_points DESC
       LIMIT 5`,
      ...periodParams
    );

    const recentActivity = await db.all(
      `SELECT id, student_name, type, category, severity, title, status, incident_date, updated_at
       FROM discipline_records
       WHERE 1=1${periodFilter}
       ORDER BY updated_at DESC
       LIMIT 6`,
      ...periodParams
    );

    return res.json({
      success: true,
      data: {
        totals: {
          total: totals.total || 0,
          demerits: totals.demerits || 0,
          merits: totals.merits || 0,
          open: totals.open || 0,
          underReview: totals.under_review || 0,
        },
        byCategory,
        bySeverity,
        trends: trendStats,
        topDemerits,
        recentActivity,
      },
    });
  } catch (error) {
    console.error('Error generating discipline overview:', error);
    return res.status(500).json({ success: false, message: 'Database error generating discipline overview.' });
  }
});

// Student's own discipline records + conduct score (Student only)
router.get('/me', authorizePermission('DISCIPLINE_VIEW_OWN'), async (req: any, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  const studentId = authReq.user!.id;
  const db = getDb();
  const { academicTermId } = resolveAcademicPeriod(authReq);

  try {
    const records = academicTermId != null
      ? await db.all(
          "SELECT * FROM discipline_records WHERE student_id = ? AND deleted_at IS NULL AND (academic_term_id = ? OR academic_term_id IS NULL) ORDER BY incident_date DESC, created_at DESC",
          studentId, academicTermId
        )
      : await db.all(
          'SELECT * FROM discipline_records WHERE student_id = ? AND deleted_at IS NULL ORDER BY incident_date DESC, created_at DESC',
          studentId
        );
    return res.json({
      // The full record list (including dismissed ones) stays visible for
      // transparency, but the score itself excludes dismissed records —
      // "dismissed" means the incident was ruled invalid and excluded from
      // follow-up (see the dismiss confirmation copy), so it shouldn't still
      // count against the student. Matches ledger.service.ts's balance calc.
      success: true,
      data: { records, conductScore: computeConductScore(records.filter((r: any) => r.status !== 'dismissed')) },
    });
  } catch (error) {
    console.error('Error fetching own discipline records:', error);
    return res.status(500).json({ success: false, message: 'Error fetching your conduct records.' });
  }
});

// A specific student's discipline records (anyone with DISCIPLINE_VIEW_ALL, or the student themself)
router.get('/student/:id', selfOrPermission('id', 'DISCIPLINE_VIEW_ALL'), async (req: any, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  const studentId = req.params.id;

  const db = getDb();
  const { academicTermId } = resolveAcademicPeriod(authReq);
  try {
    const records = academicTermId != null
      ? await db.all(
          "SELECT * FROM discipline_records WHERE student_id = ? AND deleted_at IS NULL AND (academic_term_id = ? OR academic_term_id IS NULL) ORDER BY incident_date DESC, created_at DESC",
          studentId, academicTermId
        )
      : await db.all(
          'SELECT * FROM discipline_records WHERE student_id = ? AND deleted_at IS NULL ORDER BY incident_date DESC, created_at DESC',
          studentId
        );
    return res.json({
      // The full record list (including dismissed ones) stays visible for
      // transparency, but the score itself excludes dismissed records —
      // "dismissed" means the incident was ruled invalid and excluded from
      // follow-up (see the dismiss confirmation copy), so it shouldn't still
      // count against the student. Matches ledger.service.ts's balance calc.
      success: true,
      data: { records, conductScore: computeConductScore(records.filter((r: any) => r.status !== 'dismissed')) },
    });
  } catch (error) {
    console.error('Error fetching student discipline records:', error);
    return res.status(500).json({ success: false, message: 'Error fetching student conduct records.' });
  }
});

// Full detail for one record — every field plus its change history (D3).
router.get('/:id(\\d+)', authorizePermission('DISCIPLINE_VIEW_ALL'),
  requireAccess('DISCIPLINE_VIEW_ALL', (req: any) => () => recordTarget(req, req.params.id), { minDepth: 'detail' }), async (req: any, res: Response) => {
  const db = getDb();
  try {
    const record = await db.get('SELECT * FROM discipline_records WHERE id = ? AND deleted_at IS NULL', req.params.id);
    if (!record) return res.status(404).json({ success: false, message: 'Discipline record not found.' });

    const history = await db.all(
      `SELECT action, actor_name, details, created_at
         FROM audit_log
        WHERE entity_type = 'discipline_record' AND entity_id = ?
        ORDER BY created_at ASC`,
      String(req.params.id)
    );
    let rule = null;
    if (record.rule_id) rule = await getRule(db, record.rule_id);

    return res.json({ success: true, data: { record, rule, history } });
  } catch (error: any) {
    console.error('Error fetching discipline record detail:', error);
    return res.status(500).json({ success: false, message: 'Error fetching the discipline record.' });
  }
});

// Update a record's review status / sanction (Teacher/Admin only)
router.put('/:id/status', authorizePermission('DISCIPLINE_REVIEW'),
  requireAccess('DISCIPLINE_REVIEW', (req: any) => () => recordTarget(req, req.params.id)), async (req: any, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  const id = req.params.id;
  const { status, resolutionNote, sanction } = req.body;

  if (!status || !RECORD_STATUSES.includes(status)) {
    return res.status(400).json({
      success: false,
      message: `Invalid status. Expected one of: ${RECORD_STATUSES.join(', ')}.`,
    });
  }

  if (sanction !== undefined && !SANCTIONS.includes(sanction)) {
    return res.status(400).json({ success: false, message: `Invalid sanction '${sanction}'.` });
  }

  const db = getDb();
  const actor = authReq.user!;

  try {
    const existing = await db.get('SELECT * FROM discipline_records WHERE id = ? AND deleted_at IS NULL', id);
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Discipline record not found.' });
    }

    if (sanction !== undefined && existing.type === 'demerit') {
      const deniedCap = await sanctionDenied(req, sanction, [String(existing.student_id)], existing.sanction);
      if (deniedCap) return sanctionForbidden(res, deniedCap);
    }

    await db.run(
      `UPDATE discipline_records
         SET status = ?,
             resolution_note = COALESCE(?, resolution_note),
             sanction = COALESCE(?, sanction),
             resolved_by = ?,
             resolved_by_id = ?,
             resolved_by_name = ?,
             updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      status,
      resolutionNote ?? null,
      sanction ?? null,
      actor.name || actor.id,   // legacy column kept in sync
      actor.id,
      actor.name ?? null,
      id
    );

    const updated = await db.get('SELECT * FROM discipline_records WHERE id = ?', id);

    await recordAudit(db, actor, 'discipline.status', 'discipline_record', id, {
      from: existing.status,
      to: status,
      sanction: sanction ?? existing.sanction,
    }, { required: true });

    // Remediation D4: dismissing (or un-dismissing) a demerit changes the
    // term balance, so re-run the escalation check against the new figure.
    if (existing.type === 'demerit' && existing.status !== status) {
      await triggerConductCheck(existing.student_id, existing.student_name, existing.academic_term_id ?? undefined, req);
    }

    return res.json({ success: true, data: updated, message: 'Record updated successfully.' });
  } catch (error: any) {
    console.error('Error updating discipline record:', error);
    return res.status(500).json({ success: false, message: error.message || 'Error updating the discipline record.' });
  }
});

/**
 * Remediation D2 — correct the factual content of a record (wrong student,
 * wrong date, typo, wrong rule). Points are re-derived when the rule or
 * severity changes; the full before/after is audited. Allowed for a
 * DISCIPLINE_EDIT holder, or the original logger within 24h of creating it.
 */
router.put('/:id(\\d+)', async (req: any, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  const actor = authReq.user!;
  if (!actor) return res.status(401).json({ success: false, message: 'Unauthorized.' });
  const db = getDb();

  const existing = await db.get('SELECT * FROM discipline_records WHERE id = ? AND deleted_at IS NULL', req.params.id);
  if (!existing) return res.status(404).json({ success: false, message: 'Discipline record not found.' });

  const canEdit = actor.permissions.has('DISCIPLINE_EDIT');
  const createdAtMs = new Date(String(existing.created_at).replace(' ', 'T') + 'Z').getTime();
  const isRecentOwnEntry =
    existing.logged_by === actor.id &&
    Number.isFinite(createdAtMs) &&
    Date.now() - createdAtMs < 24 * 60 * 60 * 1000;
  if (!canEdit && !isRecentOwnEntry) {
    return res.status(403).json({
      success: false,
      message: 'You can only edit a record you logged, and only within 24 hours. Ask a reviewer otherwise.',
    });
  }

  const b = req.body ?? {};
  const next = {
    student_id: b.studentId ?? existing.student_id,
    student_name: b.studentName ?? existing.student_name,
    class_name: b.className !== undefined ? b.className : existing.class_name,
    type: b.type ?? existing.type,
    category: b.category ?? existing.category,
    severity: b.severity !== undefined ? b.severity : existing.severity,
    title: b.title ?? existing.title,
    description: b.description !== undefined ? b.description : existing.description,
    incident_date: b.incidentDate ?? existing.incident_date,
    location: b.location !== undefined ? b.location : existing.location,
    sanction: b.sanction ?? existing.sanction,
    rule_id: b.ruleId !== undefined ? (b.ruleId == null ? null : Number(b.ruleId)) : existing.rule_id,
    points: existing.points,
  };

  if (next.type !== 'demerit' && next.type !== 'merit') {
    return res.status(400).json({ success: false, message: "Invalid type. Expected 'demerit' or 'merit'." });
  }
  const fieldError = validateIncidentFields({
    title: next.title, description: next.description ?? '', incidentDate: next.incident_date,
    location: next.location, className: next.class_name,
  });
  if (fieldError) return res.status(400).json({ success: false, message: fieldError });
  if (!SANCTIONS.includes(next.type === 'demerit' ? next.sanction : 'none')) {
    return res.status(400).json({ success: false, message: `Invalid sanction '${next.sanction}'.` });
  }
  if (next.type === 'merit') next.sanction = 'none';
  if (next.type === 'demerit') {
    const deniedCap = await sanctionDenied(req, next.sanction, [String(next.student_id)], existing.sanction);
    if (deniedCap) return sanctionForbidden(res, deniedCap);
  }

  // Re-derive points if the rule or severity/type changed.
  const ruleChanged = next.rule_id !== existing.rule_id;
  const severityChanged = next.severity !== existing.severity;
  const typeChanged = next.type !== existing.type;
  if (ruleChanged || severityChanged || typeChanged) {
    if (next.rule_id != null) {
      const rule = await getRule(db, next.rule_id);
      if (!rule || rule.type !== next.type) {
        return res.status(400).json({ success: false, message: 'Invalid ruleId for this discipline type.' });
      }
      next.category = rule.category;
      next.severity = rule.severity ?? null;
      next.points = rule.default_points;
    } else {
      if (!isValidCategory(next.type as DisciplineType, next.category)) {
        return res.status(400).json({ success: false, message: `Invalid category '${next.category}' for ${next.type}.` });
      }
      try {
        next.points = derivePoints(next.type as DisciplineType, next.severity);
      } catch (err: any) {
        return res.status(400).json({ success: false, message: err.message });
      }
    }
  }

  const { academicYearId, academicTermId } = await resolveAcademicPeriodForDate(
    db, next.incident_date, resolveAcademicPeriod(authReq)
  );

  try {
    await db.run('BEGIN TRANSACTION');
    await db.run(
      `UPDATE discipline_records SET
         student_id = ?, student_name = ?, class_name = ?, type = ?, category = ?, severity = ?,
         points = ?, title = ?, description = ?, incident_date = ?, location = ?, sanction = ?,
         rule_id = ?, academic_year_id = ?, academic_term_id = ?,
         edited_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      next.student_id, next.student_name, next.class_name, next.type, next.category, next.severity,
      next.points, next.title, next.description, next.incident_date, next.location, next.sanction,
      next.rule_id, academicYearId ?? null, academicTermId ?? null, req.params.id
    );
    await recordAudit(db, actor, 'discipline.edit', 'discipline_record', req.params.id, {}, {
      required: true,
      previousValue: {
        studentId: existing.student_id, type: existing.type, category: existing.category,
        severity: existing.severity, points: existing.points, title: existing.title,
        incidentDate: existing.incident_date, ruleId: existing.rule_id, sanction: existing.sanction,
      },
      newValue: {
        studentId: next.student_id, type: next.type, category: next.category,
        severity: next.severity, points: next.points, title: next.title,
        incidentDate: next.incident_date, ruleId: next.rule_id, sanction: next.sanction,
      },
    });
    await db.run('COMMIT');
  } catch (err: any) {
    await db.run('ROLLBACK');
    console.error('Error editing discipline record:', err);
    return res.status(500).json({ success: false, message: 'Could not save the correction.' });
  }

  // Points may have moved in either direction; re-check the balance.
  const updated = await db.get('SELECT * FROM discipline_records WHERE id = ?', req.params.id);
  if (updated.type === 'demerit') {
    await triggerConductCheck(updated.student_id, updated.student_name, updated.academic_term_id ?? undefined, req);
  }
  return res.json({ success: true, data: updated, message: 'Record corrected.' });
});

/**
 * Remediation D2 — permanently remove a record logged in error (soft delete,
 * so it drops out of every aggregate but stays auditable). Admin-gated.
 */
router.delete('/:id(\\d+)', authorizePermission('DISCIPLINE_DELETE'), async (req: any, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  const actor = authReq.user!;
  const db = getDb();

  const existing = await db.get('SELECT * FROM discipline_records WHERE id = ? AND deleted_at IS NULL', req.params.id);
  if (!existing) return res.status(404).json({ success: false, message: 'Discipline record not found.' });

  try {
    await db.run('BEGIN TRANSACTION');
    await db.run('UPDATE discipline_records SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?', req.params.id);
    await recordAudit(db, actor, 'discipline.delete', 'discipline_record', req.params.id, {
      reason: (req.body?.reason ?? '').toString().slice(0, 500) || undefined,
    }, {
      required: true,
      previousValue: { studentId: existing.student_id, type: existing.type, points: existing.points, title: existing.title },
    });
    await db.run('COMMIT');
  } catch (err: any) {
    await db.run('ROLLBACK');
    console.error('Error deleting discipline record:', err);
    return res.status(500).json({ success: false, message: 'Could not remove the record.' });
  }

  if (existing.type === 'demerit') {
    await triggerConductCheck(existing.student_id, existing.student_name, existing.academic_term_id ?? undefined, req);
  }
  return res.json({ success: true, message: 'Record removed.' });
});

export default router;
