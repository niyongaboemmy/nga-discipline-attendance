import express, { Router, Request, Response } from 'express';
import { LogoutTokenError, verifyLogoutTokenSubject } from '../utils/ssoLogout.js';
import { signSession } from '../auth/sessionToken.js';
import { config } from '../config.js';
import { ensureTenantDb, getDb, tenantDbExists } from '../database.js';
import {
  gateTenant, normalizeTenant, parseTid, runWithTenant, tenantOfMisPayload, tenantRegistry, tidOfMisToken,
  type TenantCtx,
} from '../tenancy/index.js';
import { Role, authMiddleware, AuthenticatedRequest } from '../middleware/auth.js';
import { resolveCurrentAcademicPeriod } from '../utils/misAcademics.js';
import { misUserIdOf, noteAccessVersion } from '../access/snapshot.js';
import { noteAiPolicyVersion } from '../services/aiPolicy.js';
import { noteAiRoutesVersion } from '../services/myAiGateway.js';
import { recheckMisStatus, recordMisStatus } from '../services/activeStudents.js';
import { revokeSessions } from '../auth/revocation.js';
import { noteFallback } from '../tenancy/fallbacks.js';

const router = Router();

/** The central profile picture as MIS reports it (services/avatar in nga_central_mis). */
export interface MisAvatar { version: number; sm: string; md: string; lg: string }

