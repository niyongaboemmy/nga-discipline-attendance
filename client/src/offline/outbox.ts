/**
 * Offline registers (nga-desktop NEXT_FEATURES_ANALYSIS §3 #6).
 *
 * Classroom Wi-Fi drops. A register saved without a connection is kept on
 * this device (per signed-in person) and sent as soon as the connection is
 * back: on the `online` event, when the app opens, and every minute while
 * something is waiting. Saving the same register again (same class, date,
 * period, session type and subject) replaces the waiting copy. The server's
 * POST /api/attendance/mark is an upsert, so sending twice is harmless.
 *
 * Plain functions over a Storage-like object, so they're unit-tested without
 * a browser (tests/offlineOutbox.test.ts).
 *
 * Keys carry the school as well as the person (TD-9: one device can be used
 * by two schools): `tendo.outbox.v2.<tid>.<uid>` and
 * `tendo.cache.v2.<tid>.<uid>.<path>`. The `uid` parameter of every function
 * below is that `<tid>.<uid>` owner (see currentOwner). Keys written before
 * tenancy (v1, no tid) belong to tenant 1 and are moved once
 * (migrateV1Keys).
 */

export interface KV {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface RegisterPayload {
  classId: string;
  className?: string;
  date: string;
  period: number | string;
  sessionType: string;
  subjectId?: string | number | null;
  subjectName?: string;
  /** The rows as the page sends them (studentId, status, notes, …); passed through untouched. */
  records: object[];
}

export interface Waiting {
  key: string;
  payload: RegisterPayload;
  savedAt: number;
  /** Set when the server refused it (it stays until someone looks). */
  error?: string;
  attempts: number;
}

/** The signed-in person (sso_user), so one teacher never sends another's queue. */
export function currentUserId(kv: KV): string | null {
  try {
    const u = JSON.parse(kv.getItem('sso_user') || 'null');
    const id = u?.id ?? u?.userId ?? u?.user_id;
    return id === undefined || id === null ? null : String(id);
  } catch {
    return null;
  }
}

/** The signed-in person's school (sso_user.tid). A session from before tenancy is NGA, tenant 1. */
export function currentTenantId(kv: KV): string {
  try {
    const u = JSON.parse(kv.getItem('sso_user') || 'null');
    const tid = Number(u?.tid);
    return Number.isSafeInteger(tid) && tid > 0 ? String(tid) : '1';
  } catch {
    return '1';
  }
}

/** `<tid>.<uid>` for the signed-in person, or null when nobody is signed in. */
export function currentOwner(kv: KV): string | null {
  const uid = currentUserId(kv);
  if (!uid) return null;
  migrateV1Keys(kv, uid);
  return `${currentTenantId(kv)}.${uid}`;
}

const boxKey = (owner: string) => `tendo.outbox.v2.${owner}`;
const V1_BOX = 'tendo.outbox.v1.';
const V1_CACHE = 'tendo.cache.v1.';

/**
 * One-time move of pre-tenancy keys into tenant 1's v2 keys. A v1 outbox is
 * merged into any v2 one already there (v2 wins for the same register).
 * Cached reads are moved when the storage can be enumerated, else dropped
 * from view (they are only a convenience copy). Safe to call repeatedly.
 */
export function migrateV1Keys(kv: KV & { length?: number; key?(i: number): string | null }, uid?: string) {
  const moveBox = (id: string) => {
    const raw = kv.getItem(V1_BOX + id);
    if (raw === null) return;
    try {
      const old = JSON.parse(raw);
      const target = boxKey(`1.${id}`);
      const cur = JSON.parse(kv.getItem(target) || '[]');
      const curItems: Waiting[] = Array.isArray(cur) ? cur : [];
      const merged = [...(Array.isArray(old) ? old : []).filter((w: Waiting) => !curItems.some((c) => c.key === w?.key)), ...curItems];
      if (merged.length) kv.setItem(target, JSON.stringify(merged));
    } catch {
      /* unreadable v1 queue: nothing to keep */
    }
    kv.removeItem(V1_BOX + id);
  };
  if (uid) moveBox(uid);
  if (typeof kv.length !== 'number' || !kv.key) return;
  const keys: string[] = [];
  for (let i = 0; i < kv.length; i++) {
    const k = kv.key(i);
    if (k && (k.startsWith(V1_BOX) || k.startsWith(V1_CACHE))) keys.push(k);
  }
  for (const k of keys) {
    if (k.startsWith(V1_BOX)) moveBox(k.slice(V1_BOX.length));
    else {
      const v = kv.getItem(k);
      if (v !== null) {
        try {
          kv.setItem(`tendo.cache.v2.1.${k.slice(V1_CACHE.length)}`, v);
        } catch {
          /* storage full: the copy is just not kept */
        }
      }
      kv.removeItem(k);
    }
  }
}

/** One register = one slot in the outbox. */
export const registerKey = (p: RegisterPayload) =>
  [p.classId, p.date, String(p.period), p.sessionType, p.sessionType === 'subject' ? p.subjectId ?? '' : ''].join('|');

export function list(kv: KV, uid: string | null = currentOwner(kv)): Waiting[] {
  if (!uid) return [];
  try {
    const v = JSON.parse(kv.getItem(boxKey(uid)) || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function save(kv: KV, uid: string, items: Waiting[]) {
  if (items.length) kv.setItem(boxKey(uid), JSON.stringify(items));
  else kv.removeItem(boxKey(uid));
}

export function enqueue(kv: KV, payload: RegisterPayload, now = Date.now(), uid: string | null = currentOwner(kv)): Waiting | null {
  if (!uid) return null;
  const key = registerKey(payload);
  const items = list(kv, uid).filter((w) => w.key !== key);
  const item: Waiting = { key, payload, savedAt: now, attempts: 0 };
  items.push(item);
  save(kv, uid, items);
  return item;
}

export function remove(kv: KV, key: string, uid: string | null = currentOwner(kv)) {
  if (!uid) return;
  save(kv, uid, list(kv, uid).filter((w) => w.key !== key));
}

/** How a send went: sent; refused by the server (keep, show why); or no connection (try later). */
export type SendOutcome = { ok: true } | { ok: false; refused: true; message: string } | { ok: false; refused: false };

/**
 * Sends everything waiting, oldest first. Stops at the first "no connection"
 * (no point hammering a dead network). Returns what happened.
 */
export async function flush(kv: KV, send: (p: RegisterPayload) => Promise<SendOutcome>, uid: string | null = currentOwner(kv)) {
  const result = { sent: 0, refused: 0, waiting: 0 };
  if (!uid) return result;
  const items = list(kv, uid).sort((a, b) => a.savedAt - b.savedAt);
  for (const w of items) {
    if (w.error) {
      result.refused++;
      continue;
    }
    const r = await send(w.payload);
    if (r.ok) {
      remove(kv, w.key, uid);
      result.sent++;
      continue;
    }
    const cur = list(kv, uid);
    const i = cur.findIndex((x) => x.key === w.key && x.savedAt === w.savedAt);
    if (i >= 0) {
      cur[i] = { ...cur[i], attempts: cur[i].attempts + 1, ...(r.refused ? { error: r.message } : {}) };
      save(kv, uid, cur);
    }
    if (r.refused) {
      result.refused++;
      continue;
    }
    break;
  }
  result.waiting = list(kv, uid).filter((w) => !w.error).length;
  return result;
}

// ─── cached reads ───────────────────────────────────────────────────────────

/** GETs worth keeping for offline use: rosters, subjects and the timetable. */
export const OFFLINE_GET = /^\/api\/(mis\/(classes|students|class-subjects)|academics\/subjects|attendance\/(schedule\/|session|coverage|me)|discipline\/overview|roles-permissions\/me)/;

const cacheKey = (owner: string, path: string) => `tendo.cache.v2.${owner}.${path}`;

export function writeCache(kv: KV, path: string, body: unknown, uid: string | null = currentOwner(kv)) {
  if (!uid || !OFFLINE_GET.test(path)) return;
  try {
    kv.setItem(cacheKey(uid, path), JSON.stringify({ at: Date.now(), body }));
  } catch {
    /* storage full: offline copy just isn't refreshed */
  }
}

export function readCache<T>(kv: KV, path: string, uid: string | null = currentOwner(kv)): { at: number; body: T } | null {
  if (!uid || !OFFLINE_GET.test(path)) return null;
  try {
    return JSON.parse(kv.getItem(cacheKey(uid, path)) || 'null');
  } catch {
    return null;
  }
}

/** Sign-out on a shared computer: drop the cached rosters (the outbox stays for its owner). */
export function clearCache(kv: KV & { length?: number; key?(i: number): string | null }) {
  if (typeof kv.length !== 'number' || !kv.key) return;
  const doomed: string[] = [];
  for (let i = 0; i < kv.length; i++) {
    const k = kv.key(i);
    if (k && (k.startsWith('tendo.cache.v2.') || k.startsWith(V1_CACHE))) doomed.push(k);
  }
  doomed.forEach((k) => kv.removeItem(k));
}
