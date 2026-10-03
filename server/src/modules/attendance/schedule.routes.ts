import { Router, Response } from 'express';
import { getDb } from '../../database.js';
import { authMiddleware, AuthenticatedRequest } from '../../middleware/auth.js';
import { authorizePermission } from '../../middleware/authorize.js';
import { resolveLiveAcademicPeriod } from '../../utils/academicPeriod.js';
import { misGetOrNullObject, misGetListOrNull, fetchClassTeacherClasses } from '../../services/misClient.js';
import {
  schoolDateString,
  schoolMinutesOfDay,
  dayOfWeekFor,
  timeToMinutes,
  periodForTime,
  weekStartFor,
  addDays,
} from '../../shared/schoolTime.js';
import { DATE_RE } from '../../shared/validation.js';

/**
 * Calendar-driven attendance — the timetable *is* the to-do list.
 *
 * These routes turn the MIS calendar (per-teacher `my-calendar`, per-student
 * `student-calendar`, admin-wide `calendar/slots`) into concrete "sessions to
 * record" for a given day/week, each annotated with whether its register has
 * been taken locally. The client "Today" and "Schedule" pages render straight
 * off this.
 *
 * Mounted at /api/attendance (see app.ts) — paths are namespaced under
 * /schedule to stay clear of routes/attendance.ts.
 */
const router = Router();
router.use(authMiddleware);

type Status = 'present' | 'absent' | 'late' | 'excused';
type SessionStatus = 'recorded' | 'missing';

interface Slot {
  slotId: number | null;
  subjectId: number | null;
  subjectName: string | null;
  subjectCode: string | null;
  color: string | null;
  classId: string;
  className: string;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  room: string;
  teacherId: number | null;
  teacherName: string | null;
}

const HOMEROOM_PERIOD = process.env.HOMEROOM_PERIOD || 'Morning';

const str = (v: unknown): string | undefined =>
  v == null || v === '' ? undefined : String(v);

/** Pull the signed-in user's weekly timetable from the MIS, normalised.
 *  Prefers the role-scoped endpoint, falls back to the admin-wide one. */
async function fetchTimetable(
  req: AuthenticatedRequest,
  termId: string | undefined,
  classId?: string
): Promise<{ slots: Slot[]; source: 'mis' | 'none' }> {
  const misToken = req.user?.misToken;
  if (!misToken) return { slots: [], source: 'none' };
  const role = req.user?.role;

  let raw: any[] | null = null;
  if (role === 'student') {
    const own = await misGetOrNullObject(misToken, '/calendar/student-calendar', {
      academic_term_id: termId,
    });
    raw = own?.slots ?? null;
  } else {
    const own = await misGetOrNullObject(misToken, '/calendar/my-calendar', {
      academic_term_id: termId,
      class_group_id: classId,
    });
    raw = own?.slots ?? null;
  }
  if (raw === null) {
    raw =
      (await misGetListOrNull(misToken, '/calendar/slots', {
        class_group_id: classId,
        academic_term_id: termId,
      })) ?? [];
  }

  const slots: Slot[] = (raw ?? [])
    .filter((s: any) => s && s.start_time && s.day_of_week != null)
    .map((s: any) => ({
      slotId: s.slot_id != null ? Number(s.slot_id) : null,
      subjectId: s.subject_id != null ? Number(s.subject_id) : null,
      subjectName: s.subject_name ?? null,
      subjectCode: s.subject_code ?? null,
      color: s.color ?? null,
      classId: String(s.class_group_id ?? ''),
      className: s.class_group_name || s.class_name || 'Class',
      dayOfWeek: Number(s.day_of_week),
      startTime: String(s.start_time).slice(0, 5),
      endTime: s.end_time ? String(s.end_time).slice(0, 5) : '',
      room: s.location || '',
      teacherId: s.user_id != null ? Number(s.user_id) : null,
      teacherName: [s.instructor_name, s.instructor_lastname].filter(Boolean).join(' ') || null,
    }))
    .filter((s: Slot) => s.classId);

  return { slots, source: 'mis' };
}

