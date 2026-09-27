import { config } from '../config.js';
import type { AccessSnapshot } from '../vendor/nga-access/index.js';

/**
 * Access control v2 snapshot client (packages/access/README.md §4-5).
 *
 * GET {MIS}/access/me?app=da with the user's own MIS token returns their
 * compiled AccessSnapshot. It is cached in memory per MIS user id and its
 * `v` (User.access_version):
 *
 *  - fresh for FRESH_MS; after that it is re-fetched on next use;
 *  - dropped early when the verify-mis poll reports a different
 *    access_version (noteAccessVersion);
 *  - when MIS is unreachable the last good snapshot is kept for up to
 *    STALE_MAX_MS (24h), then the user has no snapshot (fail closed);
 *  - a 503 from MIS means "access v2 is not installed there": unavailable,
 *    no snapshot, and not asked again for UNAVAILABLE_BACKOFF_MS.
 *
 * Local user ids ARE MIS user ids (routes/sso.ts stores String(misUser.user_id)),
 * so the MIS id is just Number(localUser.id).
 */

const FRESH_MS = 5 * 60 * 1000;
const STALE_MAX_MS = 24 * 60 * 60 * 1000;
const FAILURE_BACKOFF_MS = 30 * 1000;
const UNAVAILABLE_BACKOFF_MS = 5 * 60 * 1000;
export const MIS_TIMEOUT_MS = 3000;

interface CacheEntry {
  snapshot: AccessSnapshot;
  fetchedAt: number;
}

const cache = new Map<number, CacheEntry>();
/** Latest access_version MIS reported for a user (from the verify-mis poll). */
const versionHints = new Map<number, number>();
/** misUserId -> time before which we don't ask MIS again after a failure. */
const backoffUntil = new Map<number, number>();
const inflight = new Map<number, Promise<AccessSnapshot | null>>();

export function misUserIdOf(localUser: { id?: string | number } | null | undefined): number | null {
  const n = Number(localUser?.id);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** fetch with a hard timeout -- MIS must never stall a request for long. */
export async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = MIS_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function usable(entry: CacheEntry | undefined, now: number, maxAge: number): entry is CacheEntry {
  return !!entry && now - entry.fetchedAt < maxAge;
}

/**
 * The user's snapshot, or null when there is none to be had (no MIS id, v2
 * not installed on MIS, or MIS unreachable for more than 24h).
 */
export async function getSnapshot(
  localUser: { id?: string | number } | null | undefined,
  misToken: string | null | undefined
): Promise<AccessSnapshot | null> {
  const misUserId = misUserIdOf(localUser);
  if (misUserId == null) return null;

  const now = Date.now();
  const entry = cache.get(misUserId);
  const hint = versionHints.get(misUserId);
  const versionOk = !entry || hint === undefined || entry.snapshot.v === hint;
  if (usable(entry, now, FRESH_MS) && versionOk) return entry.snapshot;

  const stale = usable(entry, now, STALE_MAX_MS) ? entry.snapshot : null;
  if (!misToken || (backoffUntil.get(misUserId) ?? 0) > now) return stale;

  let p = inflight.get(misUserId);
  if (!p) {
    p = fetchSnapshot(misUserId, misToken, stale).finally(() => inflight.delete(misUserId));
    inflight.set(misUserId, p);
  }
  return p;
}

async function fetchSnapshot(misUserId: number, misToken: string, stale: AccessSnapshot | null): Promise<AccessSnapshot | null> {
  try {
    const resp = await fetchWithTimeout(`${config.ngaMisBaseUrl}/access/me?app=da`, {
      headers: { Authorization: `Bearer ${misToken}`, Accept: 'application/json' },
    });
    if (resp.status === 503) {
      // Access v2 is not installed on this MIS: nothing to decide with.
      cache.delete(misUserId);
      backoffUntil.set(misUserId, Date.now() + UNAVAILABLE_BACKOFF_MS);
      return null;
    }
    if (!resp.ok) throw new Error(`MIS /access/me returned ${resp.status}`);
    const body = (await resp.json()) as any;
    const snapshot = (body && typeof body === 'object' && 'data' in body ? body.data : body) as AccessSnapshot;
    if (!snapshot || typeof snapshot !== 'object' || typeof snapshot.caps !== 'object') {
      throw new Error('MIS /access/me returned no snapshot');
    }
    cache.set(misUserId, { snapshot, fetchedAt: Date.now() });
    if (typeof snapshot.v === 'number') versionHints.set(misUserId, snapshot.v);
    backoffUntil.delete(misUserId);
    return snapshot;
  } catch (err) {
    backoffUntil.set(misUserId, Date.now() + FAILURE_BACKOFF_MS);
    console.warn(`[access] snapshot fetch failed for MIS user ${misUserId}: ${(err as Error)?.message ?? err}`);
    return stale;
  }
}

/**
 * Called from the verify-mis proxy with MIS's current access_version. A
 * different version than the cached snapshot's drops the entry, so the next
 * check re-fetches. The stale copy is NOT kept as a fallback: MIS just told us
 * it is out of date.
 */
export function noteAccessVersion(misUserId: number | null | undefined, v: unknown) {
  if (misUserId == null || typeof v !== 'number' || !Number.isFinite(v)) return;
  versionHints.set(misUserId, v);
  const entry = cache.get(misUserId);
  if (entry && entry.snapshot.v !== v) {
    cache.delete(misUserId);
    backoffUntil.delete(misUserId);
  }
}

/** Test hook. */
export function __resetSnapshotCache() {
  cache.clear();
  versionHints.clear();
  backoffUntil.clear();
  inflight.clear();
}

/** Test hook: age a cached entry. */
export function __ageSnapshot(misUserId: number, ms: number) {
  const entry = cache.get(misUserId);
  if (entry) entry.fetchedAt -= ms;
}
