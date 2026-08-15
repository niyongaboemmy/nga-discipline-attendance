import { Router, Response } from 'express';
import { getDb } from '../database.js';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth.js';
import { roleGuard } from '../middleware/roleGuard.js';
import {
  derivePoints,
  isValidCategory,
  computeConductScore,
  recordAudit,
  SANCTIONS,
  RECORD_STATUSES,
  DisciplineType,
} from '../utils/conduct.js';
import { notifyUserExternal } from '../utils/notifier.js';
import { resolveAcademicPeriod } from '../utils/academicPeriod.js';

const router = Router();

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

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
 * After demerits are logged, check whether a student's total demerit points have
 * crossed the follow-up threshold and, if so, raise a one-per-day escalation to
 * staff/admins. Best-effort: never blocks the primary write.
 */
async function triggerConductCheck(studentId: string, studentName: string) {
  const db = getDb();
  try {
    const row = await db.get(
      `SELECT SUM(points) as demerit_points FROM discipline_records WHERE student_id = ? AND type = 'demerit'`,
      studentId
    );
    const demeritPoints = row?.demerit_points || 0;
    if (demeritPoints < CONDUCT_FLAG_THRESHOLD) return;

    const alreadyFlagged = await db.get(
      `SELECT id FROM notifications
       WHERE user_id = 'all' AND type = 'system' AND title LIKE ? AND created_at >= date('now')`,
      `Conduct follow-up: ${studentName}%`
    );
    if (alreadyFlagged) return;

    await db.run(
      `INSERT INTO notifications (user_id, type, title, message) VALUES ('all', 'system', ?, ?)`,
      `Conduct follow-up: ${studentName}`,
      `${studentName} has accumulated ${demeritPoints} demerit points and may need a disciplinary follow-up.`
    );
  } catch (err) {
    console.error('Error in triggerConductCheck:', err);
  }
}

