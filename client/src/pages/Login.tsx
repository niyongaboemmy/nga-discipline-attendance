import React from 'react';
import { useAuth } from '../context/AuthContext';
import { ArrowRight, Sun, Moon, Info, ExternalLink } from 'lucide-react';
import './Login.css';

export const Login: React.FC = () => {
  const { theme, toggleTheme, login } = useAuth();

  return (
    <div className="login-page">
      {/* Top bar */}
      <header className="login-topbar">
        <div className="login-topbar-brand">
          <img src="/logo.png" alt="Discipline logo" />
          <span>Discipline</span>
        </div>
        <div className="login-topbar-actions">
          <button className="icon-btn" onClick={toggleTheme} aria-label="Toggle theme">
            {theme === 'light' ? <Moon size={18} /> : <Sun size={18} />}
          </button>
          <a className="btn btn-outline btn-sm" href="https://ngamis.isengesho.com" target="_blank" rel="noopener noreferrer">
            Visit MIS <ExternalLink size={14} />
          </a>
        </div>
      </header>

      {/* Centered card */}
      <main className="login-main">
        <div className="login-card">
          <div className="login-logo-badge">
            <img src="/logo.png" alt="Discipline" />
          </div>

          <h1 className="login-title">Welcome to Discipline</h1>
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
            <a href="https://ngamis.isengesho.com" target="_blank" rel="noopener noreferrer">Visit Discipline MIS</a>
          </p>
        </div>
      </main>

      <footer className="login-page-foot">© {new Date().getFullYear()} Discipline</footer>
    </div>
  );
};
