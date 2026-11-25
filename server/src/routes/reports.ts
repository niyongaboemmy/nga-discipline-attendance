import { Router, Response } from 'express';
import { getDb } from '../database.js';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth.js';
import { authorizePermission } from '../middleware/authorize.js';
import { resolveAcademicPeriod } from '../utils/academicPeriod.js';
import { fetchClassTeacherClasses } from '../services/misClient.js';
import { attendanceComment } from '../modules/reporting/attendanceReport.service.js';
import { ATTENDED_SQL_CASE, attendanceRate, attendanceWarnThreshold } from '../shared/attendancePolicy.js';
import { reportableAttendanceSql } from '../shared/attendanceScope.js';
import { schoolDateString } from '../shared/schoolTime.js';
import { accessScope, allowedStudents, shadowListLeak } from '../access/policy.js';

const router = Router();

/** A transparent, explainable projection -- ordinary least-squares slope
 *  through the recent daily rates, extrapolated to the end of the current
 *  term (or a fixed 14-day horizon when the term's end date isn't known).
 *  Deliberately not a "smart"/ML model: a teacher needs to be able to see
 *  *why* the number is what it is (it's just "the trend, continued"), not
 *  trust a black box. Returns null when there's too little data to mean
 *  anything (fewer than 3 days recorded). */
function computeProjection(
  trendStats: Array<{ date: string; rate: number }>,
  termEndDate: string | null
): { projectedRate: number; horizonDays: number; horizonLabel: string; direction: 'up' | 'down' | 'flat' } | null {
  if (trendStats.length < 3) return null;

  const n = trendStats.length;
  const xs = trendStats.map((_, i) => i);
  const ys = trendStats.map((t) => t.rate);
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (xs[i] - meanX) * (ys[i] - meanY); den += (xs[i] - meanX) ** 2; }
  const slope = den === 0 ? 0 : num / den;

  const today = new Date();
  let horizonDays = 14;
  let horizonLabel = 'in the next 2 weeks';
  if (termEndDate) {
    const end = new Date(`${termEndDate}T00:00:00`);
    const diffDays = Math.round((end.getTime() - today.getTime()) / 86400000);
    if (diffDays > 0) { horizonDays = diffDays; horizonLabel = 'by end of term'; }
  }

  const lastValue = ys[n - 1];
  const projectedRate = Math.max(0, Math.min(100, Math.round(lastValue + slope * horizonDays)));
  const direction = Math.abs(slope) < 0.15 ? 'flat' : slope > 0 ? 'up' : 'down';
  return { projectedRate, horizonDays, horizonLabel, direction };
}

router.use(authMiddleware);

