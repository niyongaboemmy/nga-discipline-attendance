import { Router, Response } from 'express';
import { getDb } from '../../database.js';
import { authMiddleware, AuthenticatedRequest } from '../../middleware/auth.js';
import { authorizePermission, selfOrPermission } from '../../middleware/authorize.js';
import { resolveAcademicPeriod } from '../../utils/academicPeriod.js';
import { clampPagination } from '../../shared/pagination.js';

/**
 * Subject/course attendance (A.1.2) and teacher subject-calendar delivery
 * (A.2). Mounted at /api/attendance alongside routes/attendance.ts.
 */
const router = Router();
router.use(authMiddleware);

// A.1.2 — course attendance for one subject, scoped by class group + term.
router.get('/subject/:subjectId', authorizePermission('ATTENDANCE_VIEW_ALL'), async (req: any, res: Response) => {
  const db = getDb();
  const subjectId = Number(req.params.subjectId);
  const { classId } = req.query;
  const { academicTermId } = resolveAcademicPeriod(req as AuthenticatedRequest);
  const { limit, offset } = clampPagination(req.query, { defaultLimit: 50, maxLimit: 500 });

  let where = " WHERE session_type = 'subject' AND subject_id = ?";
  const params: any[] = [subjectId];
  if (classId) { where += ' AND class_id = ?'; params.push(classId); }
  if (academicTermId != null) { where += ' AND (academic_term_id = ? OR academic_term_id IS NULL)'; params.push(academicTermId); }

  try {
    const totalRow = await db.get(`SELECT COUNT(*) as count FROM attendance_records${where}`, ...params);
    const records = await db.all(
      `SELECT * FROM attendance_records${where} ORDER BY session_date DESC, student_name ASC LIMIT ? OFFSET ?`,
      ...params, limit, offset
    );
    return res.json({ success: true, data: records, total: totalRow.count });
  } catch (error) {
    console.error('Error fetching subject attendance:', error);
    return res.status(500).json({ success: false, message: 'Error fetching subject attendance records.' });
  }
});

/**
 * A.2 — a teacher's subject-calendar delivery rate for a given day: how many
 * of their scheduled class_subject_assignments sessions actually got
 * attendance submitted. This is a derived read, not a second write path —
 * "did the teacher show up" is inferred from whether they logged the
 * subject-session's attendance, kept alongside (not instead of) their plain
 * on-campus clock-in/out in staff_attendance.
 */
router.get('/teachers/:id/delivery', selfOrPermission('id', 'STAFF_ATTENDANCE_VIEW_ALL'), async (req: any, res: Response) => {
  const db = getDb();
  const teacherId = req.params.id;
  const date = String(req.query.date || new Date().toISOString().split('T')[0]);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ success: false, message: 'Invalid date. Expected YYYY-MM-DD.' });
  }
  const { academicTermId } = resolveAcademicPeriod(req as AuthenticatedRequest);
  // JS getDay(): 0=Sunday..6=Saturday, matching the day_of_week convention
  // used when class_subject_assignments rows are synced from the MIS schedule.
  const dayOfWeek = new Date(`${date}T00:00:00Z`).getUTCDay();

  try {
    let scheduledQuery = `SELECT * FROM class_subject_assignments WHERE teacher_id = ? AND day_of_week = ?`;
    const scheduledParams: any[] = [teacherId, dayOfWeek];
    if (academicTermId != null) { scheduledQuery += ' AND (academic_term_id = ? OR academic_term_id IS NULL)'; scheduledParams.push(academicTermId); }

    // Matched on class+subject only, not period: MarkAttendance.tsx's period
    // is a free-text label ('Morning'/'Afternoon'/'Evening') while
    // class_subject_assignments.period is whatever slot format the MIS
    // schedule uses — the two vocabularies aren't guaranteed to line up, so
    // including period in the key made every match fail and deliveryRate
    // report 0% regardless of what the teacher actually submitted.
    const [scheduled, delivered] = await Promise.all([
      db.all(scheduledQuery, ...scheduledParams),
      db.all(
        `SELECT DISTINCT class_id, subject_id FROM attendance_records
         WHERE marked_by = ? AND session_date = ? AND session_type = 'subject'`,
        teacherId, date
      ),
    ]);
    const deliveredKeys = new Set(delivered.map((d: any) => `${d.class_id}|${d.subject_id}`));

    const sessions = scheduled.map((s: any) => ({
      classId: s.class_id,
      className: s.class_name,
      subjectId: s.subject_id,
      subjectName: s.subject_name,
      period: s.period,
      delivered: deliveredKeys.has(`${s.class_id}|${s.subject_id}`),
    }));

    const deliveredCount = sessions.filter((s) => s.delivered).length;

    return res.json({
      success: true,
      data: {
        date,
        scheduledCount: sessions.length,
        deliveredCount,
        deliveryRate: sessions.length > 0 ? Math.round((deliveredCount / sessions.length) * 100) : null,
        sessions,
      },
    });
  } catch (error) {
    console.error('Error computing teacher delivery rate:', error);
    return res.status(500).json({ success: false, message: 'Error computing teacher delivery rate.' });
  }
});

export default router;
