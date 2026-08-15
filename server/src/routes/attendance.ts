import { Router, Response } from 'express';
import { getDb } from '../database.js';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth.js';
import { roleGuard } from '../middleware/roleGuard.js';
import { recordAudit } from '../utils/conduct.js';
import { notifyUserExternal } from '../utils/notifier.js';
import { resolveAcademicPeriod } from '../utils/academicPeriod.js';

const router = Router();

const ATTENDANCE_STATUSES = ['present', 'absent', 'late', 'excused'] as const;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Apply auth check on all attendance routes
router.use(authMiddleware);

// Mark attendance (Teacher/Admin only)
router.post('/mark', roleGuard(['teacher', 'admin']), async (req: any, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  const { classId, className, date, period = 'Morning', records } = req.body;

  if (!classId || !className || !date || !records || !Array.isArray(records)) {
    return res.status(400).json({
      success: false,
      message: 'Invalid payload. Missing classId, className, date, or records array.',
    });
  }
  if (!DATE_RE.test(String(date))) {
    return res.status(400).json({ success: false, message: 'Invalid date. Expected YYYY-MM-DD.' });
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
         (student_id, student_name, class_id, class_name, session_date, period, status, notes, marked_by, academic_year_id, academic_term_id, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(student_id, class_id, session_date, period) DO UPDATE SET
           status = excluded.status,
           notes = excluded.notes,
           marked_by = excluded.marked_by,
           updated_at = CURRENT_TIMESTAMP`,
        studentId,
        studentName,
        classId,
        className,
        date,
        period,
        status,
        notes,
        teacherId,
        academicYearId ?? null,
        academicTermId ?? null
      );
    }

    await db.run('COMMIT');

    // Trigger low attendance notification evaluation in background
    triggerLowAttendanceCheck(classId, className);

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
router.get('/records', roleGuard(['teacher', 'admin']), async (req: any, res: Response) => {
  const { classId, dateFrom, dateTo, search, status } = req.query;
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
router.get('/me', roleGuard(['student']), async (req: any, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  const studentId = authReq.user!.id;
  const db = getDb();
  const { academicTermId } = resolveAcademicPeriod(authReq);

  try {
    const records = academicTermId != null
      ? await db.all(
          'SELECT * FROM attendance_records WHERE student_id = ? AND (academic_term_id = ? OR academic_term_id IS NULL) ORDER BY session_date DESC',
          studentId, academicTermId
        )
      : await db.all(
          'SELECT * FROM attendance_records WHERE student_id = ? ORDER BY session_date DESC',
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

// Specific student's attendance (Teacher/Admin, or the student themself)
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
          'SELECT * FROM attendance_records WHERE student_id = ? AND (academic_term_id = ? OR academic_term_id IS NULL) ORDER BY session_date DESC',
          studentId, academicTermId
        )
      : await db.all(
          'SELECT * FROM attendance_records WHERE student_id = ? ORDER BY session_date DESC',
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
router.get('/excuses/me', roleGuard(['student']), async (req: any, res: Response) => {
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
router.post('/excuse', roleGuard(['student']), async (req: any, res: Response) => {
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
router.get('/excuses', roleGuard(['teacher', 'admin']), async (req: any, res: Response) => {
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
router.put('/excuse/:id/status', roleGuard(['teacher', 'admin']), async (req: any, res: Response) => {
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
async function triggerLowAttendanceCheck(classId: string, className: string) {
  const db = getDb();
  try {
    // Select all students and count their presence vs absence
    const stats = await db.all(
      `SELECT student_id, student_name,
              SUM(CASE WHEN status = 'present' THEN 1 ELSE 0 END) as present,
              COUNT(*) as total
       FROM attendance_records 
       WHERE class_id = ? 
       GROUP BY student_id`,
      classId
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