// Get overview analytics stats (Teacher & Admin only)
router.get('/overview', authorizePermission('REPORTS_VIEW'), async (req: any, res: Response) => {
  const db = getDb();
  // The school's date, not UTC: just after midnight in Kigali the UTC date is
  // still yesterday, so "today" showed the previous day's register.
  const today = schoolDateString();
  const authReq = req as AuthenticatedRequest;
  const { academicTermId, academicYearId } = resolveAcademicPeriod(authReq);

  // A class teacher (the MIS's own UserGrade assignment, not merely
  // teaching a lesson there) gets the Dashboard's personal view scoped to
  // their own class -- but this same endpoint also backs the /reports page,
  // which is explicitly "school-wide" for both admins and teachers, so the
  // scoping is opt-in (?scope=me) rather than automatic: only Dashboard.tsx
  // asks for it. Anyone without such an assignment (a subject-only teacher,
  // an admin) gets the unscoped view regardless, same as before either way.
  const wantsOwnScope = req.query.scope === 'me';
  const myClasses = wantsOwnScope && authReq.user?.misToken
    ? await fetchClassTeacherClasses(authReq.user.misToken, authReq.user.id, academicYearId).catch(() => [])
    : [];
  const scopedClassIds = myClasses.map((c) => c.id);
  const isClassTeacher = scopedClassIds.length > 0;
  const classScopeClause = isClassTeacher ? ` AND class_id IN (${scopedClassIds.map(() => '?').join(',')})` : '';
  const classScopeParams = isClassTeacher ? scopedClassIds : [];

  // Scoped to homeroom sessions only — since attendance_records can now also
  // hold subject/course rows (A.1.2) for the same student/date, an unscoped
  // query here would double-count a student who was marked for both a
  // homeroom and a subject session on the same day. "Overall attendance"
  // (A.1.1) is the homeroom signal; the separate `subjects` summary below
  // covers A.1.2.
  // Every number below counts the same rows: this term's registers (untermed
  // rows by date, not in every term), students still active and still in the
  // class (shared/attendanceScope.ts).
  const reportable = reportableAttendanceSql(academicTermId);
  const periodFilter = reportable.sql + " AND session_type = 'homeroom'" + classScopeClause;
  const periodParams = [...reportable.params, ...classScopeParams];

  try {
    // 1. Total records logged overall (within the selected academic period)
    const overallCount = await db.get(
      `SELECT
         COUNT(*) as total,
         SUM(${ATTENDED_SQL_CASE}) as attended
       FROM attendance_records WHERE 1=1${periodFilter}`,
      ...periodParams
    );

    // Attended = present + late + excused (shared/attendancePolicy.ts), the
    // same rule as the student's own page and the low-attendance warning. This
    // used to count present + late only, so every excused absence lowered the
    // dashboard rate but not the student's.
    const overallRate = attendanceRate(overallCount.attended, overallCount.total);

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

    // 3. Class-by-class attendance rates (for a class teacher this is just
    // their own assigned class(es) -- see `scope`)
    const classRates = await db.all(
      `SELECT
         class_id,
         class_name,
         COUNT(*) as total,
         COUNT(DISTINCT student_id) as students,
         SUM(${ATTENDED_SQL_CASE}) as attended
       FROM attendance_records
       WHERE 1=1${periodFilter}
       GROUP BY class_id`,
      ...periodParams
    );

    const classStats = classRates.map((c) => ({
      classId: c.class_id,
      className: c.class_name,
      rate: attendanceRate(c.attended, c.total),
      totalCount: c.total,
      studentCount: c.students,
    }));

    // 3b. A distinct headcount, not a sum of attendance records (a student
    // marked on 20 different days is one student, not 20).
    const distinctStudents = await db.get(
      `SELECT COUNT(DISTINCT student_id) as n FROM attendance_records WHERE 1=1${periodFilter}`,
      ...periodParams
    );

    // 3c. How many of this class's students are below the at-risk bar this
    // term -- the number behind the dashboard's judgement banner.
    const atRiskCount = isClassTeacher
      ? (await db.all(
          `SELECT student_id,
             SUM(CASE WHEN status IN ('present','late','excused') THEN 1 ELSE 0 END) as attended,
             COUNT(*) as total
           FROM attendance_records WHERE 1=1${periodFilter} GROUP BY student_id`,
          ...periodParams
        )).filter((s) => s.total > 0 && attendanceRate(s.attended, s.total) < attendanceWarnThreshold()).length
      : null;

    // 4. Daily attendance rate over the last 14 sessions (for the trend
    // chart and the projection below -- 7 was too thin a base to fit a
    // trend line through).
    const trends = await db.all(
      `SELECT
         session_date as date,
         COUNT(*) as total,
         SUM(${ATTENDED_SQL_CASE}) as attended
       FROM attendance_records
       WHERE 1=1${periodFilter}
       GROUP BY session_date
       ORDER BY session_date DESC
       LIMIT 14`,
      ...periodParams
    );

    const trendStats = trends.reverse().map((t) => ({
      date: t.date,
      rate: attendanceRate(t.attended, t.total),
    }));

    const termEndRow = academicTermId != null
      ? await db.get<{ end_date: string | null }>(`SELECT end_date FROM academic_terms WHERE id = ?`, academicTermId)
      : undefined;
    const projection = computeProjection(trendStats, termEndRow?.end_date ?? null);

    // 5. Recent activity log
    const recentActivity = await db.all(
      `SELECT
         student_id, student_name, class_name, session_date, status, updated_at
       FROM attendance_records
       WHERE 1=1${periodFilter}
       ORDER BY updated_at DESC
       LIMIT 5`,
      ...periodParams
    );

    // 6. Subjects summary — the A.1.2 counterpart to the homeroom numbers
    // above, rolled up across every subject session recorded for this
    // scope this term. Whole-school (unscoped) for anyone who isn't a
    // class teacher, same as everything else on this endpoint.
    const subjectPeriodFilter = reportable.sql + " AND session_type = 'subject'" + classScopeClause;
    const subjectPeriodParams = [...reportable.params, ...classScopeParams];
    const subjectCount = await db.get(
      `SELECT
         COUNT(*) as total,
         SUM(${ATTENDED_SQL_CASE}) as attended,
         COUNT(DISTINCT subject_id) as subjectCount,
         COUNT(DISTINCT student_id) as studentsTracked
       FROM attendance_records WHERE 1=1${subjectPeriodFilter}`,
      ...subjectPeriodParams
    );
    const subjectsSummary = {
      rate: subjectCount.total > 0 ? attendanceRate(subjectCount.attended, subjectCount.total) : null,
      total: subjectCount.total || 0,
      subjectCount: subjectCount.subjectCount || 0,
      studentsTracked: subjectCount.studentsTracked || 0,
    };

    return res.json({
      success: true,
      data: {
        scope: isClassTeacher
          ? { isClassTeacher: true, classIds: scopedClassIds, classNames: myClasses.map((c) => c.name) }
          : { isClassTeacher: false },
        projection,
        overallRate,
        overallComment: attendanceComment(overallRate),
        atRiskCount,
        atRiskThreshold: attendanceWarnThreshold(),
        totalStudentsTracked: distinctStudents?.n || 0,
        today: {
          total: todayCount.total || 0,
          present: todayCount.present || 0,
          absent: todayCount.absent || 0,
          late: todayCount.late || 0,
          excused: todayCount.excused || 0,
        },
        classes: classStats,
        subjectsSummary,
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
  const reportable = reportableAttendanceSql(academicTermId);
  const periodFilter = reportable.sql + " AND session_type = 'homeroom'";
  const periodParams = reportable.params;

  try {
    let stats = await db.all(
      `SELECT
         student_id, MAX(student_name) as student_name,
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

    // Access control v2: per-student rows need ATTENDANCE_VIEW_ALL at detail
    // for the student (class group = this class). Enforce filters; shadow
    // counts what would be hidden.
    const classGroupId = Number.isInteger(Number(classId)) ? Number(classId) : null;
    const v2 = await accessScope(req, 'ATTENDANCE_VIEW_ALL', 'detail');
    if (!v2.unrestricted) {
      const ids = stats.map((r: any) => String(r.student_id));
      const ok = v2.scope
        ? await allowedStudents(req, v2.snapshot, 'ATTENDANCE_VIEW_ALL', 'detail', ids, new Map(ids.map((id: string) => [id, classGroupId])))
        : new Set<string>();
      stats = stats.filter((r: any) => ok.has(String(r.student_id)));
    } else {
      shadowListLeak(req, 'ATTENDANCE_VIEW_ALL', 'detail', stats.map((r: any) => ({ studentId: r.student_id, classGroupId })));
    }

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
