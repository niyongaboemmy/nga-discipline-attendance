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
