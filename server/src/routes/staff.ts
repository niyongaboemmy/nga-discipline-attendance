import { Router, Response } from 'express';
import { getDb } from '../database.js';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth.js';
import { authorizePermission } from '../middleware/authorize.js';
import { resolveAcademicPeriod } from '../utils/academicPeriod.js';
import { schoolDateString, schoolMinutesOfDay } from '../shared/schoolTime.js';

/** Staff are "late" if they clock in after this local time (minutes from midnight). */
const LATE_CUTOFF_MINUTES = Number(process.env.STAFF_LATE_CUTOFF_MINUTES || 8 * 60 + 30);

const router = Router();

router.use(authMiddleware);

// Clock In (Teachers & Admins)
router.post('/clock-in', authorizePermission('STAFF_ATTENDANCE_CLOCK'), async (req: any, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  const staffId = authReq.user!.id;
  const staffName = authReq.user!.name;
  
  // Remediation A15: "today" and the late cutoff are both evaluated in the
  // school's timezone, not a mix of UTC and server-local.
  const today = schoolDateString();
  const now = new Date().toISOString();
  const status = schoolMinutesOfDay() > LATE_CUTOFF_MINUTES ? 'late' : 'present';

  const db = getDb();
  try {
    const existing = await db.get(
      'SELECT id FROM staff_attendance WHERE staff_id = ? AND date = ?',
      staffId,
      today
    );

    if (existing) {
      return res.status(400).json({
        success: false,
        message: 'You have already clocked in today.',
      });
    }

    const { academicYearId, academicTermId } = resolveAcademicPeriod(authReq);

    // A.2 vs A.3: a staff member with any subject-calendar assignment this
    // term is a "teacher" for reporting purposes (their attendance is also
    // derivable from delivered subject sessions); everyone else is "other"
    // (simple daily clock, A.3).
    const hasSubjects = await db.get(
      `SELECT 1 FROM class_subject_assignments
       WHERE teacher_id = ? AND (academic_term_id = ? OR academic_term_id IS NULL) LIMIT 1`,
      staffId, academicTermId ?? null
    );
    const staffType = hasSubjects ? 'teacher' : 'other';

    await db.run(
      `INSERT INTO staff_attendance (staff_id, staff_name, date, clock_in, status, academic_year_id, academic_term_id, staff_type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      staffId,
      staffName,
      today,
      now,
      status,
      academicYearId ?? null,
      academicTermId ?? null,
      staffType
    );

    return res.json({
      success: true,
      message: `Clocked in successfully as ${status === 'late' ? 'LATE' : 'PRESENT'}.`,
      data: { clockIn: now, status },
    });
  } catch (error) {
    console.error('Error clocking in:', error);
    return res.status(500).json({
      success: false,
      message: 'Database error while clocking in.',
    });
  }
});

// Clock Out (Teachers & Admins)
router.post('/clock-out', authorizePermission('STAFF_ATTENDANCE_CLOCK'), async (req: any, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  const staffId = authReq.user!.id;
  const today = schoolDateString();
  const now = new Date().toISOString();

  const db = getDb();
  try {
    const existing = await db.get(
      'SELECT id, clock_in, clock_out FROM staff_attendance WHERE staff_id = ? AND date = ?',
      staffId,
      today
    );

    if (!existing) {
      return res.status(400).json({
        success: false,
        message: 'You must clock in first before clocking out.',
      });
    }

    if (existing.clock_out) {
      return res.status(400).json({
        success: false,
        message: 'You have already clocked out today.',
      });
    }

    await db.run(
      'UPDATE staff_attendance SET clock_out = ? WHERE id = ?',
      now,
      existing.id
    );

    return res.json({
      success: true,
      message: 'Clocked out successfully.',
      data: { clockOut: now },
    });
  } catch (error) {
    console.error('Error clocking out:', error);
    return res.status(500).json({
      success: false,
      message: 'Database error while clocking out.',
    });
  }
});

// Fetch own staff attendance (Teacher / Admin logs for themselves)
router.get('/attendance/me', authorizePermission('STAFF_ATTENDANCE_VIEW_OWN'), async (req: any, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  const staffId = authReq.user!.id;
  const { academicTermId } = resolveAcademicPeriod(authReq);

  const db = getDb();
  try {
    const records = academicTermId != null
      ? await db.all(
          'SELECT * FROM staff_attendance WHERE staff_id = ? AND (academic_term_id = ? OR academic_term_id IS NULL) ORDER BY date DESC',
          staffId, academicTermId
        )
      : await db.all(
          'SELECT * FROM staff_attendance WHERE staff_id = ? ORDER BY date DESC',
          staffId
        );
    return res.json({
      success: true,
      data: records,
    });
  } catch (error) {
    console.error('Error fetching own staff logs:', error);
    return res.status(500).json({
      success: false,
      message: 'Database error fetching staff logs.',
    });
  }
});

// Fetch all staff attendance (Admins only)
router.get('/attendance', authorizePermission('STAFF_ATTENDANCE_VIEW_ALL'), async (req: any, res: Response) => {
  const db = getDb();
  const { academicTermId } = resolveAcademicPeriod(req as AuthenticatedRequest);
  try {
    const records = academicTermId != null
      ? await db.all(
          'SELECT * FROM staff_attendance WHERE (academic_term_id = ? OR academic_term_id IS NULL) ORDER BY date DESC, staff_name ASC',
          academicTermId
        )
      : await db.all('SELECT * FROM staff_attendance ORDER BY date DESC, staff_name ASC');
    return res.json({
      success: true,
      data: records,
    });
  } catch (error) {
    console.error('Error fetching all staff logs:', error);
    return res.status(500).json({
      success: false,
      message: 'Database error fetching all staff logs.',
    });
  }
});

export default router;
