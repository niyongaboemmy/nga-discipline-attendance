import { clearCache, currentOwner } from '../offline/outbox';
import React, { createContext, useState, useEffect, useContext } from 'react';
import { startMisSignIn } from '../utils/ssoStart';
import { SCHOOL_NAME } from '../utils/rfidCards';
import {
  RESIGN_CODES, misHomeOf, rememberBranding, storageChange, switchSchoolUrl, type SchoolBranding,
} from '../tenancy/school.ts';
import { SCHOOL_SWITCH_EVENT, checkSchool, restartSignIn } from '../tenancy/switch';
import { endActivity } from '../activity';
import { withPolledAvatar, type MisAvatar } from '../utils/avatar';

export type Role = 'teacher' | 'admin' | 'student' | 'unassigned';

export interface User {
  id: string;
  name: string;
  email: string;
  role: Role;
  preferred_theme?: 'light' | 'dark';
  academicYearId?: number;
  academicTermId?: number;
  /** The school (tenant id) this session belongs to; absent on pre-tenancy sessions (= 1).
   *  Offline storage keys and the install cookie carry it (src/offline/outbox.ts). */
  tid?: number;
  tenantSlug?: string;
  /** The central NGA MIS profile picture (null = none). */
  avatar?: MisAvatar | null;
}

/** Where each role lands by default. Single source of truth for role routing:
 *  ProtectedRoute's post-login redirect, the "/" auth-guard and the 404 page
 *  all send an assigned user to the dashboard (which carries today's
 *  calendar); only the unassigned wait on /pending. */
export const homeRouteForRole = (role: Role): string =>
  role === 'unassigned' ? '/pending' : '/dashboard';

/** One of the signed-in person's schools (MIS /auth/my-schools through /api/sso/my-schools). */
export interface MySchool {
  tid: number;
  slug: string;
  name: string;
  logoUrl: string | null;
  current: boolean;
}

/** Shown wherever the school name is needed before (or without) MIS branding. */
export const FALLBACK_SCHOOL_NAME = SCHOOL_NAME;

