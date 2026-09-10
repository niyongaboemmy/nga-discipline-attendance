/**
 * Remediation A6 — the single source of truth for "what counts as attendance".
 *
 * Before this, three definitions were in play: the low-attendance warning
 * counted `present` only, reporting counted `present + late`, and the student's
 * own page counted `present + late + excused`. The 80% warning therefore fired
 * against a number shown nowhere. Every read path and the warning check now
 * import from here.
 */

export const ATTENDANCE_STATUSES = ['present', 'absent', 'late', 'excused'] as const;
export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number];

/** Statuses that count towards a student's attendance rate. A late arrival and
 *  an authorised absence both count as "did not skip"; only an unexcused
 *  `absent` counts against the rate. */
export const ATTENDED_STATUSES: readonly AttendanceStatus[] = ['present', 'late', 'excused'];

/** Below this attendance rate (%), a student is flagged / warned. */
export const ATTENDANCE_WARN_THRESHOLD = Number(process.env.ATTENDANCE_WARN_THRESHOLD || 80);

/** Minimum recorded sessions before the rate is considered meaningful. */
export const ATTENDANCE_MIN_SESSIONS = Number(process.env.ATTENDANCE_MIN_SESSIONS || 3);

export function isAttended(status: string): boolean {
  return (ATTENDED_STATUSES as readonly string[]).includes(status);
}

/** SQL fragment: `1` when the row counts as attended, else `0`. Use inside
 *  `SUM(CASE WHEN ... )`. Kept here so the list of statuses can't drift between
 *  the JS predicate and the aggregate queries. */
export const ATTENDED_SQL_CASE =
  "CASE WHEN status IN ('present','late','excused') THEN 1 ELSE 0 END";

export function attendanceRate(attended: number, total: number): number {
  if (!total || total <= 0) return 100;
  return Math.round((attended / total) * 100);
}
