/**
 * A small "Saving…" pill at the top of the screen while any change (POST, PUT,
 * PATCH, DELETE to /api) is on its way. It covers every action in the app, so no
 * button is ever silent, even one without its own spinner. Quick requests (under
 * 300 ms) never show it; background sends (activity, sign-in) never count.
 */

let pending = 0;
export const listeners = new Set<(n: number) => void>();
const emit = () => listeners.forEach((l) => l(pending));
const QUIET = /\/api\/(activity|sso|clock)\b/;

function counts(input: RequestInfo | URL, init?: RequestInit): boolean {
  const method = (init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
  if (method === 'GET' || method === 'HEAD' || init?.keepalive) return false;
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  let path: string;
  try {
    const u = new URL(url, window.location.origin);
    if (u.origin !== window.location.origin) return false;
    path = u.pathname;
  } catch {
    return false;
  }
  return path.startsWith('/api/') && !QUIET.test(path);
}

let installed = false;
export function installNetActivity(): void {
  if (installed || typeof window === 'undefined' || !window.fetch) return;
  installed = true;
  const original = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    if (!counts(input, init)) return original(input, init);
    pending += 1;
    emit();
    return original(input, init).finally(() => {
      pending = Math.max(0, pending - 1);
      emit();
    });
  };
}
