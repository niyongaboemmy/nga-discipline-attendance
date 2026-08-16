import { apiGet } from './client';

/** Mirrors the NGA Central MIS's `System` row shape (see nga_central_mis
 *  backend `src/db/schema.ts`), as returned by `GET /users/me`. */
export interface System {
  system_id: number;
  name: string;
  description?: string;
  client_id?: string;
  allowed_redirect_uris?: string;
  icon_url?: string;
  home_url?: string;
  status?: 'ACTIVE' | 'DISABLED';
}

export async function getSystems(): Promise<System[]> {
  const res = await apiGet<{ systems: System[] }>('/api/sso/systems');
  return res.data?.systems || [];
}

export interface AuthorizeResult {
  code: string;
  state?: string;
}

/** Requests a one-time SSO code for `clientId`, scoped to the signed-in
 *  user's MIS session — used to hop into a sibling app without re-login. */
export async function authorizeSSO(
  clientId: string,
  redirectUri: string,
  responseType: string = 'code',
  state?: string
): Promise<AuthorizeResult | null> {
  const params = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: responseType });
  if (state) params.set('state', state);
  const res = await apiGet<AuthorizeResult>(`/api/sso/authorize?${params.toString()}`);
  return res.data || null;
}
