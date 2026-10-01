import type { Request } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { getDb } from '../database.js';
import { issuedBeforeRevocation } from '../utils/ssoLogout.js';
import { createActivityRelay, type ActivityRelay, type RelayOptions } from '../vendor/nga-activity-relay/relay.js';

/**
 * Platform usage analytics: Tendo's relay to the NGA Central MIS
 * (nga_central_mis USAGE_ANALYTICS_IMPLEMENTATION_PLAN.md §5.2).
 *
 * The browser posts its activity batches to this server (same origin, its own
 * Tendo session); the relay stamps the MIS user id and the real client IP and
 * forwards everything to MIS with this app's SSO client credentials.
 * Analytics must never affect the app: without MIS configured the relay is a
 * no-op, and nothing here ever rejects a request.
 */

const DEFAULT_ORIGINS = [
  'https://tendo.amashuri.com',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:5172',
  'http://127.0.0.1:5172',
];

/**
 * The MIS user id behind a request's Tendo session, or null (a public visitor).
 * Validates the session exactly like `authMiddleware` -- signature, expiry,
 * single sign-out revocation and a live local user row -- but never rejects:
 * any failure simply means "anonymous". Tendo's `users.id` IS the MIS user id.
 */
export async function misUserIdOf(req: Request): Promise<number | null> {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) return null;
    let decoded: any;
    try {
      decoded = jwt.verify(header.split(' ')[1], config.jwtSecret);
    } catch {
      return null;
    }
    if (!decoded || typeof decoded !== 'object' || decoded.id == null) return null;

    const db = getDb();
    try {
      const revoked = await db.get('SELECT revoked_at FROM session_revocations WHERE user_id = ?', String(decoded.id));
      if (issuedBeforeRevocation(decoded.iat, revoked?.revoked_at)) return null;
    } catch {
      /* same as authMiddleware: a lookup failure does not end the session */
    }

    // authMiddleware treats a token whose user row is gone as a dead session.
    const user = await db.get('SELECT id FROM users WHERE id = ?', String(decoded.id));
    if (!user) return null;

    const id = Number(decoded.id);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
}

/** Stand-in used when MIS is not configured: answers like a relay, forwards nothing. */
const disabledRelay = (): ActivityRelay => {
  const stats = { forwarded: 0, dropped: 0, failures: 0, lastOkAt: 0 };
  return {
    handler: async (_req: any, res: any) => res.status(204).end(),
    configHandler: async (_req: any, res: any) => {
      res.set?.('Cache-Control', 'no-store');
      return res.status(200).json({ enabled: false, v: 1 });
    },
    track: () => undefined,
    pushCatalog: async () => false,
    deviceIdOf: () => null,
    flush: async () => undefined,
    stop: async () => undefined,
    stats,
    _queue: () => ({ batches: 0, serverEvents: 0 }),
  };
};

export interface ActivityEnv {
  NGA_MIS_BASE_URL?: string;
  SSO_CLIENT_ID?: string;
  SSO_CLIENT_SECRET?: string;
  ACTIVITY_ORIGINS?: string;
}

let warned = false;

/** Builds the relay from env. Missing MIS settings -> a no-op relay (logged once). */
export function buildActivityRelay(
  env: ActivityEnv = process.env,
  overrides: Partial<RelayOptions> = {},
): ActivityRelay {
  // Read the raw env, not `config`: config falls back to placeholder values
  // that must never receive forwarded analytics.
  const misBaseUrl = (env.NGA_MIS_BASE_URL || '').trim();
  const clientId = (env.SSO_CLIENT_ID || '').trim();
  const clientSecret = (env.SSO_CLIENT_SECRET || '').trim();
  if (!misBaseUrl || !clientId || !clientSecret) {
    if (!warned) {
      warned = true;
      console.warn('[activity] NGA_MIS_BASE_URL / SSO_CLIENT_ID / SSO_CLIENT_SECRET not all set: usage analytics relay disabled.');
    }
    return disabledRelay();
  }
  const origins = (env.ACTIVITY_ORIGINS || DEFAULT_ORIGINS.join(','))
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  return createActivityRelay({
    app: 'tendo',
    misBaseUrl,
    clientId,
    clientSecret,
    origins,
    getUserId: misUserIdOf,
    ...overrides,
  });
}

/** One relay per process. */
export const activityRelay = buildActivityRelay();

/**
 * Server-side key event for the signed-in actor (counted even if the browser
 * closes right after). Params must be ids/counts only -- never free text.
 * Never throws.
 */
export function trackKeyEvent(
  req: Request,
  name: 'tendo.register.save' | 'tendo.incident.create' | 'tendo.excuse.approve',
  params: Record<string, string | number | boolean | null>,
  relay: ActivityRelay = activityRelay,
): void {
  try {
    const raw = Number((req as any).user?.id);
    const userId = Number.isSafeInteger(raw) && raw > 0 ? raw : null;
    const ip = String(req.ip || '').replace(/^::ffff:/, '') || null;
    relay.track(userId, relay.deviceIdOf(req), name, params, ip);
  } catch {
    /* analytics never breaks a save */
  }
}
