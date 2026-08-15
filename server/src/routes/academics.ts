import { Router, Response } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth.js';

/**
 * Academic year/term integration with the NGA Central MIS.
 *
 * The MIS is the sole source of truth for academic years/terms — this app never
 * creates its own. It exposes `/academics/years` and `/academics/terms` but has
 * no dedicated "current period" endpoint, so "current" is derived from
 * `GET /users/me`, which bundles `currentAcademicYear`/`currentAcademicTerms`
 * (see SSO_CLIENT_INTEGRATION.md in nga_central_mis).
 */
const router = Router();

router.use(authMiddleware);

/** Fetch the caller's current academic year + terms-in-that-year from the MIS. */
async function fetchCurrentPeriod(misToken: string) {
  const resp = await fetch(`${config.ngaMisBaseUrl}/users/me`, {
    headers: { Authorization: `Bearer ${misToken}`, Accept: 'application/json' },
  });
  if (!resp.ok) return null;
  const body = (await resp.json()) as any;
  const data = body.data ?? body;
  return {
    currentAcademicYear: data.currentAcademicYear ?? null,
    currentAcademicTerms: data.currentAcademicTerms ?? [],
  };
}

router.get('/years', async (req: AuthenticatedRequest, res: Response) => {
  const misToken = req.user?.misToken;
  if (!misToken) {
    return res.status(403).json({ success: false, message: 'This session is not linked to the MIS.' });
  }
  try {
    const resp = await fetch(`${config.ngaMisBaseUrl}/academics/years`, {
      headers: { Authorization: `Bearer ${misToken}`, Accept: 'application/json' },
    });
    if (!resp.ok) {
      return res.status(resp.status).json({ success: false, message: `MIS returned ${resp.status} for /academics/years.` });
    }
    const body = (await resp.json()) as any;
    const data = Array.isArray(body) ? body : body.data ?? body.results ?? [];
    return res.json({ success: true, data });
  } catch (error) {
    console.error('Academics years proxy error:', (error as Error).message);
    return res.status(502).json({ success: false, message: 'Could not reach the NGA Central MIS. Please try again.' });
  }
});

router.get('/terms', async (req: AuthenticatedRequest, res: Response) => {
  const misToken = req.user?.misToken;
  if (!misToken) {
    return res.status(403).json({ success: false, message: 'This session is not linked to the MIS.' });
  }
  try {
    const url = new URL(`${config.ngaMisBaseUrl}/academics/terms`);
    const yearId = req.query.academic_year_id;
    if (yearId) url.searchParams.set('academic_year_id', String(yearId));

    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${misToken}`, Accept: 'application/json' },
    });
    if (!resp.ok) {
      return res.status(resp.status).json({ success: false, message: `MIS returned ${resp.status} for /academics/terms.` });
    }
    const body = (await resp.json()) as any;
    const data = Array.isArray(body) ? body : body.data ?? body.results ?? [];
    return res.json({ success: true, data });
  } catch (error) {
    console.error('Academics terms proxy error:', (error as Error).message);
    return res.status(502).json({ success: false, message: 'Could not reach the NGA Central MIS. Please try again.' });
  }
});

router.get('/current', async (req: AuthenticatedRequest, res: Response) => {
  const misToken = req.user?.misToken;
  if (!misToken) {
    return res.status(403).json({ success: false, message: 'This session is not linked to the MIS.' });
  }
  try {
    const period = await fetchCurrentPeriod(misToken);
    if (!period) {
      return res.status(502).json({ success: false, message: 'Could not resolve the current academic period from the MIS.' });
    }
    return res.json({ success: true, data: period });
  } catch (error) {
    console.error('Academics current-period error:', (error as Error).message);
    return res.status(502).json({ success: false, message: 'Could not reach the NGA Central MIS. Please try again.' });
  }
});

router.post('/switch', async (req: AuthenticatedRequest, res: Response) => {
  const misToken = req.user?.misToken;
  if (!misToken || !req.user) {
    return res.status(403).json({ success: false, message: 'This session is not linked to the MIS.' });
  }

  const academicYearId = Number(req.body?.academic_year_id);
  const academicTermId = Number(req.body?.academic_term_id);
  if (!Number.isFinite(academicYearId) || !Number.isFinite(academicTermId)) {
    return res.status(400).json({ success: false, message: 'academic_year_id and academic_term_id are required.' });
  }

  try {
    // Validate the requested pair is real by checking it appears in the MIS's
    // term list for that year — prevents switching into an id that doesn't exist.
    const url = new URL(`${config.ngaMisBaseUrl}/academics/terms`);
    url.searchParams.set('academic_year_id', String(academicYearId));
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${misToken}`, Accept: 'application/json' },
    });
    if (!resp.ok) {
      return res.status(resp.status).json({ success: false, message: `MIS returned ${resp.status} while validating the academic period.` });
    }
    const body = (await resp.json()) as any;
    const terms = Array.isArray(body) ? body : body.data ?? body.results ?? [];
    const match = terms.find((t: any) => Number(t.academic_term_id) === academicTermId);
    if (!match) {
      return res.status(400).json({ success: false, message: 'That academic term was not found for the given year.' });
    }

    const { misToken: _misToken, iat, exp, ...rest } = req.user as any;
    const updatedUser = { ...rest, academicYearId, academicTermId };
    const token = jwt.sign({ ...updatedUser, misToken }, config.jwtSecret, { expiresIn: '24h' });

    return res.json({ success: true, data: { token, user: updatedUser } });
  } catch (error) {
    console.error('Academics switch error:', (error as Error).message);
    return res.status(502).json({ success: false, message: 'Could not reach the NGA Central MIS. Please try again.' });
  }
});

export default router;
