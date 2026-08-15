import { useAuth } from '../context/AuthContext';

/** Gate UI on this app's own RBAC permission keys (see
 *  server/src/constants/permissions.ts). The backend is always the
 *  authoritative enforcer — this is UX polish, not the security boundary. */
export function usePermissions() {
  const { rolePermissions } = useAuth();
  const set = new Set(rolePermissions);

  /** True if the user holds ANY of the given keys. */
  const can = (key: string | string[]): boolean => {
    const keys = Array.isArray(key) ? key : [key];
    return keys.some((k) => set.has(k));
  };

  /** True if the user holds ALL of the given keys. */
  const canAll = (keys: string[]): boolean => keys.every((k) => set.has(k));

  return { can, canAll, permissions: rolePermissions };
}
