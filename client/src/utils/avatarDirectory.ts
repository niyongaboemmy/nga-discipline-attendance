import { useEffect, useSyncExternalStore } from 'react';
import type { MisAvatar } from './avatar';

/**
 * Who looks like what: NGA profile photos for the people on a page, by MIS user id
 * (Tendo's own user and student ids). Every id asked for during one render goes out as
 * a single POST /api/avatars/lookup; answers are kept for the session, including
 * "no photo" (null), so nobody is asked about twice.
 */
type Entry = MisAvatar | null;
export type AvatarTransport = (ids: string[]) => Promise<Record<string, MisAvatar>>;

const BATCH = 500;
const FLUSH_DELAY_MS = 16;

const defaultTransport: AvatarTransport = async (ids) => {
  // Imported lazily: the API client reads the session from the browser.
  const { apiPost } = await import('../api/client');
  const res = await apiPost<{ avatars: Record<string, MisAvatar> }>('/api/avatars/lookup', { ids });
  return res.data?.avatars ?? {};
};
let transport: AvatarTransport = defaultTransport;

const cache = new Map<string, Entry>();
const queued = new Set<string>();
const inFlight = new Set<string>();
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | null = null;

const emit = () => listeners.forEach((l) => l());
/** MIS user ids are positive integers; anything else (an email-keyed fallback id) can't have a photo. */
export const isMisId = (id: unknown): id is string | number => /^[1-9]\d{0,15}$/.test(String(id ?? ''));

async function flush() {
  timer = null;
  const ids = [...queued];
  queued.clear();
  for (let i = 0; i < ids.length; i += BATCH) {
    const chunk = ids.slice(i, i + BATCH);
    chunk.forEach((id) => inFlight.add(id));
    try {
      const avatars = await transport(chunk);
      chunk.forEach((id) => cache.set(id, avatars[id] ?? null));
    } catch {
      chunk.forEach((id) => cache.set(id, null)); // initials; no retry storm
    } finally {
      chunk.forEach((id) => inFlight.delete(id));
    }
  }
  emit();
}

export function requestAvatar(id: string | number | null | undefined) {
  if (!isMisId(id)) return;
  const key = String(id);
  if (cache.has(key) || queued.has(key) || inFlight.has(key)) return;
  queued.add(key);
  if (!timer) timer = setTimeout(flush, FLUSH_DELAY_MS);
}

/** Record a photo already known (e.g. your own from the session). */
export function primeAvatar(id: string | number, avatar: Entry | undefined) {
  if (!isMisId(id) || avatar === undefined) return;
  cache.set(String(id), avatar);
  emit();
}

export const getCachedAvatar = (id: string | number): Entry | undefined => cache.get(String(id));

const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

/** undefined while unknown, null when the person has no photo. */
export function useMisAvatar(id: string | number | null | undefined): Entry | undefined {
  const snapshot = useSyncExternalStore(subscribe, () => (isMisId(id) ? cache.get(String(id)) : undefined));
  useEffect(() => requestAvatar(id), [id]);
  return snapshot;
}

export function _setAvatarTransportForTests(fn: AvatarTransport | null) {
  transport = fn ?? defaultTransport;
  cache.clear();
  queued.clear();
  inFlight.clear();
  if (timer) clearTimeout(timer);
  timer = null;
}
