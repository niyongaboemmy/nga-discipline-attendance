import { apiGet, apiPost, apiDelete } from './client';

export type ExcuseStatus = 'pending' | 'approved' | 'rejected';
export type ExcuseSessionType = 'homeroom' | 'subject';

/** One row of excuse_requests, as the student sees it. */
export interface Excuse {
  id: number;
  class_id: string | null;
  class_name: string;
  period: string | null;
  session_type: ExcuseSessionType;
  subject_id: number | null;
  subject_name: string | null;
  session_date: string;
  reason: string;
  description: string;
  status: ExcuseStatus;
  reviewer_note: string | null;
  reviewed_by_name: string | null;
  supersedes_id: number | null;
  created_at: string;
  updated_at: string;
}

interface ExcuseRef { id: number; status: ExcuseStatus; created_at: string; reviewer_note?: string | null }

export interface ExcuseDetail extends Excuse {
  /** What the attendance row this excuse covers says right now. */
  attendanceStatus: 'present' | 'absent' | 'late' | 'excused' | null;
  /** The decided request this one appeals, if any. */
  supersedes: ExcuseRef | null;
  /** The later appeal that follows this one, if any. */
  supersededBy: ExcuseRef | null;
}

/** An `absent` mark of the student's, with the excuse already covering it. */
export interface Absence {
  recordId: number;
  date: string;
  period: string;
  sessionType: ExcuseSessionType;
  classId: string;
  className: string;
  subjectId: number | null;
  subjectName: string | null;
  excuse: { id: number; status: ExcuseStatus } | null;
}

export interface NewExcuse {
  className: string;
  classId?: string | null;
  period?: string | null;
  sessionDate: string;
  sessionType: ExcuseSessionType;
  subjectId?: number | null;
  subjectName?: string | null;
  reason: string;
  description: string;
  supersedesId?: number | null;
}

export const getMyExcuses = () =>
  apiGet<Excuse[]>('/api/attendance/excuses/me').then((r) => r.data ?? []);

export const getMyAbsences = () =>
  apiGet<Absence[]>('/api/attendance/excuses/me/absences').then((r) => r.data ?? []);

export const getMyExcuse = (id: number) =>
  apiGet<ExcuseDetail>(`/api/attendance/excuses/me/${id}`).then((r) => r.data!);

export const submitExcuse = (body: NewExcuse) =>
  apiPost<Excuse>('/api/attendance/excuse', body).then((r) => r.data!);

export const withdrawExcuse = (id: number) =>
  apiDelete<void>(`/api/attendance/excuse/${id}`);

/** What the excuse is for, in words: "JavaScript" or "Morning check". */
export const excuseTarget = (e: { session_type: ExcuseSessionType; subject_name: string | null }) =>
  e.session_type === 'subject' ? (e.subject_name || 'Lesson') : 'Morning check';

/** The absence an excuse would cover — what /excuses/new needs to pre-fill. */
export interface ExcuseTarget {
  date: string;
  classId: string | null;
  className: string;
  period: string | null;
  sessionType: ExcuseSessionType;
  subjectId: number | null;
  subjectName: string | null;
}

/** Link to the form with the absence's identity carried in the query. */
export const newExcuseLink = (t: ExcuseTarget) => {
  const qs = new URLSearchParams({ date: t.date, className: t.className, sessionType: t.sessionType });
  if (t.classId) qs.set('classId', t.classId);
  if (t.period) qs.set('period', t.period);
  if (t.sessionType === 'subject' && t.subjectId != null) {
    qs.set('subjectId', String(t.subjectId));
    if (t.subjectName) qs.set('subjectName', t.subjectName);
  }
  return `/excuses/new?${qs.toString()}`;
};
