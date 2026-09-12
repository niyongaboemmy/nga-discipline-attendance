import { Database } from 'sqlite';
import { attendanceRate } from '../../shared/attendancePolicy.js';

/**
 * Class → subject attendance register. Where reporting.service.ts answers
 * "how is the whole school doing", this answers the question a teacher or
 * admin actually walks in with: "show me Grade 9A's Applied Mathematics
 * register" — one class, one subject (or homeroom), every session, every
 * student, with a rate and a comment tier per student. Modeled after the
 * reference "Class Attendance record" sheet.
 *
 * Columns are real `session_date` values, not reconstructed "Week N / Period
 * N" labels — the schema has no concept of week-number or a fixed
 * periods-per-week count, so a date is the only thing that's actually true
 * of the data.
 */

function periodFilter(academicTermId?: number): { clause: string; params: any[] } {
  if (academicTermId == null) return { clause: '', params: [] };
  return { clause: ' AND (academic_term_id = ? OR academic_term_id IS NULL)', params: [academicTermId] };
}

export interface ReportableClass {
  classId: string;
  className: string;
}

export async function listReportableClasses(db: Database, academicTermId?: number): Promise<ReportableClass[]> {
  const { clause, params } = periodFilter(academicTermId);
  const rows = await db.all(
    `SELECT class_id as classId, class_name as className FROM class_subject_assignments
      WHERE 1=1${clause}
     UNION
     SELECT class_id as classId, class_name as className FROM attendance_records
      WHERE 1=1${clause}`,
    ...params, ...params
  );
  const byId = new Map<string, ReportableClass>();
  for (const r of rows) {
    if (!r.classId || byId.has(r.classId)) continue;
    byId.set(r.classId, { classId: r.classId, className: r.className || r.classId });
  }
  return [...byId.values()].sort((a, b) => a.className.localeCompare(b.className));
}

export type ClassSection =
  | { kind: 'homeroom' }
  | { kind: 'subject'; subjectId: number; subjectName: string; teacherName: string | null };

export async function listClassSections(db: Database, classId: string, academicTermId?: number): Promise<ClassSection[]> {
  const { clause, params } = periodFilter(academicTermId);
  const rows = await db.all(
    `SELECT DISTINCT subject_id as subjectId, subject_name as subjectName, teacher_name as teacherName
       FROM class_subject_assignments
      WHERE class_id = ?${clause}
      ORDER BY subject_name`,
    classId, ...params
  );
  const seen = new Set<number>();
  const subjects: ClassSection[] = [];
  for (const r of rows) {
    if (r.subjectId == null || seen.has(r.subjectId)) continue;
    seen.add(r.subjectId);
    subjects.push({ kind: 'subject', subjectId: r.subjectId, subjectName: r.subjectName || `Subject ${r.subjectId}`, teacherName: r.teacherName ?? null });
  }
  return [{ kind: 'homeroom' }, ...subjects];
}

/** Rolls a set of raw `(student_id, status)` rows into a class/subject-level
 *  summary — the shared math behind every "how is this group doing" card.
 *  Also used by getClassSectionReport's own per-student pass. */
function aggregateStudentRates(rows: Array<{ student_id: string; status: string }>) {
  const byStudent = new Map<string, { present: number; late: number; excused: number; total: number }>();
  for (const r of rows) {
    let s = byStudent.get(r.student_id);
    if (!s) { s = { present: 0, late: 0, excused: 0, total: 0 }; byStudent.set(r.student_id, s); }
    s.total += 1;
    if (r.status === 'present') s.present += 1;
    else if (r.status === 'late') s.late += 1;
    else if (r.status === 'excused') s.excused += 1;
  }
  const rates = [...byStudent.values()].map((s) => attendanceRate(s.present + s.late + s.excused, s.total));
  const averageRate = rates.length ? Math.round(rates.reduce((a, b) => a + b, 0) / rates.length) : 100;
  const atRiskCount = rates.filter((r) => r < 80).length;
  return { studentsTracked: byStudent.size, averageRate, atRiskCount };
}