// Log a discipline record — demerit or merit (Teacher/Admin only)
router.post('/', roleGuard(['teacher', 'admin']), async (req: any, res: Response) => {
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
  } = req.body;

  // --- Validation (server is authoritative; client-supplied points are ignored) ---
  if (!studentId || !studentName || !type || !category || !severity || !title || !incidentDate) {
    return res.status(400).json({
      success: false,
      message: 'Missing required fields: studentId, studentName, type, category, severity, title, incidentDate.',
    });
  }

  if (type !== 'demerit' && type !== 'merit') {
    return res.status(400).json({ success: false, message: "Invalid type. Expected 'demerit' or 'merit'." });
  }

  if (!isValidCategory(type as DisciplineType, category)) {
    return res.status(400).json({ success: false, message: `Invalid category '${category}' for ${type}.` });
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

  let points: number;
  try {
    points = derivePoints(type as DisciplineType, severity);
  } catch (err: any) {
    return res.status(400).json({ success: false, message: err.message });
  }

  const db = getDb();
  const actor = authReq.user!;
  const { academicYearId, academicTermId } = resolveAcademicPeriod(authReq);

  try {
    const result = await db.run(
      `INSERT INTO discipline_records
         (student_id, student_name, class_name, type, category, severity, points, title, description, incident_date, location, sanction, logged_by, logged_by_name, academic_year_id, academic_term_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      studentId,
      studentName,
      className,
      type,
      category,
      severity,
      points,
      title,
      description,
      incidentDate,
      location,
      effectiveSanction,
      actor.id,
      actor.name,
      academicYearId ?? null,
      academicTermId ?? null
    );

    const inserted = await db.get('SELECT * FROM discipline_records WHERE id = ?', result.lastID);

    await recordAudit(db, actor, 'discipline.create', 'discipline_record', result.lastID ?? null, {
      studentId,
      type,
      category,
      severity,
      points,
      sanction: effectiveSanction,
    });

    // Notify the student (reuse the 'system' notification type to avoid a CHECK migration).
    const verb = type === 'merit' ? 'received a merit' : 'received a demerit';
    await db.run(
      `INSERT INTO notifications (user_id, type, title, message) VALUES (?, 'system', ?, ?)`,
      studentId,
      type === 'merit' ? `Merit awarded: ${title}` : `Conduct notice: ${title}`,
      `You ${verb} (${category}, ${points} pts) on ${incidentDate}. ${description || ''}`.trim()
    );

    // Escalate major demerits to staff/admins.
    if (type === 'demerit' && severity === 'major') {
      await db.run(
        `INSERT INTO notifications (user_id, type, title, message) VALUES ('all', 'system', ?, ?)`,
        `Major incident: ${studentName}`,
        `A major demerit (${category}) was logged for ${studentName}: ${title}.`
      );
    }

    // Notify the student externally (respects their preferences) and check
    // whether their cumulative demerits now warrant a follow-up.
    await notifyUserExternal(
      db,
      studentId,
      type === 'merit' ? `Merit awarded: ${title}` : `Conduct notice: ${title}`,
      `${type === 'merit' ? 'You received a merit' : 'A demerit was recorded'} (${category}, ${points} pts) on ${incidentDate}.`
    );
    if (type === 'demerit') await triggerConductCheck(studentId, studentName);

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
router.post('/bulk', roleGuard(['teacher', 'admin']), async (req: any, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  const {
    students, className = null, type, category, severity, title,
    description = '', incidentDate, location = null, sanction = 'none',
  } = req.body;

  if (!Array.isArray(students) || students.length === 0 || !type || !category || !severity || !title || !incidentDate) {
    return res.status(400).json({
      success: false,
      message: 'Missing required fields: students[], type, category, severity, title, incidentDate.',
    });
  }
  if (type !== 'demerit' && type !== 'merit') {
    return res.status(400).json({ success: false, message: "Invalid type. Expected 'demerit' or 'merit'." });
  }
  if (!isValidCategory(type as DisciplineType, category)) {
    return res.status(400).json({ success: false, message: `Invalid category '${category}' for ${type}.` });
  }
  const bulkFieldError = validateIncidentFields({ title, description, incidentDate, location, className });
  if (bulkFieldError) {
    return res.status(400).json({ success: false, message: bulkFieldError });
  }
  const effectiveSanction = type === 'demerit' ? sanction : 'none';
  if (!SANCTIONS.includes(effectiveSanction)) {
    return res.status(400).json({ success: false, message: `Invalid sanction '${sanction}'.` });
  }

  let points: number;
  try {
    points = derivePoints(type as DisciplineType, severity);
  } catch (err: any) {
    return res.status(400).json({ success: false, message: err.message });
  }

  const db = getDb();
  const actor = authReq.user!;
  const { academicYearId, academicTermId } = resolveAcademicPeriod(authReq);

  try {
    await db.run('BEGIN TRANSACTION');
    const insertedIds: number[] = [];
    for (const s of students) {
      if (!s.studentId || !s.studentName) throw new Error('Each student needs studentId and studentName.');
      const result = await db.run(
        `INSERT INTO discipline_records
           (student_id, student_name, class_name, type, category, severity, points, title, description, incident_date, location, sanction, logged_by, logged_by_name, academic_year_id, academic_term_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        s.studentId, s.studentName, className, type, category, severity, points,
        title, description, incidentDate, location, effectiveSanction, actor.id, actor.name,
        academicYearId ?? null, academicTermId ?? null
      );
      insertedIds.push(result.lastID!);
      await db.run(
        `INSERT INTO notifications (user_id, type, title, message) VALUES (?, 'system', ?, ?)`,
        s.studentId,
        type === 'merit' ? `Merit awarded: ${title}` : `Conduct notice: ${title}`,
        `${type === 'merit' ? 'You received a merit' : 'A demerit was recorded'} (${category}, ${points} pts) on ${incidentDate}.`
      );
    }
    await db.run('COMMIT');

    await recordAudit(db, actor, 'discipline.create', 'discipline_record', null, {
      bulk: true, count: students.length, type, category, severity, points,
    });

    // Run conduct checks outside the transaction.
    if (type === 'demerit') {
      for (const s of students) await triggerConductCheck(s.studentId, s.studentName);
    }

    return res.json({ success: true, data: { count: insertedIds.length }, message: `Logged ${insertedIds.length} records.` });
  } catch (error: any) {
    await db.run('ROLLBACK');
    console.error('Error saving bulk discipline records:', error);
    return res.status(500).json({ success: false, message: error.message || 'Error saving bulk records.' });
  }
});

