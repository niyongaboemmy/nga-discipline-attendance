import { Router, Response } from 'express';
import { getDb } from '../database.js';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth.js';
import { roleGuard } from '../middleware/roleGuard.js';
import { resolveAcademicPeriod } from '../utils/academicPeriod.js';

const router = Router();

router.use(authMiddleware);

// Clock In (Teachers & Admins)
router.post('/clock-in', roleGuard(['teacher', 'admin']), async (req: any, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  const staffId = authReq.user!.id;
  const staffName = authReq.user!.name;
  
  const today = new Date().toISOString().split('T')[0];
  const now = new Date().toISOString();
  
  // Decide if check-in is late (cutoff 8:30 AM)
  const cutoff = new Date();
  cutoff.setHours(8, 30, 0, 0);
  const status = new Date() > cutoff ? 'late' : 'present';

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
    await db.run(
      `INSERT INTO staff_attendance (staff_id, staff_name, date, clock_in, status, academic_year_id, academic_term_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      staffId,
      staffName,
      today,
      now,
      status,
      academicYearId ?? null,
      academicTermId ?? null
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
router.post('/clock-out', roleGuard(['teacher', 'admin']), async (req: any, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  const staffId = authReq.user!.id;
  const today = new Date().toISOString().split('T')[0];
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
router.get('/attendance/me', roleGuard(['teacher', 'admin']), async (req: any, res: Response) => {
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
router.get('/attendance', roleGuard(['admin']), async (req: any, res: Response) => {
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
