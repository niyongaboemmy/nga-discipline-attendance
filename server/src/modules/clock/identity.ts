import { config } from '../../config.js';
import { basicAuthHeader } from '../../access/misService.js';
import { tenantHeader } from '../../tenancy/index.js';

/**
 * Which Amashuri account a verified Google account is, in the current school:
 * POST {MIS}/users/service/staff-identity with this app's client credentials
 * (scope profiles:read) and the school header.
 */

export interface MisStaffIdentity {
  user_id: number;
  name: string;
  email: string | null;
  status: string;
  user_type: string | null;
  is_student: boolean;
  roles: string[];
  permissions: string[];
}

export type IdentityResult = { kind: 'found'; person: MisStaffIdentity } | { kind: 'no_match' };

export class IdentityUnavailable extends Error {}

async function realResolve(google: { sub: string; email: string }): Promise<IdentityResult> {
  let resp: Response;
  try {
    resp = await fetch(`${config.ngaMisBaseUrl.replace(/\/+$/, '')}/users/service/staff-identity`, {
      method: 'POST',
      headers: { Authorization: basicAuthHeader(), 'Content-Type': 'application/json', Accept: 'application/json', ...tenantHeader() },
      body: JSON.stringify({ google_sub: google.sub, google_email: google.email }),
      signal: AbortSignal.timeout(6000),
    });
  } catch {
    throw new IdentityUnavailable('Amashuri could not be reached. Try again in a moment.');
  }
  if (resp.status === 404) {
    const body: any = await resp.json().catch(() => null);
    if (body?.code === 'NO_MATCH') return { kind: 'no_match' };
    throw new IdentityUnavailable('Amashuri is being updated. Try again in a moment.');
  }
  if (!resp.ok) throw new IdentityUnavailable('Amashuri could not check your account. Try again in a moment.');
  const body: any = await resp.json();
  const p = body?.data ?? body;
  if (!p?.user_id) throw new IdentityUnavailable('Amashuri sent an unexpected answer.');
  return {
    kind: 'found',
    person: {
      user_id: Number(p.user_id),
      name: String(p.name || p.email || `User ${p.user_id}`),
      email: p.email ?? null,
      status: String(p.status || ''),
      user_type: p.user_type ?? null,
      is_student: !!p.is_student,
      roles: Array.isArray(p.roles) ? p.roles.map(String) : [],
      permissions: Array.isArray(p.permissions) ? p.permissions.map(String) : [],
    },
  };
}

let resolver: (google: { sub: string; email: string }) => Promise<IdentityResult> = realResolve;

export function resolveStaffIdentity(google: { sub: string; email: string }): Promise<IdentityResult> {
  return resolver(google);
}

/** Test hook (null restores the MIS call). */
export function __setIdentityResolver(fn: ((google: { sub: string; email: string }) => Promise<IdentityResult>) | null): void {
  resolver = fn ?? realResolve;
}
