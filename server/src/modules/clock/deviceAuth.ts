import crypto from 'crypto';

/**
 * Device identity for the staff clock (plan §4).
 *
 * The page makes a non-extractable ECDSA P-256 key on first use; its private half
 * never leaves the device. We store the public key and its RFC 7638 thumbprint
 * (the device id). Each tap signs a single-use server nonce, so a copied token or
 * cookie is useless without the device itself.
 */

export interface EcJwk {
  kty: 'EC';
  crv: 'P-256';
  x: string;
  y: string;
}

const B64URL_32 = /^[A-Za-z0-9_-]{43}$/;

/** A P-256 public JWK with nothing else in it, or null. */
export function cleanJwk(raw: unknown): EcJwk | null {
  const j = raw as any;
  if (!j || typeof j !== 'object') return null;
  if (j.kty !== 'EC' || j.crv !== 'P-256') return null;
  if (typeof j.x !== 'string' || typeof j.y !== 'string' || !B64URL_32.test(j.x) || !B64URL_32.test(j.y)) return null;
  if ('d' in j) return null; // a private key was sent: refuse rather than store it
  const jwk: EcJwk = { kty: 'EC', crv: 'P-256', x: j.x, y: j.y };
  try {
    crypto.createPublicKey({ key: jwk as any, format: 'jwk' });
  } catch {
    return null;
  }
  return jwk;
}

/** RFC 7638 thumbprint: SHA-256 over the canonical members, base64url. */
export function jwkThumbprint(jwk: EcJwk): string {
  const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
  return crypto.createHash('sha256').update(canonical).digest('base64url');
}

/** Verify a WebCrypto ECDSA(SHA-256) signature (IEEE P1363, 64 bytes) over `message`. */
export function verifyDeviceSignature(jwk: EcJwk, message: string, signatureB64url: string): boolean {
  try {
    const sig = Buffer.from(String(signatureB64url || ''), 'base64url');
    if (sig.length !== 64) return false;
    const key = crypto.createPublicKey({ key: jwk as any, format: 'jwk' });
    return crypto.verify('sha256', Buffer.from(message, 'utf8'), { key, dsaEncoding: 'ieee-p1363' }, sig);
  } catch {
    return false;
  }
}

/** The opaque, non-expiring device token (only its hash is stored). */
export function newDeviceToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export function hashDeviceToken(token: string): string {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

/** What the device signs for a tap. Both sides build it the same way. */
export function punchMessage(nonce: string, position: { lat: number; lng: number; accuracy: number }): string {
  return `tendo-clock-v1|${nonce}|${position.lat}|${position.lng}|${position.accuracy}`;
}

// ---------------------------------------------------------------------------
// Single-use nonces (60 s). One server process serves Tendo, so memory is enough;
// keys carry the school so two schools' device ids never meet.
// ---------------------------------------------------------------------------

export const NONCE_TTL_MS = 60_000;
const nonces = new Map<string, { key: string; expires: number }>();

export function issueNonce(scopeKey: string, now = Date.now()): string {
  if (nonces.size > 5000) {
    for (const [n, v] of nonces) if (v.expires <= now) nonces.delete(n);
  }
  const nonce = crypto.randomBytes(24).toString('base64url');
  nonces.set(nonce, { key: scopeKey, expires: now + NONCE_TTL_MS });
  return nonce;
}

/** True once: the nonce exists, belongs to this device and has not expired. Always burnt. */
export function consumeNonce(scopeKey: string, nonce: string, now = Date.now()): boolean {
  const entry = nonces.get(String(nonce || ''));
  if (!entry) return false;
  nonces.delete(String(nonce));
  return entry.key === scopeKey && entry.expires > now;
}

export function __resetNonces(): void {
  nonces.clear();
}
