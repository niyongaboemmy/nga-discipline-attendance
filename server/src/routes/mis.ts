import { Router } from 'express';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth.js';
import { authorizePermission } from '../middleware/authorize.js';
import { resolveAcademicPeriod } from '../utils/academicPeriod.js';
import {
  misGetList,
  misGetListOrNull,
  misGetOrNullObject,
  sendMisError,
  requireMisToken,
} from '../services/misClient.js';

// Re-exported for routes/attendance.ts, which imports the MIS client helpers
// (and the curriculum helpers below) from this module.
export { misGetList };

/**
 * MIS roster proxy.
 *
 * Reads class groups, students, staff and timetables from the NGA Central
 * MIS on behalf of the signed-in user, forwarding that user's own MIS
 * access token so the MIS enforces its own authorization.
 *
 * IMPORTANT: forwarding the *end user's* token means we only get what that
 * user may read on the MIS, and most MIS endpoints are admin-gated.
 * Verified against the live MIS, a teacher or student token gets 403 on
 * `/users` (needs MANAGE_USERS) and `/calendar/slots` (needs calendar-admin
 * permissions) — which is why the Directory and schedule views failed for
 * everyone who isn't a MIS administrator. Each handler below therefore
 * prefers the richest endpoint the caller can actually read and degrades to
 * a permission-free equivalent, rather than hard-failing:
 *
 *   students  : /users?userRole=6  ->  per-class-group rosters
 *   staff     : /users             ->  /academics/teacher-assignments
 *   schedule  : role-specific calendar -> /calendar/slots
 *
 * The permission-free paths (/academics/*, /users/search) are readable by
 * any authenticated MIS user.
 */
const router = Router();

router.use(authMiddleware);
router.use(authorizePermission('ROSTER_VIEW'));

// MIS role_id for STUDENT (see nga_central_mis Role table).
const MIS_STUDENT_ROLE_ID = '6';

// Backend day_of_week convention (nga_central_mis calendarConstants.ts):
// 0=Sunday .. 6=Saturday (standard JS Date#getDay()).
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const fullName = (...parts: any[]) => parts.filter(Boolean).join(' ').trim();

/** Flat MIS person row (class-group roster, /users/search) -> {id,name,email}. */
function normalizeFlatPerson(s: any) {
  return {
    id: String(s.user_id ?? s.id),
    name: fullName(s.first_name, s.last_name) || s.username || 'Unknown',
    email: s.email || s.username || '',
  };
}

/** Nested { user, profile } record from GET /users -> {id,name,email}. */
function normalizeMisUser(entry: any) {
  const user = entry.user || entry;
  const profile = entry.profile || {};
  return {
    id: String(user.user_id ?? user.id),
    name:
      fullName(profile.first_name ?? user.first_name, profile.last_name ?? user.last_name) ||
      user.username ||
      'Unknown',
    email: user.email || user.username || '',
  };
}

function dedupeById<T extends { id: string }>(rows: T[]): T[] {
  const seen = new Map<string, T>();
  for (const row of rows) if (!seen.has(row.id)) seen.set(row.id, row);
  return [...seen.values()];
}

router.get('/classes', async (req: any, res) => {
  const misToken = requireMisToken(req, res);
  if (!misToken) return;
  try {
    const rows = await misGetList(misToken, '/academics/class-groups');
    const data = rows.map((c: any) => ({
      id: String(c.class_group_id ?? c.id),
      name: c.name,
      department: c.program_name || c.grade_name || '',
    }));
    res.json({ success: true, data });
  } catch (error) {
    sendMisError(res, '/academics/class-groups', error);
  }
});

/**
 * Subjects on a class group's grade curriculum.
 *
 * The subject picker used to list every subject in the school, so a teacher
 * could file "Advanced Database" attendance against a primary-school class.
 * A class group belongs to a grade, and the MIS models which subjects a
 * grade actually teaches, so scope the picker to that curriculum.
 */
router.get('/class-subjects', async (req: any, res) => {
  const misToken = requireMisToken(req, res);
  if (!misToken) return;
  const classId = req.query.class_id as string | undefined;
  if (!classId) {
    return res.status(400).json({ success: false, message: 'class_id is required.' });
  }

  try {
    const gradeId = await resolveGradeId(misToken, classId);
    if (gradeId == null) {
      return res.status(404).json({ success: false, message: 'That class group was not found.' });
    }
    const rows = await misGetList(
      misToken,
      `/academics/grades/${encodeURIComponent(String(gradeId))}/subjects`
    );
    const data = rows.map((s: any) => ({
      id: Number(s.subject_id),
      name: s.subject_name ?? s.name,
      code: s.subject_code ?? s.code ?? null,
    }));
    return res.json({ success: true, data });
  } catch (error) {
    sendMisError(res, '/academics/grades/:id/subjects', error);
  }
});

/** class_group_id -> grade_id, via the class-group list. */
export async function resolveGradeId(misToken: string, classId: string): Promise<number | null> {
  const classGroups = await misGetList(misToken, '/academics/class-groups');
  const match = classGroups.find(
    (c: any) => String(c.class_group_id ?? c.id) === String(classId)
  );
  const gradeId = match?.grade_id;
  return gradeId == null ? null : Number(gradeId);
}

/** True when `subjectId` is on `classId`'s grade curriculum. Used to reject
 *  mismatched subject/class pairs server-side, since the client picker is a
 *  convenience, not a guarantee. */
export async function isSubjectOnClassCurriculum(
  misToken: string,
  classId: string,
  subjectId: number
): Promise<boolean> {
  const gradeId = await resolveGradeId(misToken, classId);
  if (gradeId == null) return false;
  const rows = await misGetList(
    misToken,
    `/academics/grades/${encodeURIComponent(String(gradeId))}/subjects`
  );
  return rows.some((s: any) => Number(s.subject_id) === Number(subjectId));
}

