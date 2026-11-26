import { randomBytes } from 'crypto';
import type { DeviceRow } from './clock.service.js';

/**
 * Carrying a sign-in from the browser to the installed app on the same phone.
 *
 * An iPhone gives a page added to the Home Screen its own empty storage: the
 * device key made in Safari is not there, so the installed app would have to
 * sign in with Google again (which often fails inside an installed web app).
 * Instead the signed-in page asks for a short-lived, single-use code; it rides in
 * the Home Screen icon's start address, and the installed app trades it once for
 * a registration of its own key, for the same person, on the same phone.
 *
 * In memory only (one Tendo process, like the phone-tap codes): after a restart
 * the code is gone and the installed app simply asks for Google sign-in.
 */

const TTL_MS = 15 * 60_000;
const MAX = 20_000;

interface Handoff { tid: number; deviceId: number; userId: string; userName: string; googleSub: string; googleEmail: string; exp: number }
const codes = new Map<string, Handoff>();

export const HANDOFF_RE = /^[A-Za-z0-9_-]{24,64}$/;

export function createHandoff(tid: number, device: DeviceRow, now: number): { code: string; expiresIn: number } {
  if (codes.size > MAX) for (const [k, v] of codes) if (v.exp <= now) codes.delete(k);
  // One live code per device: asking again replaces the last one.
  for (const [k, v] of codes) if (v.tid === tid && v.deviceId === device.id) codes.delete(k);
  const code = randomBytes(24).toString('base64url');
  codes.set(code, { tid, deviceId: device.id, userId: device.user_id, userName: device.user_name, googleSub: device.google_sub, googleEmail: device.google_email, exp: now + TTL_MS });
  return { code, expiresIn: Math.round(TTL_MS / 1000) };
}

/** Single use: the code is gone whether or not what follows succeeds. */
export function takeHandoff(tid: number, code: unknown, now: number): Handoff | null {
  const key = String(code ?? '');
  if (!HANDOFF_RE.test(key)) return null;
  const h = codes.get(key);
  if (!h) return null;
  codes.delete(key);
  return h.tid === tid && h.exp > now ? h : null;
}

export function __resetHandoffs(): void {
  codes.clear();
}
