/**
 * Every call this server makes to the MIS with a person's token names the
 * school of the request it runs in (contract §3: "a spoke forwarding the
 * user's token may also send X-NGA-Tenant; it must agree"). The MIS then
 * refuses (403 TENANT_MISMATCH) instead of quietly answering for another
 * school -- so a list can never fill with a different school's people.
 *
 * Done once, on fetch itself, because user-token MIS calls are spread across
 * many routes; a call that already names a school, uses service (Basic) auth,
 * runs outside a request, or goes elsewhere is left untouched.
 */
import { config } from '../config.js';
import { currentTenantOrNull } from '../vendor/nga-tenancy/index.js';

const TENANT_HEADER = 'X-NGA-Tenant';
const MARK = Symbol.for('tendo.misTenantFetch');

function misOrigin(): string | null {
  try {
    return new URL(config.ngaMisBaseUrl).origin;
  } catch {
    return null;
  }
}

function urlOf(input: unknown): string | null {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  if (input && typeof input === 'object' && typeof (input as any).url === 'string') return (input as any).url;
  return null;
}

/** The headers to send: `init.headers` plus the school, when this call needs it. */
export function withSchoolHeader(input: unknown, init: RequestInit | undefined, tid: number | null): Headers | null {
  if (tid == null) return null;
  const origin = misOrigin();
  const url = urlOf(input);
  if (!origin || !url) return null;
  let target: string;
  try {
    target = new URL(url).origin;
  } catch {
    return null;
  }
  if (target !== origin) return null;
  const headers = new Headers(
    init?.headers ?? (input && typeof input === 'object' && 'headers' in (input as any) ? (input as any).headers : undefined),
  );
  if (!/^Bearer\s/i.test(headers.get('authorization') ?? '')) return null;
  if (headers.has(TENANT_HEADER)) return null;
  headers.set(TENANT_HEADER, String(tid));
  return headers;
}

export function installMisTenantFetch(): void {
  const current = globalThis.fetch as typeof fetch & { [MARK]?: true };
  if (typeof current !== 'function' || current[MARK]) return;
  const wrapped = ((input: any, init?: RequestInit) => {
    const headers = withSchoolHeader(input, init, currentTenantOrNull()?.tid ?? null);
    if (!headers) return current(input, init);
    const raw = init?.headers;
    // Keep a plain header object plain (callers and tests read it back).
    const next =
      raw && typeof raw === 'object' && !(raw instanceof Headers) && !Array.isArray(raw)
        ? { ...(raw as Record<string, string>), [TENANT_HEADER]: headers.get(TENANT_HEADER)! }
        : headers;
    return current(input, { ...init, headers: next });
  }) as typeof fetch & { [MARK]?: true };
  wrapped[MARK] = true;
  globalThis.fetch = wrapped;
}
