import React, { createContext, useState, useEffect, useContext } from 'react';

export type Role = 'teacher' | 'admin' | 'student' | 'unassigned';

export interface User {
  id: string;
  name: string;
  email: string;
  role: Role;
  preferred_theme?: 'light' | 'dark';
}

/** Where each role lands by default. Single source of truth for role routing. */
export const homeRouteForRole = (role: Role): string =>
  role === 'admin' ? '/admin' : role === 'unassigned' ? '/pending' : '/dashboard';

interface AuthContextType {
  isAuthenticated: boolean;
  user: User | null;
  token: string | null;
  permissions: string[];
  loading: boolean;
  login: () => void;
  setSession: (token: string, user: User, permissions: string[]) => void;
  logout: () => void;
  toggleTheme: () => void;
  theme: 'light' | 'dark';
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [permissions, setPermissions] = useState<string[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [theme, setTheme] = useState<'light' | 'dark'>('dark');

  // Restore session on mount
  useEffect(() => {
    const savedToken = localStorage.getItem('sso_token');
    const savedUser = localStorage.getItem('sso_user');
    const savedPermissions = localStorage.getItem('sso_permissions');

    let restored = false;
    if (savedToken && savedUser) {
      try {
        const parsedUser = JSON.parse(savedUser) as User;
        setToken(savedToken);
        setUser(parsedUser);
        if (savedPermissions) {
          setPermissions(JSON.parse(savedPermissions));
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

  const login = () => {
    const clientId = import.meta.env.VITE_SSO_CLIENT_ID;
    const loginUrl = import.meta.env.VITE_MIS_LOGIN_URL;
    const redirectUri = `${window.location.origin}/callback`;

    // Construct MIS redirect URL
    const target = `${loginUrl}?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}`;
    
    // Redirect user to the MIS SSO page
    window.location.href = target;
  };

  const setSession = (newToken: string, newUser: User, newPermissions: string[]) => {
    setToken(newToken);
    setUser(newUser);
    setPermissions(newPermissions);
    
    localStorage.setItem('sso_token', newToken);
    localStorage.setItem('sso_user', JSON.stringify(newUser));
    localStorage.setItem('sso_permissions', JSON.stringify(newPermissions));

    if (newUser.preferred_theme) {
      setTheme(newUser.preferred_theme);
    }
  };

  const logout = () => {
    setToken(null);
    setUser(null);
    setPermissions([]);
    
    localStorage.removeItem('sso_token');
    localStorage.removeItem('sso_user');
    localStorage.removeItem('sso_permissions');
    
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