/** Only well-formed https/http picture sets get through to the client. */
export function misAvatarOf(data: any): MisAvatar | null {
  const a = data?.avatar;
  const ok = (u: unknown) => typeof u === 'string' && /^https?:\/\//.test(u);
  if (!a || !ok(a.sm) || !ok(a.md) || !ok(a.lg)) return null;
  return { version: Number(a.version) || 0, sm: a.sm, md: a.md, lg: a.lg };
}

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
export async function resolveAndPersistUser(
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
export function resolveMisRole(misUser: any, permissions: unknown): Role {
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

/** The rest of the SSO exchange, inside the tenant's context (its own file). */
async function completeExchange(res: Response, result: any, tenant: TenantCtx) {
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
  // Keep the local copy of the MIS account status current (active users
  // only, ACTIVE_USERS_CONTRACTS.md). Only when the MIS sends one.
  await recordMisStatus(getDb(), id, misUser.status ?? misUser.user_status);
  const rolePermissions = await fetchRolePermissions(id);

  // Carry the user's MIS theme preference through so the app opens in the same
  // light/dark mode they use in the MIS. Only honor the known values.
  const preferredTheme =
    misUser.preferred_theme === 'light' || misUser.preferred_theme === 'dark'
      ? misUser.preferred_theme
      : undefined;

  const { academicYearId, academicTermId } = await resolveCurrentAcademicPeriod(misToken);

  // The school: in the session JWT (every later request enters this tenant's
  // context from it) and in the client's user payload (offline storage keys,
  // the install cookie) -- signSession is the only signer.
  const { token, user: localUser } = signSession(
    { id, name, email, role, preferred_theme: preferredTheme, academicYearId, academicTermId },
    { tid: tenant.tid, slug: tenant.slug },
    misToken,
  );

  // The central NGA MIS profile picture (signed URLs, three sizes). Not put in the
  // session JWT: it can change mid-session, and /verify-mis below keeps it current.
  const avatar = misAvatarOf(result.data);

  return res.json({
    success: true,
    data: { token, user: { ...localUser, avatar }, permissions: permissions || [], rolePermissions },
  });
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

    // Tenancy (contract §2, §6): the school comes from the MIS response
    // (`tenant`) or the MIS SSO token's `tid`. A sign-in that names no school
    // at all is refused (TD-ISO-2): no legacy default at sign-in, so a new
    // session never lands in school 1 by accident.
    const bodyTenant = tenantOfMisPayload(result.data);
    const tokenTid = tidOfMisToken(misToken);
    if (bodyTenant && tokenTid != null && bodyTenant.tid !== tokenTid) {
      return res.status(401).json({ success: false, code: 'TENANT_MISMATCH', message: 'The MIS answered for two different schools.' });
    }
    const gate = await gateTenant(bodyTenant?.tid ?? tokenTid ?? null);
    if (!gate.ok) {
      return res.status(gate.status).json({ success: false, code: gate.code, message: gate.message });
    }
    const tenant = gate.tenant;
    await ensureTenantDb(tenant.tid);
    return await runWithTenant(tenant, () => completeExchange(res, result, tenant));
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
/**
 * POST /api/sso/backchannel-logout -- OpenID Connect Back-Channel Logout.
 * NGA MIS calls this (server to server) when a user signs out there; we end
 * that user's Tendo sessions too (nga_central_mis/docs/SINGLE_SIGN_OUT.md).
 */
router.post('/backchannel-logout', express.urlencoded({ extended: false, limit: '20kb' }), async (req: Request, res: Response) => {
  res.set('Cache-Control', 'no-store');
  try {
    const { sub: misUserId, tid: tokenTid, sid } = await verifyLogoutTokenSubject((req.body || {}).logout_token, {
      misBaseUrl: config.ngaMisBaseUrl,
      clientId: config.ssoClientId,
    });
    // Revoke on (tid, sub): the revocation lands in that school's own file.
    // MIS always sends `tid` now; a token without one is refused rather than
    // guessed as school 1 (TD-ISO-4), and counted so the strict-mode clock
    // sees it.
    const tid = tokenTid;
    if (tid == null) {
      noteFallback('payload_no_tid', 'back-channel logout (refused)');
      return res.status(400).json({ error: 'invalid_request', error_description: 'logout_token has no tid' });
    }
    const tenant = (await tenantRegistry().get(tid)) ?? (tenantDbExists(tid) ? normalizeTenant({ tid }) : null);
    // A school Tendo has never stored anything for has no sessions to end.
    if (!tenant) return res.status(200).json({ success: true });
    await ensureTenantDb(tid);
    await runWithTenant(tenant, async () => {
      // With a sid (a school switch in one browser, Appendix A.3) only that
      // browser's sessions end; without one, all of the person's sessions here.
      await revokeSessions(getDb(), String(misUserId), sid);
      if (sid) return; // a switch is not a deactivation: no status re-check
      // A sign-out from MIS may be a deactivation: re-check this person's
      // status now instead of waiting for the next roster sync. Not awaited.
      void recheckMisStatus(getDb(), String(misUserId));
    });
    return res.status(200).json({ success: true });
  } catch (error: any) {
    if (error instanceof LogoutTokenError) {
      return res.status(400).json({ error: 'invalid_request', error_description: error.message });
    }
    return res.status(500).json({ error: 'server_error' });
  }
});

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
    let avatar: MisAvatar | null | undefined;
    let currentTid: number | null = null;
    try {
      const body = (await response.json()) as any;
      // The school the MIS browser session is in now (TENANT_SWITCHING_PLAN.md
      // §4.2 backstop): another school than this session's means a switch.
      currentTid = parseTid(body?.data?.currentTid);
      noteAccessVersion(misUserIdOf((req as AuthenticatedRequest).user), body?.data?.access_version);
      // Same for the school's AI policy: a new ai_policy_v drops the cached copy.
      noteAiPolicyVersion(body?.data?.ai_policy_v);
      // My AI: a new ai_routes_v (or ai_policy_v) drops this person's cached route map.
      noteAiRoutesVersion(misUserIdOf((req as AuthenticatedRequest).user), body?.data?.ai_routes_v, body?.data?.ai_policy_v);
      avatar = body?.data?.avatar === undefined ? undefined : misAvatarOf(body.data);
    } catch {
      // Not JSON / no version (older MIS): nothing to note.
    }
    const sessionTid = (req as AuthenticatedRequest).user?.tid;
    if (currentTid != null && sessionTid != null && currentTid !== sessionTid) {
      return res.status(409).json({
        success: false,
        code: 'SCHOOL_CHANGED',
        currentTid,
        message: 'You switched school in NGA MIS. Signing you in to that school.',
      });
    }
    // The current profile picture rides along, so one changed in MIS (or another
    // NGA app) reaches this app's navbar within a minute. Omitted when MIS is silent.
    return res.json(avatar === undefined ? { success: true } : { success: true, avatar });
  } catch (error) {
    // MIS unreachable is not the same as "logged out" -- don't force-logout
    // everyone over a network blip. The next successful poll settles it.
    console.error('MIS session verify error:', error);
    return res.json({ success: true });
  }
});

