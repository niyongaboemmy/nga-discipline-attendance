import { apiGet } from './client';

export interface ReportableClass {
  classId: string;
  className: string;
}

export type ClassSection =
  | { kind: 'homeroom' }
  | { kind: 'subject'; subjectId: number; subjectName: string; teacherName: string | null };

export type AttendanceComment = 'Excellent' | 'Good' | 'Fair' | 'Poor';

export interface StudentAttendanceRow {
  studentId: string;
  studentName: string;
  marks: Record<string, string>;
  present: number;
  absent: number;
  late: number;
  excused: number;
  total: number;
  rate: number;
  comment: AttendanceComment;
}

export interface ClassSectionReport {
  classId: string;
  className: string;
  sessionType: 'homeroom' | 'subject';
  subjectId: number | null;
  subjectName: string | null;
  teacherName: string | null;
  academicTermId: number | null;
  dateColumns: string[];
  students: StudentAttendanceRow[];
  classAverageRate: number;
}

export interface ClassSectionReportQuery {
  sessionType: 'homeroom' | 'subject';
  subjectId?: number;
  from?: string;
  to?: string;
}

export interface SubjectOverview {
  subjectId: number;
  subjectName: string;
  classCount: number;
  studentsTracked: number;
  averageRate: number;
  atRiskCount: number;
}

export interface SubjectClassOverview {
  classId: string;
  className: string;
  teacherName: string | null;
  studentsTracked: number;
  averageRate: number;
}

export const attendanceReportApi = {
  classes: () => apiGet<ReportableClass[]>('/api/reporting/attendance/classes'),

  sections: (classId: string) =>
    apiGet<ClassSection[]>(`/api/reporting/attendance/classes/${encodeURIComponent(classId)}/sections`),

  classReport: (classId: string, q: ClassSectionReportQuery) => {
    const qs = new URLSearchParams({ session_type: q.sessionType });
    if (q.subjectId != null) qs.set('subject_id', String(q.subjectId));
    if (q.from) qs.set('from', q.from);
    if (q.to) qs.set('to', q.to);
    return apiGet<ClassSectionReport>(`/api/reporting/attendance/class/${encodeURIComponent(classId)}?${qs.toString()}`);
  },

  subjects: () => apiGet<SubjectOverview[]>('/api/reporting/attendance/subjects'),

  subjectClasses: (subjectId: number) =>
    apiGet<SubjectClassOverview[]>(`/api/reporting/attendance/subjects/${subjectId}/classes`),

  /** A student's own report — class auto-detected server-side, and the
   *  response is scoped to their own row only. No classId param exists
   *  because there is nothing to pick. */
  mySections: () => apiGet<ClassSection[]>('/api/reporting/attendance/me/sections'),

  myReport: (q: ClassSectionReportQuery) => {
    const qs = new URLSearchParams({ session_type: q.sessionType });
    if (q.subjectId != null) qs.set('subject_id', String(q.subjectId));
    if (q.from) qs.set('from', q.from);
    if (q.to) qs.set('to', q.to);
    return apiGet<ClassSectionReport>(`/api/reporting/attendance/me/report?${qs.toString()}`);
  },

  /** Every section (homeroom + each subject) side by side — the "All
   *  Subjects" comparison view, zero-filled rather than omitting a subject
   *  with nothing recorded yet. */
  myAllSubjects: (from?: string, to?: string) => {
    const qs = new URLSearchParams();
    if (from) qs.set('from', from);
    if (to) qs.set('to', to);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return apiGet<OwnSubjectSummary[]>(`/api/reporting/attendance/me/subjects${suffix}`);
  },
};

export interface OwnSubjectSummary {
  kind: 'homeroom' | 'subject';
  subjectId: number | null;
  subjectName: string | null;
  present: number;
  absent: number;
  late: number;
  excused: number;
  total: number;
  rate: number;
  comment: AttendanceComment;
  hasData: boolean;
}
