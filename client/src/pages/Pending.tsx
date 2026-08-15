import React from 'react';
import { useAuth } from '../context/AuthContext';
import { Hourglass, LogOut } from 'lucide-react';

export const Pending: React.FC = () => {
  const { user, logout } = useAuth();

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
        <button className="btn btn-outline btn-block" onClick={logout}>
          <LogOut size={16} /> Sign out
        </button>
      </div>
    </div>
  );
};