export interface SubjectClassScope {
  classId: string;
  className: string;
  teacherName: string | null;
}

/** Which classes teach `subjectId` this term — every class for an admin
 *  (or anyone without a narrower view), only the classes *this* teacher was
 *  assigned it in otherwise. Mirrors "if you have subjects assigned, use
 *  them; if admin, see everything." */
async function classesForSubject(
  db: Database, subjectId: number, role: string | undefined, userId: string | undefined, academicTermId?: number
): Promise<SubjectClassScope[]> {
  const { clause, params } = periodFilter(academicTermId);
  let scope = ' WHERE subject_id = ?';
  const scopeParams: any[] = [subjectId];
  if (role !== 'admin' && userId) { scope += ' AND teacher_id = ?'; scopeParams.push(userId); }
  scope += clause;
  return db.all(
    `SELECT DISTINCT class_id as classId, class_name as className, teacher_name as teacherName
       FROM class_subject_assignments${scope}`,
    ...scopeParams, ...params
  );
}

export interface SubjectOverview {
  subjectId: number;
  subjectName: string;
  classCount: number;
  studentsTracked: number;
  averageRate: number;
  atRiskCount: number;
}

export interface SubjectScopeParams {
  role?: string;
  userId?: string;
  academicTermId?: number;
}

/** The "Subjects" dashboard: every subject this user should see (their own
 *  assignments, or the whole school for an admin), each with a quick
 *  attendance-health summary rolled up across every class teaching it. */
export async function listAvailableSubjects(db: Database, opts: SubjectScopeParams): Promise<SubjectOverview[]> {
  const { clause, params } = periodFilter(opts.academicTermId);
  let scope = ' WHERE 1=1';
  const scopeParams: any[] = [];
  if (opts.role !== 'admin' && opts.userId) { scope += ' AND teacher_id = ?'; scopeParams.push(opts.userId); }
  scope += clause;
  const subjectRows = await db.all(
    `SELECT DISTINCT subject_id as subjectId, subject_name as subjectName FROM class_subject_assignments${scope}`,
    ...scopeParams, ...params
  );

  const overviews: SubjectOverview[] = [];
  for (const s of subjectRows) {
    if (s.subjectId == null) continue;
    const classes = await classesForSubject(db, s.subjectId, opts.role, opts.userId, opts.academicTermId);
    if (classes.length === 0) continue;
    const placeholders = classes.map(() => '?').join(',');
    const { clause: tClause, params: tParams } = periodFilter(opts.academicTermId);
    const rows = await db.all(
      `SELECT student_id, status FROM attendance_records
        WHERE subject_id = ? AND class_id IN (${placeholders})${tClause}`,
      s.subjectId, ...classes.map((c) => c.classId), ...tParams
    );
    const agg = aggregateStudentRates(rows);
    overviews.push({ subjectId: s.subjectId, subjectName: s.subjectName || `Subject ${s.subjectId}`, classCount: classes.length, ...agg });
  }
  return overviews.sort((a, b) => a.subjectName.localeCompare(b.subjectName));
}

export interface SubjectClassOverview extends SubjectClassScope {
  studentsTracked: number;
  averageRate: number;
}

/** Drill-down from a subject: every class teaching it (scoped the same way
 *  as listAvailableSubjects), each with its own quick summary — lets the UI
 *  jump straight to the register when there's only one, or offer a pick
 *  list when a subject spans several classes/teachers. */
export async function listSubjectClasses(db: Database, subjectId: number, opts: SubjectScopeParams): Promise<SubjectClassOverview[]> {
  const classes = await classesForSubject(db, subjectId, opts.role, opts.userId, opts.academicTermId);
  const { clause, params } = periodFilter(opts.academicTermId);
  const results: SubjectClassOverview[] = [];
  for (const c of classes) {
    const rows = await db.all(
      `SELECT student_id, status FROM attendance_records WHERE subject_id = ? AND class_id = ?${clause}`,
      subjectId, c.classId, ...params
    );
    const agg = aggregateStudentRates(rows);
    results.push({ ...c, studentsTracked: agg.studentsTracked, averageRate: agg.averageRate });
  }
  return results.sort((a, b) => a.className.localeCompare(b.className));
}