interface Agg {
  present: number;
  absent: number;
  late: number;
  excused: number;
  total: number;
  lastMarkedAt: string | null;
  markedBy: string | null;
  ownStatus: Status | null;
}
const emptyAgg = (): Agg => ({
  present: 0, absent: 0, late: 0, excused: 0, total: 0,
  lastMarkedAt: null, markedBy: null, ownStatus: null,
});

/** Aggregate local attendance rows by session key for one or more dates. */
async function loadAttendance(
  classIds: string[],
  fromDate: string,
  toDate: string,
  ownStudentId: string | null,
  academicTermId?: number
): Promise<Map<string, Agg>> {
  const db = getDb();
  const map = new Map<string, Agg>();
  if (classIds.length === 0) return map;

  const placeholders = classIds.map(() => '?').join(',');
  const params: any[] = [...classIds, fromDate, toDate];
  let termClause = '';
  if (academicTermId != null) {
    termClause = ' AND (academic_term_id = ? OR academic_term_id IS NULL)';
    params.push(academicTermId);
  }
  const rows = await db.all(
    `SELECT class_id, subject_id, session_type, session_date, status, student_id, updated_at, marked_by
       FROM attendance_records
      WHERE class_id IN (${placeholders})
        AND session_date BETWEEN ? AND ?${termClause}`,
    ...params
  );

  for (const r of rows) {
    const key =
      r.session_type === 'homeroom'
        ? `${r.session_date}|homeroom|${r.class_id}`
        : `${r.session_date}|subject|${r.class_id}|${r.subject_id}`;
    let a = map.get(key);
    if (!a) { a = emptyAgg(); map.set(key, a); }
    a.total += 1;
    if (r.status in a) (a as any)[r.status] += 1;
    if (!a.lastMarkedAt || r.updated_at > a.lastMarkedAt) {
      a.lastMarkedAt = r.updated_at;
      a.markedBy = r.marked_by;
    }
    if (ownStudentId && r.student_id === ownStudentId) a.ownStatus = r.status;
  }
  return map;
}

const deepLink = (
  kind: 'homeroom' | 'subject',
  classId: string,
  date: string,
  startTime: string,
  subjectId: number | null
) => {
  const qs = new URLSearchParams({ classId, date, sessionType: kind });
  qs.set('period', kind === 'homeroom' ? HOMEROOM_PERIOD : periodForTime(startTime));
  if (kind === 'subject' && subjectId != null) qs.set('subjectId', String(subjectId));
  return `/attendance/mark?${qs.toString()}`;
};

interface SessionItem {
  kind: 'homeroom' | 'subject';
  slotId: number | null;
  classId: string;
  className: string;
  subjectId: number | null;
  subjectName: string | null;
  subjectCode: string | null;
  color: string | null;
  startTime: string;
  endTime: string;
  room: string;
  status: SessionStatus;
  ownStatus: Status | null;
  stats: { present: number; absent: number; late: number; excused: number; total: number };
  lastMarkedAt: string | null;
  markedByMe: boolean;
  deepLink: string;
  teacherId: number | null;
  teacherName: string | null;
  isMine: boolean;
}

