import { Router, Response } from 'express';
import { getDb } from '../database.js';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth.js';
import { authorizePermission, selfOrPermission } from '../middleware/authorize.js';
import { recordAudit } from '../utils/conduct.js';
import { notifyUserExternal } from '../utils/notifier.js';
import { resolveAcademicPeriod } from '../utils/academicPeriod.js';
import { isSubjectOnClassCurriculum } from './mis.js';

const router = Router();

const ATTENDANCE_STATUSES = ['present', 'absent', 'late', 'excused'] as const;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Apply auth check on all attendance routes
router.use(authMiddleware);

// Mark attendance (Teacher/Admin only)
router.post('/mark', authorizePermission('ATTENDANCE_MARK'), async (req: any, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  const {
    classId, className, date, period = 'Morning', records,
    sessionType = 'homeroom', subjectId = null,
  } = req.body;

  if (!classId || !className || !date || !records || !Array.isArray(records)) {
    return res.status(400).json({
      success: false,
      message: 'Invalid payload. Missing classId, className, date, or records array.',
    });
  }
  if (!DATE_RE.test(String(date))) {
    return res.status(400).json({ success: false, message: 'Invalid date. Expected YYYY-MM-DD.' });
  }
  if (sessionType !== 'homeroom' && sessionType !== 'subject') {
    return res.status(400).json({ success: false, message: "Invalid sessionType. Expected 'homeroom' or 'subject'." });
  }
  // A.1.2: course/subject attendance must be tied to a specific subject.
  if (sessionType === 'subject' && !subjectId) {
    return res.status(400).json({ success: false, message: 'subjectId is required when sessionType is "subject".' });
  }
  // ...and that subject must actually be taught to this class group's grade.
  // The client only offers matching subjects, but that's a convenience, not
  // a guarantee — without this check a stale tab or a direct API call could
  // file attendance for a subject the class doesn't even take.
  if (sessionType === 'subject' && subjectId) {
    const misToken = authReq.user?.misToken;
    if (misToken) {
      try {
        const allowed = await isSubjectOnClassCurriculum(misToken, String(classId), Number(subjectId));
        if (!allowed) {
          return res.status(400).json({
            success: false,
            message: 'That subject is not on this class group’s curriculum. Pick a subject taught to this class.',
          });
        }
      } catch (error) {
        // The MIS being unreachable shouldn't block attendance from being
        // recorded — log and fall through rather than lose the teacher's work.
        console.error('Subject/class curriculum check skipped:', (error as Error).message);
      }
    }
  }
  // Validate every record up front so the transaction can't fail halfway through
  // on the DB CHECK constraint (which would surface as an opaque 500).
  for (const record of records) {
    if (!record?.studentId || !record?.studentName || !record?.status) {
      return res.status(400).json({ success: false, message: 'Each record needs studentId, studentName, and status.' });
    }
    if (!ATTENDANCE_STATUSES.includes(record.status)) {
      return res.status(400).json({
        success: false,
        message: `Invalid status '${record.status}'. Expected one of: ${ATTENDANCE_STATUSES.join(', ')}.`,
      });
    }
  }

  const db = getDb();
  const teacherId = authReq.user!.id;
  const { academicYearId, academicTermId } = resolveAcademicPeriod(authReq);

  try {
    // Run all insertions in a transaction
    await db.run('BEGIN TRANSACTION');

    for (const record of records) {
      const { studentId, studentName, status, notes = '' } = record;

      if (!studentId || !studentName || !status) {
        throw new Error(`Record missing studentId, studentName, or status.`);
      }

      await db.run(
        `INSERT INTO attendance_records
         (student_id, student_name, class_id, class_name, session_date, period, session_type, subject_id, status, notes, marked_by, academic_year_id, academic_term_id, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(student_id, class_id, session_date, session_type, subject_id, period) DO UPDATE SET
           status = excluded.status,
           notes = excluded.notes,
           marked_by = excluded.marked_by,
           -- Re-marking a session must restamp the period too. Without
           -- these, a record first marked under one term kept that term
           -- forever, so corrections made after a term switch stayed
           -- filed under the old period and vanished from the new one.
           academic_year_id = excluded.academic_year_id,
           academic_term_id = excluded.academic_term_id,
           updated_at = CURRENT_TIMESTAMP`,
        studentId,
        studentName,
        classId,
        className,
        date,
        period,
        sessionType,
        subjectId,
        status,
        notes,
        teacherId,
        academicYearId ?? null,
        academicTermId ?? null
      );
    }

    await db.run('COMMIT');

    // Trigger low attendance notification evaluation in background
    // (scoped to this session type so subject-attendance drops don't get
    // conflated with homeroom drops for the same class).
    triggerLowAttendanceCheck(classId, className, sessionType, academicTermId);

    return res.json({
      success: true,
      message: 'Attendance saved successfully.',
    });
  } catch (error: any) {
    await db.run('ROLLBACK');
    console.error('Error saving attendance:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Error occurred while saving attendance records.',
    });
  }
});

