import { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { getDb } from '../database.js';
import { Role } from '../middleware/auth.js';

const router = Router();

/**
 * Resolve a user's effective role and persist the identity.
 * Precedence: an admin-assigned role in our DB ALWAYS wins; otherwise we use the
 * role detected from the MIS payload; if neither yields a role the user is
 * 'unassigned' (never silently treated as a teacher).
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
    await db.run(
      `UPDATE users
         SET name = ?, email = COALESCE(?, email), role = ?, last_login = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      name, email || null, finalRole, id
    );
    return finalRole;
  }

  await db.run(
    `INSERT INTO users (id, name, email, role, source, last_login)
     VALUES (?, ?, ?, ?, 'sso', CURRENT_TIMESTAMP)`,
    id, name, email || null, computedRole
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

/**
 * Resolve the caller's current academic year/term from the MIS. The MIS bundles
 * this into `GET /users/me` rather than exposing a dedicated "current" endpoint
 * (see nga_central_mis/SSO_CLIENT_INTEGRATION.md), so we call it once at login
 * and cache the result as JWT claims — cheaper than calling it on every request.
 */
async function resolveCurrentAcademicPeriod(
  misToken: string
): Promise<{ academicYearId?: number; academicTermId?: number }> {
  try {
    const resp = await fetch(`${config.ngaMisBaseUrl}/users/me`, {
      headers: { Authorization: `Bearer ${misToken}`, Accept: 'application/json' },
    });
    if (!resp.ok) return {};
    const body = (await resp.json()) as any;
    const data = body.data ?? body;
    const year = data.currentAcademicYear;
    const terms: any[] = Array.isArray(data.currentAcademicTerms) ? data.currentAcademicTerms : [];
    const currentTerm = terms.find((t) => Number(t.is_current) === 1) || terms[0];
    return {
      academicYearId: year?.academic_year_id != null ? Number(year.academic_year_id) : undefined,
      academicTermId: currentTerm?.academic_term_id != null ? Number(currentTerm.academic_term_id) : undefined,
    };
  } catch (error) {
    console.error('Could not resolve current academic period from MIS:', (error as Error).message);
    return {};
  }
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

    return res.json({ success: true, data: { token, user: localUser, permissions: permissions || [] } });
  } catch (error) {
    console.error('SSO exchange error:', error);
    return res.status(502).json({
      success: false,
      message: 'Could not reach the Discipline MIS authentication server. Please try again.',
    });
  }
});

export default router;