function buildDaySessions(
  daySlots: Slot[],
  date: string,
  agg: Map<string, Agg>,
  userId: string,
  // The full timetable (not just this day's slots) — the morning register is
  // owed every school day for every class on the timetable, including days
  // with no lessons for that class, so homeroom entries are derived from the
  // whole schedule rather than from `daySlots` alone.
  homeroomSlots: Slot[] = daySlots
): SessionItem[] {
  // One homeroom entry per distinct class on the timetable, earliest known
  // slot's class first — that teacher most often takes the morning register.
  const classOrder: string[] = [];
  const classMeta = new Map<string, Slot>();
  for (const s of [...homeroomSlots].sort((a, b) => a.startTime.localeCompare(b.startTime))) {
    if (!classMeta.has(s.classId)) { classMeta.set(s.classId, s); classOrder.push(s.classId); }
  }

  const homeroom: SessionItem[] = classOrder.map((classId) => {
    const meta = classMeta.get(classId)!;
    const a = agg.get(`${date}|homeroom|${classId}`) ?? emptyAgg();
    return {
      kind: 'homeroom' as const,
      slotId: null,
      classId,
      className: meta.className,
      subjectId: null, subjectName: null, subjectCode: null, color: null,
      startTime: meta.startTime, endTime: '',
      room: '',
      status: a.total > 0 ? 'recorded' : 'missing',
      ownStatus: a.ownStatus,
      stats: { present: a.present, absent: a.absent, late: a.late, excused: a.excused, total: a.total },
      lastMarkedAt: a.lastMarkedAt,
      markedByMe: a.markedBy === userId,
      deepLink: deepLink('homeroom', classId, date, meta.startTime, null),
      teacherId: null,
      teacherName: null,
      isMine: true,
    };
  });

  const subjects: SessionItem[] = [...daySlots]
    .sort((a, b) => a.startTime.localeCompare(b.startTime))
    .map((s) => {
      const a = agg.get(`${date}|subject|${s.classId}|${s.subjectId}`) ?? emptyAgg();
      return {
        kind: 'subject' as const,
        slotId: s.slotId,
        classId: s.classId,
        className: s.className,
        subjectId: s.subjectId,
        subjectName: s.subjectName,
        subjectCode: s.subjectCode,
        color: s.color,
        startTime: s.startTime,
        endTime: s.endTime,
        room: s.room,
        status: a.total > 0 ? 'recorded' : 'missing',
        ownStatus: a.ownStatus,
        stats: { present: a.present, absent: a.absent, late: a.late, excused: a.excused, total: a.total },
        lastMarkedAt: a.lastMarkedAt,
        markedByMe: a.markedBy === userId,
        deepLink: deepLink('subject', s.classId, date, s.startTime, s.subjectId),
        teacherId: s.teacherId,
        teacherName: s.teacherName,
        isMine: s.teacherId == null || String(s.teacherId) === userId,
      };
    });

  return [...homeroom, ...subjects];
}

/** Slots eligible to seed a homeroom entry: for a student, their own
 *  timetable (there's nothing to gate — they don't take the register); for
 *  everyone else, only the classes they are the assigned Class Teacher of. */
async function resolveHomeroomSlots(
  authReq: AuthenticatedRequest,
  slots: Slot[],
  academicYearId: number | undefined
): Promise<Slot[]> {
  if (authReq.user?.role === 'student') return slots;
  const misToken = authReq.user?.misToken;
  if (!misToken) return [];
  const classTeacherOf = new Set((await fetchClassTeacherClasses(misToken, authReq.user!.id, academicYearId)).map((c) => c.id));
  return slots.filter((s) => classTeacherOf.has(s.classId));
}

import { fetchOfficeHours } from './officeHours.js';

const ATT_PERMS = ['ATTENDANCE_MARK', 'ATTENDANCE_VIEW_ALL', 'ATTENDANCE_VIEW_OWN', 'ATTENDANCE_CALENDAR_VIEW_OWN'];

// GET /api/attendance/schedule/day?date=YYYY-MM-DD
router.get('/schedule/day', authorizePermission(...ATT_PERMS), async (req: any, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  const date = str(req.query.date) ?? schoolDateString();
  if (!DATE_RE.test(date)) {
    return res.status(400).json({ success: false, message: 'date must be YYYY-MM-DD.' });
  }
  const { academicYearId, academicTermId } = await resolveLiveAcademicPeriod(authReq);
  const isStudent = authReq.user?.role === 'student';

  try {
    const { slots, source } = await fetchTimetable(
      authReq,
      academicTermId != null ? String(academicTermId) : undefined
    );
    const homeroomSlots = await resolveHomeroomSlots(authReq, slots, academicYearId);
    const dow = dayOfWeekFor(date);
    const daySlots = slots.filter((s) => s.dayOfWeek === dow);
    // Full timetable's classes, not just today's — the morning register is
    // owed for every class on the schedule regardless of whether it has a
    // lesson today.
    const classIds = [...new Set(slots.map((s) => s.classId))];
    const agg = await loadAttendance(
      classIds, date, date,
      isStudent ? authReq.user!.id : null,
      academicTermId
    );
    const sessions = buildDaySessions(daySlots, date, agg, authReq.user!.id, homeroomSlots);

    // Progress tracks the subject registers plus the first (primary) homeroom.
    let seenHomeroom = false;
    const recordable = sessions.filter((s) => {
      if (s.kind === 'subject') return true;
      if (seenHomeroom) return false;
      seenHomeroom = true;
      return true;
    });
    const done = recordable.filter((s) => s.status === 'recorded').length;

    const officeHours = await fetchOfficeHours(authReq.user?.misToken, date, date, isStudent);
    return res.json({
      success: true,
      data: {
        date,
        dayOfWeek: dow,
        timetableAvailable: source === 'mis' && slots.length > 0,
        sessions,
        officeHours,
        progress: { done, total: recordable.length },
      },
    });
  } catch (error) {
    console.error('Error building schedule/day:', (error as Error).message);
    return res.status(502).json({ success: false, message: 'Could not load the schedule.' });
  }
});

