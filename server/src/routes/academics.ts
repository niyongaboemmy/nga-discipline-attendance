import { Router, Response } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth.js';
import { authorizePermission } from '../middleware/authorize.js';
import { resolveCurrentAcademicPeriod } from '../utils/misAcademics.js';
import { getDb } from '../database.js';
import { syncAll } from '../modules/academics/academicsSync.service.js';

/**
 * Academic year/term integration with the NGA Central MIS.
 *
 * The MIS is the sole source of truth for academic years/terms — this app never
 * creates its own. It exposes `/academics/years` and `/academics/terms` but has
 * no dedicated "current period" endpoint, so "current" is derived from the
 * misToken's own JWT payload (falling back to `GET /users/me`) via
 * utils/misAcademics.ts.
 */
const router = Router();

router.use(authMiddleware);

router.get('/years', authorizePermission('ACADEMIC_PERIOD_VIEW'), async (req: AuthenticatedRequest, res: Response) => {
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

router.get('/terms', authorizePermission('ACADEMIC_PERIOD_VIEW'), async (req: AuthenticatedRequest, res: Response) => {
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

router.get('/current', authorizePermission('ACADEMIC_PERIOD_VIEW'), async (req: AuthenticatedRequest, res: Response) => {
  const misToken = req.user?.misToken;
  if (!misToken) {
    return res.status(403).json({ success: false, message: 'This session is not linked to the MIS.' });
  }
  try {
    const period = await resolveCurrentAcademicPeriod(misToken);
    return res.json({ success: true, data: period });
  } catch (error) {
    console.error('Academics current-period error:', (error as Error).message);
    return res.status(502).json({ success: false, message: 'Could not reach the NGA Central MIS. Please try again.' });
  }
});

router.post('/switch', authorizePermission('ACADEMIC_PERIOD_SWITCH'), async (req: AuthenticatedRequest, res: Response) => {
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

    // Only carry the plain JWT-claim fields forward — req.user also has RBAC
    // fields (roleId/roleName/roleLevel/permissions) that authMiddleware
    // resolves fresh from the DB every request and must never be baked into
    // the token itself (permissions is a Set, which doesn't even survive
    // JSON serialization).
    const { id, name, email, role, preferred_theme } = req.user as any;
    const updatedUser = { id, name, email, role, preferred_theme, academicYearId, academicTermId };
    const token = jwt.sign({ ...updatedUser, misToken }, config.jwtSecret, { expiresIn: '24h' });

    return res.json({ success: true, data: { token, user: updatedUser } });
  } catch (error) {
    console.error('Academics switch error:', (error as Error).message);
    return res.status(502).json({ success: false, message: 'Could not reach the NGA Central MIS. Please try again.' });
  }
});

// Locally cached subjects (synced from the MIS schedule — see /sync below).
// Used by the client's homeroom/subject attendance toggle (A.1.2) without a
// round-trip to the MIS on every page load.
router.get('/subjects', authorizePermission('ROSTER_VIEW'), async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const subjects = await getDb().all(`SELECT id, name, code FROM subjects ORDER BY name`);
    return res.json({ success: true, data: subjects });
  } catch (error) {
    console.error('Error listing cached subjects:', error);
    return res.status(500).json({ success: false, message: 'Error fetching subjects.' });
  }
});

/**
 * Refresh the local academic-year/term + subject/timetable cache from the
 * MIS (Phase 1 + Phase 3). Admin maintenance action — not called on every
 * request, since the underlying MIS data changes rarely within a term.
 */
router.post('/sync', authorizePermission('ROSTER_SYNC'), async (req: AuthenticatedRequest, res: Response) => {
  const misToken = req.user?.misToken;
  if (!misToken) {
    return res.status(403).json({ success: false, message: 'This session is not linked to the MIS.' });
  }
  try {
    const result = await syncAll(getDb(), misToken);
    return res.json({ success: true, data: result, message: 'Academic period and roster cache synced.' });
  } catch (error) {
    console.error('Academics sync error:', (error as Error).message);
    return res.status(502).json({ success: false, message: 'Could not sync from the NGA Central MIS. Please try again.' });
  }
});

export default router;
