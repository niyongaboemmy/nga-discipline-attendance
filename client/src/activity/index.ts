import { initActivity, getDeviceId, endActivity, type CatalogEntry } from '../vendor/nga-activity';
import catalog from './catalog.json';

/**
 * Platform usage analytics for Tendo (nga_central_mis
 * USAGE_ANALYTICS_IMPLEMENTATION_PLAN.md §5.1). The browser posts to this
 * app's own server (same origin, `/api/activity`), which relays to the MIS
 * with the MIS user id taken from the Tendo session -- never from here.
 *
 * `catalog.json` is a copy of server/src/activity/catalog.json (the source of
 * truth, published to MIS on boot). Re-copy with `npm run activity:catalog`;
 * tests/activityCatalog.test.ts fails if they differ.
 */
const TOKEN_KEY = 'sso_token';
const USER_KEY = 'sso_user';

const storedToken = (): string | null => {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
};

/** Tendo's `users.id` IS the MIS user id (set from the MIS SSO exchange). */
const misUserId = (): number | null => {
  try {
    if (!storedToken()) return null;
    const u = JSON.parse(localStorage.getItem(USER_KEY) || 'null');
    const id = Number(u?.id);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
};

export const startActivity = () =>
  initActivity({
    app: 'tendo',
    endpoint: '/api/activity',
    configUrl: '/api/activity/config',
    authHeader: () => {
      const t = storedToken();
      return t ? `Bearer ${t}` : null;
    },
    userKey: misUserId,
    // Tendo only knows its own role (admin/teacher/...), not the MIS user type;
    // the MIS fills that in from the user id.
    userType: () => null,
    release: (import.meta.env.VITE_RELEASE as string | undefined) ?? undefined,
    catalog: (catalog as { features: CatalogEntry[] }).features,
    // An administrator signed this device out (MIS Usage & Monitoring):
    // end the Tendo session the same way AuthContext.logout does.
    onEndCommand: () => {
      try {
        for (const k of [TOKEN_KEY, USER_KEY, 'sso_permissions', 'sso_role_permissions']) localStorage.removeItem(k);
      } catch {
        /* storage unavailable: the redirect still ends the visit */
      }
      window.location.assign('/');
    },
  });

export { getDeviceId, endActivity };
