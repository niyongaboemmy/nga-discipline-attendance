import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import {
  PRIMARY_TENANT_ID,
  TenantContextMissing,
  TenantRegistry,
  currentTenantOrNull,
  isTenantUsable,
  normalizeTenant,
  parseTid,
  primaryTenantCtx,
  tidFromClaims,
  type TenantCtx,
} from '../vendor/nga-tenancy/index.js';

/**
 * Tendo's side of the NGA tenancy contract (nga_central_mis/packages/tenancy/
 * CONTRACT.md). The vendored core (../vendor/nga-tenancy) holds the context
 * and the registry; this module adds what is specific to Tendo:
 *
 *  - TENANCY_MODE: `shadow` (default) lets code that runs with no tenant
 *    context fall back to tenant 1 (logged once per call site kind), so a
 *    single-school install behaves exactly as before; `enforce` throws
 *    TenantContextMissing instead (fail closed, contract §6.3).
 *  - the registry, loaded from MIS GET /platform/tenants/active with this
 *    app's service credentials and falling back to the primary tenant when
 *    MIS is old, unreachable or not configured;
 *  - status gates for requests (contract §6.1) and the X-NGA-Tenant header
 *    for service calls to MIS (contract §3).
 */

export * from '../vendor/nga-tenancy/index.js';

export type TenancyMode = 'shadow' | 'enforce';

export function tenancyMode(): TenancyMode {
  return (process.env.TENANCY_MODE || '').trim().toLowerCase() === 'enforce' ? 'enforce' : 'shadow';
}

/**
 * `TENANCY_LEGACY_DEFAULT_TID` (default 1): the tenant a token without `tid`
 * belongs to. `none` rejects such tokens (401 TENANT_REQUIRED).
 */
export function legacyDefaultTid(): number | null {
  const raw = (process.env.TENANCY_LEGACY_DEFAULT_TID ?? '').trim().toLowerCase();
  if (raw === 'none' || raw === 'null' || raw === 'off') return null;
  return parseTid(raw) ?? PRIMARY_TENANT_ID;
}

const warned = new Set<string>();

/**
 * The tenant code is running for. With no context: tenant 1 in shadow mode
 * (warned once per `what`), TenantContextMissing in enforce mode.
 */
export function effectiveTenant(what = 'operation'): TenantCtx {
  const t = currentTenantOrNull();
  if (t) return t;
  if (tenancyMode() === 'enforce') throw new TenantContextMissing(what);
  if (!warned.has(what)) {
    warned.add(what);
    if (process.env.NODE_ENV !== 'test' && !process.env.VITEST) {
      console.warn(`[tenancy] ${what} ran without a tenant context; using tenant ${PRIMARY_TENANT_ID} (TENANCY_MODE=shadow)`);
    }
  }
  return primaryTenantCtx();
}

export function effectiveTid(what?: string): number {
  return effectiveTenant(what).tid;
}

/** `{ 'X-NGA-Tenant': '<tid>' }` for a service call made inside a request or job. */
export function tenantHeader(tid: number = effectiveTid('MIS service call')): Record<string, string> {
  return { 'X-NGA-Tenant': String(tid) };
}

/** Cache key scoped to the effective tenant: `t<tid>:<parts>`. */
export function scopedKey(...parts: Array<string | number>): string {
  return [`t${effectiveTid('tenant cache')}`, ...parts].join(':');
}

// ---------------------------------------------------------------------------
// Claims carried by MIS tokens and payloads
// ---------------------------------------------------------------------------

/** The tid a decoded token (session JWT, MIS token, logout token) speaks for. */
export function tidOfClaims(claims: unknown, legacy: number | null = legacyDefaultTid()): number | null {
  return tidFromClaims((claims && typeof claims === 'object' ? claims : null) as any, legacy);
}

/** The tid inside a raw MIS JWT, without verifying it (MIS verifies its own tokens). */
export function tidOfMisToken(token: string | null | undefined): number | null {
  if (!token) return null;
  try {
    return tidOfClaims(jwt.decode(token), null);
  } catch {
    return null;
  }
}

