/**
 * School (tenant) switching, the browser side (TENANT_SWITCHING_PLAN.md §4.2,
 * §4.5 and Appendix A).
 *
 * One school per browser: the school is the `tid` of the MIS browser session,
 * which MIS publishes in the readable cookie `nga_school=<tid>.<sid>`. When
 * it names another school than this Tendo session, Tendo drops its session
 * slot (no sign-out) and runs the MIS SSO again, which lands in the MIS
 * session's school.
 *
 * Plain functions over Storage-like objects and strings, so they are
 * unit-tested without a browser (tests/schoolSwitch.test.ts). No imports
 * except other plain modules.
 */

export interface KV {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** The session slot: dropped on a switch, without the sign-out side effects. */
export const SESSION_KEYS = ['sso_token', 'sso_user', 'sso_permissions', 'sso_role_permissions'] as const;

const COOKIE_RE = /^(\d{1,9})\.([A-Za-z0-9_-]{8,32})$/;

/** `nga_school` out of a `document.cookie` string (A.1), or null when absent or malformed. */
export function parseSchoolCookie(cookie: string | null | undefined): { tid: number; sid: string } | null {
  if (!cookie) return null;
  for (const part of cookie.split(';')) {
    const i = part.indexOf('=');
    if (i < 0 || part.slice(0, i).trim() !== 'nga_school') continue;
    let value = part.slice(i + 1).trim();
    try {
      value = decodeURIComponent(value);
    } catch {
      return null;
    }
    const m = COOKIE_RE.exec(value);
    if (!m) return null;
    const tid = Number(m[1]);
    return tid > 0 ? { tid, sid: m[2] } : null;
  }
  return null;
}

/** The school of the stored Tendo session (sso_user.tid; a pre-tenancy session is school 1), or null when signed out. */
export function sessionTid(kv: KV): number | null {
  try {
    if (!kv.getItem('sso_token')) return null;
    const u = JSON.parse(kv.getItem('sso_user') || 'null');
    if (!u) return null;
    const tid = Number(u.tid);
    return Number.isSafeInteger(tid) && tid > 0 ? tid : 1;
  } catch {
    return null;
  }
}

/** The `tid` inside a Tendo session JWT (unverified: the server verifies), 1 for a pre-tenancy token, null for none. */
export function tidOfToken(token: string | null | undefined): number | null {
  if (!token) return null;
  try {
    const part = token.split('.')[1];
    if (!part) return null;
    const json = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=')));
    const tid = Number(json?.tid);
    return Number.isSafeInteger(tid) && tid > 0 ? tid : 1;
  } catch {
    return null;
  }
}

/**
 * The guard's decision (A.1 table): `switch` only when both a session and the
 * cookie exist and name different schools. No cookie = nothing to do (the
 * person may use Tendo without MIS open; the verify-mis poll covers sign-out).
 */
export function guardDecision(cookieTid: number | null, ownTid: number | null): 'ok' | 'switch' {
  return cookieTid != null && ownTid != null && cookieTid !== ownTid ? 'switch' : 'ok';
}

// ─── loop guard ────────────────────────────────────────────────────────────

const TRIES_KEY = 'tendo.schoolSwitch.tries';
export const MAX_TRIES = 3;
export const TRY_WINDOW_MS = 2 * 60 * 1000;

/**
 * Records one automatic re-sign-in and says whether it may go ahead: at most
 * 3 per 2 minutes (§4.5 step 5), after which the manual sign-in is shown.
 */
export function allowSwitchAttempt(kv: KV, now = Date.now()): boolean {
  let tries: number[] = [];
  try {
    const v = JSON.parse(kv.getItem(TRIES_KEY) || '[]');
    if (Array.isArray(v)) tries = v.filter((t) => typeof t === 'number' && now - t < TRY_WINDOW_MS);
  } catch {
    tries = [];
  }
  if (tries.length >= MAX_TRIES) return false;
  tries.push(now);
  try {
    kv.setItem(TRIES_KEY, JSON.stringify(tries));
  } catch {
    /* storage unavailable: no loop guard memory, the SSO still runs */
  }
  return true;
}

/**
 * True while the last 2 minutes already used the 3 tries: the cookie guard
 * then stays quiet, so a manual sign-in is not kicked out again at once.
 */
export function switchAttemptsExhausted(kv: KV, now = Date.now()): boolean {
  try {
    const v = JSON.parse(kv.getItem(TRIES_KEY) || '[]');
    return Array.isArray(v) && v.filter((t) => typeof t === 'number' && now - t < TRY_WINDOW_MS).length >= MAX_TRIES;
  } catch {
    return false;
  }
}

/** Forget the loop guard. */
export function resetSwitchAttempts(kv: KV) {
  try {
    kv.removeItem(TRIES_KEY);
  } catch {
    /* nothing to forget */
  }
}

/** Drop the session slot. Not a sign-out: no activity end, cached reads and waiting registers stay. */
export function clearSessionSlot(kv: KV) {
  for (const k of SESSION_KEYS) {
    try {
      kv.removeItem(k);
    } catch {
      /* storage unavailable */
    }
  }
}

// ─── other tabs ────────────────────────────────────────────────────────────

/**
 * What a tab does when another tab changes the session slot (`storage` event):
 *  - `reload`  a different session (school or person) took over: reload so this
 *              tab never mixes two schools;
 *  - `wait`    the slot was cleared (a switch or a sign-out is under way in the
 *              other tab): show the overlay and reload when it settles;
 *  - `ignore`  same session, or a key we don't care about.
 */
export function storageChange(
  key: string | null,
  newValue: string | null,
  own: { token: string | null; tid: number | null; uid: string | null },
): 'reload' | 'wait' | 'ignore' {
  if (key === null) return own.token ? 'wait' : 'ignore'; // localStorage.clear()
  if (key === 'sso_token') {
    if (newValue === own.token) return 'ignore';
    if (!newValue) return own.token ? 'wait' : 'ignore';
    // A re-signed token for the same school and person (academic period switch) is fine.
    return own.token && tidOfToken(newValue) === own.tid ? 'ignore' : 'reload';
  }
  if (key === 'sso_user') {
    if (!newValue) return own.token ? 'wait' : 'ignore';
    try {
      const u = JSON.parse(newValue);
      const tid = Number(u?.tid) > 0 ? Number(u.tid) : 1;
      const uid = u?.id == null ? null : String(u.id);
      return own.token && tid === own.tid && uid === own.uid ? 'ignore' : 'reload';
    } catch {
      return 'ignore';
    }
  }
  return 'ignore';
}

// ─── branding ──────────────────────────────────────────────────────────────

export interface SchoolBranding {
  tid: number;
  name: string | null;
  logoUrl: string | null;
  slug?: string | null;
}

const brandingKey = (tid: number) => `tendo.school.v1.${tid}`;

/** Remember a school's name/logo on this device (shown for registers waiting for that school). */
export function rememberBranding(kv: KV, b: SchoolBranding) {
  try {
    kv.setItem(brandingKey(b.tid), JSON.stringify(b));
  } catch {
    /* storage full: only a label */
  }
}

export function cachedBranding(kv: KV, tid: number): SchoolBranding | null {
  try {
    const v = JSON.parse(kv.getItem(brandingKey(tid)) || 'null');
    return v && typeof v === 'object' ? (v as SchoolBranding) : null;
  } catch {
    return null;
  }
}

/** A human label for a school: cached name, else its slug, else "school <tid>". */
export function schoolLabel(kv: KV, tid: number, slug?: string | null): string {
  const b = cachedBranding(kv, tid);
  return b?.name || b?.slug || slug || `school ${tid}`;
}

/**
 * Where "Switch school" goes: the MIS switch page (A.4) with `return` set to
 * Tendo's SSO entry (`/?sso=1`, which starts MIS SSO straight away), so the
 * person comes back already in the new school.
 */
export function switchSchoolUrl(misHome: string, appOrigin: string): string {
  const base = misHome.replace(/\/+$/, '');
  return `${base}/switch-school?return=${encodeURIComponent(`${appOrigin.replace(/\/+$/, '')}/?sso=1`)}`;
}

/** The MIS front-end origin: VITE_MIS_HOME_URL, else the origin of VITE_MIS_LOGIN_URL. */
export function misHomeOf(homeUrl: string | undefined, loginUrl: string | undefined): string {
  if (homeUrl) return homeUrl;
  try {
    return loginUrl ? new URL(loginUrl).origin : 'https://mis.amashuri.com';
  } catch {
    return 'https://mis.amashuri.com';
  }
}

/** The analytics identity key: `<tid>:<uid>`, so the same id in two schools is two people. */
export function activityUserKey(kv: KV): string | null {
  try {
    if (!kv.getItem('sso_token')) return null;
    const u = JSON.parse(kv.getItem('sso_user') || 'null');
    const id = Number(u?.id);
    if (!Number.isSafeInteger(id) || id <= 0) return null;
    const tid = Number(u?.tid);
    return `${Number.isSafeInteger(tid) && tid > 0 ? tid : 1}:${id}`;
  } catch {
    return null;
  }
}

/** 401/409 codes that mean "sign in again into the current school", not "sign out". */
export const RESIGN_CODES = new Set(['TENANT_MISMATCH', 'TENANT_UNKNOWN', 'SCHOOL_CHANGED']);