// View attendance history (Teacher/Admin only)
/**
 * Has this exact session already been marked?
 *
 * POST /mark upserts (ON CONFLICT DO UPDATE), so re-submitting silently
 * replaces an existing register with no indication that prior marks were
 * overwritten. This lets the client warn first — it reports what's already
 * recorded rather than deciding anything itself.
 */
router.get('/session-status', authorizePermission('ATTENDANCE_MARK'), async (req: any, res: Response) => {
  const { classId, date, period = 'Morning', sessionType = 'homeroom' } = req.query;
  const subjectId = req.query.subjectId ? Number(req.query.subjectId) : null;

  if (!classId || !date) {
    return res.status(400).json({ success: false, message: 'classId and date are required.' });
  }
  if (!DATE_RE.test(String(date))) {
    return res.status(400).json({ success: false, message: 'Invalid date. Expected YYYY-MM-DD.' });
  }

  try {
    const db = getDb();
    const row = await db.get(
      `SELECT COUNT(*) AS count, MAX(updated_at) AS last_marked, MAX(marked_by) AS marked_by
       FROM attendance_records
       WHERE class_id = ? AND session_date = ? AND period = ? AND session_type = ?
         AND (subject_id IS ? OR subject_id = ?)`,
      classId, date, period, sessionType, subjectId, subjectId
    );
    const count = row?.count ?? 0;
    let markedByName: string | null = null;
    if (count > 0 && row?.marked_by) {
      const actor = await db.get('SELECT name FROM users WHERE id = ?', row.marked_by);
      markedByName = actor?.name ?? null;
    }
    return res.json({
      success: true,
      data: { exists: count > 0, count, lastMarkedAt: row?.last_marked ?? null, markedByName },
    });
  } catch (error) {
    console.error('Error checking session status:', error);
    return res.status(500).json({ success: false, message: 'Could not check this session.' });
  }
});

router.get('/records', authorizePermission('ATTENDANCE_VIEW_ALL'), async (req: any, res: Response) => {
  const { classId, dateFrom, dateTo, search, status, sessionType, subjectId } = req.query;
  const db = getDb();
  const { academicTermId } = resolveAcademicPeriod(req as AuthenticatedRequest);

  let query = 'SELECT * FROM attendance_records WHERE 1=1';
  const params: any[] = [];

  if (academicTermId != null) {
    // Legacy rows (no academic_term_id recorded yet) stay visible under any period.
    query += ' AND (academic_term_id = ? OR academic_term_id IS NULL)';
    params.push(academicTermId);
  }
  if (classId) {
    query += ' AND class_id = ?';
    params.push(classId);
  }
  if (sessionType) {
    query += ' AND session_type = ?';
    params.push(sessionType);
  }
  if (subjectId) {
    query += ' AND subject_id = ?';
    params.push(subjectId);
  }
  if (status && status !== 'all') {
    query += ' AND status = ?';
    params.push(status);
  }
  if (dateFrom) {
    query += ' AND session_date >= ?';
    params.push(dateFrom);
  }
  if (dateTo) {
    query += ' AND session_date <= ?';
    params.push(dateTo);
  }
  if (search) {
    query += ' AND (student_name LIKE ? OR student_id LIKE ?)';
    params.push(`%${search}%`, `%${search}%`);
  }

  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 500);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

  try {
    const totalRow = await db.get(`SELECT COUNT(*) as count FROM (${query})`, ...params);
    const records = await db.all(
      `${query} ORDER BY session_date DESC, student_name ASC LIMIT ? OFFSET ?`,
      ...params, limit, offset
    );
    return res.json({
      success: true,
      data: records,
      total: totalRow.count,
    });
  } catch (error) {
    console.error('Error fetching attendance records:', error);
    return res.status(500).json({
      success: false,
      message: 'Error fetching attendance records.',
    });
  }
});

// Student's own attendance (Student only)
router.get('/me', authorizePermission('ATTENDANCE_VIEW_OWN'), async (req: any, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  const studentId = authReq.user!.id;
  const db = getDb();
  const { academicTermId } = resolveAcademicPeriod(authReq);

  try {
    // Homeroom-only: a student's "overall attendance" (A.1.1) is the homeroom
    // signal. Without this, a subject-session row (A.1.2) for the same day
    // would double-count against the same rate calculation client-side.
    const records = academicTermId != null
      ? await db.all(
          "SELECT * FROM attendance_records WHERE student_id = ? AND session_type = 'homeroom' AND (academic_term_id = ? OR academic_term_id IS NULL) ORDER BY session_date DESC",
          studentId, academicTermId
        )
      : await db.all(
          "SELECT * FROM attendance_records WHERE student_id = ? AND session_type = 'homeroom' ORDER BY session_date DESC",
          studentId
        );
    return res.json({
      success: true,
      data: records,
    });
  } catch (error) {
    console.error('Error fetching own attendance:', error);
    return res.status(500).json({
      success: false,
      message: 'Error fetching own attendance records.',
    });
  }
});

