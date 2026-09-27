import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { config } from '../config.js';
import { getDb } from '../database.js';
import { AuthenticatedRequest, Role, resolvePermissions } from './auth.js';
import { fetchWithTimeout, noteAccessVersion } from '../access/snapshot.js';
import { resolveCurrentAcademicPeriod } from '../utils/misAcademics.js';

/**
 * Auth for /api/integration/* -- server-to-server calls the NGA Central MIS
 * makes on behalf of a signed-in user (the Home page), carrying that user's
 * OWN MIS session token rather than one of this app's session JWTs.
 *
 *   1. The token is verified with MIS (GET /auth/verify). 401/403 there ->
 *      401 MIS_TOKEN_INVALID here; MIS unreachable -> 503. A verification is
 *      cached for VERIFY_TTL_MS keyed by sha256(token) -- the token itself is
 *      never stored as a key and never logged. Failures (401, 5xx, network)
 *      are never cached, so a revoked token stops working within the TTL.
 *      The caller's current academic period rides on the same entry, so a
 *      cache hit costs MIS nothing.
 *   2. The MIS user id maps to the local user exactly as SSO does it:
 *      users.id IS String(MIS user id) (routes/sso.ts). No local user yet ->
 *      req.homeProvisioned = false and the route answers with an empty,
 *      provisioned:false summary. Nothing is created here -- the SSO exchange
 *      owns user creation.
 *   3. req.user is built like authMiddleware builds it (role + permissions
 *      fresh from the DB, the MIS token as misToken, the current academic
 *      period the same way the SSO exchange resolves it), so access/policy.ts
 *      and the MIS client work unchanged.
 */

const VERIFY_TTL_MS = 60_000;
/** Verified tokens kept at most (env override is for tests). */
const MAX_CACHE = Number(process.env.MIS_VERIFY_CACHE_MAX) || 2000;
/** Longer than any real MIS JWT; anything bigger is refused without asking MIS. */
const MAX_TOKEN_LENGTH = 4096;

interface Verified {
  misUserId: number;
  at: number;
  period?: { academicYearId?: number; academicTermId?: number };
}
const verified = new Map<string, Verified>();

const tokenKey = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

export interface IntegrationRequest extends AuthenticatedRequest {
  /** false when the MIS user has never signed in to this app. */
  homeProvisioned?: boolean;
  misUserId?: number;
}

type VerifyResult = { ok: true; entry: Verified } | { ok: false; status: 401 | 503 };

/** Bounded: expired entries go first, then the oldest (Map insertion order). */
function remember(key: string, entry: Verified) {
  verified.delete(key);
  if (verified.size >= MAX_CACHE) {
    const now = Date.now();
    for (const [k, v] of verified) if (now - v.at >= VERIFY_TTL_MS) verified.delete(k);
    for (const k of verified.keys()) {
      if (verified.size < MAX_CACHE) break;
      verified.delete(k);
    }
  }
  verified.set(key, entry);
}

async function verifyWithMis(token: string): Promise<VerifyResult> {
  const key = tokenKey(token);
  const hit = verified.get(key);
  if (hit && Date.now() - hit.at < VERIFY_TTL_MS) return { ok: true, entry: hit };
  if (hit) verified.delete(key);

  let resp: globalThis.Response;
  try {
    resp = await fetchWithTimeout(`${config.ngaMisBaseUrl}/auth/verify`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
  } catch (err) {
    console.warn(`[integration] MIS /auth/verify unreachable: ${(err as Error)?.message ?? err}`);
    return { ok: false, status: 503 };
  }
  if (resp.status === 401 || resp.status === 403) return { ok: false, status: 401 };
  if (!resp.ok) return { ok: false, status: 503 };

  let body: any = null;
  try {
    body = await resp.json();
  } catch {
    body = null;
  }
  const data = body && typeof body === 'object' && 'data' in body ? body.data : body;
  const misUserId = Number(data?.userId ?? data?.user_id);
  if (!Number.isInteger(misUserId) || misUserId <= 0) return { ok: false, status: 401 };

  // Same hint the verify-mis poll gives: a changed access_version drops the
  // cached access snapshot so this request decides with fresh grants.
  noteAccessVersion(misUserId, data?.access_version);

  const entry: Verified = { misUserId, at: Date.now() };
  remember(key, entry);
  return { ok: true, entry };
}

export async function misBearerAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header ?? '');
  const token = match?.[1] ?? '';
  if (!token) {
    return res.status(401).json({ success: false, code: 'MIS_TOKEN_INVALID', message: 'An MIS bearer token is required.' });
  }
  if (token.length > MAX_TOKEN_LENGTH) {
    return res.status(401).json({ success: false, code: 'MIS_TOKEN_INVALID', message: 'The MIS session is not valid.' });
  }

  try {
    const result = await verifyWithMis(token);
    if (!result.ok) {
      return result.status === 401
        ? res.status(401).json({ success: false, code: 'MIS_TOKEN_INVALID', message: 'The MIS session is not valid.' })
        : res.status(503).json({ success: false, code: 'MIS_UNAVAILABLE', message: 'Could not verify the session with the MIS.' });
    }

    const r = req as IntegrationRequest;
    const { entry } = result;
    r.misUserId = entry.misUserId;
    const id = String(entry.misUserId);
    const user = await getDb().get('SELECT id, name, email, role FROM users WHERE id = ?', id);
    if (!user) {
      r.homeProvisioned = false;
      return next();
    }

    const resolved = (await resolvePermissions(id)) ?? { permissions: new Set<string>() };
    // Once per verification, not per request (it may call MIS /users/me).
    entry.period ??= await resolveCurrentAcademicPeriod(token);
    const { academicYearId, academicTermId } = entry.period;
    r.homeProvisioned = true;
    r.user = {
      id,
      name: user.name,
      email: user.email ?? '',
      role: user.role as Role,
      misToken: token,
      academicYearId,
      academicTermId,
      roleId: resolved.roleId,
      roleName: resolved.roleName,
      roleLevel: resolved.roleLevel,
      permissions: resolved.permissions,
    };
    return next();
  } catch (err) {
    return next(err);
  }
}

/** Test hook. */
export function __resetMisBearerCache() {
  verified.clear();
}

/** Test hook. */
export function __misBearerCacheSize() {
  return verified.size;
}
