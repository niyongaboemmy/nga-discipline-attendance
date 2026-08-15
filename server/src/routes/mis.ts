import { Router, Response } from 'express';
import { config } from '../config.js';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth.js';
import { authorizePermission } from '../middleware/authorize.js';

/**
 * MIS roster proxy.
 *
 * Reads classes, students, staff and timetables from the NGA Central MIS on
 * behalf of the signed-in user. Every request is authenticated locally (JWT)
 * and forwarded to the MIS with that user's MIS access token, so the MIS
 * enforces its own authorization on the underlying records.
 *
 * The upstream resource paths default to `${NGA_MIS_BASE_URL}/<resource>` and
 * can be overridden via env (MIS_*_PATH) if the MIS exposes them elsewhere.
 */
const router = Router();

router.use(authMiddleware);
router.use(authorizePermission('ROSTER_VIEW'));

const paths = {
  classes: process.env.MIS_CLASSES_PATH || '/classes',
  students: process.env.MIS_STUDENTS_PATH || '/students',
  staff: process.env.MIS_STAFF_PATH || '/staff',
  schedule: process.env.MIS_SCHEDULE_PATH || '/schedule',
};

/** Forward a GET to the MIS and return its (normalized) list payload. */
async function proxy(
  req: AuthenticatedRequest,
  res: Response,
  path: string,
  query?: Record<string, string | undefined>
) {
  const misToken = req.user?.misToken;
  if (!misToken) {
    return res.status(403).json({
      success: false,
      message: 'This session is not linked to the MIS, so roster data is unavailable.',
    });
  }

  const url = new URL(`${config.ngaMisBaseUrl}${path}`);
  for (const [key, value] of Object.entries(query || {})) {
    if (value) url.searchParams.set(key, value);
  }

  try {
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${misToken}`, Accept: 'application/json' },
    });
    if (!resp.ok) {
      return res.status(resp.status).json({
        success: false,
        message: `MIS returned ${resp.status} for ${path}.`,
      });
    }
    const body = (await resp.json()) as any;
    const data = Array.isArray(body) ? body : body.data ?? body.results ?? [];
    return res.json({ success: true, data });
  } catch (error) {
    console.error(`MIS proxy error (${path}):`, (error as Error).message);
    return res.status(502).json({
      success: false,
      message: 'Could not reach the NGA Central MIS. Please try again.',
    });
  }
}

router.get('/classes', (req: any, res) => proxy(req, res, paths.classes));

router.get('/students', (req: any, res) =>
  proxy(req, res, paths.students, { class_id: req.query.class_id }));

router.get('/staff', (req: any, res) => proxy(req, res, paths.staff));

router.get('/schedule', (req: any, res) =>
  proxy(req, res, paths.schedule, { class_id: req.query.class_id }));

export default router;
