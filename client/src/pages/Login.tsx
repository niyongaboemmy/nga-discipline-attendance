import React, { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth, homeRouteForRole } from '../context/AuthContext';
import { ArrowRight, Sun, Moon, Info, ExternalLink } from 'lucide-react';
import './Login.css';

export const Login: React.FC = () => {
  const { theme, toggleTheme, login, isAuthenticated, user, loading } = useAuth();
  const navigate = useNavigate();

  // A valid session landing on "/" (stale bookmark, browser back, a stray
  // internal link) used to render this public card regardless — silently
  // "logged in but on the login screen" was the actual bug behind reports
  // that the app "isn't auto-logging in".
  useEffect(() => {
    if (!loading && isAuthenticated && user) {
      navigate(homeRouteForRole(user.role), { replace: true });
    }
  }, [loading, isAuthenticated, user, navigate]);

  if (loading || (isAuthenticated && user)) return null;

  return (
    <div className="login-page">
      {/* Top bar */}
      <header className="login-topbar">
        <div className="login-topbar-brand">
          <img src="/icon.png" alt="Tendo logo" />
          <span>Tendo</span>
        </div>
        <div className="login-topbar-actions">
          <button className="icon-btn" onClick={toggleTheme} aria-label="Toggle theme">
            {theme === 'light' ? <Moon size={18} /> : <Sun size={18} />}
          </button>
          <a className="btn btn-outline btn-sm" href="https://mis.amashuri.com" target="_blank" rel="noopener noreferrer">
            Visit MIS <ExternalLink size={14} />
          </a>
        </div>
      </header>

      {/* Centered card */}
      <main className="login-main">
        <div className="login-card">
          <div className="login-logo-badge">
            <img src="/icon.png" alt="Tendo" />
          </div>

          <h1 className="login-title">Welcome to Tendo</h1>
          <p className="login-sub">Discipline &amp; Attendance Management Portal</p>

          <div className="login-info">
            <Info size={16} />
            <span>Sign in with your <strong>Discipline MIS</strong> account to continue.</span>
          </div>

          <button className="btn btn-primary btn-lg btn-block" onClick={login}>
            Sign in with Discipline MIS <ArrowRight size={18} />
          </button>

          <p className="login-foot">
            No account or need password help?{' '}
            <a href="https://mis.amashuri.com" target="_blank" rel="noopener noreferrer">Visit Discipline MIS</a>
          </p>
        </div>
      </main>

      <footer className="login-page-foot">© {new Date().getFullYear()} Tendo</footer>
    </div>
  );
};
