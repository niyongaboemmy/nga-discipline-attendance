import { config } from '../config.js';
import type { Depth, Target } from '../vendor/nga-access/index.js';
import { fetchWithTimeout } from './snapshot.js';

/**
 * App-to-MIS access calls made with this app's own SSO client credentials
 * (HTTP Basic, client id "discipline_attendance") -- not a user's token.
 */

export function basicAuthHeader(clientId = config.ssoClientId, clientSecret = config.ssoClientSecret) {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
}

export interface Holder {
  user_id: number;
  depth: Depth | null;
  via: number[];
}

const HOLDERS_TTL_MS = 5 * 60 * 1000;
const holdersCache = new Map<string, { at: number; holders: Holder[] }>();

function targetQuery(target: Target | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(target ?? {})) {
    if (v !== null && v !== undefined && Number.isFinite(Number(v))) out[k] = String(v);
  }
  return out;
}

/**
 * Who holds `cap` at a node covering `target` (GET /access/holders).
 * Throws when MIS can't answer -- callers decide the fallback.
 */
export async function fetchHolders(cap: string, target: Target | null | undefined, minDepth?: Depth | null): Promise<Holder[]> {
  const params = new URLSearchParams({ app: 'da', cap, ...targetQuery(target) });
  if (minDepth) params.set('minDepth', minDepth);
  const key = params.toString();
  const hit = holdersCache.get(key);
  if (hit && Date.now() - hit.at < HOLDERS_TTL_MS) return hit.holders;

  const resp = await fetchWithTimeout(`${config.ngaMisBaseUrl}/access/holders?${key}`, {
    headers: { Authorization: basicAuthHeader(), Accept: 'application/json' },
  });
  if (!resp.ok) throw new Error(`MIS /access/holders returned ${resp.status}`);
  const body = (await resp.json()) as any;
  const data = body && typeof body === 'object' && 'data' in body ? body.data : body;
  if (!Array.isArray(data)) throw new Error('MIS /access/holders returned no list');
  const holders = data
    .filter((h: any) => Number.isInteger(Number(h?.user_id)))
    .map((h: any) => ({ user_id: Number(h.user_id), depth: h.depth ?? null, via: Array.isArray(h.via) ? h.via : [] }));
  holdersCache.set(key, { at: Date.now(), holders });
  if (holdersCache.size > 2000) holdersCache.clear();
  return holders;
}

/** Report a restricted (sensitive) read to MIS's one audit log. Never throws. */
export async function postAccessAudit(entry: {
  action: string;
  actor_id: number | null;
  subject_user_id?: number | null;
  target?: Record<string, unknown>;
  reason?: string | null;
}): Promise<boolean> {
  try {
    const resp = await fetchWithTimeout(`${config.ngaMisBaseUrl}/access/audit`, {
      method: 'POST',
      headers: { Authorization: basicAuthHeader(), 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(entry),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

export function __resetHoldersCache() {
  holdersCache.clear();
}
