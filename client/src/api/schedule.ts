import { apiGet } from './client';

export type SessionKind = 'homeroom' | 'subject';
export type SessionStatus = 'recorded' | 'missing';
export type AttStatus = 'present' | 'absent' | 'late' | 'excused';

export interface DaySession {
  kind: SessionKind;
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
  ownStatus: AttStatus | null;
  stats: { present: number; absent: number; late: number; excused: number; total: number };
  lastMarkedAt: string | null;
  markedByMe: boolean;
  deepLink: string;
  teacherId: number | null;
  teacherName: string | null;
  isMine: boolean;
}

/** An office-hours session from the MIS (read-only here; the MIS keeps the register). */
export interface OfficeHoursEntry {
  sessionId: number;
  scheduleId: number;
  date: string;
  title: string;
  startTime: string;
  endTime: string;
  room: string | null;
  state: string;
  expected: number | null;
  marked: number | null;
  ownStatus: string | null;
  link: string;
}

export interface DayResponse {
  date: string;
  dayOfWeek: number;
  timetableAvailable: boolean;
  sessions: DaySession[];
  officeHours?: OfficeHoursEntry[];
  progress: { done: number; total: number };
}

/** The fields every calendar view can rely on for a session, whether it came
 *  from the full day payload or the lighter week payload. */
export type CalendarSession = Pick<
  DaySession,
  'kind' | 'classId' | 'className' | 'subjectId' | 'subjectName' | 'color' | 'startTime' | 'endTime' | 'room' | 'status' | 'ownStatus' | 'deepLink' | 'teacherId' | 'teacherName' | 'isMine'
> &
  Partial<Pick<DaySession, 'slotId' | 'subjectCode' | 'stats' | 'lastMarkedAt' | 'markedByMe'>>;

export interface WeekDay {
  date: string;
  dayOfWeek: number;
  sessions: CalendarSession[];
  officeHours?: OfficeHoursEntry[];
}

export interface WeekResponse {
  weekStart: string;
  weekEnd: string;
  days: WeekDay[];
}

export interface UpcomingResponse {
  date: string;
  now: number;
  upcoming: DaySession[];
  nextUnrecorded: DaySession | null;
}

export const getScheduleDay = (date?: string) =>
  apiGet<DayResponse>(`/api/attendance/schedule/day${date ? `?date=${date}` : ''}`).then((r) => r.data!);

export const getScheduleWeek = (weekStart?: string) =>
  apiGet<WeekResponse>(`/api/attendance/schedule/week${weekStart ? `?weekStart=${weekStart}` : ''}`).then((r) => r.data!);

export const getScheduleUpcoming = () =>
  apiGet<UpcomingResponse>('/api/attendance/schedule/upcoming').then((r) => r.data!);

export interface MonthDay {
  date: string;
  dayOfWeek: number;
  lessonCount: number;
  colors: string[];
  progress: { done: number; total: number };
  ownStatuses: AttStatus[];
}
export interface MonthResponse {
  month: string;
  first: string;
  last: string;
  timetableAvailable: boolean;
  days: MonthDay[];
}
export const getScheduleMonth = (month?: string) =>
  apiGet<MonthResponse>(`/api/attendance/schedule/month${month ? `?month=${month}` : ''}`).then((r) => r.data!);

export interface HomeroomClass { id: string; name: string }

/** Classes the signed-in user is the assigned Class Teacher of — the only
 *  classes they may take a morning register for. */
export const getHomeroomClasses = () =>
  apiGet<HomeroomClass[]>('/api/attendance/schedule/homeroom-classes').then((r) => r.data ?? []);

/** Route for the read-only session detail page. Carries exactly what the
 *  page needs to find the session again in that day's schedule payload —
 *  `start` disambiguates a class that has the same subject twice in a day. */
export const sessionDetailLink = (s: Pick<CalendarSession, 'kind' | 'classId' | 'subjectId' | 'startTime'>, date: string) => {
  const qs = new URLSearchParams({ date, classId: s.classId, sessionType: s.kind });
  if (s.kind === 'subject' && s.subjectId != null) qs.set('subjectId', String(s.subjectId));
  if (s.startTime) qs.set('start', s.startTime.slice(0, 5));
  return `/attendance/session?${qs.toString()}`;
};

/** Find `link`'s session in a loaded day — the inverse of sessionDetailLink. */
export const findSession = (
  sessions: CalendarSession[],
  q: { sessionType: string; classId: string; subjectId: number | null; start: string | null }
): CalendarSession | undefined => {
  const matches = sessions.filter(
    (s) => s.kind === q.sessionType && s.classId === q.classId && (q.sessionType === 'homeroom' || s.subjectId === q.subjectId)
  );
  return matches.find((s) => q.start && s.startTime.slice(0, 5) === q.start) ?? matches[0];
};
