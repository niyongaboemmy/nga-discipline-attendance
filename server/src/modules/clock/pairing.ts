import { randomBytes } from 'crypto';
import { validFix, type Fix } from './geofence.js';

/**
 * "Use my phone's GPS" for an admin setting up on a computer (computers have no
 * GPS). The computer asks for a pairing code and shows it as a QR code; the phone
 * opens /c/<school>/pair/<code>, no sign-in needed, and sends its location; the
 * computer reads it. Setup tests only: it never records attendance.
 *
 * One Tendo process, so memory is enough. Codes live 10 minutes, hold at most 10
 * readings, and are scoped to their school.
 */

const TTL_MS = 10 * 60_000;
const MAX_READINGS = 10;

interface Pairing {
  tid: number;
  by: string;
  expires: number;
  readings: Array<Fix & { at: number }>;
}

const pairings = new Map<string, Pairing>();

function sweep(now: number) {
  for (const [code, p] of pairings) if (p.expires <= now) pairings.delete(code);
}

export function createPairing(tid: number, by: string, now = Date.now()): { code: string; expiresIn: number } {
  sweep(now);
  const code = randomBytes(12).toString('base64url');
  pairings.set(code, { tid, by, expires: now + TTL_MS, readings: [] });
  return { code, expiresIn: TTL_MS / 1000 };
}

/** From the phone. Returns false for an unknown, expired, foreign or full code. */
export function addPairReading(tid: number, code: string, raw: unknown, now = Date.now()): 'ok' | 'unknown' | 'full' | 'bad' {
  const p = pairings.get(String(code || ''));
  if (!p || p.tid !== tid || p.expires <= now) return 'unknown';
  const fix = validFix(raw);
  if (!fix) return 'bad';
  if (p.readings.length >= MAX_READINGS) return 'full';
  p.readings.push({ ...fix, at: now });
  return 'ok';
}

export function pairingExists(tid: number, code: string, now = Date.now()): boolean {
  const p = pairings.get(String(code || ''));
  return !!p && p.tid === tid && p.expires > now;
}

/** For the computer that created it: the readings so far. */
export function readPairing(tid: number, code: string, by: string, now = Date.now()) {
  const p = pairings.get(String(code || ''));
  if (!p || p.tid !== tid || p.by !== by || p.expires <= now) return null;
  return { readings: p.readings, expiresIn: Math.max(0, Math.round((p.expires - now) / 1000)) };
}

export function __resetPairings(): void {
  pairings.clear();
}