// Specific student's attendance (anyone with ATTENDANCE_VIEW_ALL, or the student themself)
router.get('/student/:id', selfOrPermission('id', 'ATTENDANCE_VIEW_ALL'), async (req: any, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  const studentId = req.params.id;

  const db = getDb();
  const { academicTermId } = resolveAcademicPeriod(authReq);
  try {
    // Homeroom-only, matching /me and the reports overview — otherwise a
    // student's own attendance rate and their instructor-facing StudentReport
    // rate would disagree once subject/course sessions are also recorded.
    const records = academicTermId != null
      ? await db.all(
          "SELECT * FROM attendance_records WHERE student_id = ? AND session_type = 'homeroom' AND (academic_term_id = ? OR academic_term_id IS NULL) ORDER BY session_date DESC",
          studentId, academicTermId
        )
      : await db.all(
          "SELECT * FROM attendance_records WHERE student_id = ? AND session_type = 'homeroom' ORDER BY session_date DESC",
          studentId
        );
    return res.json({
      success: true,
      data: records,
    });
  } catch (error) {
    console.error('Error fetching student attendance:', error);
    return res.status(500).json({
      success: false,
      message: 'Error fetching student attendance records.',
    });
  }
});

// Fetch student's own excuse requests
router.get('/excuses/me', authorizePermission('EXCUSES_VIEW_OWN'), async (req: any, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  const studentId = authReq.user!.id;
  const db = getDb();
  const { academicTermId } = resolveAcademicPeriod(authReq);

  try {
    const excuses = academicTermId != null
      ? await db.all(
          'SELECT * FROM excuse_requests WHERE student_id = ? AND (academic_term_id = ? OR academic_term_id IS NULL) ORDER BY created_at DESC',
          studentId, academicTermId
        )
      : await db.all(
          'SELECT * FROM excuse_requests WHERE student_id = ? ORDER BY created_at DESC',
          studentId
        );
    return res.json({
      success: true,
      data: excuses,
    });
  } catch (error) {
    console.error('Error fetching student excuses:', error);
    return res.status(500).json({
      success: false,
      message: 'Error fetching excuse requests.',
    });
  }
});

