import React, { createContext, useState, useEffect, useContext } from 'react';
import { beginSsoState } from '../utils/ssoState';
import { endActivity } from '../activity';

export type Role = 'teacher' | 'admin' | 'student' | 'unassigned';

export interface User {
  id: string;
  name: string;
  email: string;
  role: Role;
  preferred_theme?: 'light' | 'dark';
  academicYearId?: number;
  academicTermId?: number;
}

/** Where each role lands by default. Single source of truth for role routing:
 *  ProtectedRoute's post-login redirect, the "/" auth-guard and the 404 page
 *  all send an assigned user to the dashboard (which carries today's
 *  calendar); only the unassigned wait on /pending. */
export const homeRouteForRole = (role: Role): string =>
  role === 'unassigned' ? '/pending' : '/dashboard';

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
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [permissions, setPermissions] = useState<string[]>([]);
  const [rolePermissions, setRolePermissions] = useState<string[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [theme, setTheme] = useState<'light' | 'dark'>('dark');

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
        if (res.status === 401) {
          logout();
        }
      } catch {
        // Network hiccup — don't force-logout over a transient failure,
        // the next poll will settle it either way.
      }
    };

    // Single sign-out: check right away, whenever this tab comes back into
    // view (e.g. after signing out of MIS in another tab), and every minute.
    let lastCheck = 0;
    const checkSoon = () => {
      if (Date.now() - lastCheck < 5000) return; // focus + visibility fire together
      lastCheck = Date.now();
      void verifyMisSession();
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

  const login = () => {
    const clientId = import.meta.env.VITE_SSO_CLIENT_ID;
    const loginUrl = import.meta.env.VITE_MIS_LOGIN_URL;
    const redirectUri = `${window.location.origin}/sso/callback`;

    // Construct MIS redirect URL
    // `state` is the OAuth CSRF token: the MIS echoes it back to /sso/callback,
    // which checks it against the copy kept in this tab's sessionStorage.
    const state = beginSsoState();
    const target = `${loginUrl}?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${encodeURIComponent(state)}`;
    
    // Redirect user to the MIS SSO page
    window.location.href = target;
  };

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
      }}
    >
      {children}
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
