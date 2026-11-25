import { INACTIVE_IDS_SQL } from '../services/activeStudents.js';

/**
 * Which attendance_records rows a report or a count may use. Every attendance
 * report, dashboard number, report-card import and low-attendance warning
 * builds its WHERE clause from these two helpers, so they all count the same rows.
 *
 * The registers themselves are never deleted. A student's own page and the
 * raw records log still show every row; only aggregates use these filters.
 */

// Always qualified: inside the correlated subqueries below a bare `class_id`
// or `student_id` would bind to the roster table's own column, not the row's.
// Callers that pass no alias must select FROM attendance_records unaliased.
const col = (alias: string, name: string) => `${alias || 'attendance_records'}.${name}`;

/**
 * ` AND <row belongs to term>`. A row stored with its term id matches that term.
 * A row with no term id (recorded before the term calendar was synced, or on a
 * date no term covered) matches the term whose dates contain its session date.
 *
 * The old rule, `academic_term_id = ? OR academic_term_id IS NULL`, put every
 * untermed row into every term. Term comparisons, annual totals and
 * "this term" rates all counted those rows more than once.
 *
 * If the term is not in the local academic_terms cache, or its dates are not
 * set, untermed rows still match. That was the old behaviour, so no data
 * disappears when the cache is empty.
 */
export function attendanceTermSql(academicTermId: number | null | undefined, alias = ''): { sql: string; params: any[] } {
  if (academicTermId == null) return { sql: '', params: [] };
  const term = col(alias, 'academic_term_id');
  const date = col(alias, 'session_date');
  return {
    sql: ` AND (${term} = ? OR (${term} IS NULL AND (
        NOT EXISTS (SELECT 1 FROM academic_terms tq WHERE tq.id = ?)
        OR EXISTS (SELECT 1 FROM academic_terms tq WHERE tq.id = ?
                     AND (tq.start_date IS NULL OR date(${date}) >= date(tq.start_date))
                     AND (tq.end_date IS NULL OR date(${date}) <= date(tq.end_date))))))`,
    params: [academicTermId, academicTermId, academicTermId],
  };
}

/**
 * ` AND <row's student still counts for this class>`. A row is left out when:
 *  - the student is known inactive: users.status = 'inactive', or the roster's
 *    MIS status is not ACTIVE (INACTIVE, SUSPENDED, or REMOVED from the MIS); or
 *  - the student was removed from the class. The roster lists this class for
 *    the row's academic year (so Tendo knows its members), and the student has
 *    no ACTIVE enrolment in it that year.
 *
 * A student with no synced status, or a class the roster has never seen, is
 * kept. A stale or empty cache must not make registers vanish from a report.
 * Rows with no academic year use the roster's current (latest active) year.
 */
export function reportableStudentSql(alias = ''): string {
  const student = col(alias, 'student_id');
  const classId = col(alias, 'class_id');
  const year = `COALESCE(${col(alias, 'academic_year_id')},
      (SELECT MAX(academic_year_id) FROM roster_enrolments WHERE status = 'ACTIVE'))`;
  return ` AND CAST(${student} AS TEXT) NOT IN (${INACTIVE_IDS_SQL})
    AND NOT (
      EXISTS (SELECT 1 FROM roster_enrolments rk
               WHERE rk.class_id = CAST(${classId} AS TEXT) AND rk.academic_year_id = ${year})
      AND NOT EXISTS (SELECT 1 FROM roster_enrolments rm
               WHERE rm.class_id = CAST(${classId} AS TEXT) AND rm.academic_year_id = ${year}
                 AND rm.student_id = CAST(${student} AS TEXT) AND rm.status = 'ACTIVE'))`;
}

/** Both filters together: the rows an attendance aggregate may count. */
export function reportableAttendanceSql(academicTermId: number | null | undefined, alias = ''): { sql: string; params: any[] } {
  const term = attendanceTermSql(academicTermId, alias);
  return { sql: term.sql + reportableStudentSql(alias), params: term.params };
}
