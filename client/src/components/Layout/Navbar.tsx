import React, { useState, useEffect, useRef } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { AcademicPeriodSwitcher } from './AcademicPeriodSwitcher';
import { navItems, type NavItem } from './navConfig';
import {
  Sun, Moon, Bell, Menu, X, CheckCheck, Trash2, ChevronDown, LogOut,
  Settings as SettingsIcon,
} from 'lucide-react';

interface Notification {
  id: number;
  title: string;
  message: string;
  read: boolean;
  created_at: string;
}

/** Top-level nav entry: either a direct link or a labeled dropdown of links. */
type NavGroup = { item: NavItem } | { section: string; items: NavItem[] };

/** Group the role's nav items by section; single-item sections become direct links.
    Settings is excluded here — it lives in the user menu. */
function buildGroups(role: string): NavGroup[] {
  const visible = navItems.filter((i) => i.roles.includes(role as NavItem['roles'][number]) && i.path !== '/settings');
  const groups: Array<{ section?: string; items: NavItem[] }> = [];
  for (const item of visible) {
    const last = groups[groups.length - 1];
    if (item.section && last?.section === item.section) last.items.push(item);
    else groups.push({ section: item.section, items: [item] });
  }
  return groups.map((g) =>
    !g.section || g.items.length === 1 ? { item: g.items[0] } : { section: g.section, items: g.items }
  );
}

