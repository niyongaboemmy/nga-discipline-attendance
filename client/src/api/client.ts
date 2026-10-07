/**
 * Minimal shared API client. Replaces the 21-page pattern of each component
 * inlining `fetch` + its own `authHeaders()` + assuming the same
 * `{success, data}` envelope. New pages should use `apiGet`/`apiPost`/etc.
 * instead of calling `fetch` directly.
 */
import { getDeviceId } from '../activity';
import { readCache, writeCache } from '../offline/outbox';

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
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
  data?: T;
  message?: string;
  total?: number;
  /** Served from this device's last copy because there's no connection (src/offline). */
  offline?: { at: number };
}

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem('sso_token');
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** The shared NGA device id, so server-side analytics events link to this device. */
function deviceHeader(): Record<string, string> {
  const did = getDeviceId();
  return did ? { 'X-NGA-Device': did } : {};
}

async function request<T>(path: string, init: RequestInit = {}): Promise<Envelope<T>> {
  const isGet = (init.method || 'GET').toUpperCase() === 'GET';
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers: {
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...authHeaders(),
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
  if (res.status === 401 && localStorage.getItem('sso_token')) {
    localStorage.removeItem('sso_token');
    localStorage.removeItem('sso_user');
    localStorage.removeItem('sso_permissions');
    localStorage.removeItem('sso_role_permissions');
    window.location.href = '/';
  }

  let body: Envelope<T>;
  try {
    body = await res.json();
  } catch {
    throw new ApiError(`Unexpected response (${res.status})`, res.status);
  }

  if (!res.ok || body.success === false) {
    throw new ApiError(body.message || `Request failed (${res.status})`, res.status);
  }
  if (isGet) writeCache(localStorage, path, body);
  return body;
}

export async function apiGet<T>(path: string): Promise<Envelope<T>> {
  return request<T>(path, { method: 'GET' });
}

export async function apiPost<T>(path: string, data?: unknown): Promise<Envelope<T>> {
  return request<T>(path, { method: 'POST', body: data !== undefined ? JSON.stringify(data) : undefined });
}

export async function apiPut<T>(path: string, data?: unknown): Promise<Envelope<T>> {
  return request<T>(path, { method: 'PUT', body: data !== undefined ? JSON.stringify(data) : undefined });
}

export async function apiDelete<T>(path: string, data?: unknown): Promise<Envelope<T>> {
  return request<T>(path, { method: 'DELETE', body: data !== undefined ? JSON.stringify(data) : undefined });
}
