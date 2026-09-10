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

export interface WeekDay {
  date: string;
  dayOfWeek: number;
  sessions: Array<
    Pick<
      DaySession,
      'kind' | 'classId' | 'className' | 'subjectId' | 'subjectName' | 'color' | 'startTime' | 'endTime' | 'room' | 'status' | 'ownStatus' | 'deepLink'
    >
  >;
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
