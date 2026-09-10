import { Database } from 'sqlite';
import { listTermBalances } from '../discipline/ledger.service.js';
import { ATTENDED_SQL_CASE, attendanceRate } from '../../shared/attendancePolicy.js';

/** Unified reporting (C): termly/annual/combined/comparison views reading
 *  from attendance_records + discipline_records + the term-balance view,
 *  replacing the two previously-separate ad hoc analytics implementations
 *  in routes/reports.ts and routes/discipline.ts's /overview. */

function periodFilter(column: string, academicTermId?: number): { clause: string; params: any[] } {
  if (academicTermId == null) return { clause: '', params: [] };
  return { clause: ` AND (${column} = ? OR ${column} IS NULL)`, params: [academicTermId] };
}

export interface AttendanceSummary {
  overallRate: number;
  totalRecords: number;
  bySessionType: Array<{ sessionType: string; total: number; presentRate: number }>;
}

export async function getAttendanceSummary(db: Database, academicTermId?: number): Promise<AttendanceSummary> {
  const { clause, params } = periodFilter('academic_term_id', academicTermId);
  const [overall, bySessionType] = await Promise.all([
    // Remediation A7: the headline rate is the homeroom (overall daily
    // attendance) signal only. Mixing subject sessions in counted a day with a
    // homeroom register plus three subject registers as four "sessions".
    db.get(
      `SELECT COUNT(*) as total, SUM(${ATTENDED_SQL_CASE}) as attended
       FROM attendance_records WHERE session_type = 'homeroom'${clause}`,
      ...params
    ),
    db.all(
      `SELECT session_type as sessionType, COUNT(*) as total,
              SUM(${ATTENDED_SQL_CASE}) as attended
       FROM attendance_records WHERE 1=1${clause}
       GROUP BY session_type`,
      ...params
    ),
  ]);
  return {
    overallRate: attendanceRate(overall.attended, overall.total),
    totalRecords: overall.total || 0,
    bySessionType: bySessionType.map((r: any) => ({
      sessionType: r.sessionType,
      total: r.total,
      presentRate: attendanceRate(r.attended, r.total),
    })),
  };
}

export interface DisciplineSummary {
  totalRecords: number;
  demerits: number;
  merits: number;
  averageBalance: number;
  atRiskCount: number;
}

export async function getDisciplineSummary(db: Database, academicTermId?: number): Promise<DisciplineSummary> {
  const { clause, params } = periodFilter('academic_term_id', academicTermId);
  const [totals, balances] = await Promise.all([
    db.get(
      `SELECT COUNT(*) as total,
              SUM(CASE WHEN type='demerit' THEN 1 ELSE 0 END) as demerits,
              SUM(CASE WHEN type='merit' THEN 1 ELSE 0 END) as merits
       FROM discipline_records WHERE 1=1${clause}`,
      ...params
    ),
    // Reuses ledger.service.ts's aggregation (not a raw view query) so legacy
    // NULL-term rows correctly fold into the current term's balance instead
    // of being counted as a separate, silently-ignored group — see the
    // comment on listTermBalances for why a plain view WHERE can't do this.
    listTermBalances(db, academicTermId),
  ]);
  const averageBalance = balances.length
    ? Math.round(balances.reduce((sum, b) => sum + b.balance, 0) / balances.length)
    : 100;
  return {
    totalRecords: totals.total || 0,
    demerits: totals.demerits || 0,
    merits: totals.merits || 0,
    averageBalance,
    atRiskCount: balances.filter((b) => b.balance < 70).length,
  };
}

export interface CombinedReport {
  academicTermId: number | null;
  attendance: AttendanceSummary;
  discipline: DisciplineSummary;
  /** Students whose attendance rate is also low AND whose conduct balance is
   *  low — the "combined" signal the requirements ask for, so leadership can
   *  spot compounding risk instead of reading two disconnected reports. */
  studentsAtCombinedRisk: Array<{ studentId: string; studentName: string; attendanceRate: number; conductBalance: number }>;
}