/** GET with the session's MIS token; null on any failure (MIS old, down, or refusing). */
async function misGet(path: string, misToken: string | undefined, timeoutMs = 4000): Promise<any | null> {
  try {
    const response = await fetch(`${config.ngaMisBaseUrl.replace(/\/+$/, '')}${path}`, {
      headers: { ...(misToken ? { Authorization: `Bearer ${misToken}` } : {}), Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

export interface MySchool {
  tid: number;
  slug: string;
  name: string;
  logoUrl: string | null;
  current: boolean;
}

/** The well-formed entries of MIS `/auth/my-schools` (Appendix A.4). */
export function mySchoolsOf(body: any, sessionTid?: number): MySchool[] {
  const raw = body?.data?.schools ?? body?.schools;
  if (!Array.isArray(raw)) return [];
  const out: MySchool[] = [];
  for (const r of raw) {
    const tid = parseTid(r?.tid);
    if (!tid || out.some((s) => s.tid === tid)) continue;
    out.push({
      tid,
      slug: typeof r.slug === 'string' ? r.slug : '',
      name: typeof r.name === 'string' && r.name ? r.name : (typeof r.slug === 'string' ? r.slug : `School ${tid}`),
      logoUrl: typeof r.logoUrl === 'string' && /^https?:\/\//.test(r.logoUrl) ? r.logoUrl : null,
      current: typeof r.current === 'boolean' ? r.current : tid === sessionTid,
    });
  }
  return out;
}

/**
 * GET /api/sso/my-schools -- the signed-in person's schools, from MIS
 * `/auth/my-schools` with this session's MIS token (it never reaches the
 * browser). The client shows "Switch school" only for 2 or more. An MIS that
 * does not have the endpoint yet answers an empty list.
 */
router.get('/my-schools', authMiddleware, async (req: Request, res: Response) => {
  const u = (req as AuthenticatedRequest).user;
  res.set('Cache-Control', 'no-store');
  const body = u?.misToken ? await misGet('/auth/my-schools', u.misToken) : null;
  return res.json({ success: true, data: { schools: mySchoolsOf(body, u?.tid) } });
});

export interface SchoolBranding {
  tid: number;
  name: string | null;
  logoUrl: string | null;
  /** the school's documents logo (report headers), when it has one */
  documentsLogoUrl?: string | null;
}

/** MIS `/tenant/branding` (Appendix A.5): `data.school_name`, `data.logoUrl`, `data.logos.documents`. */
export function brandingOf(body: any, tid: number): SchoolBranding | null {
  const d = body?.data ?? body;
  if (!d || typeof d !== 'object') return null;
  const name = [d.school_name, d.name].find((v) => typeof v === 'string' && v.trim());
  const logo = [d.logoUrl, d.logo_url].find((v) => typeof v === 'string' && /^https?:\/\//.test(v));
  const docs = [d.logos?.documents, d.documents_logo_url].find((v) => typeof v === 'string' && /^https?:\/\//.test(v));
  if (!name && !logo) return null;
  return { tid, name: name ? String(name).trim() : null, logoUrl: logo ?? null, documentsLogoUrl: docs ?? null };
}

const brandingCache = new Map<number, { at: number; value: SchoolBranding | null }>();
const BRANDING_TTL_MS = 10 * 60 * 1000;

/** A school's name and logo from MIS (public data), cached 10 min; a miss for 1 min. */
export async function schoolBranding(tid: number): Promise<SchoolBranding | null> {
  const hit = brandingCache.get(tid);
  if (hit && Date.now() - hit.at < BRANDING_TTL_MS) return hit.value;
  const value = brandingOf(await misGet(`/tenant/branding?tid=${tid}`, undefined), tid);
  // A miss is cached for a minute only, so a logo set in MIS shows up soon.
  brandingCache.set(tid, { at: value ? Date.now() : Date.now() - BRANDING_TTL_MS + 60_000, value });
  return value;
}

/** GET /api/sso/branding -- this session's school name and logo (public MIS data, cached 10 min). */
router.get('/branding', authMiddleware, async (req: Request, res: Response) => {
  const tid = (req as AuthenticatedRequest).user?.tid;
  if (!tid) return res.json({ success: true, data: null });
  return res.json({ success: true, data: await schoolBranding(tid) });
});

/** Test hook. */
export function __clearBrandingCache() {
  brandingCache.clear();
}

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
