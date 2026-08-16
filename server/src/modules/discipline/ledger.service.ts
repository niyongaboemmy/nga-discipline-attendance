import { Database } from 'sqlite';

export interface TermBalance {
  studentId: string;
  studentName: string;
  academicYearId: number | null;
  academicTermId: number | null;
  balance: number;
  meritPoints: number;
  demeritPoints: number;
  eventCount: number;
}

/**
 * Aggregated directly over `discipline_records` rather than the
 * `discipline_term_balance` view (see database.ts). The view is grouped by
 * (student_id, academic_year_id, academic_term_id), so a student with both a
 * legacy NULL-term group and a real-term group produces *two* view rows —
 * a plain `WHERE (academic_term_id = ? OR academic_term_id IS NULL)` on the
 * view matches both groups separately instead of merging them, returning
 * whichever one the driver happens to pick first (or, for listTermBalances,
 * silently duplicating the student). Aggregating the base table directly
 * with this same WHERE clause folds legacy rows into the single balance
 * they should have always counted toward.
 */
const AGGREGATE_SQL = `
  student_id as studentId,
  MAX(student_name) as studentName,
  SUM(CASE WHEN type = 'merit' THEN points ELSE 0 END) as meritPoints,
  SUM(CASE WHEN type = 'demerit' THEN points ELSE 0 END) as demeritPoints,
  COUNT(*) as eventCount
`;

function toBalance(row: { meritPoints: number; demeritPoints: number }): number {
  return Math.max(0, Math.min(100, 100 + row.meritPoints - row.demeritPoints));
}

/** A student's running point balance for one academic term (B.0/B.3).
 *  Returns a clean zero-state row if the student has no records yet. */
export async function getStudentTermBalance(
  db: Database,
  studentId: string,
  academicYearId?: number,
  academicTermId?: number
): Promise<TermBalance> {
  const termClause = academicTermId != null
    ? 'AND (academic_term_id = ? OR academic_term_id IS NULL)'
    : 'AND academic_term_id IS NULL';
  const params = academicTermId != null ? [studentId, academicTermId] : [studentId];

  const row = await db.get(
    `SELECT ${AGGREGATE_SQL} FROM discipline_records
     WHERE student_id = ? AND status != 'dismissed' ${termClause}
     GROUP BY student_id`,
    ...params
  );

  if (row) {
    return {
      studentId, studentName: row.studentName, academicYearId: academicYearId ?? null,
      academicTermId: academicTermId ?? null, balance: toBalance(row),
      meritPoints: row.meritPoints, demeritPoints: row.demeritPoints, eventCount: row.eventCount,
    };
  }

  const student = await db.get(
    `SELECT student_name FROM discipline_records WHERE student_id = ? ORDER BY created_at DESC LIMIT 1`,
    studentId
  );
  return {
    studentId,
    studentName: student?.student_name ?? studentId,
    academicYearId: academicYearId ?? null,
    academicTermId: academicTermId ?? null,
    balance: 100,
    meritPoints: 0,
    demeritPoints: 0,
    eventCount: 0,
  };
}

/** Term balances for every student with discipline activity in a term —
 *  the roster-hierarchy stats requirement (B.4) starts from this list, then
 *  joins against the MIS roster cache for class/grade/program grouping. */
export async function listTermBalances(
  db: Database,
  academicTermId?: number
): Promise<TermBalance[]> {
  const termClause = academicTermId != null
    ? 'AND (academic_term_id = ? OR academic_term_id IS NULL)'
    : 'AND academic_term_id IS NULL';
  const params = academicTermId != null ? [academicTermId] : [];

  const rows = await db.all(
    `SELECT ${AGGREGATE_SQL} FROM discipline_records
     WHERE status != 'dismissed' ${termClause}
     GROUP BY student_id`,
    ...params
  );

  return rows
    .map((row: any) => ({
      studentId: row.studentId, studentName: row.studentName, academicYearId: null,
      academicTermId: academicTermId ?? null, balance: toBalance(row),
      meritPoints: row.meritPoints, demeritPoints: row.demeritPoints, eventCount: row.eventCount,
    }))
    .sort((a, b) => a.balance - b.balance);
}