// Submit a new excuse request
router.post('/excuse', authorizePermission('EXCUSES_SUBMIT'), async (req: any, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  const studentId = authReq.user!.id;
  const studentName = authReq.user!.name;
  const { className, sessionDate, reason, description } = req.body;

  if (!className || !sessionDate || !reason) {
    return res.status(400).json({
      success: false,
      message: 'Missing required fields: className, sessionDate, reason.',
    });
  }
  if (!DATE_RE.test(String(sessionDate))) {
    return res.status(400).json({ success: false, message: 'Invalid sessionDate. Expected YYYY-MM-DD.' });
  }
  if (String(reason).length > 100 || String(className).length > 100 || String(description || '').length > 2000) {
    return res.status(400).json({ success: false, message: 'Input too long: reason/className max 100 chars, description max 2000.' });
  }

  const db = getDb();
  const { academicYearId, academicTermId } = resolveAcademicPeriod(authReq);
  try {
    const result = await db.run(
      `INSERT INTO excuse_requests (student_id, student_name, class_name, session_date, reason, description, status, academic_year_id, academic_term_id)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      studentId,
      studentName,
      className,
      sessionDate,
      reason,
      description || '',
      academicYearId ?? null,
      academicTermId ?? null
    );

    const inserted = await db.get('SELECT * FROM excuse_requests WHERE id = ?', result.lastID);

    return res.json({
      success: true,
      data: inserted,
      message: 'Excuse request submitted successfully.',
    });
  } catch (error: any) {
    console.error('Error submitting excuse:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Error submitting excuse request.',
    });
  }
});


// List excuse requests for review (Teacher/Admin only)
router.get('/excuses', authorizePermission('EXCUSES_REVIEW'), async (req: any, res: Response) => {
  const { status, search } = req.query;
  const db = getDb();
  const { academicTermId } = resolveAcademicPeriod(req as AuthenticatedRequest);

  let query = 'SELECT * FROM excuse_requests WHERE 1=1';
  const params: any[] = [];
  if (academicTermId != null) {
    query += ' AND (academic_term_id = ? OR academic_term_id IS NULL)';
    params.push(academicTermId);
  }
  if (status) { query += ' AND status = ?'; params.push(status); }
  if (search) {
    query += ' AND (student_name LIKE ? OR student_id LIKE ? OR class_name LIKE ?)';
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  // Pending first, then most recent.
  query += " ORDER BY (status = 'pending') DESC, created_at DESC";

  try {
    const excuses = await db.all(query, ...params);
    return res.json({ success: true, data: excuses });
  } catch (error) {
    console.error('Error fetching excuse requests:', error);
    return res.status(500).json({ success: false, message: 'Error fetching excuse requests.' });
  }
});

// Approve or reject an excuse request (Teacher/Admin only)
router.put('/excuse/:id/status', authorizePermission('EXCUSES_REVIEW'), async (req: any, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  const id = req.params.id;
  const { status } = req.body as { status?: string };

  if (status !== 'approved' && status !== 'rejected') {
    return res.status(400).json({ success: false, message: "Invalid status. Expected 'approved' or 'rejected'." });
  }

  const db = getDb();
  const actor = authReq.user!;

  try {
    const existing = await db.get('SELECT * FROM excuse_requests WHERE id = ?', id);
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Excuse request not found.' });
    }

    await db.run(
      'UPDATE excuse_requests SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      status, id
    );
    const updated = await db.get('SELECT * FROM excuse_requests WHERE id = ?', id);

    await recordAudit(db, actor, 'excuse.review', 'excuse_request', id, { from: existing.status, to: status });

    // Notify the student in-app + on external channels.
    await db.run(
      `INSERT INTO notifications (user_id, type, title, message) VALUES (?, 'system', ?, ?)`,
      existing.student_id,
      `Excuse ${status}`,
      `Your excuse for ${existing.class_name} on ${existing.session_date} was ${status}.`
    );
    await notifyUserExternal(
      db,
      existing.student_id,
      `Excuse request ${status}`,
      `Your excuse for ${existing.class_name} (${existing.session_date}) has been ${status} by ${actor.name}.`
    );

    return res.json({ success: true, data: updated, message: `Excuse ${status}.` });
  } catch (error: any) {
    console.error('Error reviewing excuse:', error);
    return res.status(500).json({ success: false, message: error.message || 'Error updating the excuse request.' });
  }
});

// Helper background logic to analyze attendance drop and push system alerts
async function triggerLowAttendanceCheck(
  classId: string,
  className: string,
  sessionType: string = 'homeroom',
  academicTermId?: number
) {
  const db = getDb();
  try {
    // Scoped to the term the session belongs to. Averaging over every term
    // ever recorded meant a student's past-term absences dragged their
    // current-term percentage down (and vice versa), so the 80% warning
    // fired against a figure shown nowhere in the UI. NULL term rows are
    // included when we have a term, matching the read paths' convention for
    // records written before period tracking existed.
    const stats = await db.all(
      `SELECT student_id, student_name,
              SUM(CASE WHEN status = 'present' THEN 1 ELSE 0 END) as present,
              COUNT(*) as total
       FROM attendance_records
       WHERE class_id = ? AND session_type = ?
         AND (? IS NULL OR academic_term_id = ? OR academic_term_id IS NULL)
       GROUP BY student_id`,
      classId, sessionType, academicTermId ?? null, academicTermId ?? null
    );

    for (const student of stats) {
      const percentage = (student.present / student.total) * 100;
      if (student.total >= 3 && percentage < 80) { // Notify if attendance drops below 80% (over at least 3 records)
        // Check if notification already pushed today to avoid spamming
        const alreadyNotified = await db.get(
          `SELECT id FROM notifications 
           WHERE user_id = ? AND type = 'low_attendance' AND title LIKE ? AND created_at >= date('now')`,
          student.student_id,
          `%Low Attendance Warning%`
        );

        if (!alreadyNotified) {
          await db.run(
            `INSERT INTO notifications (user_id, type, title, message) VALUES (?, 'low_attendance', ?, ?)`,
            student.student_id,
            `Low Attendance Warning (${percentage.toFixed(0)}%)`,
            `Your attendance in ${className} is currently ${percentage.toFixed(0)}% (${student.present}/${student.total} classes). Please contact your instructor.`
          );

          // Also reach the student on external channels (respects their preferences).
          await notifyUserExternal(
            db,
            student.student_id,
            `Low attendance in ${className}`,
            `Your attendance in ${className} has dropped to ${percentage.toFixed(0)}% (${student.present}/${student.total}). Please contact your instructor.`,
            { kind: 'absence' }
          );

          // Also notify admins/teachers
          await db.run(
            `INSERT INTO notifications (user_id, type, title, message) VALUES (?, 'low_attendance', ?, ?)`,
            'all',
            `Attendance Drop: ${student.student_name}`,
            `${student.student_name}'s attendance in ${className} has dropped to ${percentage.toFixed(0)}%.`
          );
        }
      }
    }
  } catch (err) {
    console.error('Error in triggerLowAttendanceCheck:', err);
  }
}

export default router;