export const Navbar: React.FC = () => {
  const { user, theme, toggleTheme, logout } = useAuth();
  const location = useLocation();
  const [notifications, setNotifications] = useState<Notification[]>([]);
  // Which popup is open: a section name, 'notif', 'user', 'mobile', or none.
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const barRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const fetchNotifications = async () => {
      try {
        const res = await fetch('/api/notifications', {
          headers: { Authorization: `Bearer ${localStorage.getItem('sso_token')}` },
        });
        if (res.ok) {
          const result = await res.json();
          if (result.success) setNotifications(result.data);
        }
      } catch (err) {
        console.error('Error fetching notifications:', err);
      }
    };
    fetchNotifications();
    const interval = setInterval(fetchNotifications, 30000);
    return () => clearInterval(interval);
  }, []);

  // Close any open popup on outside click or route change.
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (barRef.current && !barRef.current.contains(e.target as Node)) setOpenMenu(null);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);
  useEffect(() => { setOpenMenu(null); }, [location.pathname]);

  const authHeader = () => ({ Authorization: `Bearer ${localStorage.getItem('sso_token')}` });

  const markAsRead = async (id: number) => {
    try {
      const res = await fetch(`/api/notifications/${id}/read`, { method: 'PUT', headers: authHeader() });
      if (res.ok) {
        setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, read: true } : n)));
      }
    } catch (err) {
      console.error('Error marking notification as read:', err);
    }
  };

  const markAllRead = async () => {
    try {
      const res = await fetch('/api/notifications/read-all', { method: 'PUT', headers: authHeader() });
      if (res.ok) setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
    } catch (err) {
      console.error('Error marking all read:', err);
    }
  };

  const clearAll = async () => {
    try {
      const res = await fetch('/api/notifications', { method: 'DELETE', headers: authHeader() });
      // Broadcasts ('all') are kept server-side; refetch to reflect the true state.
      if (res.ok) {
        const r = await fetch('/api/notifications', { headers: authHeader() });
        if (r.ok) { const result = await r.json(); if (result.success) setNotifications(result.data); }
      }
    } catch (err) {
      console.error('Error clearing notifications:', err);
    }
  };

  const unreadCount = notifications.filter((n) => !n.read).length;
  if (!user) return null;

  const groups = buildGroups(user.role);
  const toggle = (key: string) => setOpenMenu((m) => (m === key ? null : key));
  const isGroupActive = (items: NavItem[]) => items.some((i) => i.path === location.pathname);

  return (
    <header className="navbar" ref={barRef}>
      <div className="flex items-center" style={{ minWidth: 0 }}>
        {/* Brand */}
        <NavLink to="/dashboard" className="topnav-brand">
          <img src="/logo.png" alt="NGA logo" />
          <span className="wordmark">Discipline Portal</span>
        </NavLink>

        {/* Primary navigation (desktop) */}
        <nav className="topnav-links" aria-label="Primary">
          {groups.map((g) =>
            'item' in g ? (
              <NavLink
                key={g.item.path}
                to={g.item.path}
                className={({ isActive }) => `topnav-link${isActive ? ' is-active' : ''}`}
              >
                {g.item.label}
              </NavLink>
            ) : (
              <div key={g.section} className="topnav-group">
                <button
                  className={`topnav-link${isGroupActive(g.items) ? ' is-active' : ''}${openMenu === g.section ? ' is-open' : ''}`}
                  onClick={() => toggle(g.section)}
                  aria-expanded={openMenu === g.section}
                >
                  {g.section}
                  <ChevronDown size={14} className="topnav-caret" />
                </button>
                {openMenu === g.section && (
                  <div className="menu animate-fade-in">
                    {g.items.map((item) => {
                      const Icon = item.icon;
                      return (
                        <NavLink
                          key={item.path}
                          to={item.path}
                          className={({ isActive }) => `menu-item${isActive ? ' is-active' : ''}`}
                        >
                          <Icon size={16} />
                          <span>{item.label}</span>
                        </NavLink>
                      );
                    })}
                  </div>
                )}
              </div>
            )
          )}
        </nav>
      </div>

      <div className="navbar-actions">
        {/* Academic period switcher */}
        <AcademicPeriodSwitcher />

        {/* Notifications */}
        <div style={{ position: 'relative' }}>
          <button className="icon-btn" onClick={() => toggle('notif')} aria-label="Notifications">
            <Bell size={18} />
            {unreadCount > 0 && <span className="notif-badge">{unreadCount}</span>}
          </button>

          {openMenu === 'notif' && (
            <div className="popover animate-fade-in">
              <div className="card-header">
                <span className="section-title text-base">Notifications</span>
                {notifications.length > 0 && (
                  <div className="flex items-center gap-1">
                    <button className="icon-btn" onClick={markAllRead} disabled={unreadCount === 0} title="Mark all as read" aria-label="Mark all as read">
                      <CheckCheck size={16} />
                    </button>
                    <button className="icon-btn" onClick={clearAll} title="Clear notifications" aria-label="Clear notifications">
                      <Trash2 size={16} />
                    </button>
                  </div>
                )}
              </div>
              <div style={{ maxHeight: '320px', overflowY: 'auto' }}>
                {notifications.length === 0 ? (
                  <div className="empty-state" style={{ padding: '32px' }}>
                    <Bell size={24} />
                    <span className="text-sm">No notifications</span>
                  </div>
                ) : (
                  notifications.map((n) => (
                    <button
                      key={n.id}
                      onClick={() => !n.read && markAsRead(n.id)}
                      className="w-full text-left border-b"
                      style={{
                        display: 'block',
                        padding: '12px 16px',
                        background: n.read ? 'transparent' : 'var(--primary-light)',
                      }}
                    >
                      <div className="font-semibold text-sm">{n.title}</div>
                      <div className="text-secondary text-xs mt-1">{n.message}</div>
                      <div className="text-tertiary text-xs mt-1">
                        {new Date(n.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </div>
                    </button>
                  ))
                )}
              </div>
            </div>
          )}
        </div>

        {/* Theme toggle */}
        <button className="icon-btn" onClick={toggleTheme} aria-label="Toggle theme">
          {theme === 'light' ? <Moon size={18} /> : <Sun size={18} />}
        </button>

        {/* User menu (profile, settings, sign out) */}
        <div style={{ position: 'relative' }}>
          <button className="topnav-user" onClick={() => toggle('user')} aria-expanded={openMenu === 'user'}>
            <div className="avatar avatar-sm">{user.name.charAt(0).toUpperCase()}</div>
            <div className="hide-mobile text-left">
              <div className="text-sm font-semibold truncate" style={{ maxWidth: '140px' }}>{user.name}</div>
              <div className="text-xs text-secondary capitalize">{user.role}</div>
            </div>
            <ChevronDown size={14} className="topnav-caret hide-mobile" />
          </button>

          {openMenu === 'user' && (
            <div className="menu menu--right animate-fade-in">
              <div className="menu-header">
                <div className="text-sm font-semibold truncate">{user.name}</div>
                <div className="text-xs text-secondary truncate">{user.email}</div>
              </div>
              <NavLink to="/settings" className={({ isActive }) => `menu-item${isActive ? ' is-active' : ''}`}>
                <SettingsIcon size={16} />
                <span>Settings</span>
              </NavLink>
              <button className="menu-item menu-item--danger" onClick={logout}>
                <LogOut size={16} />
                <span>Sign out</span>
              </button>
            </div>
          )}
        </div>

        {/* Mobile menu toggle */}
        <button className="icon-btn topnav-hamburger" onClick={() => toggle('mobile')} aria-label="Open menu">
          {openMenu === 'mobile' ? <X size={20} /> : <Menu size={20} />}
        </button>
      </div>

      {/* Mobile slide-down panel */}
      {openMenu === 'mobile' && (
        <div className="topnav-mobile-panel animate-slide-in-up">
          {groups.map((g) =>
            'item' in g ? (
              <NavLink
                key={g.item.path}
                to={g.item.path}
                className={({ isActive }) => `nav-item${isActive ? ' is-active' : ''}`}
              >
                <span className="nav-icon"><g.item.icon size={18} /></span>
                <span className="nav-label">{g.item.label}</span>
              </NavLink>
            ) : (
              <React.Fragment key={g.section}>
                <div className="nav-section-label">{g.section}</div>
                {g.items.map((item) => {
                  const Icon = item.icon;
                  return (
                    <NavLink
                      key={item.path}
                      to={item.path}
                      className={({ isActive }) => `nav-item${isActive ? ' is-active' : ''}`}
                    >
                      <span className="nav-icon"><Icon size={18} /></span>
                      <span className="nav-label">{item.label}</span>
                    </NavLink>
                  );
                })}
              </React.Fragment>
            )
          )}
          <div className="nav-divider" />
          <NavLink to="/settings" className={({ isActive }) => `nav-item${isActive ? ' is-active' : ''}`}>
            <span className="nav-icon"><SettingsIcon size={18} /></span>
            <span className="nav-label">Settings</span>
          </NavLink>
        </div>
      )}
    </header>
  );
};
