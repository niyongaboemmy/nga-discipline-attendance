import React, { useState } from 'react';
import { NavLink } from 'react-router-dom';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { navItems, type NavItem } from './navConfig';

const COLLAPSE_STORAGE_KEY = 'discipline_sidebar_collapsed';

type NavGroup = { standalone: NavItem } | { section: string; items: NavItem[] };

/** Group the role's visible nav items by section; unsectioned items stand alone.
    Mirrors the grouping the top navbar used to do, but rendered as a sidebar. */
function buildGroups(role: NavItem['roles'][number]): NavGroup[] {
  const visible = navItems.filter((i) => i.roles.includes(role));
  const groups: NavGroup[] = [];
  for (const item of visible) {
    if (!item.section) {
      groups.push({ standalone: item });
      continue;
    }
    const last = groups[groups.length - 1];
    if (last && 'section' in last && last.section === item.section) last.items.push(item);
    else groups.push({ section: item.section, items: [item] });
  }
  return groups;
}

const SidebarLink: React.FC<{ item: NavItem; collapsed: boolean; onNavigate?: () => void }> = ({
  item, collapsed, onNavigate,
}) => {
  const Icon = item.icon;
  return (
    <NavLink
      to={item.path}
      onClick={onNavigate}
      title={collapsed ? item.label : undefined}
      className={({ isActive }) => `sidebar-item${isActive ? ' is-active' : ''}`}
    >
      <Icon size={collapsed ? 20 : 18} className="sidebar-item-icon" />
      {!collapsed && <span>{item.label}</span>}
    </NavLink>
  );
};

const SidebarNav: React.FC<{ collapsed: boolean; role: NavItem['roles'][number]; onNavigate?: () => void }> = ({
  collapsed, role, onNavigate,
}) => (
  <nav className="sidebar-nav" aria-label="Primary">
    {buildGroups(role).map((g, i) =>
      'standalone' in g ? (
        <SidebarLink key={g.standalone.path} item={g.standalone} collapsed={collapsed} onNavigate={onNavigate} />
      ) : (
        <div key={`${g.section}-${i}`}>
          {!collapsed && <div className="sidebar-group-label">{g.section}</div>}
          <div className="sidebar-group-items">
            {g.items.map((item) => (
              <SidebarLink key={item.path} item={item} collapsed={collapsed} onNavigate={onNavigate} />
            ))}
          </div>
        </div>
      )
    )}
  </nav>
);

interface SidebarProps {
  mobileOpen: boolean;
  onCloseMobile: () => void;
}

/** App navigation: a collapsible desktop rail (persisted to localStorage) plus
 *  a mobile overlay drawer, matching MIS/TaskMentor's Sidebar. */
export const Sidebar: React.FC<SidebarProps> = ({ mobileOpen, onCloseMobile }) => {
  const { user } = useAuth();
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(COLLAPSE_STORAGE_KEY) === '1';
    } catch {
      return false;
    }
  });

  const toggleCollapsed = () => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(COLLAPSE_STORAGE_KEY, next ? '1' : '0');
      } catch {
        /* localStorage unavailable — collapse state just won't persist */
      }
      return next;
    });
  };

  if (!user) return null;

  return (
    <>
      {/* Desktop persistent rail */}
      <aside className={`sidebar${collapsed ? ' is-collapsed' : ''}`}>
        <div className="sidebar-header">
          {!collapsed && <span className="sidebar-brand">Menu</span>}
          <button
            className="icon-btn"
            onClick={toggleCollapsed}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {collapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
          </button>
        </div>
        <SidebarNav collapsed={collapsed} role={user.role} />
        <div className="sidebar-footer">
          {!collapsed && <span className="text-xs text-tertiary">Tendo</span>}
        </div>
      </aside>

      {/* Mobile overlay drawer */}
      {mobileOpen && (
        <>
          <div className="sidebar-scrim" onClick={onCloseMobile} aria-hidden="true" />
          <aside className="sidebar-drawer" role="dialog" aria-modal="true" aria-label="Navigation menu">
            <div className="sidebar-header">
              <span className="sidebar-brand">Menu</span>
              <button className="icon-btn" onClick={onCloseMobile} aria-label="Close menu">
                <X size={18} />
              </button>
            </div>
            <SidebarNav collapsed={false} role={user.role} onNavigate={onCloseMobile} />
          </aside>
        </>
      )}
    </>
  );
};
