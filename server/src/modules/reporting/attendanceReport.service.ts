import { Database } from 'sqlite';
import { attendanceRate } from '../../shared/attendancePolicy.js';
import { misGetList } from '../../services/misClient.js';

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

/** A student's own class group, auto-detected from their own attendance
 *  history (the most recent session recorded for them) — the same signal
 *  `MyAttendance.tsx`'s schedule tab already relies on (`days[0]?.classId`).
 *  No class picker for a student: they belong to exactly one class, so
 *  there is nothing to choose. Returns null only for a brand-new student
 *  with no attendance recorded yet at all. */
export async function resolveOwnClassId(db: Database, studentId: string): Promise<string | null> {
  const row = await db.get(
    `SELECT class_id as classId FROM attendance_records WHERE student_id = ? ORDER BY session_date DESC LIMIT 1`,
    studentId
  );
  return row?.classId ?? null;
}

/** Sections (homeroom + subjects) for a student's own auto-detected class —
 *  same shape as listClassSections, but unions in attendance_records scoped
 *  to this student too (not just the roster cache), so a subject they've
 *  actually been marked for never goes missing just because the sync cache
 *  hasn't caught up (same reasoning as attendanceReport.service.ts's other
 *  cache-can-lag-reality fallbacks). */
export async function listOwnSections(db: Database, studentId: string, academicTermId?: number): Promise<ClassSection[]> {
  const classId = await resolveOwnClassId(db, studentId);
  if (!classId) return [{ kind: 'homeroom' }];

  const { clause, params } = periodFilter(academicTermId);
  const rows = await db.all(
    `SELECT subject_id as subjectId, subject_name as subjectName, teacher_name as teacherName
       FROM class_subject_assignments WHERE class_id = ?${clause}
     UNION
     SELECT ar.subject_id as subjectId, s.name as subjectName, NULL as teacherName
       FROM attendance_records ar LEFT JOIN subjects s ON s.id = ar.subject_id
      WHERE ar.class_id = ? AND ar.student_id = ? AND ar.session_type = 'subject' AND ar.subject_id IS NOT NULL${clause}`,
    classId, ...params, classId, studentId, ...params
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

interface TeacherAssignmentRow {
  subjectId: number;
  subjectName: string;
  classId: string;
  className: string;
}

/** Live "who teaches what" for one teacher, straight from the MIS's
 *  `TeacherSubjectAssignment` table (`GET /academics/teachers/:id/subjects`)
 *  — the same authoritative source the MIS's own "Assigned Subjects"
 *  dashboard tile reads, and the same endpoint academicsSync.service.ts
 *  already cross-checks against.
 *
 *  Earlier this fell back to the local `class_subject_assignments` roster
 *  cache (which only refreshes on a manual sync and can go stale) unioned
 *  with `attendance_records` scoped by `marked_by` — but `marked_by` just
 *  means "whoever clicked save on that session," not "is assigned to teach
 *  it" (an admin correction, a substitute, or a stale account link all
 *  falsify it), so a teacher could see subjects that were never actually
 *  theirs. Going straight to the MIS live removes that guesswork entirely —
 *  no cache to go stale, no proxy column to misread. */
async function fetchTeacherAssignments(
  misToken: string, userId: string, academicYearId?: number
): Promise<TeacherAssignmentRow[]> {
  const raw = await misGetList(misToken, `/academics/teachers/${userId}/subjects`);
  const relevant = academicYearId != null
    ? raw.filter((a) => Number(a.academic_year_id) === academicYearId)
    : raw.filter((a) => Number(a.academic_year_is_current) === 1);
  return relevant
    .filter((a) => a.subject_id != null && a.class_group_id != null)
    .map((a) => ({
      subjectId: Number(a.subject_id),
      subjectName: a.subject_name || `Subject ${a.subject_id}`,
      classId: String(a.class_group_id),
      className: a.class_group_name || String(a.class_group_id),
    }));
}

/** Which classes teach `subjectId` this term — every class for an admin (or
 *  anyone without a narrower view, read from the local roster cache/
 *  attendance history), or exactly the classes the MIS says *this* teacher
 *  is assigned it in otherwise. Mirrors "if you have subjects assigned, use
 *  them; if admin, see everything." */
async function classesForSubject(
  db: Database, subjectId: number, opts: SubjectScopeParams
): Promise<SubjectClassScope[]> {
  if (opts.role !== 'admin' && opts.misToken && opts.userId) {
    const assignments = await fetchTeacherAssignments(opts.misToken, opts.userId, opts.academicYearId);
    const byId = new Map<string, SubjectClassScope>();
    for (const a of assignments) {
      if (a.subjectId !== subjectId) continue;
      if (!byId.has(a.classId)) byId.set(a.classId, { classId: a.classId, className: a.className, teacherName: null });
    }
    return [...byId.values()];
  }

  // Admin — no scoping. A teacher session with no MIS link (e.g. an older/
  // local-only account, no misToken to ask live) falls back to the same
  // local-cache scoping used before this fix (teacher_id / marked_by) —
  // weaker than the live MIS answer, but still scoped to this teacher, never
  // opened up to everyone else's classes.
  const { clause: csaClause, params: csaParams } = periodFilter(opts.academicTermId);
  let csaScope = ' WHERE subject_id = ?';
  const csaScopeParams: any[] = [subjectId];
  let arScope = ` WHERE subject_id = ? AND session_type = 'subject'`;
  const arScopeParams: any[] = [subjectId];
  if (opts.role !== 'admin' && opts.userId) {
    csaScope += ' AND teacher_id = ?'; csaScopeParams.push(opts.userId);
    arScope += ' AND marked_by = ?'; arScopeParams.push(opts.userId);
  }
  csaScope += csaClause;
  arScope += csaClause;
  const rows = await db.all(
    `SELECT class_id as classId, class_name as className, teacher_name as teacherName
       FROM class_subject_assignments${csaScope}
     UNION
     SELECT class_id as classId, class_name as className, NULL as teacherName
       FROM attendance_records${arScope}`,
    ...csaScopeParams, ...csaParams, ...arScopeParams, ...csaParams
  );

  const byId = new Map<string, SubjectClassScope>();
  for (const r of rows) {
    if (!r.classId) continue;
    const existing = byId.get(r.classId);
    if (!existing) {
      byId.set(r.classId, { classId: r.classId, className: r.className || r.classId, teacherName: r.teacherName ?? null });
    } else if (!existing.teacherName && r.teacherName) {
      existing.teacherName = r.teacherName;
    }
  }
  return [...byId.values()];
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
  /** Needed to ask the MIS live for a teacher's real assignments — see
   *  fetchTeacherAssignments(). Not required (and unused) for an admin. */
  misToken?: string;
  academicYearId?: number;
}

/** The "Subjects" dashboard: every subject this user should see (their own
 *  assignments, or the whole school for an admin), each with a quick
 *  attendance-health summary rolled up across every class teaching it. */
export async function listAvailableSubjects(db: Database, opts: SubjectScopeParams): Promise<SubjectOverview[]> {
  let subjectIds: Map<number, string>;

  if (opts.role !== 'admin' && opts.misToken && opts.userId) {
    const assignments = await fetchTeacherAssignments(opts.misToken, opts.userId, opts.academicYearId);
    subjectIds = new Map(assignments.map((a) => [a.subjectId, a.subjectName]));
  } else {
    // Admin — unscoped. A teacher with no MIS link falls back to the local
    // cache, scoped by teacher_id / marked_by (see classesForSubject).
    const { clause: csaClause, params: csaParams } = periodFilter(opts.academicTermId);
    let csaScope = ' WHERE 1=1';
    const csaScopeParams: any[] = [];
    let arScope = ` WHERE ar.session_type = 'subject' AND ar.subject_id IS NOT NULL`;
    const arScopeParams: any[] = [];
    if (opts.role !== 'admin' && opts.userId) {
      csaScope += ' AND teacher_id = ?'; csaScopeParams.push(opts.userId);
      arScope += ' AND ar.marked_by = ?'; arScopeParams.push(opts.userId);
    }
    csaScope += csaClause;
    arScope += csaClause;
    const subjectRows = await db.all(
      `SELECT subject_id as subjectId, subject_name as subjectName FROM class_subject_assignments${csaScope}
       UNION
       SELECT ar.subject_id as subjectId, s.name as subjectName
         FROM attendance_records ar LEFT JOIN subjects s ON s.id = ar.subject_id${arScope}`,
      ...csaScopeParams, ...csaParams, ...arScopeParams, ...csaParams
    );
    subjectIds = new Map();
    for (const r of subjectRows) {
      if (r.subjectId == null) continue;
      if (!subjectIds.has(r.subjectId) || (!subjectIds.get(r.subjectId) && r.subjectName)) {
        subjectIds.set(r.subjectId, r.subjectName ?? null);
      }
    }
  }

  const overviews: SubjectOverview[] = [];
  for (const [subjectId, subjectName] of subjectIds) {
    const classes = await classesForSubject(db, subjectId, opts);
    if (classes.length === 0) continue;
    const placeholders = classes.map(() => '?').join(',');
    const { clause: tClause, params: tParams } = periodFilter(opts.academicTermId);
    const rows = await db.all(
      `SELECT student_id, status FROM attendance_records
        WHERE subject_id = ? AND class_id IN (${placeholders})${tClause}`,
      subjectId, ...classes.map((c) => c.classId), ...tParams
    );
    const agg = aggregateStudentRates(rows);
    overviews.push({ subjectId, subjectName: subjectName || `Subject ${subjectId}`, classCount: classes.length, ...agg });
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
  const classes = await classesForSubject(db, subjectId, opts);
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

/** Class/subject/teacher display names for the letterhead. Tries the
 *  class_subject_assignments cache first (richer — carries a teacher name),
 *  then falls back to attendance_records (class_name is denormalised on
 *  every row) joined to `subjects` for the subject name. Without this
 *  fallback, a (class, subject) pair missing from the cache — the same
 *  staleness this file already routes around for *scoping* elsewhere —
 *  silently produced a raw class id and a null subject name, which the
 *  frontend then mislabeled as "Homeroom" purely because the name came back
 *  empty. Reported bug: letterhead showed "Class: 26 / Subject: Homeroom"
 *  while viewing a real subject (Web3 Applications) whose class had no
 *  synced roster row. */
async function resolveSectionMeta(
  db: Database, classId: string, sessionType: 'homeroom' | 'subject', subjectId?: number
): Promise<{ className: string | null; subjectName: string | null; teacherName: string | null } | undefined> {
  if (sessionType !== 'subject') {
    const row = await db.get(`SELECT class_name as className FROM attendance_records WHERE class_id = ? LIMIT 1`, classId);
    return row ? { className: row.className, subjectName: null, teacherName: null } : undefined;
  }

  const cached = await db.get(
    `SELECT class_name as className, subject_name as subjectName, teacher_name as teacherName
       FROM class_subject_assignments WHERE class_id = ? AND subject_id = ? LIMIT 1`,
    classId, subjectId
  );
  if (cached?.className && cached?.subjectName) return cached;

  const fallback = await db.get(
    `SELECT ar.class_name as className, s.name as subjectName
       FROM attendance_records ar LEFT JOIN subjects s ON s.id = ar.subject_id
      WHERE ar.class_id = ? AND ar.subject_id = ? LIMIT 1`,
    classId, subjectId
  );
  return {
    className: cached?.className ?? fallback?.className ?? null,
    subjectName: cached?.subjectName ?? fallback?.subjectName ?? null,
    teacherName: cached?.teacherName ?? null,
  };
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
    resolveSectionMeta(db, p.classId, p.sessionType, p.subjectId),
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

/**
 * A student's own attendance register — same query as getClassSectionReport
 * (auto-scoped to their own class, never a class they pick), with the result
 * narrowed to their own row before it ever leaves the server. This is a
 * privacy boundary, not just a UI filter: a student must never receive a
 * classmate's attendance record over the wire, even transiently.
 */
export async function getOwnSectionReport(
  db: Database, studentId: string, p: Omit<ClassSectionReportParams, 'classId'>
): Promise<ClassSectionReport> {
  const classId = await resolveOwnClassId(db, studentId);
  if (!classId) {
    return {
      classId: '', className: 'Your class', sessionType: p.sessionType,
      subjectId: p.sessionType === 'subject' ? p.subjectId ?? null : null,
      subjectName: null, teacherName: null, academicTermId: p.academicTermId ?? null,
      dateColumns: [], students: [], classAverageRate: 100,
    };
  }
  const full = await getClassSectionReport(db, { ...p, classId });
  const own = full.students.find((s) => s.studentId === studentId) ?? null;
  return { ...full, students: own ? [own] : [], classAverageRate: own ? own.rate : 100 };
}

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
  comment: ReturnType<typeof attendanceComment>;
  /** False when nothing has been recorded for this section yet in the
   *  selected range — every count (including `rate`) is a real 0, not the
   *  "innocent until proven guilty" 100 the single-section view defaults to.
   *  A comparison list that quietly showed an untouched subject as "100%"
   *  would misread as perfect attendance rather than "nothing to show yet",
   *  so this view deliberately zero-fills and flags it instead. */
  hasData: boolean;
}

/** Every section (homeroom + each subject) for a student's own class, side
 *  by side — the "All Subjects" comparison view. Reuses listOwnSections for
 *  the roster (already resilient to a stale sync cache) and
 *  getOwnSectionReport per section for the numbers. */
export async function getOwnSubjectsOverview(
  db: Database, studentId: string, opts: { academicTermId?: number; fromDate?: string; toDate?: string }
): Promise<OwnSubjectSummary[]> {
  const sections = await listOwnSections(db, studentId, opts.academicTermId);
  return Promise.all(
    sections.map(async (sec): Promise<OwnSubjectSummary> => {
      const report = await getOwnSectionReport(db, studentId, {
        academicTermId: opts.academicTermId, fromDate: opts.fromDate, toDate: opts.toDate,
        sessionType: sec.kind, subjectId: sec.kind === 'subject' ? sec.subjectId : undefined,
      });
      const own = report.students[0];
      const hasData = !!own && own.total > 0;
      return {
        kind: sec.kind,
        subjectId: sec.kind === 'subject' ? sec.subjectId : null,
        subjectName: sec.kind === 'subject' ? sec.subjectName : null,
        present: own?.present ?? 0,
        absent: own?.absent ?? 0,
        late: own?.late ?? 0,
        excused: own?.excused ?? 0,
        total: own?.total ?? 0,
        rate: hasData ? own!.rate : 0,
        comment: hasData ? own!.comment : attendanceComment(0),
        hasData,
      };
    })
  );
}
