import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth, homeRouteForRole, type Role } from '../context/AuthContext';
import { apiGet, ApiError } from '../api/client';
import { Hourglass, LogOut, RefreshCw } from 'lucide-react';

const ROLE_LEVEL_TO_ROLE: Record<string, Role> = { STUDENT: 'student', TEACHER: 'teacher', ADMIN: 'admin' };

/** Previously required a manual sign-out/in to discover a newly-granted
 *  role. "Check again" re-resolves the caller's role from the DB (the same
 *  data authMiddleware already recomputes on every request) and updates the
 *  local session in place — no new SSO round trip needed, since the server
 *  never trusted the JWT's role claim for authorization anyway. */
export const Pending: React.FC = () => {
  const { user, token, permissions, rolePermissions, setSession, logout } = useAuth();
  const navigate = useNavigate();
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const checkAgain = async () => {
    setChecking(true);
    setMessage(null);
    try {
      const res = await apiGet<{ roleLevel: 'STUDENT' | 'TEACHER' | 'ADMIN' | null; permissionKeys: string[] }>('/api/roles-permissions/me');
      const roleLevel = res.data?.roleLevel;
      const newRole = roleLevel ? ROLE_LEVEL_TO_ROLE[roleLevel] : undefined;
      if (newRole && user && token) {
        setSession(token, { ...user, role: newRole }, permissions, res.data?.permissionKeys || rolePermissions);
        navigate(homeRouteForRole(newRole));
      } else {
        setMessage("Still no role assigned yet. Try again shortly, or contact your administrator.");
      }
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : 'Could not check right now. Please try again.');
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="flex flex-col items-center justify-center" style={{ minHeight: '100vh', padding: '24px', background: 'var(--bg-page)' }}>
      <div className="card card-pad text-center flex flex-col items-center gap-4" style={{ maxWidth: '440px', width: '100%' }}>
        <div className="login-role-icon tone-warning" style={{ width: '56px', height: '56px' }}>
          <Hourglass size={26} />
        </div>
        <div>
          <h1 className="text-2xl font-bold">Awaiting role assignment</h1>
          <p className="page-subtitle">
            Hi {user?.name?.split(' ')[0] || 'there'} — your account is active, but an administrator
            hasn’t assigned your role yet. You’ll get access as soon as a role is granted.
          </p>
        </div>
        <span className="badge badge-warning">Unassigned</span>
        {message && <p className="text-sm text-secondary">{message}</p>}
        <div className="flex gap-2" style={{ width: '100%' }}>
          <button className="btn btn-outline" style={{ flex: 1 }} onClick={logout}>
            <LogOut size={16} /> Sign out
          </button>
          <button className="btn btn-primary" style={{ flex: 1 }} onClick={checkAgain} disabled={checking}>
            <RefreshCw size={16} /> {checking ? 'Checking…' : 'Check again'}
          </button>
        </div>
      </div>
    </div>
  );
};
