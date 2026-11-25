/** The public staff clock API (/api/clock/:slug). No session: the device token proves the device. */

export class ClockApiError extends Error {
  status: number;
  code: string;
  data: Record<string, unknown>;
  constructor(status: number, code: string, message: string, data: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

export class OfflineError extends ClockApiError {
  constructor() {
    super(0, 'OFFLINE', 'No connection');
  }
}

export interface Zone {
  id: number;
  name: string;
  kind: string;
  lat: number | null;
  lng: number | null;
  radius: number | null;
}

export interface Bootstrap {
  school: { name: string; slug: string; logoUrl?: string | null };
  open: boolean;
  googleClientId: string | null;
  /** Amashuri profile card where staff link the Gmail they check in with */
  profileUrl?: string;
  serverNow: string;
  schoolDate: string;
  timezone: string;
  rules: { opens: string; lateAfter: string; earlyLeaveBefore: string; minShiftMinutes: number; maxAccuracy: number; requireZone: boolean };
  zones: Zone[];
}

export interface Person {
  name: string;
  firstName: string;
  initials: string;
  role: string | null;
}

export interface WeekDay {
  date: string;
  isToday: boolean;
  future: boolean;
  checkIn: string | null;
  checkOut: string | null;
  status: string | null;
}

export interface DayState {
  serverNow: string;
  schoolDate: string;
  timezone: string;
  schoolDay: boolean;
  next: 'check_in' | 'check_out' | 'done' | 'closed';
  checkoutOpensAt: string | null;
  opensAt: string;
  today: { checkIn: string | null; checkOut: string | null; status: string; outStatus: string | null; minutesAtSchool: number } | null;
  week: WeekDay[];
}

export interface Me extends DayState {
  school: { name: string; slug: string };
  open: boolean;
  person: Person;
  email: string;
  device: { status: 'active' | 'pending'; label: string | null; formFactor: string; registeredAt: string };
  rules: { lateAfter: string; earlyLeaveBefore: string; minShiftMinutes: number };
}

export interface RegisterPreview {
  preview: true;
  deviceStatus: 'active' | 'pending';
  replaces: boolean;
  person: Person;
  email: string;
}

export interface Registered {
  deviceToken: string;
  deviceStatus: 'active' | 'pending';
  replaced: boolean;
  person: Person;
  email: string;
}

export interface PunchResult {
  action: 'check_in' | 'check_out';
  at: string;
  status: string;
  distance: number | null;
  zone: string | null;
  flags: string[];
  state: DayState;
}

async function call<T>(slug: string, path: string, init: RequestInit & { token?: string | null } = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (init.body) headers['Content-Type'] = 'application/json';
  if (init.token) headers['X-Clock-Device'] = init.token;
  let res: Response;
  try {
    res = await fetch(`/api/clock/${encodeURIComponent(slug)}${path}`, { ...init, headers, cache: 'no-store' });
  } catch {
    throw new OfflineError();
  }
  let body: { success?: boolean; code?: string; message?: string; data?: unknown } | null = null;
  try {
    body = await res.json();
  } catch {
    /* not JSON */
  }
  if (!res.ok || !body?.success) {
    throw new ClockApiError(res.status, body?.code || 'ERROR', body?.message || 'Something went wrong. Try again.', (body as Record<string, unknown>) || {});
  }
  return body.data as T;
}

export const clockApi = {
  bootstrap: (slug: string) => call<Bootstrap>(slug, '/bootstrap'),
  register: (slug: string, payload: Record<string, unknown>) => call<RegisterPreview | Registered>(slug, '/register', { method: 'POST', body: JSON.stringify(payload) }),
  me: (slug: string, token: string) => call<Me>(slug, '/me', { token }),
  challenge: (slug: string, token: string) => call<{ nonce: string; expiresIn: number; serverNow: string }>(slug, '/challenge', { method: 'POST', token, body: '{}' }),
  punch: (slug: string, token: string, payload: Record<string, unknown>) => call<PunchResult>(slug, '/punch', { method: 'POST', token, body: JSON.stringify(payload) }),
};
