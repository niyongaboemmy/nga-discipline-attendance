import { config } from '../config.js';
import jwt from 'jsonwebtoken';

/** Pull `{ academicYearId, academicTermId }` out of a MIS payload shaped like
 *  `{ currentAcademicYear, currentAcademicTerms }` (used both for the decoded
 *  misToken and the `/users/me` fallback response). */
export function extractCurrentPeriod(data: any): { academicYearId?: number; academicTermId?: number } {
  const year = data?.currentAcademicYear;
  const terms: any[] = Array.isArray(data?.currentAcademicTerms) ? data.currentAcademicTerms : [];
  const currentTerm = terms.find((t) => Number(t.is_current) === 1) || terms[0];
  return {
    academicYearId: year?.academic_year_id != null ? Number(year.academic_year_id) : undefined,
    academicTermId: currentTerm?.academic_term_id != null ? Number(currentTerm.academic_term_id) : undefined,
  };
}

/**
 * Resolve the caller's current academic year/term from the MIS.
 *
 * The token minted by `POST /sso/token` already embeds `currentAcademicYear`/
 * `currentAcademicTerms` directly in its JWT payload (see
 * nga_central_mis/backend/src/controllers/ssoController.ts, `getSSOToken`) —
 * decoding it locally is instant and has no failure mode beyond a malformed
 * token. We only fall back to a live `GET /users/me` call (per
 * SSO_CLIENT_INTEGRATION.md) if that payload doesn't carry the claim, e.g. an
 * older MIS deployment or a misToken minted some other way.
 */
export async function resolveCurrentAcademicPeriod(
  misToken: string
): Promise<{ academicYearId?: number; academicTermId?: number }> {
  try {
    const decoded = jwt.decode(misToken) as any;
    if (decoded?.currentAcademicYear || decoded?.currentAcademicTerms) {
      const fromToken = extractCurrentPeriod(decoded);
      if (fromToken.academicYearId != null || fromToken.academicTermId != null) return fromToken;
    }
  } catch (error) {
    console.error('Could not decode misToken for academic period:', (error as Error).message);
  }

  try {
    const resp = await fetch(`${config.ngaMisBaseUrl}/users/me`, {
      headers: { Authorization: `Bearer ${misToken}`, Accept: 'application/json' },
    });
    if (!resp.ok) {
      console.error(`MIS /users/me returned ${resp.status} while resolving the current academic period.`);
      return {};
    }
    const body = (await resp.json()) as any;
    return extractCurrentPeriod(body.data ?? body);
  } catch (error) {
    console.error('Could not resolve current academic period from MIS:', (error as Error).message);
    return {};
  }
}
