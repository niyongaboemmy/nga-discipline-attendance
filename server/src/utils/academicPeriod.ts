import { Database } from 'sqlite';
import { AuthenticatedRequest } from '../middleware/auth.js';

export interface AcademicPeriod {
  academicYearId?: number;
  academicTermId?: number;
}

/**
 * Resolve the academic year/term a request should be scoped to.
 *
 * Precedence:
 * 1. Explicit query override (`?academic_year_id=`, `?academic_term_id=`) — lets a
 *    caller view a specific historical period without touching their session.
 * 2. The session default carried in the JWT (set at login, updated by `/academics/switch`).
 * 3. Neither — the request is unscoped (older tokens minted before this feature,
 *    or a caller with no MIS link). Callers should treat this as "match anything".
 */
export function resolveAcademicPeriod(req: AuthenticatedRequest): AcademicPeriod {
  const queryYear = req.query.academic_year_id;
  const queryTerm = req.query.academic_term_id;

  const academicYearId = queryYear != null && queryYear !== ''
    ? Number(queryYear)
    : req.user?.academicYearId;

  const academicTermId = queryTerm != null && queryTerm !== ''
    ? Number(queryTerm)
    : req.user?.academicTermId;

  return {
    academicYearId: Number.isFinite(academicYearId) ? academicYearId : undefined,
    academicTermId: Number.isFinite(academicTermId) ? academicTermId : undefined,
  };
}

/**
 * Remediation X3 — a record must be filed under the academic period its *date*
 * falls in, not whichever term the acting user's session currently points at.
 * Back-dating attendance or an incident into a previous term otherwise stamps
 * it with today's term and it vanishes from that term's reports.
 *
 * Looks the date up against the cached `academic_terms` calendar. Falls back to
 * the caller's session period only when the date matches no known term (e.g.
 * the calendar hasn't been synced yet), so behaviour never regresses to worse
 * than today's.
 */
export async function resolveAcademicPeriodForDate(
  db: Database,
  dateStr: string,
  fallback: AcademicPeriod = {}
): Promise<AcademicPeriod> {
  try {
    const term = await db.get(
      `SELECT id, academic_year_id
         FROM academic_terms
        WHERE start_date IS NOT NULL AND end_date IS NOT NULL
          AND date(?) BETWEEN date(start_date) AND date(end_date)
        ORDER BY start_date DESC
        LIMIT 1`,
      dateStr
    );
    if (term) {
      return { academicYearId: term.academic_year_id ?? undefined, academicTermId: term.id };
    }
  } catch (err) {
    console.error('resolveAcademicPeriodForDate lookup failed:', (err as Error).message);
  }
  return fallback;
}
