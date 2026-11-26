import { randomBytes } from 'crypto';
import type { Database } from 'sqlite';
import { consumeNonce, verifyDeviceSignature, type EcJwk } from './deviceAuth.js';
import { plausibilityFlags, validFix, type Fix } from './geofence.js';
import { applyTap, ClockError, clockNow, clockReady, personState, type DeviceRow, type PunchResult } from './clock.service.js';

/**
 * Check in or out from a computer with a phone's GPS (computers have no GPS, so
 * their location is often hundreds of metres off).
 *
 * The person's own registered computer signs a request for a code and shows it as
 * a QR code. Any phone scans it, opens /c/<school>/tap/<code>, reads its location
 * and sends it; the server records the tap for the computer's owner exactly like a
 * tap on their own device (school clock, one in and one out, inside the zone), and
 * marks it "phone_location". The computer polls the code and shows the result.
 *
 * Codes live 2 minutes and record at most one tap, so a photo of the QR sent away
 * is soon useless; the location is still checked against the school zone.
 */

const TTL_MS = 2 * 60_000;
const MAX_TRIES = 6;

export type PhoneTapState = 'waiting' | 'locating' | 'done' | 'failed';

interface PhoneTap {
  tid: number;
  deviceId: number;
  userName: string;
  expires: number;
  state: PhoneTapState;
  tries: number;
  result: PunchResult | null;
  error: { code: string; message: string; data: Record<string, unknown> } | null;
}

const taps = new Map<string, PhoneTap>();

function sweep(now: number) {
  for (const [code, t] of taps) if (t.expires + 60_000 <= now) taps.delete(code);
}

/** What the computer signs to ask for a code. Both sides build it the same way. */
export function phoneTapMessage(nonce: string): string {
  return `tendo-clock-phone-v1|${nonce}`;
}

/** From the person's own computer, signed with its key over a fresh challenge. */
export function createPhoneTap(tid: number, device: DeviceRow, body: { nonce?: unknown; signature?: unknown }, now = clockNow()) {
  if (!consumeNonce(`t${tid}:d${device.id}`, String(body.nonce || ''), now)) {
    throw new ClockError(401, 'BAD_CHALLENGE', 'That took too long. Try again.');
  }
  const jwk = JSON.parse(device.public_key_jwk) as EcJwk;
  if (!verifyDeviceSignature(jwk, phoneTapMessage(String(body.nonce)), String(body.signature || ''))) {
    throw new ClockError(401, 'BAD_SIGNATURE', 'This device could not prove it is yours. Register it again.');
  }
  sweep(now);
  // One live code per computer: a new one replaces the old.
  for (const [code, t] of taps) if (t.tid === tid && t.deviceId === device.id && t.state !== 'done') taps.delete(code);
  const code = randomBytes(12).toString('base64url');
  taps.set(code, { tid, deviceId: device.id, userName: device.user_name, expires: now + TTL_MS, state: 'waiting', tries: 0, result: null, error: null });
  return { code, expiresIn: TTL_MS / 1000 };
}

function live(tid: number, code: string, now: number): PhoneTap | null {
  const t = taps.get(String(code || ''));
  if (!t || t.tid !== tid) return null;
  if (t.state !== 'done' && t.expires <= now) return null;
  return t;
}

/** For the computer that made it (same device): where the phone is at. */
export function readPhoneTap(tid: number, deviceId: number, code: string, now = clockNow()) {
  const t = taps.get(String(code || ''));
  if (!t || t.tid !== tid || t.deviceId !== deviceId) return null;
  // A finished or refused code stays readable for a minute so the computer sees why.
  if (t.state !== 'done' && t.state !== 'failed' && t.expires <= now) return null;
  return {
    state: t.state,
    expiresIn: Math.max(0, Math.round((t.expires - now) / 1000)),
    result: t.result,
    error: t.error,
  };
}

/** For the phone, before it reads its location: whose tap this is and what it will do. */
export async function previewPhoneTap(db: Database, tid: number, code: string, now = clockNow()) {
  const t = live(tid, code, now);
  if (!t || t.state === 'done') throw new ClockError(404, 'TAP_EXPIRED', 'This code expired. Show a new one on the computer.');
  const device = await activeDevice(db, t.deviceId);
  const state = await personState(db, device);
  const first = String(t.userName || '').trim().split(/\s+/)[0] || '';
  t.state = 'locating';
  return { firstName: first, next: state.next, expiresIn: Math.max(0, Math.round((t.expires - now) / 1000)) };
}

async function activeDevice(db: Database, id: number): Promise<DeviceRow> {
  const device = await db.get<DeviceRow>(`SELECT * FROM attendance_devices WHERE id = ?`, id);
  if (!device || device.status !== 'active') throw new ClockError(403, 'DEVICE_REVOKED', 'This computer can no longer check in. Register it again.');
  const user = await db.get<{ status: string | null }>(`SELECT status FROM users WHERE id = ?`, device.user_id);
  if (user?.status === 'inactive') throw new ClockError(403, 'INACTIVE', 'This account is no longer active.');
  return device;
}

/** From the phone: its location. Records the tap for the computer's owner. */
export async function submitPhoneTap(
  db: Database,
  tid: number,
  code: string,
  body: { position?: unknown; samples?: unknown; clientTime?: unknown },
  ctx: { ip: string | null; userAgent: string | null },
  now = clockNow()
): Promise<PunchResult> {
  const t = live(tid, code, now);
  if (!t) throw new ClockError(404, 'TAP_EXPIRED', 'This code expired. Show a new one on the computer.');
  if (t.state === 'done') throw new ClockError(409, 'TAP_USED', 'This code was already used. Look at the computer.');
  if (t.tries >= MAX_TRIES) throw new ClockError(429, 'TAP_TRIES', 'Too many tries with this code. Show a new one on the computer.');
  t.tries += 1;
  try {
    if (!(await clockReady(db))) throw new ClockError(403, 'CLOCK_OFF', 'Staff attendance is not open for this school yet.');
    const device = await activeDevice(db, t.deviceId);
    const fix = validFix(body.position);
    const samples = (Array.isArray(body.samples) ? body.samples : []).slice(0, 10).map(validFix).filter((s): s is Fix => !!s);
    const clientMs = Date.parse(String(body.clientTime || ''));
    const skew = Number.isFinite(clientMs) ? clientMs - now : null;
    const flags = fix ? plausibilityFlags({ fix, samples, serverNow: now, clientSkewMs: skew }) : [];
    const result = await applyTap(db, {
      userId: device.user_id, userName: device.user_name, fix, ip: ctx.ip, userAgent: ctx.userAgent,
      source: 'device', deviceId: device.id, flags: [...flags, 'phone_location'], skew,
      clientTime: typeof body.clientTime === 'string' ? body.clientTime.slice(0, 40) : null, by: null,
    });
    await db.run(`UPDATE attendance_devices SET last_used_at = ? WHERE id = ?`, new Date(now).toISOString(), device.id);
    t.state = 'done';
    t.result = result;
    t.error = null;
    return result;
  } catch (err) {
    if (err instanceof ClockError) {
      t.state = 'failed';
      t.error = { code: err.code, message: err.message, data: err.extra ?? {} };
      // A refusal the phone cannot fix ends the code; a weak or outside reading can be retried.
      if (!['LOW_ACCURACY', 'OUTSIDE_ZONE', 'NO_LOCATION'].includes(err.code)) t.expires = Math.min(t.expires, now);
    }
    throw err;
  }
}

export function __resetPhoneTaps(): void {
  taps.clear();
}