/** Comment tiers mirroring the reference sheet's boundaries: 100% → Excellent,
 *  92.9%/85.7% → Good, 78.6% → Fair, 71.4% → Poor. */
export function attendanceComment(rate: number): 'Excellent' | 'Good' | 'Fair' | 'Poor' {
  if (rate >= 95) return 'Excellent';
  if (rate >= 85) return 'Good';
  if (rate >= 75) return 'Fair';
  return 'Poor';
}

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
  comment: ReturnType<typeof attendanceComment>;
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

export interface ClassSectionReportParams {
  classId: string;
  academicTermId?: number;
  sessionType: 'homeroom' | 'subject';
  subjectId?: number;
  fromDate?: string;
  toDate?: string;
}

export async function getClassSectionReport(db: Database, p: ClassSectionReportParams): Promise<ClassSectionReport> {
  const { clause: termClause, params: termParams } = periodFilter(p.academicTermId);

  let scope = ' WHERE class_id = ? AND session_type = ?';
  const scopeParams: any[] = [p.classId, p.sessionType];
  if (p.sessionType === 'subject') {
    scope += ' AND subject_id = ?';
    scopeParams.push(p.subjectId);
  }
  if (p.fromDate) { scope += ' AND session_date >= ?'; scopeParams.push(p.fromDate); }
  if (p.toDate) { scope += ' AND session_date <= ?'; scopeParams.push(p.toDate); }
  scope += termClause;
  scopeParams.push(...termParams);

  const [classMeta, dateRows, recordRows] = await Promise.all([
    // Class/subject/teacher display names — the class_subject_assignments
    // cache, falling back to whatever attendance_records has denormalised
    // for a class that only ever gets homeroom attendance.
    p.sessionType === 'subject'
      ? db.get(
          `SELECT class_name as className, subject_name as subjectName, teacher_name as teacherName
             FROM class_subject_assignments WHERE class_id = ? AND subject_id = ? LIMIT 1`,
          p.classId, p.subjectId
        )
      : db.get(`SELECT class_name as className FROM attendance_records WHERE class_id = ? LIMIT 1`, p.classId),
    db.all(`SELECT DISTINCT session_date FROM attendance_records${scope} ORDER BY session_date`, ...scopeParams),
    db.all(
      `SELECT student_id, student_name, session_date, status FROM attendance_records${scope}
       ORDER BY student_name, session_date`,
      ...scopeParams
    ),
  ]);

  const dateColumns: string[] = dateRows.map((r: any) => r.session_date);

  const byStudent = new Map<string, StudentAttendanceRow>();
  for (const r of recordRows) {
    let s = byStudent.get(r.student_id);
    if (!s) {
      s = {
        studentId: r.student_id, studentName: r.student_name, marks: {},
        present: 0, absent: 0, late: 0, excused: 0, total: 0, rate: 0, comment: 'Poor',
      };
      byStudent.set(r.student_id, s);
    }
    s.marks[r.session_date] = r.status;
    s.total += 1;
    if (r.status in s) (s as any)[r.status] += 1;
  }

  const students = [...byStudent.values()]
    .map((s) => {
      const attended = s.present + s.late + s.excused;
      const rate = attendanceRate(attended, s.total);
      return { ...s, rate, comment: attendanceComment(rate) };
    })
    .sort((a, b) => a.studentName.localeCompare(b.studentName));

  const classAverageRate = students.length
    ? Math.round(students.reduce((sum, s) => sum + s.rate, 0) / students.length)
    : 100;

  return {
    classId: p.classId,
    className: classMeta?.className || p.classId,
    sessionType: p.sessionType,
    subjectId: p.sessionType === 'subject' ? p.subjectId ?? null : null,
    subjectName: p.sessionType === 'subject' ? (classMeta?.subjectName ?? null) : null,
    teacherName: p.sessionType === 'subject' ? (classMeta?.teacherName ?? null) : null,
    academicTermId: p.academicTermId ?? null,
    dateColumns,
    students,
    classAverageRate,
  };
}
