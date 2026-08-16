import React, { useState, useEffect, useRef } from "react";
import { NavLink } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import { AcademicPeriodSwitcher } from "./AcademicPeriodSwitcher";
import { SystemsMenu } from "./SystemsMenu";
import { NavSearch } from "./NavSearch";
import { getSystems } from "../../api/systems";
import type { System } from "../../api/systems";
import {
  Sun,
  Moon,
  Bell,
  Menu,
  CheckCheck,
  Trash2,
  LogOut,
  LayoutGrid,
  Settings as SettingsIcon,
} from "lucide-react";

interface Notification {
  id: number;
  title: string;
  message: string;
  read: boolean;
  created_at: string;
}

interface NavbarProps {
  onOpenMobileMenu?: () => void;
}

/** Fixed top bar: brand, academic period switcher, notifications, theme toggle,
 *  user menu, and (on narrow viewports) the trigger for the Sidebar's mobile
 *  drawer. Primary navigation itself lives in Sidebar, not here. */
export const Navbar: React.FC<NavbarProps> = ({ onOpenMobileMenu }) => {
  const { user, theme, toggleTheme, logout } = useAuth();
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [systems, setSystems] = useState<System[]>([]);
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const barRef = useRef<HTMLElement>(null);

  useEffect(() => {
    getSystems().then(setSystems).catch(() => setSystems([]));
  }, []);

  useEffect(() => {
    const fetchNotifications = async () => {
      try {
        const res = await fetch("/api/notifications", {
          headers: {
            Authorization: `Bearer ${localStorage.getItem("sso_token")}`,
          },
        });
        if (res.ok) {
          const result = await res.json();
          if (result.success) setNotifications(result.data);
        }
      } catch (err) {
        console.error("Error fetching notifications:", err);
      }
    };
    fetchNotifications();
    const interval = setInterval(fetchNotifications, 30000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (barRef.current && !barRef.current.contains(e.target as Node))
        setOpenMenu(null);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const authHeader = () => ({
    Authorization: `Bearer ${localStorage.getItem("sso_token")}`,
  });

  const markAsRead = async (id: number) => {
    try {
      const res = await fetch(`/api/notifications/${id}/read`, {
        method: "PUT",
        headers: authHeader(),
      });
      if (res.ok) {
        setNotifications((prev) =>
          prev.map((n) => (n.id === id ? { ...n, read: true } : n)),
        );
      }
    } catch (err) {
      console.error("Error marking notification as read:", err);
    }
  };

  const markAllRead = async () => {
    try {
      const res = await fetch("/api/notifications/read-all", {
        method: "PUT",
        headers: authHeader(),
      });
      if (res.ok)
        setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
    } catch (err) {
      console.error("Error marking all read:", err);
    }
  };

  const clearAll = async () => {
    try {
      const res = await fetch("/api/notifications", {
        method: "DELETE",
        headers: authHeader(),
      });
      // Broadcasts ('all') are kept server-side; refetch to reflect the true state.
      if (res.ok) {
        const r = await fetch("/api/notifications", { headers: authHeader() });
        if (r.ok) {
          const result = await r.json();
          if (result.success) setNotifications(result.data);
        }
      }
    } catch (err) {
      console.error("Error clearing notifications:", err);
    }
  };

  const unreadCount = notifications.filter((n) => !n.read).length;
  if (!user) return null;

  const toggle = (key: string) => setOpenMenu((m) => (m === key ? null : key));

  return (
    <header className="navbar" ref={barRef}>
      <div className="flex items-center" style={{ minWidth: 0 }}>
        {onOpenMobileMenu && (
          <button
            className="icon-btn sidebar-hamburger"
            onClick={onOpenMobileMenu}
            aria-label="Open navigation menu"
          >
            <Menu size={20} />
          </button>
        )}

        {/* Apps waffle (cross-app switcher) */}
        <div style={{ position: "relative" }}>
          <button
            className="icon-btn"
            onClick={() => toggle("apps")}
            aria-label="Switch apps"
            title="Apps"
          >
            <LayoutGrid size={19} />
          </button>
          <SystemsMenu
            isOpen={openMenu === "apps"}
            onClose={() => setOpenMenu(null)}
            systems={systems}
          />
        </div>

        <NavLink to="/dashboard" className="topnav-brand">
          <img src="/icon.png" alt="Tendo logo" />
          <span className="wordmark">Tendo</span>
        </NavLink>
      </div>

      <div className="navbar-actions">
        <AcademicPeriodSwitcher />

        <NavSearch />

        {/* Notifications */}
        <div style={{ position: "relative" }}>
          <button
            className="icon-btn"
            onClick={() => toggle("notif")}
            aria-label="Notifications"
          >
            <Bell size={18} />
            {unreadCount > 0 && (
              <span className="notif-badge">{unreadCount}</span>
            )}
          </button>

          {openMenu === "notif" && (
            <div className="popover animate-fade-in">
              <div className="card-header">
                <span className="section-title text-base">Notifications</span>
                {notifications.length > 0 && (
                  <div className="flex items-center gap-1">
                    <button
                      className="icon-btn"
                      onClick={markAllRead}
                      disabled={unreadCount === 0}
                      title="Mark all as read"
                      aria-label="Mark all as read"
                    >
                      <CheckCheck size={16} />
                    </button>
                    <button
                      className="icon-btn"
                      onClick={clearAll}
                      title="Clear notifications"
                      aria-label="Clear notifications"
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                )}
              </div>
              <div style={{ maxHeight: "320px", overflowY: "auto" }}>
                {notifications.length === 0 ? (
                  <div className="empty-state" style={{ padding: "32px" }}>
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
                        display: "block",
                        padding: "12px 16px",
                        background: n.read
                          ? "transparent"
                          : "var(--primary-light)",
                      }}
                    >
                      <div className="font-semibold text-sm">{n.title}</div>
                      <div className="text-secondary text-xs mt-1">
                        {n.message}
                      </div>
                      <div className="text-tertiary text-xs mt-1">
                        {new Date(n.created_at).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </div>
                    </button>
                  ))
                )}
              </div>
            </div>
          )}
        </div>

        {/* Theme toggle */}
        <button
          className="icon-btn"
          onClick={toggleTheme}
          aria-label="Toggle theme"
        >
          {theme === "light" ? <Moon size={18} /> : <Sun size={18} />}
        </button>

        {/* User menu (profile, settings, sign out) */}
        <div className="topnav-user-wrap" style={{ position: "relative" }}>
          <button
            className="topnav-user"
            onClick={() => toggle("user")}
            aria-expanded={openMenu === "user"}
            aria-label="Account menu"
          >
            <div className="avatar avatar-sm">
              {user.name.charAt(0).toUpperCase()}
            </div>
          </button>

          {openMenu === "user" && (
            <div className="menu menu--right animate-fade-in">
              <div className="menu-header">
                <div className="text-sm font-semibold truncate">
                  {user.name}
                </div>
                <div className="text-xs text-secondary truncate">
                  {user.email}
                </div>
              </div>
              <NavLink
                to="/settings"
                className={({ isActive }) =>
                  `menu-item${isActive ? " is-active" : ""}`
                }
              >
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
      </div>
    </header>
  );
};
