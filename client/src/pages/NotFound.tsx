import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth, homeRouteForRole } from '../context/AuthContext';
import { Compass, ArrowLeft } from 'lucide-react';

export const NotFound: React.FC = () => {
  const navigate = useNavigate();
  const { user } = useAuth();
  const homePath = user ? homeRouteForRole(user.role) : '/';

  return (
    <div className="flex flex-col items-center justify-center" style={{ minHeight: '100vh', padding: '24px', background: 'var(--bg-page)' }}>
      <div className="card card-pad text-center flex flex-col items-center gap-4" style={{ maxWidth: '420px', width: '100%' }}>
        <div className="login-role-icon tone-brand" style={{ width: '56px', height: '56px' }}>
          <Compass size={28} />
        </div>
        <div>
          <h1 className="text-3xl font-bold">404</h1>
          <h2 className="text-lg font-semibold mt-2">Page not found</h2>
          <p className="page-subtitle">The page you’re looking for doesn’t exist or has moved.</p>
        </div>
        <button className="btn btn-primary btn-block" onClick={() => navigate(homePath)}>
          <ArrowLeft size={16} /> Back to {user ? 'dashboard' : 'login'}
        </button>
      </div>
    </div>
  );
};
