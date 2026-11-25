import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { config } from '../../config.js';

/**
 * Verify a Google Identity Services ID token (the "Sign in with Google" credential)
 * without an extra dependency: Google's public keys (JWKS) are fetched and cached,
 * the RS256 signature, audience (our GOOGLE_CLIENT_ID), issuer and expiry checked.
 */

export interface GoogleIdentity {
  sub: string;
  email: string;
  name?: string;
  /** Google Workspace domain, when the account belongs to one. */
  hd?: string;
}

export class GoogleTokenError extends Error {
  constructor(message: string, public code: 'GOOGLE_NOT_CONFIGURED' | 'GOOGLE_INVALID' | 'GOOGLE_UNVERIFIED' = 'GOOGLE_INVALID') {
    super(message);
  }
}

const JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];
let keys: { at: number; byKid: Map<string, crypto.KeyObject> } | null = null;
const KEYS_TTL_MS = 6 * 3600_000;

async function googleKey(kid: string): Promise<crypto.KeyObject> {
  const fresh = keys && Date.now() - keys.at < KEYS_TTL_MS;
  if (!fresh || !keys!.byKid.has(kid)) {
    const resp = await fetch(JWKS_URL, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) throw new GoogleTokenError('Could not reach Google to check the sign-in.');
    const body: any = await resp.json();
    const byKid = new Map<string, crypto.KeyObject>();
    for (const jwk of body?.keys ?? []) {
      if (jwk?.kid && jwk.kty === 'RSA') byKid.set(jwk.kid, crypto.createPublicKey({ key: jwk, format: 'jwk' }));
    }
    keys = { at: Date.now(), byKid };
  }
  const key = keys!.byKid.get(kid);
  if (!key) throw new GoogleTokenError('This Google sign-in could not be checked. Try again.');
  return key;
}

async function realVerify(credential: string): Promise<GoogleIdentity> {
  if (!config.googleClientId) throw new GoogleTokenError('Google sign-in is not set up for this school yet.', 'GOOGLE_NOT_CONFIGURED');
  const decoded = jwt.decode(credential, { complete: true }) as any;
  const kid = decoded?.header?.kid;
  if (!kid || decoded?.header?.alg !== 'RS256') throw new GoogleTokenError('This Google sign-in is not valid.');
  const key = await googleKey(kid);
  let payload: any;
  try {
    payload = jwt.verify(credential, key, {
      algorithms: ['RS256'],
      audience: config.googleClientId,
      issuer: ISSUERS as [string, ...string[]],
    });
  } catch {
    throw new GoogleTokenError('This Google sign-in has expired or is not valid. Try again.');
  }
  if (!payload?.sub || !payload?.email) throw new GoogleTokenError('This Google sign-in is not valid.');
  if (payload.email_verified !== true && payload.email_verified !== 'true') {
    throw new GoogleTokenError("Your Google account's e-mail is not verified.", 'GOOGLE_UNVERIFIED');
  }
  return { sub: String(payload.sub), email: String(payload.email).toLowerCase(), name: payload.name, hd: payload.hd };
}

let verifier: (credential: string) => Promise<GoogleIdentity> = realVerify;

export function verifyGoogleCredential(credential: string): Promise<GoogleIdentity> {
  return verifier(credential);
}

/** Test hook: a fake verifier (null restores the real one). */
export function __setGoogleVerifier(fn: ((credential: string) => Promise<GoogleIdentity>) | null): void {
  verifier = fn ?? realVerify;
}

/** STAFF_CLOCK_GOOGLE_DOMAINS: empty = any Google account; else the e-mail domain must be listed. */
export function domainAllowed(email: string, allowList: string): boolean {
  const list = allowList.split(/[,\s]+/).map((d) => d.trim().toLowerCase().replace(/^@/, '')).filter(Boolean);
  if (list.length === 0) return true;
  const domain = email.split('@')[1]?.toLowerCase() ?? '';
  return list.includes(domain);
}
