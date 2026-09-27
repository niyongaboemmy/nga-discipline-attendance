import { validateManifest, Manifest } from '../vendor/nga-access/index.js';
import { DA_MANIFEST } from './manifest.js';

/**
 * Publish this app's capability manifest to MIS (packages/access README §3):
 *   PUT {NGA_MIS_BASE_URL}/access/manifests/da
 *   Authorization: Basic base64(SSO_CLIENT_ID:SSO_CLIENT_SECRET)
 * Uses the same env vars as the SSO token exchange (config.ts). Idempotent:
 * MIS answers `unchanged: true` for an identical manifest.
 */

export interface PublishEnv {
  misBaseUrl?: string;
  clientId?: string;
  clientSecret?: string;
}

export interface PublishRequest {
  url: string;
  init: { method: 'PUT'; headers: Record<string, string>; body: string };
}

const PLACEHOLDERS = new Set(['', 'placeholder_client_id', 'placeholder_client_secret']);

/** Build (and validate) the PUT request. Throws with every problem found. */
export function buildPublishRequest(env: PublishEnv, manifest: Manifest = DA_MANIFEST): PublishRequest {
  const problems = validateManifest(manifest).map((e) => `manifest: ${e}`);
  const base = (env.misBaseUrl || '').replace(/\/+$/, '');
  if (!/^https?:\/\//.test(base)) problems.push('NGA_MIS_BASE_URL is not set to an http(s) URL');
  if (!env.clientId || PLACEHOLDERS.has(env.clientId)) problems.push('SSO_CLIENT_ID is not set');
  if (!env.clientSecret || PLACEHOLDERS.has(env.clientSecret)) problems.push('SSO_CLIENT_SECRET is not set');
  if (problems.length) throw new Error(`Cannot publish the access manifest:\n  - ${problems.join('\n  - ')}`);

  return {
    url: `${base}/access/manifests/${encodeURIComponent(manifest.app)}`,
    init: {
      method: 'PUT',
      headers: {
        Authorization: `Basic ${Buffer.from(`${env.clientId}:${env.clientSecret}`).toString('base64')}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(manifest),
    },
  };
}

/** Publish; resolves with MIS's response body, rejects on any failure. */
export async function publishManifest(env: PublishEnv, timeoutMs = 15000): Promise<unknown> {
  const { url, init } = buildPublishRequest(env);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let resp: Response;
  try {
    resp = await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
  const text = await resp.text();
  let body: unknown = text;
  try { body = JSON.parse(text); } catch { /* keep text */ }
  if (!resp.ok) {
    throw new Error(`MIS answered ${resp.status} for PUT ${url}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
  }
  return body;
}
