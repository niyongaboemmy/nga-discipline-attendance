import type { Request } from 'express';
import jwt from 'jsonwebtoken';
import { gunzipSync, gzipSync } from 'zlib';
import { config } from '../config.js';
import { ensureTenantDb } from '../database.js';
import { PRIMARY_TENANT_ID, effectiveTid, tenantHeader, tidOfClaims } from '../tenancy/index.js';
import { sessionRevoked } from '../auth/revocation.js';
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

/** Who a request's Tendo session belongs to: the school and the MIS user id. */
export interface SessionIdentity {
  tid: number;
  userId: number;
}

/**
 * The school and MIS user id behind a request's Tendo session, or null (a
 * public visitor). Validates the session exactly like `authMiddleware` --
 * signature, expiry, single sign-out revocation and a live local user row --
 * but never rejects: any failure simply means "anonymous". Tendo's `users.id`
 * IS the MIS user id.
 */
async function resolveIdentity(req: Request): Promise<SessionIdentity | null> {
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

    // The session's own school file (never creates one).
    const tid = tidOfClaims(decoded);
    if (tid == null) return null;
    const db = await ensureTenantDb(tid, { create: false });
    try {
      if (await sessionRevoked(db, decoded)) return null;
    } catch {
      /* same as authMiddleware: a lookup failure does not end the session */
    }

    // authMiddleware treats a token whose user row is gone as a dead session.
    const user = await db.get('SELECT id FROM users WHERE id = ?', String(decoded.id));
    if (!user) return null;

    const id = Number(decoded.id);
    return Number.isSafeInteger(id) && id > 0 ? { tid, userId: id } : null;
  } catch {
    return null;
  }
}

/**
 * Resolved once per request, so the school a batch is routed to and the user
 * id stamped on it always come from the same answer.
 */
const identities = new WeakMap<object, Promise<SessionIdentity | null>>();
export function sessionIdentityOf(req: Request): Promise<SessionIdentity | null> {
  let p = identities.get(req);
  if (!p) {
    p = resolveIdentity(req);
    identities.set(req, p);
  }
  return p;
}

/** The MIS user id behind a request's Tendo session, or null (a public visitor). */
export async function misUserIdOf(req: Request): Promise<number | null> {
  return (await sessionIdentityOf(req))?.userId ?? null;
}