/** A `tenant: TenantCtx` (or `tid`) carried in an MIS response body (contract §2). */
export function tenantOfMisPayload(data: any): TenantCtx | null {
  if (!data || typeof data !== 'object') return null;
  if (data.tenant && typeof data.tenant === 'object') return normalizeTenant(data.tenant);
  const tid = parseTid(data.tid);
  return tid ? normalizeTenant({ tid }) : null;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const PLACEHOLDER_SECRETS = new Set(['', 'placeholder_client_secret']);

function serviceAuthHeader(): string | null {
  const token = process.env.MIS_INTEGRATION_TOKEN?.trim();
  if (token) return `Bearer ${token}`;
  if (!PLACEHOLDER_SECRETS.has(config.ssoClientSecret) && config.ssoClientId) {
    return `Basic ${Buffer.from(`${config.ssoClientId}:${config.ssoClientSecret}`).toString('base64')}`;
  }
  return null;
}

let lastGood: TenantCtx[] | null = null;
let loadWarned = false;

/** Make sure tenant 1 is always there: an old or partial MIS answer never drops NGA. */
function withPrimary(list: TenantCtx[]): TenantCtx[] {
  return list.some((t) => t.tid === PRIMARY_TENANT_ID) ? list : [primaryTenantCtx(), ...list];
}

/**
 * GET {MIS}/platform/tenants/active. Never throws: an unconfigured app, an old
 * MIS (404) or a network failure answers with the last good list, else the
 * primary tenant only -- and that answer is cached for the TTL like any other,
 * so a single-school install does not ask MIS on every request.
 */
export async function loadTenantsFromMis(fetchImpl: typeof fetch = fetch): Promise<TenantCtx[]> {
  const auth = serviceAuthHeader();
  if (!auth) return lastGood ?? [primaryTenantCtx()];
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Number(process.env.TENANCY_REGISTRY_TIMEOUT_MS) || 3000);
    let resp: Response;
    try {
      resp = await fetchImpl(`${config.ngaMisBaseUrl.replace(/\/+$/, '')}/platform/tenants/active`, {
        headers: { Authorization: auth, Accept: 'application/json' },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!resp.ok) throw new Error(`MIS /platform/tenants/active returned ${resp.status}`);
    const body: any = await resp.json();
    const raw = body?.tenants ?? body?.data?.tenants ?? (Array.isArray(body?.data) ? body.data : null);
    if (!Array.isArray(raw)) throw new Error('MIS /platform/tenants/active returned no tenant list');
    const list = withPrimary(raw.map((r: any) => normalizeTenant(r ?? {})).filter((t): t is TenantCtx => !!t));
    lastGood = list;
    loadWarned = false;
    return list;
  } catch (err) {
    if (!loadWarned) {
      loadWarned = true;
      console.warn(`[tenancy] tenant registry unavailable (${(err as Error)?.message ?? err}); serving ${lastGood ? 'the last good list' : 'the primary tenant only'}`);
    }
    return lastGood ?? [primaryTenantCtx()];
  }
}

function buildRegistry(): TenantRegistry {
  return new TenantRegistry({
    load: () => loadTenantsFromMis(),
    ttlMs: Number(process.env.TENANCY_REGISTRY_TTL_MS) || 30_000,
    fallback: [primaryTenantCtx()],
  });
}

let registry: Pick<TenantRegistry, 'get' | 'list' | 'listSchedulable' | 'invalidate'> = buildRegistry();

export function tenantRegistry() {
  return registry;
}

/** Test hook: a fixed tenant list (null restores the MIS-backed registry). */
export function __setTenants(list: TenantCtx[] | null): void {
  if (!list) {
    registry = buildRegistry();
    lastGood = null;
    return;
  }
  registry = new TenantRegistry({ load: async () => list, ttlMs: 0 });
}

// ---------------------------------------------------------------------------
// Request gates (contract §6.1)
// ---------------------------------------------------------------------------

export type TenantGate =
  | { ok: true; tenant: TenantCtx }
  | { ok: false; status: 401 | 403; code: 'TENANT_REQUIRED' | 'TENANT_UNKNOWN' | 'TENANT_PENDING' | 'TENANT_SUSPENDED'; message: string };

/** Look a tenant up (re-asking MIS once when it is not in the cached list) and apply the status rules. */
export async function gateTenant(tid: number | null): Promise<TenantGate> {
  if (tid == null) {
    return { ok: false, status: 401, code: 'TENANT_REQUIRED', message: 'This session carries no school. Please sign in again.' };
  }
  let tenant = await registry.get(tid);
  if (!tenant) {
    // A school activated a moment ago may not be in the cached list yet.
    registry.invalidate();
    tenant = await registry.get(tid);
  }
  if (!tenant) return { ok: false, status: 401, code: 'TENANT_UNKNOWN', message: 'This school is not known. Please sign in again.' };
  if (tenant.status === 'PENDING') {
    return { ok: false, status: 403, code: 'TENANT_PENDING', message: 'This school has not been activated yet.' };
  }
  if (!isTenantUsable(tenant.status)) {
    return { ok: false, status: 403, code: 'TENANT_SUSPENDED', message: 'This school’s access is suspended.' };
  }
  return { ok: true, tenant };
}
