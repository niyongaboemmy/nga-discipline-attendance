import { useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { can as canCore, depthAt as depthAtCore } from '../vendor/nga-access';
import type { AccessSnapshot, Depth, Target } from '../vendor/nga-access';

/**
 * Access control v2 in the UI (plan §7.2): the signed-in user's MIS access
 * snapshot from GET /api/access/me, evaluated with the same vendored core the
 * server uses. NOT wired into any page yet -- the role-based UI
 * (usePermissions, allowedRoles) stays authoritative until the switch-over.
 *
 * `snapshot` is null while loading or when the server has none (503).
 */
export function useAccess() {
  const { token } = useAuth();
  const [snapshot, setSnapshot] = useState<AccessSnapshot | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    fetch('/api/access/me', { headers: { Authorization: `Bearer ${token}` } })
      .then(async (res) => (res.ok ? ((await res.json()) as { data?: AccessSnapshot }).data ?? null : null))
      .catch(() => null)
      .then((snap) => {
        if (cancelled) return;
        setSnapshot(snap);
        setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  return {
    snapshot,
    loaded,
    can: (cap: string, target?: Target | null, minDepth?: Depth | null) => canCore(snapshot, cap, target, minDepth),
    depthAt: (cap: string, target?: Target | null) => depthAtCore(snapshot, cap, target),
  };
}