/** Stand-in used when MIS is not configured: answers like a relay, forwards nothing. */
const disabledRelays = new WeakSet<object>();
const disabledRelay = (): ActivityRelay => {
  const stats = { forwarded: 0, dropped: 0, failures: 0, lastOkAt: 0 };
  const relay: ActivityRelay = {
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
  disabledRelays.add(relay);
  return relay;
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

/**
 * The school a request's activity belongs to: its live Tendo session's school,
 * or null for an anonymous (signed-out, expired, revoked) visitor. Anonymous
 * activity belongs to no school.
 */
export async function tidOfRequest(req: Request): Promise<number | null> {
  return (await sessionIdentityOf(req))?.tid ?? null;
}

/** fetch that adds X-NGA-Tenant, so MIS files each school's batches under it (contract §3). */
function tenantFetch(tid: number, base: typeof fetch = fetch): typeof fetch {
  return ((url: any, init: any = {}) =>
    base(url, { ...init, headers: { ...(init.headers || {}), ...tenantHeader(tid) } })) as typeof fetch;
}

/** Every batch and server event of an ingest body, with no user id. */
export function stripUserIds(body: any): any {
  if (!body || typeof body !== 'object') return body;
  for (const b of Array.isArray(body.batches) ? body.batches : []) {
    if (b && typeof b === 'object') {
      b.user_id = null;
      if (b.envelope && typeof b.envelope === 'object') delete b.envelope.user_id;
    }
  }
  for (const e of Array.isArray(body.server_events) ? body.server_events : []) {
    if (e && typeof e === 'object') e.user_id = null;
  }
  return body;
}

/**
 * fetch for the anonymous relay: the wire is the last wall, so whatever the
 * relay queued, an anonymous ingest body leaves with every user id nulled.
 * A body it can't read is not sent at all.
 */
function anonymousFetch(base: typeof fetch = fetch): typeof fetch {
  return (async (url: any, init: any = {}) => {
    if (!/\/activity\/ingest$/.test(String(url)) || init.body == null) return base(url, init);
    const headers = init.headers || {};
    const gz = headers['Content-Encoding'] === 'gzip';
    let body: any;
    try {
      const raw = gz ? gunzipSync(init.body as Buffer).toString('utf8') : String(init.body);
      body = stripUserIds(JSON.parse(raw));
    } catch {
      return new Response(JSON.stringify({ accepted: 0, rejected: 0, commands: [] }), { status: 202 });
    }
    const json = Buffer.from(JSON.stringify(body));
    return base(url, { ...init, body: gz ? gzipSync(json) : json.toString('utf8') });
  }) as typeof fetch;
}

/**
 * One vendored relay per school, plus one for anonymous visitors, behind the
 * single ActivityRelay interface the app uses: each school relay queues and
 * forwards only its own signed-in people's events with that school's
 * X-NGA-Tenant header, and stamps a user only when the request's session is of
 * that school. The vendored relay is unchanged.
 *
 * Anonymous visitors belong to no school. MIS keeps no tenant-free activity
 * store (every analytics row lives in a tenant database, and /activity/ingest
 * without X-NGA-Tenant means tenant 1, or 400 under TENANCY_REQUIRE_HEADER), so
 * anonymous batches go to the platform's primary bucket -- the same place MIS
 * files its own signed-out /activity/sync visits -- named explicitly, from a
 * relay that never resolves a user and whose wire body has every user id
 * nulled. They are never routed by a (dead or foreign) session's school.
 */
export function buildTenantActivityRelay(
  env: ActivityEnv = process.env,
  overrides: Partial<RelayOptions> = {},
): ActivityRelay {
  const schoolRelay = (tid: number) =>
    buildActivityRelay(env, {
      ...overrides,
      fetchImpl: tenantFetch(tid, overrides.fetchImpl),
      getUserId: async (req: any) => {
        const who = await sessionIdentityOf(req);
        return who && who.tid === tid ? who.userId : null;
      },
    });
  const first = schoolRelay(PRIMARY_TENANT_ID);
  // Not configured: the same no-op for every school.
  if (disabledRelays.has(first)) return first;
  const anonymous = buildActivityRelay(env, {
    ...overrides,
    fetchImpl: tenantFetch(PRIMARY_TENANT_ID, anonymousFetch(overrides.fetchImpl)),
    getUserId: () => null,
  });
  const relays = new Map<number, ActivityRelay>([[PRIMARY_TENANT_ID, first]]);
  const relayFor = (tid: number): ActivityRelay => {
    let r = relays.get(tid);
    if (!r) {
      r = schoolRelay(tid);
      relays.set(tid, r);
    }
    return r;
  };
  const relayOfRequest = async (req: any): Promise<ActivityRelay> => {
    const tid = await tidOfRequest(req);
    return tid == null ? anonymous : relayFor(tid);
  };
  const all = () => [...relays.values(), anonymous];
  const stats = {
    get forwarded() { return all().reduce((n, r) => n + r.stats.forwarded, 0); },
    get dropped() { return all().reduce((n, r) => n + r.stats.dropped, 0); },
    get failures() { return all().reduce((n, r) => n + r.stats.failures, 0); },
    get lastOkAt() { return Math.max(0, ...all().map((r) => r.stats.lastOkAt)); },
  };
  return {
    handler: async (req: any, res: any) => (await relayOfRequest(req)).handler(req, res),
    configHandler: async (req: any, res: any) => (await relayOfRequest(req)).configHandler(req, res),
    track: (...args: Parameters<ActivityRelay['track']>) => relayFor(effectiveTid('activity event')).track(...args),
    // The feature catalog is the app's, not a school's: published once (tenant 1).
    pushCatalog: (...args: Parameters<ActivityRelay['pushCatalog']>) => first.pushCatalog(...args),
    deviceIdOf: (req: any) => first.deviceIdOf(req),
    flush: async () => { await Promise.all(all().map((r) => r.flush())); },
    stop: async () => { await Promise.all(all().map((r) => r.stop())); },
    stats,
    _queue: () => all().reduce(
      (acc, r) => { const q = r._queue(); return { batches: acc.batches + q.batches, serverEvents: acc.serverEvents + q.serverEvents }; },
      { batches: 0, serverEvents: 0 },
    ),
  } as ActivityRelay;
}

/** One relay per process (fanning out per school, see buildTenantActivityRelay). */
export const activityRelay = buildTenantActivityRelay();

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
