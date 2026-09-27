import { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { getDb } from '../database.js';
import { Role, authMiddleware, AuthenticatedRequest } from '../middleware/auth.js';
import { resolveCurrentAcademicPeriod } from '../utils/misAcademics.js';
import { misUserIdOf, noteAccessVersion } from '../access/snapshot.js';

const router = Router();

const levelForRole: Record<string, string> = { student: 'STUDENT', teacher: 'TEACHER', admin: 'ADMIN' };

/** Look up the id of the seeded system role matching a legacy role string's level. */
async function systemRoleIdFor(role: Role): Promise<number | null> {
  const level = levelForRole[role];
  if (!level) return null; // 'unassigned' has no role_id
  const db = getDb();
  const row = await db.get('SELECT id FROM roles WHERE level = ? AND is_system = 1', level);
  return row?.id ?? null;
}

/** The local RBAC permission-key set for a user, straight from the DB — used to
 *  hydrate the frontend session (distinct from the unrelated MIS `permissions`
 *  array carried alongside it). */
async function fetchRolePermissions(userId: string): Promise<string[]> {
  const db = getDb();
  const rows = await db.all(
    `SELECT DISTINCT p.key FROM users u
     JOIN role_permissions rp ON rp.role_id = u.role_id
     JOIN permissions p ON p.id = rp.permission_id
     WHERE u.id = ? ORDER BY p.key`,
    userId
  );
  return rows.map((r: any) => r.key);
}

/**
 * Resolve a user's effective role and persist the identity.
 * Precedence: an admin-assigned role in our DB ALWAYS wins; otherwise we use the
 * role detected from the MIS payload; if neither yields a role the user is
 * 'unassigned' (never silently treated as a teacher).
 *
 * `role_id` (the RBAC permission-set link) is only touched when the legacy
 * role actually changes here — if an admin has assigned this user a *custom*
 * role at the same level, a login must not silently reset it back to the
 * plain system role.
 */
async function resolveAndPersistUser(
  id: string,
  name: string,
  email: string,
  computedRole: Role,
  forceRole = false
): Promise<Role> {
  const db = getDb();
  const existing = await db.get('SELECT role FROM users WHERE id = ?', id);

  if (existing) {
    // A bootstrap admin always wins (prevents accidental lockout); otherwise an
    // admin-assigned role is sticky and only 'unassigned' is recomputed from MIS.
    const finalRole: Role = forceRole
      ? computedRole
      : existing.role !== 'unassigned' ? existing.role : computedRole;

    if (finalRole !== existing.role) {
      const roleId = await systemRoleIdFor(finalRole);
      await db.run(
        `UPDATE users
           SET name = ?, email = COALESCE(?, email), role = ?, role_id = ?, last_login = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        name, email || null, finalRole, roleId, id
      );
    } else {
      await db.run(
        `UPDATE users
           SET name = ?, email = COALESCE(?, email), last_login = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        name, email || null, id
      );
    }
    return finalRole;
  }

  const roleId = await systemRoleIdFor(computedRole);
  await db.run(
    `INSERT INTO users (id, name, email, role, role_id, source, last_login)
     VALUES (?, ?, ?, ?, ?, 'sso', CURRENT_TIMESTAMP)`,
    id, name, email || null, computedRole, roleId
  );
  return computedRole;
}

/**
 * Derive a role from the MIS permission set. The NGA Central MIS is
 * permission-based (no explicit role field), so we infer the role the same way
 * sibling systems do: from what the user is allowed to do.
 *
 * Precedence is most-privileged-first — a user who can manage the institution is
 * an admin even if they also hold teaching/viewing permissions; a user who can
 * mark attendance or log discipline is a teacher even if they can also view; a
 * user who can only view their own records is a student.
 */
function roleFromPermissions(permissions: unknown): Role {
  const perms = (Array.isArray(permissions) ? permissions : [])
    .map((p) => String(p).toUpperCase());
  const has = (...keywords: string[]) =>
    perms.some((p) => keywords.some((k) => p.includes(k)));

  // Institution-level administration.
  if (has('MANAGE_USER', 'MANAGE_ROLE', 'MANAGE_STAFF', 'MANAGE_SYSTEM', 'MANAGE_SCHOOL', 'ADMIN'))
    return 'admin';

  // Staff/teacher capabilities — anything beyond read-only self-service.
  if (has('MARK_ATTENDANCE', 'TAKE_ATTENDANCE', 'MANAGE_ATTENDANCE',
          'MANAGE_DISCIPLINE', 'LOG_INCIDENT', 'MANAGE_LESSON', 'CREATE_LESSON',
          'MANAGE_RESULT', 'ENTER_RESULT', 'GRADE', 'MANAGE_CLASS',
          'MANAGE_STUDENT', 'TEACHER', 'STAFF'))
    return 'teacher';

  // Student / self-service signals.
  if (has('STUDENT', 'VIEW_RESULTS', 'VIEW_ATTENDANCE', 'VIEW_STUDENT_CALENDAR', 'VIEW_LESSON'))
    return 'student';

  // Nothing recognizable — must be assigned by an administrator.
  return 'unassigned';
}

/** Fallback role detection from an explicit role field, if a MIS ever sends one. */
function detectRoleFromMis(misUser: any): Role {
  const roleFields = [
    misUser?.role, misUser?.role_name, misUser?.type, misUser?.user_type,
    misUser?.role?.name, misUser?.role?.role_name, misUser?.role?.code,
    misUser?.role_code, misUser?.user_role,
  ];
  const roleString = roleFields
    .map((f) => (!f ? '' : typeof f === 'object' ? JSON.stringify(f) : String(f)))
    .join(' ')
    .toLowerCase();

  if (roleString.includes('admin') || roleString.includes('administrator')) return 'admin';
  if (
    roleString.includes('teacher') || roleString.includes('instructor') ||
    roleString.includes('faculty') || roleString.includes('tutor') ||
    roleString.includes('staff')
  ) return 'teacher';
  if (
    roleString.includes('student') || roleString.includes('learner') ||
    roleString.includes('pupil')
  ) return 'student';

  return 'unassigned';
}

/** Resolve a role for a freshly authenticated MIS user: permissions first, then
 *  any explicit role field as a fallback. */
function resolveMisRole(misUser: any, permissions: unknown): Role {
  const fromPerms = roleFromPermissions(permissions);
  if (fromPerms !== 'unassigned') return fromPerms;
  return detectRoleFromMis(misUser);
}

/**
 * Minimal in-memory rate limiter for the token exchange — prevents brute-forcing
 * authorization codes. Allows MAX_ATTEMPTS per IP per WINDOW_MS sliding window.
 */
const WINDOW_MS = 60_000;
const MAX_ATTEMPTS = 10;
const attempts = new Map<string, number[]>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const recent = (attempts.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  attempts.set(ip, recent);
  // Opportunistic cleanup so the map can't grow unbounded.
  if (attempts.size > 10_000) {
    for (const [key, times] of attempts) {
      if (times.every((t) => now - t >= WINDOW_MS)) attempts.delete(key);
    }
  }
  return recent.length > MAX_ATTEMPTS;
}

router.post('/exchange', async (req: Request, res: Response) => {
  const { code } = req.body;

  if (rateLimited(req.ip || 'unknown')) {
    return res.status(429).json({ success: false, message: 'Too many sign-in attempts. Please wait a minute and try again.' });
  }

  if (!code || typeof code !== 'string') {
    return res.status(400).json({ success: false, message: 'Authorization code is required' });
  }

  // ---- SSO token exchange with NGA Central MIS ----
  try {
    const response = await fetch(`${config.ngaMisBaseUrl}/sso/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, client_id: config.ssoClientId, client_secret: config.ssoClientSecret }),
    });

    const result = (await response.json()) as any;

    if (!response.ok || !result.success) {
      return res.status(response.status || 400).json({
        success: false,
        message: result.message || 'Token exchange failed on the Discipline MIS server.',
      });
    }

    const { token: misToken, user: misUser, permissions } = result.data;
    // Sign-in is a natural refresh point: drop a cached access snapshot if
    // MIS says this user's access changed since it was fetched.
    noteAccessVersion(Number(misUser?.user_id), result.data?.access_version);

    const id = String(misUser.user_id ?? misUser.id ?? misUser.uuid ?? misUser.email ?? 'MIS-USER');
    const name = misUser.name || misUser.username || 'Discipline User';
    const email = misUser.email || '';

    // Bootstrap admins (config allowlist) outrank MIS permissions and are forced
    // so the app owner can never be locked out of administration.
    const isBootstrapAdmin =
      config.adminUsernames.includes(String(misUser.username || name).toLowerCase()) ||
      config.adminEmails.includes(String(email).toLowerCase());
    const computedRole: Role = isBootstrapAdmin ? 'admin' : resolveMisRole(misUser, permissions);

    const role = await resolveAndPersistUser(id, name, email, computedRole, isBootstrapAdmin);
    const rolePermissions = await fetchRolePermissions(id);

    // Carry the user's MIS theme preference through so the app opens in the same
    // light/dark mode they use in the MIS. Only honor the known values.
    const preferredTheme =
      misUser.preferred_theme === 'light' || misUser.preferred_theme === 'dark'
        ? misUser.preferred_theme
        : undefined;

    const { academicYearId, academicTermId } = await resolveCurrentAcademicPeriod(misToken);

    const localUser = {
      id, name, email, role, preferred_theme: preferredTheme,
      academicYearId, academicTermId,
    };
    const token = jwt.sign({ ...localUser, misToken }, config.jwtSecret, { expiresIn: '24h' });

    return res.json({
      success: true,
      data: { token, user: localUser, permissions: permissions || [], rolePermissions },
    });
  } catch (error) {
    console.error('SSO exchange error:', error);
    return res.status(502).json({
      success: false,
      message: 'Could not reach the Discipline MIS authentication server. Please try again.',
    });
  }
});

/**
 * Polled periodically by the frontend (see AuthContext) so a logout on the
 * MIS ends this app's session too, not just the MIS's own. The local
 * session JWT is otherwise self-contained and valid for its own 24h life
 * regardless of what happens to the MIS session it was built from — this
 * is the only thing that ties the two together after the initial /exchange.
 * Deliberately fails CLOSED (401) on any MIS rejection, unlike /systems
 * below: a stale MIS session should end this one, not be shrugged off.
 */
router.get('/verify-mis', authMiddleware, async (req: Request, res: Response) => {
  const misToken = (req as AuthenticatedRequest).user?.misToken;
  if (!misToken) {
    return res.status(401).json({ success: false, message: 'No MIS session on this token.' });
  }

  try {
    const response = await fetch(`${config.ngaMisBaseUrl}/auth/verify`, {
      headers: { Authorization: `Bearer ${misToken}` },
    });
    if (!response.ok) {
      return res.status(401).json({ success: false, message: 'MIS session has ended.' });
    }
    // Access control v2: MIS reports the user's access_version here; a change
    // drops their cached snapshot so the next access check re-fetches it.
    try {
      const body = (await response.json()) as any;
      noteAccessVersion(misUserIdOf((req as AuthenticatedRequest).user), body?.data?.access_version);
    } catch {
      // Not JSON / no version (older MIS): nothing to note.
    }
    return res.json({ success: true });
  } catch (error) {
    // MIS unreachable is not the same as "logged out" -- don't force-logout
    // everyone over a network blip. The next successful poll settles it.
    console.error('MIS session verify error:', error);
    return res.json({ success: true });
  }
});

/**
 * The cross-app "waffle" switcher's live app list — proxies the MIS's own
 * `/users/me` (using the misToken embedded in this app's session JWT at
 * /exchange above) and hands back just the `systems` array, mirroring how
 * nga-task-mentor's server does the same thing. Fails open (empty list)
 * rather than breaking the navbar if the MIS is briefly unreachable.
 */
router.get('/systems', authMiddleware, async (req: Request, res: Response) => {
  const misToken = (req as AuthenticatedRequest).user?.misToken;
  if (!misToken) {
    return res.json({ success: true, data: { systems: [] } });
  }

  try {
    const response = await fetch(`${config.ngaMisBaseUrl}/users/me`, {
      headers: { Authorization: `Bearer ${misToken}` },
    });
    const result = (await response.json()) as any;
    if (!response.ok || !result.success) {
      return res.json({ success: true, data: { systems: [] } });
    }
    return res.json({ success: true, data: { systems: result.data?.systems || [] } });
  } catch (error) {
    console.error('Fetch MIS systems error:', error);
    return res.json({ success: true, data: { systems: [] } });
  }
});

/**
 * Proxies an SSO authorization request to the MIS on behalf of the signed-in
 * user, so the waffle switcher can hop into a sibling app without asking them
 * to log in again — same protocol nga-task-mentor's client/server use.
 */
router.get('/authorize', authMiddleware, async (req: Request, res: Response) => {
  const misToken = (req as AuthenticatedRequest).user?.misToken;
  if (!misToken) {
    return res.status(401).json({ success: false, message: 'MIS session expired' });
  }

  const { client_id, redirect_uri, response_type, state } = req.query;
  try {
    const url = new URL(`${config.ngaMisBaseUrl}/sso/authorize`);
    if (client_id) url.searchParams.set('client_id', String(client_id));
    if (redirect_uri) url.searchParams.set('redirect_uri', String(redirect_uri));
    if (response_type) url.searchParams.set('response_type', String(response_type));
    if (state) url.searchParams.set('state', String(state));

    const response = await fetch(url, { headers: { Authorization: `Bearer ${misToken}` } });
    const result = await response.json();
    return res.status(response.status).json(result);
  } catch (error) {
    console.error('SSO authorize proxy error:', error);
    return res.status(502).json({ success: false, message: 'Could not reach the MIS authorization server.' });
  }
});

export default router;
