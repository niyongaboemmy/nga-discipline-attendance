import React, { useEffect, useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth, homeRouteForRole } from '../context/AuthContext';
import { AlertCircle, ArrowLeft } from 'lucide-react';
import './Login.css';
import './SSOCallback.css';

export const SSOCallback: React.FC = () => {
  const { setSession } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const hasExchanged = useRef<boolean>(false);

  useEffect(() => {
    const exchangeCode = async () => {
      const params = new URLSearchParams(window.location.search);
      const code = params.get('code');

      if (!code) {
        setError('Authorization code is missing in the redirect URL.');
        setLoading(false);
        return;
      }

      // Avoid a double exchange under React Strict Mode.
      if (hasExchanged.current) return;
      hasExchanged.current = true;

      try {
        const response = await fetch('/api/sso/exchange', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code }),
        });

        const result = await response.json();

        if (response.ok && result.success) {
          const { token, user, permissions } = result.data;
          setSession(token, user, permissions);
          // Route to the dashboard that matches the user's actual role.
          navigate(homeRouteForRole(user.role));
        } else {
          setError(result.message || 'Token exchange failed. The code may have expired or been reused.');
        }
      } catch (err) {
        console.error('SSO Exchange error:', err);
        setError('Network error: could not reach the Discipline backend server.');
      } finally {
        setLoading(false);
      }
    };

    exchangeCode();
  }, [setSession, navigate]);

  return (
    <div className="login-page">
      <main className="login-main">
        <div className="login-card text-center flex flex-col items-center">
          {loading ? (
            <>
              <div className="sso-badge">
                <span className="sso-ring" />
                <span className="sso-ring sso-ring-delayed" />
                <div className="login-logo-badge"><img src="/logo.png" alt="Discipline" /></div>
              </div>

              <h1 className="login-title" style={{ fontSize: '24px' }}>Verifying your session</h1>
              <p className="login-sub">Securely signing you in with Discipline MIS…</p>

              <div className="sso-dots" aria-hidden="true"><span /><span /><span /></div>
            </>
          ) : (
            <>
              <div className="sso-badge-error"><AlertCircle size={28} /></div>
              <h1 className="login-title" style={{ fontSize: '24px', color: 'var(--text-primary)' }}>Sign-in failed</h1>
              <p className="login-sub" style={{ marginBottom: '24px' }}>{error}</p>
              <button className="btn btn-outline btn-block" onClick={() => navigate('/')}>
                <ArrowLeft size={16} /> Back to login
              </button>
            </>
          )}
        </div>
      </main>
    </div>
  );
};