interface AuthContextType {
  isAuthenticated: boolean;
  user: User | null;
  token: string | null;
  /** MIS-native permission strings — a separate, unrelated system used for
   *  nothing locally today. Do not confuse with `rolePermissions` below. */
  permissions: string[];
  /** This app's own RBAC permission keys for the signed-in user's current role
   *  (see server/src/constants/permissions.ts). Drives `usePermissions()`. */
  rolePermissions: string[];
  loading: boolean;
  login: () => void;
  setSession: (token: string, user: User, permissions: string[], rolePermissions?: string[]) => void;
  logout: () => void;
  toggleTheme: () => void;
  theme: 'light' | 'dark';
  /** This session's school name and logo (MIS /tenant/branding), null until known. */
  school: SchoolBranding | null;
  /** The person's schools; "Switch school" shows only for 2 or more. */
  schools: MySchool[];
  /** Go to the MIS switch page; it comes back through Tendo's SSO entry. */
  switchSchool: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [permissions, setPermissions] = useState<string[]>([]);
  const [rolePermissions, setRolePermissions] = useState<string[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [theme, setTheme] = useState<'light' | 'dark'>('dark');
  const [switching, setSwitching] = useState(false);
  const [school, setSchool] = useState<SchoolBranding | null>(null);
  const [schools, setSchools] = useState<MySchool[]>([]);

  // Restore session on mount
  useEffect(() => {
    const savedToken = localStorage.getItem('sso_token');
    const savedUser = localStorage.getItem('sso_user');
    const savedPermissions = localStorage.getItem('sso_permissions');
    const savedRolePermissions = localStorage.getItem('sso_role_permissions');

    let restored = false;
    if (savedToken && savedUser) {
      try {
        const parsedUser = JSON.parse(savedUser) as User;
        setToken(savedToken);
        setUser(parsedUser);
        if (savedPermissions) {
          setPermissions(JSON.parse(savedPermissions));
        }
        if (savedRolePermissions) {
          setRolePermissions(JSON.parse(savedRolePermissions));
        }

        // Handle theme (dark is the app's signature look)
        const savedTheme = localStorage.getItem('theme') || parsedUser.preferred_theme || 'dark';
        setTheme(savedTheme as 'light' | 'dark');
        document.documentElement.setAttribute('data-theme', savedTheme);
        restored = true;
      } catch {
        // Corrupted storage (e.g. stale cache) — clear it and fall through to a fresh state.
        localStorage.removeItem('sso_token');
        localStorage.removeItem('sso_user');
        localStorage.removeItem('sso_permissions');
        localStorage.removeItem('sso_role_permissions');
      }
    }
    if (!restored) {
      // Dark is the default; an explicit user choice always wins.
      const savedTheme = localStorage.getItem('theme') || 'dark';
      setTheme(savedTheme as 'light' | 'dark');
      document.documentElement.setAttribute('data-theme', savedTheme);
    }
    setLoading(false);
  }, []);

  // Update DOM attribute when theme changes
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
  }, [theme]);

  // This app's session JWT is self-contained and stays valid for its own
  // 24h life regardless of what happens on the MIS side -- logging out of
  // the MIS (or an admin disabling the account) otherwise has no effect
  // here until natural expiry. Poll the MIS's session validity through our
  // own backend periodically so a revoked MIS session ends this one too.
  useEffect(() => {
    if (!token) return;

    const verifyMisSession = async () => {
      try {
        const res = await fetch('/api/sso/verify-mis', {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (res.status === 401 || res.status === 409) {
          const b = await res.json().catch(() => null);
          // Another school (MIS switched, or this session's school is wrong):
          // sign in again into MIS's school, never a sign-out (§4.5).
          if (b?.code && RESIGN_CODES.has(b.code)) {
            restartSignIn(b.code);
            return;
          }
          if (res.status === 401) logout();
          return;
        }
        // The poll carries the current NGA profile picture, so one changed in MIS
        // (or another NGA app) shows up here within a minute.
        const body = await res.json().catch(() => null);
        if (body && 'avatar' in body) {
          setUser((prev) => {
            if (!prev) return prev;
            const next = withPolledAvatar(prev, body.avatar);
            if (next !== prev) localStorage.setItem('sso_user', JSON.stringify(next));
            return next;
          });
        }
      } catch {
        // Network hiccup — don't force-logout over a transient failure,
        // the next poll will settle it either way.
      }
    };

    // Role permissions are cached at sign-in, but the server resolves them
    // fresh on every request, so a permission granted later (an admin edit,
    // or a new feature's permissions seeded on deploy) never reached the UI
    // until the user signed out and back in. Re-sync from /me on the same
    // cadence as the session check.
    const syncRolePermissions = async () => {
      try {
        const res = await fetch('/api/roles-permissions/me', {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) return;
        const body = await res.json();
        const keys = body?.data?.permissionKeys;
        if (Array.isArray(keys)) {
          setRolePermissions(keys);
          localStorage.setItem('sso_role_permissions', JSON.stringify(keys));
        }
      } catch {
        // Keep the cached set; the next sync will settle it.
      }
    };

    // Single sign-out: check right away, whenever this tab comes back into
    // view (e.g. after signing out of MIS in another tab), and every minute.
    let lastCheck = 0;
    const checkSoon = () => {
      if (Date.now() - lastCheck < 5000) return; // focus + visibility fire together
      lastCheck = Date.now();
      // School guard: the nga_school cookie names another school -> re-sign in.
      if (checkSchool()) return;
      void verifyMisSession();
      void syncRolePermissions();
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') checkSoon();
    };
    checkSoon();
    const intervalId = setInterval(checkSoon, 60 * 1000);
    window.addEventListener('focus', checkSoon);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(intervalId);
      window.removeEventListener('focus', checkSoon);
      document.removeEventListener('visibilitychange', onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  // The school guard also runs on its own when the tab is shown or focused
  // (the poll above throttles to once per 5 s), and the overlay follows any
  // re-sign-in started elsewhere in the app (e.g. a TENANT_MISMATCH answer).
  useEffect(() => {
    const onSwitch = () => setSwitching(true);
    window.addEventListener(SCHOOL_SWITCH_EVENT, onSwitch);
    return () => window.removeEventListener(SCHOOL_SWITCH_EVENT, onSwitch);
  }, []);

  // Other tabs: a session for another school or person written by another tab
  // reloads this one (never two schools in one browser); a cleared slot shows
  // the overlay until the other tab finishes (a new token arrives) or 15 s.
  useEffect(() => {
    let waitTimer: number | undefined;
    const onStorage = (e: StorageEvent) => {
      if (e.storageArea && e.storageArea !== localStorage) return;
      const own = {
        token,
        tid: token ? (user?.tid && user.tid > 0 ? user.tid : 1) : null,
        uid: user?.id == null ? null : String(user.id),
      };
      const what = storageChange(e.key, e.newValue, own);
      if (what === 'reload') {
        window.location.assign('/');
      } else if (what === 'wait') {
        setSwitching(true);
        window.clearTimeout(waitTimer);
        waitTimer = window.setTimeout(() => window.location.assign('/'), 15_000);
      }
    };
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.clearTimeout(waitTimer);
    };
  }, [token, user?.tid, user?.id]);

  // The school's name and logo, and the person's schools (for "Switch school").
  // Both through this app's server, which holds the MIS token; failures leave
  // the fallback name and no switch item (never a sign-out).
  useEffect(() => {
    // Signed out: the header is not shown, so stale values never render.
    if (!token) return;
    let live = true;
    const get = (path: string) =>
      fetch(path, { headers: { Authorization: `Bearer ${token}` } })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);
    void get('/api/sso/branding').then((b) => {
      const d = b?.data;
      if (!live || !d || typeof d.tid !== 'number') return;
      const next: SchoolBranding = { tid: d.tid, name: d.name ?? null, logoUrl: d.logoUrl ?? null, slug: user?.tenantSlug ?? null };
      setSchool(next);
      rememberBranding(localStorage, next);
    });
    void get('/api/sso/my-schools').then((b) => {
      const list = b?.data?.schools;
      if (live && Array.isArray(list)) setSchools(list);
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const switchSchool = () => {
    const misHome = misHomeOf(import.meta.env.VITE_MIS_HOME_URL, import.meta.env.VITE_MIS_LOGIN_URL);
    window.location.assign(switchSchoolUrl(misHome, window.location.origin));
  };

  const login = () => startMisSignIn();

  const setSession = (
    newToken: string, newUser: User, newPermissions: string[], newRolePermissions?: string[]
  ) => {
    setToken(newToken);
    setUser(newUser);
    setPermissions(newPermissions);

    localStorage.setItem('sso_token', newToken);
    localStorage.setItem('sso_user', JSON.stringify(newUser));
    localStorage.setItem('sso_permissions', JSON.stringify(newPermissions));

    // rolePermissions is optional here because some callers (e.g. switching
    // academic period) re-sign the token without touching the user's role —
    // in that case, keep whatever role permissions are already in state.
    if (newRolePermissions !== undefined) {
      setRolePermissions(newRolePermissions);
      localStorage.setItem('sso_role_permissions', JSON.stringify(newRolePermissions));
    }

    if (newUser.preferred_theme) {
      setTheme(newUser.preferred_theme);
    }
  };

  const logout = () => {
    // Close this tab's analytics session while the token can still sign it.
    void endActivity();
    // Shared computers: this person's cached rosters for this school go, and
    // any old copy (waiting registers stay for their owner; other schools'
    // recent copies are kept, see clearCache).
    clearCache(localStorage, currentOwner(localStorage));

    setToken(null);
    setUser(null);
    setPermissions([]);
    setRolePermissions([]);

    localStorage.removeItem('sso_token');
    localStorage.removeItem('sso_user');
    localStorage.removeItem('sso_permissions');
    localStorage.removeItem('sso_role_permissions');

    // Redirect to home/login page
    window.location.href = '/';
  };

  // NGA desktop app: it keeps the desktop and all four NGA apps on one theme.
  // A switch made elsewhere arrives here (the MIS account is updated by the
  // desktop). preventDefault tells the desktop this app applied it itself.
  useEffect(() => {
    const onDesktopTheme = (e: Event) => {
      const next = (e as CustomEvent<{ theme?: string }>).detail?.theme;
      if (next !== 'light' && next !== 'dark') return;
      e.preventDefault();
      setTheme(next);
    };
    window.addEventListener('nga:set-theme', onDesktopTheme);
    return () => window.removeEventListener('nga:set-theme', onDesktopTheme);
  }, []);

  const toggleTheme = () => {
    setTheme((prev) => (prev === 'light' ? 'dark' : 'light'));
  };

  return (
    <AuthContext.Provider
      value={{
        isAuthenticated: !!token,
        user,
        token,
        permissions,
        rolePermissions,
        loading,
        login,
        setSession,
        logout,
        toggleTheme,
        theme,
        school,
        schools,
        switchSchool,
      }}
    >
      {children}
      {switching && (
        <div
          role="alert"
          aria-live="assertive"
          data-testid="school-switch-overlay"
          style={{
            position: 'fixed', inset: 0, zIndex: 10000, display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'var(--bg-page-solid, #0b1220)', color: 'var(--text-primary, #fff)', fontSize: 16, fontWeight: 600,
          }}
        >
          Switching to your other school…
        </div>
      )}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