router.get('/students', async (req: any, res) => {
  const misToken = requireMisToken(req, res);
  if (!misToken) return;
  const classId = req.query.class_id as string | undefined;

  // A class group is a permanent label reused every year, so its membership
  // accumulates one cohort per academic year. Scoping to the selected year
  // is what keeps Mark Attendance showing this year's students instead of a
  // previous cohort.
  const { academicYearId } = resolveAcademicPeriod(req as AuthenticatedRequest);
  const yearParam = academicYearId != null ? String(academicYearId) : undefined;

  try {
    if (classId) {
      // Roster for one class group (Mark Attendance). Permission-free.
      const rows = await misGetList(
        misToken,
        `/academics/class-groups/${encodeURIComponent(classId)}/students`,
        { academic_year_id: yearParam }
      );
      return res.json({ success: true, data: rows.map(normalizeFlatPerson) });
    }

    // School-wide list (Directory). Built from the per-year class-group
    // rosters so it reflects the selected academic year; /users is not
    // year-aware at all (it lists every account ever created), so it's only
    // a last resort when class-group data is unavailable.
    const classGroups = await misGetListOrNull(misToken, '/academics/class-groups');
    if (classGroups && classGroups.length > 0) {
      const rosters = await Promise.all(
        classGroups.map((c: any) =>
          misGetListOrNull(
            misToken,
            `/academics/class-groups/${encodeURIComponent(String(c.class_group_id ?? c.id))}/students`,
            { academic_year_id: yearParam }
          ).then((r) => r ?? [])
        )
      );
      return res.json({
        success: true,
        data: dedupeById(rosters.flat().map(normalizeFlatPerson)),
      });
    }

    const viaUsers = await misGetListOrNull(misToken, '/users', {
      userRole: MIS_STUDENT_ROLE_ID,
      limit: '1000',
    });
    return res.json({
      success: true,
      data: viaUsers ? dedupeById(viaUsers.map(normalizeMisUser)) : [],
    });
  } catch (error) {
    sendMisError(res, classId ? `/academics/class-groups/${classId}/students` : '/users', error);
  }
});

router.get('/staff', async (req: any, res) => {
  const misToken = requireMisToken(req, res);
  if (!misToken) return;
  try {
    // /users spans every staff role at once but needs MANAGE_USERS; the
    // teacher-assignment list is permission-free and names every teacher
    // actually assigned to teach something.
    const viaUsers = await misGetListOrNull(misToken, '/users', { limit: '1000' });
    if (viaUsers) {
      const staffOnly = viaUsers.filter(
        (entry: any) =>
          !(entry.roles || []).some((r: any) => String(r.name).toUpperCase() === 'STUDENT')
      );
      return res.json({ success: true, data: dedupeById(staffOnly.map(normalizeMisUser)) });
    }

    const assignments = await misGetList(misToken, '/academics/teacher-assignments');
    const staff = dedupeById(
      assignments.map((a: any) => ({
        id: String(a.user_id),
        name: a.teacher_name || a.teacher_username || 'Unknown',
        email: a.teacher_username || '',
      }))
    );
    return res.json({ success: true, data: staff });
  } catch (error) {
    sendMisError(res, '/users', error);
  }
});

router.get('/schedule', async (req: any, res) => {
  const misToken = requireMisToken(req, res);
  if (!misToken) return;
  const classId = req.query.class_id as string | undefined;
  const role = (req as AuthenticatedRequest).user?.role;

  try {
    // The user's selected term, not the MIS's globally-current one -- this
    // used to call resolveCurrentAcademicPeriod(misToken), so switching the
    // period in the top bar left the timetable showing the current term.
    const { academicTermId } = resolveAcademicPeriod(req as AuthenticatedRequest);
    const termId = academicTermId != null ? String(academicTermId) : undefined;

    // /calendar/slots is the admin-wide view and 403s for teachers and
    // students; each role has its own permitted calendar endpoint, which
    // returns { slots, upcoming, term_id } rather than a bare array.
    let slots: any[] | null = null;
    if (role === 'student') {
      const own = await misGetOrNullObject(misToken, '/calendar/student-calendar', {
        academic_term_id: termId,
      });
      slots = own?.slots ?? null;
    } else if (role === 'teacher') {
      const own = await misGetOrNullObject(misToken, '/calendar/my-calendar', {
        academic_term_id: termId,
        class_group_id: classId,
      });
      slots = own?.slots ?? null;
    }
    if (slots === null) {
      slots =
        (await misGetListOrNull(misToken, '/calendar/slots', {
          class_group_id: classId,
          academic_term_id: termId,
        })) ?? [];
    }

    const byDay = new Map<number, any[]>();
    for (const slot of slots) {
      const day = Number(slot.day_of_week);
      if (Number.isNaN(day)) continue;
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day)!.push({
        time:
          slot.start_time && slot.end_time
            ? `${slot.start_time} - ${slot.end_time}`
            : slot.start_time || '',
        subject: slot.subject_name || 'Subject',
        room: slot.location || '',
        teacher: fullName(slot.instructor_name, slot.instructor_lastname),
      });
    }

    const data = [...byDay.keys()]
      .sort((a, b) => a - b)
      .map((day) => ({
        day: DAY_NAMES[day] ?? `Day ${day}`,
        periods: byDay.get(day)!.sort((a, b) => a.time.localeCompare(b.time)),
      }));

    res.json({ success: true, data });
  } catch (error) {
    sendMisError(res, '/calendar', error);
  }
});

export default router;
