import { useCallback, useEffect, useRef, useState } from 'react';
import { apiGet, ApiError } from '../api/client';

/**
 * Standardizes the fetch/loading/error pattern that was previously
 * copy-pasted (with inconsistent error handling) across most pages — some
 * showed a retry affordance, others silently swallowed failures. Every page
 * using this hook gets the same shape: `data` (typed), `loading`, `error`
 * (a message or null), and `reload()`.
 *
 * `deps` behaves like a `useEffect` dependency array — the resource refetches
 * whenever any entry changes (e.g. a selected filter or the academic period).
 */
export function useApiResource<T>(path: string | null, deps: React.DependencyList = []) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Guards against setting state from a stale request after deps change
  // again before the previous fetch resolves.
  const requestId = useRef(0);

  const load = useCallback(async () => {
    if (!path) { setLoading(false); return; }
    const id = ++requestId.current;
    setLoading(true);
    setError(null);
    try {
      const res = await apiGet<T>(path);
      if (id === requestId.current) setData(res.data ?? null);
    } catch (err) {
      if (id === requestId.current) setError(err instanceof ApiError ? err.message : 'Could not reach the server.');
    } finally {
      if (id === requestId.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, ...deps]);

  useEffect(() => { load(); }, [load]);

  return { data, loading, error, reload: load, setData };
}
