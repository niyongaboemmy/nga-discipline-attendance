/**
 * Minimal shared API client. Replaces the 21-page pattern of each component
 * inlining `fetch` + its own `authHeaders()` + assuming the same
 * `{success, data}` envelope. New pages should use `apiGet`/`apiPost`/etc.
 * instead of calling `fetch` directly.
 */

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

interface Envelope<T> {
  success: boolean;
  data?: T;
  message?: string;
  total?: number;
}

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem('sso_token');
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function request<T>(path: string, init: RequestInit = {}): Promise<Envelope<T>> {
  const res = await fetch(path, {
    ...init,
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...authHeaders(),
      ...(init.headers || {}),
    },
  });

  let body: Envelope<T>;
  try {
    body = await res.json();
  } catch {
    throw new ApiError(`Unexpected response (${res.status})`, res.status);
  }

  if (!res.ok || body.success === false) {
    throw new ApiError(body.message || `Request failed (${res.status})`, res.status);
  }
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

export async function apiDelete<T>(path: string): Promise<Envelope<T>> {
  return request<T>(path, { method: 'DELETE' });
}
