import { Router, Response } from 'express';
import { config } from '../config.js';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth.js';
import { authorizePermission } from '../middleware/authorize.js';
import { resolveCurrentAcademicPeriod } from '../utils/misAcademics.js';

/**
 * MIS roster proxy.
 *
 * Reads class groups, students, staff and timetables from the NGA Central
 * MIS on behalf of the signed-in user. Every request is authenticated
 * locally (JWT) and forwarded to the MIS with that user's MIS access token,
 * so the MIS enforces its own authorization on the underlying records.
 *
 * The upstream paths below (class-groups, class-groups/:id/students,
 * calendar/slots, users) are the MIS's real routes -- confirmed against
 * nga_central_mis/backend/src/routes/academics.ts, calendar.ts and users.ts.
 * An earlier version of this file guessed at flat `/classes`, `/students`,
 * `/staff`, `/schedule` paths that don't exist anywhere on the MIS (every
 * one of them 404s), which is why roster data never loaded.
 */
const router = Router();

router.use(authMiddleware);
router.use(authorizePermission('ROSTER_VIEW'));

// Backend day_of_week convention (see nga_central_mis's calendarConstants.ts):
// 0=Sunday, 1=Monday, ..., 6=Saturday (standard JS Date#getDay()).
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

class MisRequestError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** GET from the MIS with the caller's misToken, returning its list payload. */
async function fetchMisList(
  misToken: string,
  path: string,
  query?: Record<string, string | undefined>
): Promise<any[]> {
  const url = new URL(`${config.ngaMisBaseUrl}${path}`);
  for (const [key, value] of Object.entries(query || {})) {
    if (value) url.searchParams.set(key, value);
  }
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${misToken}`, Accept: 'application/json' },
  });
  if (!resp.ok) {
    throw new MisRequestError(resp.status, `MIS returned ${resp.status} for ${path}.`);
  }
  const body = (await resp.json()) as any;
  return Array.isArray(body) ? body : body.data ?? body.results ?? [];
}

function sendMisError(res: Response, path: string, error: unknown) {
  if (error instanceof MisRequestError) {
    return res.status(error.status).json({ success: false, message: error.message });
  }
  console.error(`MIS proxy error (${path}):`, (error as Error).message);
  return res.status(502).json({
    success: false,
    message: 'Could not reach the NGA Central MIS. Please try again.',
  });
}

function requireMisToken(req: AuthenticatedRequest, res: Response): string | null {
  const misToken = req.user?.misToken;
  if (!misToken) {
    res.status(403).json({
      success: false,
      message: 'This session is not linked to the MIS, so roster data is unavailable.',
    });
    return null;
  }
  return misToken;
}

/** A flat class-group-students row -> {id, name, email}. */
function normalizeFlatStudent(s: any) {
  return {
    id: String(s.user_id ?? s.id),
    name: [s.first_name, s.last_name].filter(Boolean).join(' ') || s.username || 'Unknown',
    email: s.email || s.username || '',
  };
}

/** A nested { user, profile, roles } row from GET /users -> {id, name, email}. */
function normalizeMisUser(entry: any) {
  const user = entry.user || entry;
  const profile = entry.profile || {};
  return {
    id: String(user.user_id ?? user.id),
    name:
      [profile.first_name ?? user.first_name, profile.last_name ?? user.last_name]
        .filter(Boolean)
        .join(' ') || user.username || 'Unknown',
    email: user.email || user.username || '',
  };
}

router.get('/classes', async (req: any, res) => {
  const misToken = requireMisToken(req, res);
  if (!misToken) return;
  try {
    const rows = await fetchMisList(misToken, '/academics/class-groups');
    const data = rows.map((c: any) => ({
      id: String(c.class_group_id ?? c.id),
      name: c.name,
      department: c.program_name || c.grade_name || '',
    }));
    res.json({ success: true, data });
  } catch (error) {
    sendMisError(res, '/academics/class-groups', error);
  }
});

router.get('/students', async (req: any, res) => {
  const misToken = requireMisToken(req, res);
  if (!misToken) return;
  const classId = req.query.class_id as string | undefined;
  try {
    if (classId) {
      // Roster for one class group, e.g. Mark Attendance's homeroom picker.
      const rows = await fetchMisList(
        misToken,
        `/academics/class-groups/${encodeURIComponent(classId)}/students`
      );
      return res.json({ success: true, data: rows.map(normalizeFlatStudent) });
    }
    // No class specified -- a school-wide listing (e.g. the Directory page).
    const rows = await fetchMisList(misToken, '/users', { userRole: '6', limit: '1000' });
    return res.json({ success: true, data: rows.map(normalizeMisUser) });
  } catch (error) {
    sendMisError(res, classId ? `/academics/class-groups/${classId}/students` : '/users', error);
  }
});

router.get('/staff', async (req: any, res) => {
  const misToken = requireMisToken(req, res);
  if (!misToken) return;
  try {
    // MIS's /users only filters by a single role at a time, and "staff"
    // spans several (teacher, admin, accountant, ...) -- fetch broadly and
    // exclude students instead of trying to enumerate every staff role id.
    const rows = await fetchMisList(misToken, '/users', { limit: '1000' });
    const staffOnly = rows.filter(
      (entry: any) =>
        !(entry.roles || []).some((r: any) => String(r.name).toUpperCase() === 'STUDENT')
    );
    res.json({ success: true, data: staffOnly.map(normalizeMisUser) });
  } catch (error) {
    sendMisError(res, '/users', error);
  }
});

router.get('/schedule', async (req: any, res) => {
  const misToken = requireMisToken(req, res);
  if (!misToken) return;
  try {
    const { academicTermId } = await resolveCurrentAcademicPeriod(misToken);
    const rows = await fetchMisList(misToken, '/calendar/slots', {
      class_group_id: req.query.class_id as string | undefined,
      academic_term_id: academicTermId != null ? String(academicTermId) : undefined,
    });

    const byDay = new Map<number, any[]>();
    for (const slot of rows) {
      const day = Number(slot.day_of_week);
      if (Number.isNaN(day)) continue;
      const period = {
        time:
          slot.start_time && slot.end_time
            ? `${slot.start_time} - ${slot.end_time}`
            : slot.start_time || '',
        subject: slot.subject_name || 'Subject',
        room: slot.location || '',
        teacher:
          [slot.instructor_name, slot.instructor_lastname].filter(Boolean).join(' ') || '',
      };
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day)!.push(period);
    }

    const data = Array.from(byDay.keys())
      .sort((a, b) => a - b)
      .map((day) => ({
        day: DAY_NAMES[day] ?? `Day ${day}`,
        periods: byDay.get(day)!.sort((a, b) => a.time.localeCompare(b.time)),
      }));

    res.json({ success: true, data });
  } catch (error) {
    sendMisError(res, '/calendar/slots', error);
  }
});

export default router;