// GET /api/attendance/schedule/week?weekStart=YYYY-MM-DD
router.get('/schedule/week', authorizePermission(...ATT_PERMS), async (req: any, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  const anchor = str(req.query.weekStart) ?? schoolDateString();
  if (!DATE_RE.test(anchor)) {
    return res.status(400).json({ success: false, message: 'weekStart must be YYYY-MM-DD.' });
  }
  const weekStart = weekStartFor(anchor);
  const weekEnd = addDays(weekStart, 6);
  const { academicYearId, academicTermId } = await resolveLiveAcademicPeriod(authReq);
  const isStudent = authReq.user?.role === 'student';

  try {
    const { slots } = await fetchTimetable(
      authReq,
      academicTermId != null ? String(academicTermId) : undefined
    );
    const homeroomSlots = await resolveHomeroomSlots(authReq, slots, academicYearId);
    const classIds = [...new Set(slots.map((s) => s.classId))];
    const agg = await loadAttendance(
      classIds, weekStart, weekEnd,
      isStudent ? authReq.user!.id : null,
      academicTermId
    );

    const days = Array.from({ length: 7 }, (_, i) => {
      const date = addDays(weekStart, i);
      const dow = dayOfWeekFor(date);
      const daySlots = slots.filter((s) => s.dayOfWeek === dow);
      const sessions = buildDaySessions(daySlots, date, agg, authReq.user!.id, homeroomSlots).map((s) => ({
        kind: s.kind,
        classId: s.classId,
        className: s.className,
        subjectId: s.subjectId,
        subjectName: s.subjectName,
        color: s.color,
        startTime: s.startTime,
        endTime: s.endTime,
        room: s.room,
        status: s.status,
        ownStatus: s.ownStatus,
        deepLink: s.deepLink,
        teacherId: s.teacherId,
        teacherName: s.teacherName,
        isMine: s.isMine,
      }));
      return { date, dayOfWeek: dow, sessions };
    });
    const officeHours = await fetchOfficeHours(authReq.user?.misToken, weekStart, weekEnd, isStudent);
    const byDate = new Map<string, typeof officeHours>();
    for (const o of officeHours) byDate.set(o.date, [...(byDate.get(o.date) ?? []), o]);

    return res.json({ success: true, data: { weekStart, weekEnd, days: days.map((d) => ({ ...d, officeHours: byDate.get(d.date) ?? [] })) } });
  } catch (error) {
    console.error('Error building schedule/week:', (error as Error).message);
    return res.status(502).json({ success: false, message: 'Could not load the week.' });
  }
});