// List discipline records with filters + pagination (Teacher/Admin only)
router.get('/', roleGuard(['teacher', 'admin']), async (req: any, res: Response) => {
  const { studentId, type, severity, status, category, dateFrom, dateTo, search } = req.query;
  const db = getDb();
  const { academicTermId } = resolveAcademicPeriod(req as AuthenticatedRequest);

  let where = ' WHERE 1=1';
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
    const totalRow = await db.get(`SELECT COUNT(*) as count FROM discipline_records${where}`, ...params);
    const records = await db.all(
      `SELECT * FROM discipline_records${where} ORDER BY incident_date DESC, created_at DESC LIMIT ? OFFSET ?`,
      ...params, limit, offset
    );

    return res.json({ success: true, data: records, total: totalRow.count });
  } catch (error) {
    console.error('Error fetching discipline records:', error);
    return res.status(500).json({ success: false, message: 'Error fetching discipline records.' });
  }
});

// Discipline overview analytics (Teacher/Admin only)
router.get('/overview', roleGuard(['teacher', 'admin']), async (req: any, res: Response) => {
  const db = getDb();
  const { academicTermId } = resolveAcademicPeriod(req as AuthenticatedRequest);
  const periodFilter = academicTermId != null ? ' AND (academic_term_id = ? OR academic_term_id IS NULL)' : '';
  const periodParams = academicTermId != null ? [academicTermId] : [];

  try {
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
router.get('/me', roleGuard(['student']), async (req: any, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  const studentId = authReq.user!.id;
  const db = getDb();
  const { academicTermId } = resolveAcademicPeriod(authReq);

  try {
    const records = academicTermId != null
      ? await db.all(
          'SELECT * FROM discipline_records WHERE student_id = ? AND (academic_term_id = ? OR academic_term_id IS NULL) ORDER BY incident_date DESC, created_at DESC',
          studentId, academicTermId
        )
      : await db.all(
          'SELECT * FROM discipline_records WHERE student_id = ? ORDER BY incident_date DESC, created_at DESC',
          studentId
        );
    return res.json({
      success: true,
      data: { records, conductScore: computeConductScore(records) },
    });
  } catch (error) {
    console.error('Error fetching own discipline records:', error);
    return res.status(500).json({ success: false, message: 'Error fetching your conduct records.' });
  }
});

// A specific student's discipline records (Teacher/Admin, or the student themself)
router.get('/student/:id', async (req: any, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  const studentId = req.params.id;

  // Staff can view anyone; everyone else (students, unassigned) only themselves.
  const { role, id: requesterId } = authReq.user!;
  const isStaff = role === 'teacher' || role === 'admin';
  if (!isStaff && requesterId !== studentId) {
    return res.status(403).json({
      success: false,
      message: 'Access denied. You can only view your own records.',
    });
  }

  const db = getDb();
  const { academicTermId } = resolveAcademicPeriod(authReq);
  try {
    const records = academicTermId != null
      ? await db.all(
          'SELECT * FROM discipline_records WHERE student_id = ? AND (academic_term_id = ? OR academic_term_id IS NULL) ORDER BY incident_date DESC, created_at DESC',
          studentId, academicTermId
        )
      : await db.all(
          'SELECT * FROM discipline_records WHERE student_id = ? ORDER BY incident_date DESC, created_at DESC',
          studentId
        );
    return res.json({
      success: true,
      data: { records, conductScore: computeConductScore(records) },
    });
  } catch (error) {
    console.error('Error fetching student discipline records:', error);
    return res.status(500).json({ success: false, message: 'Error fetching student conduct records.' });
  }
});

// Update a record's review status / sanction (Teacher/Admin only)
router.put('/:id/status', roleGuard(['teacher', 'admin']), async (req: any, res: Response) => {
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
    const existing = await db.get('SELECT * FROM discipline_records WHERE id = ?', id);
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Discipline record not found.' });
    }

    await db.run(
      `UPDATE discipline_records
         SET status = ?,
             resolution_note = COALESCE(?, resolution_note),
             sanction = COALESCE(?, sanction),
             resolved_by = ?,
             updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      status,
      resolutionNote ?? null,
      sanction ?? null,
      actor.name || actor.id,
      id
    );

    const updated = await db.get('SELECT * FROM discipline_records WHERE id = ?', id);

    await recordAudit(db, actor, 'discipline.status', 'discipline_record', id, {
      from: existing.status,
      to: status,
      sanction: sanction ?? existing.sanction,
    });

    return res.json({ success: true, data: updated, message: 'Record updated successfully.' });
  } catch (error: any) {
    console.error('Error updating discipline record:', error);
    return res.status(500).json({ success: false, message: error.message || 'Error updating the discipline record.' });
  }
});

export default router;
