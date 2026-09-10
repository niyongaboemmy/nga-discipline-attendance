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
}

export interface DayResponse {
  date: string;
  dayOfWeek: number;
  timetableAvailable: boolean;
  sessions: DaySession[];
  progress: { done: number; total: number };
}

/** The fields every calendar view can rely on for a session, whether it came
 *  from the full day payload or the lighter week payload. */
export type CalendarSession = Pick<
  DaySession,
  'kind' | 'classId' | 'className' | 'subjectId' | 'subjectName' | 'color' | 'startTime' | 'endTime' | 'room' | 'status' | 'ownStatus' | 'deepLink'
> &
  Partial<Pick<DaySession, 'slotId' | 'subjectCode' | 'stats' | 'lastMarkedAt' | 'markedByMe'>>;

export interface WeekDay {
  date: string;
  dayOfWeek: number;
  sessions: CalendarSession[];
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