// GET /api/attendance/schedule/month?month=YYYY-MM — per-day register status
// for a whole month, for the calendar month grid.
router.get('/schedule/month', authorizePermission(...ATT_PERMS), async (req: any, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  const month = str(req.query.month) ?? schoolDateString().slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(month)) {
    return res.status(400).json({ success: false, message: 'month must be YYYY-MM.' });
  }
  const [y, m] = month.split('-').map(Number);
  const first = `${month}-01`;
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const last = `${month}-${String(daysInMonth).padStart(2, '0')}`;
  const { academicYearId, academicTermId } = await resolveLiveAcademicPeriod(authReq);
  const isStudent = authReq.user?.role === 'student';

  try {
    const { slots, source } = await fetchTimetable(
      authReq,
      academicTermId != null ? String(academicTermId) : undefined
    );
    const homeroomSlots = await resolveHomeroomSlots(authReq, slots, academicYearId);
    const classIds = [...new Set(slots.map((s) => s.classId))];
    const agg = await loadAttendance(
      classIds, first, last, isStudent ? authReq.user!.id : null, academicTermId
    );

    const days = Array.from({ length: daysInMonth }, (_, i) => {
      const date = addDays(first, i);
      const dow = dayOfWeekFor(date);
      const daySlots = slots.filter((s) => s.dayOfWeek === dow);
      const sessions = buildDaySessions(daySlots, date, agg, authReq.user!.id, homeroomSlots);
      let seenHome = false;
      const recordable = sessions.filter((s) => {
        if (s.kind === 'subject') return true;
        if (seenHome) return false;
        seenHome = true;
        return true;
      });
      const done = recordable.filter((s) => s.status === 'recorded').length;
      return {
        date,
        dayOfWeek: dow,
        lessonCount: sessions.filter((s) => s.kind === 'subject').length,
        colors: [...new Set(sessions.filter((s) => s.kind === 'subject').map((s) => s.color).filter(Boolean))].slice(0, 4),
        progress: { done, total: recordable.length },
        ownStatuses: isStudent
          ? sessions.filter((s) => s.kind === 'subject' && s.ownStatus).map((s) => s.ownStatus)
          : [],
      };
    });

    return res.json({
      success: true,
      data: { month, first, last, timetableAvailable: source === 'mis' && slots.length > 0, days },
    });
  } catch (error) {
    console.error('Error building schedule/month:', (error as Error).message);
    return res.status(502).json({ success: false, message: 'Could not load the month.' });
  }
});

// GET /api/attendance/schedule/upcoming — next unrecorded sessions today.
router.get('/schedule/upcoming', authorizePermission(...ATT_PERMS), async (req: any, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  const date = schoolDateString();
  const nowMin = schoolMinutesOfDay();
  const { academicYearId, academicTermId } = await resolveLiveAcademicPeriod(authReq);
  const isStudent = authReq.user?.role === 'student';

  try {
    const { slots } = await fetchTimetable(
      authReq,
      academicTermId != null ? String(academicTermId) : undefined
    );
    const homeroomSlots = await resolveHomeroomSlots(authReq, slots, academicYearId);
    const dow = dayOfWeekFor(date);
    const daySlots = slots.filter((s) => s.dayOfWeek === dow);
    const classIds = [...new Set(slots.map((s) => s.classId))];
    const agg = await loadAttendance(
      classIds, date, date, isStudent ? authReq.user!.id : null, academicTermId
    );
    const sessions = buildDaySessions(daySlots, date, agg, authReq.user!.id, homeroomSlots);

    // "Live or ahead": lessons that have not finished yet.
    const upcoming = sessions
      .filter((s) => s.kind === 'subject')
      .filter((s) => timeToMinutes(s.endTime || s.startTime) + 5 >= nowMin)
      .slice(0, 4);
    const nextUnrecorded = sessions.find(
      (s) => s.status === 'missing' && timeToMinutes(s.startTime) <= nowMin
    ) ?? null;

    return res.json({
      success: true,
      data: { date, now: nowMin, upcoming, nextUnrecorded },
    });
  } catch (error) {
    console.error('Error building schedule/upcoming:', (error as Error).message);
    return res.status(502).json({ success: false, message: 'Could not load upcoming sessions.' });
  }
});

// GET /api/attendance/schedule/homeroom-classes — the class groups this user
// may take a morning register for, i.e. the classes they are the assigned
// Class Teacher of. Powers the "Record a session" picker so a teacher can
// only ever offer a homeroom entry for a class that's actually theirs (the
// subject-session picker stays scoped by curriculum only, unaffected).
router.get('/schedule/homeroom-classes', authorizePermission('ATTENDANCE_MARK'), async (req: any, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  const { academicYearId } = await resolveLiveAcademicPeriod(authReq);
  const misToken = authReq.user?.misToken;
  if (!misToken) return res.json({ success: true, data: [] });

  try {
    const classes = await fetchClassTeacherClasses(misToken, authReq.user!.id, academicYearId);
    return res.json({ success: true, data: classes });
  } catch (error) {
    console.error('Error loading homeroom-classes:', (error as Error).message);
    return res.status(502).json({ success: false, message: 'Could not load your classes.' });
  }
});

export default router;
export { fetchTimetable, buildDaySessions, loadAttendance, deepLink };
