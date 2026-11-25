/**
 * Minimal shared API client. Replaces the 21-page pattern of each component
 * inlining `fetch` + its own `authHeaders()` + assuming the same
 * `{success, data}` envelope. New pages should use `apiGet`/`apiPost`/etc.
 * instead of calling `fetch` directly.
 */
import { getDeviceId } from '../activity';
import { readCache, writeCache } from '../offline/outbox';
import { RESIGN_CODES, clearSessionSlot } from '../tenancy/school.ts';
import { cookieSaysOtherSchool, restartSignIn } from '../tenancy/switch';

export class ApiError extends Error {
  status: number;
  /** Machine-readable reason some endpoints send alongside the message
   *  (e.g. 'CARD_ASSIGNED' or 'AI_DISABLED'), so callers never have to match on wording. */
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** No connection at all (fetch itself failed): the request never reached the server. */
export class OfflineError extends ApiError {
  constructor() {
    super("You're offline.", 0);
  }
}

interface Envelope<T> {
  success: boolean;
  /** Set on some refusals, e.g. 'AI_DISABLED' (with `reason`) when the school turned AI off. */
  code?: string;
  data?: T;
  message?: string;
  total?: number;
  /** Served from this device's last copy because there's no connection (src/offline). */
  offline?: { at: number };
}

function authHeaders(token: string | null = localStorage.getItem('sso_token')): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** Per-request options. `token`: send with exactly this session (outbox replay), not the stored one. */
export interface RequestOptions {
  token?: string;
}

/** The shared NGA device id, so server-side analytics events link to this device. */
function deviceHeader(): Record<string, string> {
  const did = getDeviceId();
  return did ? { 'X-NGA-Device': did } : {};
}

async function request<T>(path: string, init: RequestInit = {}, opts: RequestOptions = {}): Promise<Envelope<T>> {
  const isGet = (init.method || 'GET').toUpperCase() === 'GET';
  const sentToken = opts.token ?? localStorage.getItem('sso_token');
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers: {
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...authHeaders(sentToken),
        ...deviceHeader(),
        ...(init.headers || {}),
      },
    });
  } catch {
    // No connection: rosters and the timetable come from this device's last copy.
    if (isGet) {
      const cached = readCache<Envelope<T>>(localStorage, path);
      if (cached) return { ...cached.body, offline: { at: cached.at } };
    }
    throw new OfflineError();
  }

  // A 401 means the stored session is dead (expired, or its user row no
  // longer exists). Clear it and bounce to the login screen rather than
  // letting every page render its own error against a session that can
  // never recover on its own.
  let body: Envelope<T> | null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }

  // Only when the refused token is still the stored one: a late answer to a
  // request made under an older session must not end the current one.
  const stored = localStorage.getItem('sso_token');
  if (res.status === 401 && stored && stored === sentToken) {
    // A session for the wrong school (TENANT_MISMATCH / TENANT_UNKNOWN), or
    // MIS now in another school: sign in again into the MIS session's
    // school (TENANT_SWITCHING_PLAN.md §4.5), not a sign-out.
    if ((body?.code && RESIGN_CODES.has(body.code)) || cookieSaysOtherSchool()) {
      restartSignIn(body?.code || 'school-cookie');
    } else {
      clearSessionSlot(localStorage);
      window.location.href = '/';
    }
  }

  if (!body) throw new ApiError(`Unexpected response (${res.status})`, res.status);

  if (!res.ok || body.success === false) {
    throw new ApiError(body.message || `Request failed (${res.status})`, res.status, body.code);
  }
  if (isGet) writeCache(localStorage, path, body);
  return body;
}

export async function apiGet<T>(path: string): Promise<Envelope<T>> {
  return request<T>(path, { method: 'GET' });
}

export async function apiPost<T>(path: string, data?: unknown, opts?: RequestOptions): Promise<Envelope<T>> {
  return request<T>(path, { method: 'POST', body: data !== undefined ? JSON.stringify(data) : undefined }, opts);
}

export async function apiPut<T>(path: string, data?: unknown): Promise<Envelope<T>> {
  return request<T>(path, { method: 'PUT', body: data !== undefined ? JSON.stringify(data) : undefined });
}

export async function apiDelete<T>(path: string, data?: unknown): Promise<Envelope<T>> {
  return request<T>(path, { method: 'DELETE', body: data !== undefined ? JSON.stringify(data) : undefined });
}