export async function getCombinedReport(db: Database, academicTermId?: number): Promise<CombinedReport> {
  const [attendance, discipline] = await Promise.all([
    getAttendanceSummary(db, academicTermId),
    getDisciplineSummary(db, academicTermId),
  ]);

  const { clause, params } = periodFilter('academic_term_id', academicTermId);
  const [attendanceByStudent, balanceByStudent] = await Promise.all([
    db.all(
      `SELECT student_id as studentId, student_name as studentName,
              COUNT(*) as total, SUM(${ATTENDED_SQL_CASE}) as attended
       FROM attendance_records WHERE session_type = 'homeroom'${clause}
       GROUP BY student_id
       HAVING total >= 3`,
      ...params
    ),
    listTermBalances(db, academicTermId),
  ]);
  const balanceMap = new Map(balanceByStudent.map((b) => [b.studentId, b.balance]));

  const studentsAtCombinedRisk = attendanceByStudent
    .map((a: any) => ({
      studentId: a.studentId,
      studentName: a.studentName,
      attendanceRate: attendanceRate(a.attended, a.total),
      conductBalance: balanceMap.get(a.studentId) ?? 100,
    }))
    .filter((s) => s.attendanceRate < 80 && s.conductBalance < 80)
    .sort((a, b) => (a.attendanceRate + a.conductBalance) - (b.attendanceRate + b.conductBalance));

  return { academicTermId: academicTermId ?? null, attendance, discipline, studentsAtCombinedRisk };
}

export interface TermComparison {
  termA: { academicTermId: number; attendance: AttendanceSummary; discipline: DisciplineSummary };
  termB: { academicTermId: number; attendance: AttendanceSummary; discipline: DisciplineSummary };
  deltas: { attendanceRate: number; disciplineAverageBalance: number; demerits: number; merits: number };
}

export async function compareTerms(db: Database, termAId: number, termBId: number): Promise<TermComparison> {
  const [attendanceA, disciplineA, attendanceB, disciplineB] = await Promise.all([
    getAttendanceSummary(db, termAId),
    getDisciplineSummary(db, termAId),
    getAttendanceSummary(db, termBId),
    getDisciplineSummary(db, termBId),
  ]);
  return {
    termA: { academicTermId: termAId, attendance: attendanceA, discipline: disciplineA },
    termB: { academicTermId: termBId, attendance: attendanceB, discipline: disciplineB },
    deltas: {
      attendanceRate: attendanceB.overallRate - attendanceA.overallRate,
      disciplineAverageBalance: disciplineB.averageBalance - disciplineA.averageBalance,
      demerits: disciplineB.demerits - disciplineA.demerits,
      merits: disciplineB.merits - disciplineA.merits,
    },
  };
}

/** Annual rollup: aggregate across every term cached under one academic year. */
export async function getAnnualReport(db: Database, academicYearId: number) {
  const terms = await db.all(`SELECT id, name FROM academic_terms WHERE academic_year_id = ? ORDER BY start_date`, academicYearId);
  const perTerm = await Promise.all(
    terms.map(async (t: any) => {
      const [attendance, discipline] = await Promise.all([
        getAttendanceSummary(db, t.id),
        getDisciplineSummary(db, t.id),
      ]);
      return { academicTermId: t.id, termName: t.name, attendance, discipline };
    })
  );
  const attendanceRates = perTerm.map((t) => t.attendance.overallRate).filter((r) => !Number.isNaN(r));
  const balances = perTerm.map((t) => t.discipline.averageBalance).filter((r) => !Number.isNaN(r));
  return {
    academicYearId,
    terms: perTerm,
    yearAttendanceRate: attendanceRates.length ? Math.round(attendanceRates.reduce((a, b) => a + b, 0) / attendanceRates.length) : 100,
    yearAverageBalance: balances.length ? Math.round(balances.reduce((a, b) => a + b, 0) / balances.length) : 100,
  };
}
