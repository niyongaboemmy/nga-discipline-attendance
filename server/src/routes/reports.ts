import { Router, Response } from 'express';
import { getDb } from '../database.js';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth.js';
import { authorizePermission } from '../middleware/authorize.js';
import { resolveAcademicPeriod } from '../utils/academicPeriod.js';

const router = Router();

router.use(authMiddleware);

// Get overview analytics stats (Teacher & Admin only)
router.get('/overview', authorizePermission('REPORTS_VIEW'), async (req: any, res: Response) => {
  const db = getDb();
  const today = new Date().toISOString().split('T')[0];
  const { academicTermId } = resolveAcademicPeriod(req as AuthenticatedRequest);
  // Scoped to homeroom sessions only — since attendance_records can now also
  // hold subject/course rows (A.1.2) for the same student/date, an unscoped
  // query here would double-count a student who was marked for both a
  // homeroom and a subject session on the same day. "Overall attendance"
  // (A.1.1) is the homeroom signal; subject-level rates live behind
  // /api/attendance/subject/:subjectId instead.
  const periodFilter = (academicTermId != null ? ' AND (academic_term_id = ? OR academic_term_id IS NULL)' : '') + " AND session_type = 'homeroom'";
  const periodParams = academicTermId != null ? [academicTermId] : [];

  try {
    // 1. Total records logged overall (within the selected academic period)
    const overallCount = await db.get(
      `SELECT
         COUNT(*) as total,
         SUM(CASE WHEN status = 'present' OR status = 'late' THEN 1 ELSE 0 END) as present
       FROM attendance_records WHERE 1=1${periodFilter}`,
      ...periodParams
    );

    const overallRate = overallCount.total > 0
      ? Math.round((overallCount.present / overallCount.total) * 100)
      : 100;

    // 2. Statistics for today
    const todayCount = await db.get(
      `SELECT
         COUNT(*) as total,
         SUM(CASE WHEN status = 'present' THEN 1 ELSE 0 END) as present,
         SUM(CASE WHEN status = 'absent' THEN 1 ELSE 0 END) as absent,
         SUM(CASE WHEN status = 'late' THEN 1 ELSE 0 END) as late,
         SUM(CASE WHEN status = 'excused' THEN 1 ELSE 0 END) as excused
       FROM attendance_records
       WHERE session_date = ?${periodFilter}`,
      today, ...periodParams
    );

    // 3. Class-by-class attendance rates
    const classRates = await db.all(
      `SELECT
         class_id,
         class_name,
         COUNT(*) as total,
         SUM(CASE WHEN status = 'present' OR status = 'late' THEN 1 ELSE 0 END) as present
       FROM attendance_records
       WHERE 1=1${periodFilter}
       GROUP BY class_id`,
      ...periodParams
    );

    const classStats = classRates.map((c) => ({
      classId: c.class_id,
      className: c.class_name,
      rate: c.total > 0 ? Math.round((c.present / c.total) * 100) : 100,
      totalCount: c.total
    }));

    // 4. Daily attendance rate over the last 7 sessions (for trend charts)
    const trends = await db.all(
      `SELECT
         session_date as date,
         COUNT(*) as total,
         SUM(CASE WHEN status = 'present' OR status = 'late' THEN 1 ELSE 0 END) as present
       FROM attendance_records
       WHERE 1=1${periodFilter}
       GROUP BY session_date
       ORDER BY session_date DESC
       LIMIT 7`,
      ...periodParams
    );

    const trendStats = trends.reverse().map((t) => ({
      date: t.date,
      rate: t.total > 0 ? Math.round((t.present / t.total) * 100) : 100,
    }));

    // 5. Recent activity log
    const recentActivity = await db.all(
      `SELECT
         student_name, class_name, session_date, status, updated_at
       FROM attendance_records
       WHERE 1=1${periodFilter}
       ORDER BY updated_at DESC
       LIMIT 5`,
      ...periodParams
    );

    return res.json({
      success: true,
      data: {
        overallRate,
        totalStudentsTracked: classRates.reduce((sum, c) => sum + c.total, 0), // approximate
        today: {
          total: todayCount.total || 0,
          present: todayCount.present || 0,
          absent: todayCount.absent || 0,
          late: todayCount.late || 0,
          excused: todayCount.excused || 0,
        },
        classes: classStats,
        trends: trendStats,
        recentActivity
      }
    });
  } catch (error) {
    console.error('Error generating reports overview:', error);
    return res.status(500).json({
      success: false,
      message: 'Database error generating reports overview.',
    });
  }
});

// Class level reports
router.get('/class/:id', authorizePermission('REPORTS_VIEW'), async (req: any, res: Response) => {
  const classId = req.params.id;
  const db = getDb();
  const { academicTermId } = resolveAcademicPeriod(req as AuthenticatedRequest);
  // Same homeroom-only scoping as /overview — see comment there.
  const periodFilter = (academicTermId != null ? ' AND (academic_term_id = ? OR academic_term_id IS NULL)' : '') + " AND session_type = 'homeroom'";
  const periodParams = academicTermId != null ? [academicTermId] : [];

  try {
    const stats = await db.all(
      `SELECT
         student_id, student_name,
         COUNT(*) as total,
         SUM(CASE WHEN status = 'present' THEN 1 ELSE 0 END) as present,
         SUM(CASE WHEN status = 'absent' THEN 1 ELSE 0 END) as absent,
         SUM(CASE WHEN status = 'late' THEN 1 ELSE 0 END) as late,
         SUM(CASE WHEN status = 'excused' THEN 1 ELSE 0 END) as excused
       FROM attendance_records
       WHERE class_id = ?${periodFilter}
       GROUP BY student_id
       ORDER BY student_name ASC`,
      classId, ...periodParams
    );

    return res.json({
      success: true,
      data: stats,
    });
  } catch (error) {
    console.error('Error fetching class reports:', error);
    return res.status(500).json({
      success: false,
      message: 'Database error fetching class reports.',
    });
  }
});

export default router;
