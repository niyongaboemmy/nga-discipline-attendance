import React, { useState, useEffect, useRef } from "react";
import { NavLink } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import { AcademicPeriodSwitcher } from "./AcademicPeriodSwitcher";
import { SystemsMenu } from "./SystemsMenu";
import { NavSearch } from "./NavSearch";
import { NotificationCenter } from "./NotificationCenter";
import { getSystems } from "../../api/systems";
import type { System } from "../../api/systems";
import {
  Sun,
  Moon,
  Menu,
  LogOut,
  LayoutGrid,
  Settings as SettingsIcon,
} from "lucide-react";

interface NavbarProps {
  onOpenMobileMenu?: () => void;
}

/** Fixed top bar: brand, academic period switcher, notifications, theme toggle,
 *  user menu, and (on narrow viewports) the trigger for the Sidebar's mobile
 *  drawer. Primary navigation itself lives in Sidebar, not here. */
export const Navbar: React.FC<NavbarProps> = ({ onOpenMobileMenu }) => {
  const { user, theme, toggleTheme, logout } = useAuth();
  const [systems, setSystems] = useState<System[]>([]);
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const barRef = useRef<HTMLElement>(null);

  useEffect(() => {
    getSystems().then(setSystems).catch(() => setSystems([]));
  }, []);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (barRef.current && !barRef.current.contains(e.target as Node))
        setOpenMenu(null);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

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

        <NavLink to="/welcome" className="topnav-brand">
          <img src="/icon.png" alt="Tendo logo" />
          <span className="wordmark">Tendo</span>
        </NavLink>
      </div>

      <div className="navbar-actions">
        <AcademicPeriodSwitcher />

        <NavSearch />

        {/* Notifications */}
        <NotificationCenter
          open={openMenu === "notif"}
          onToggle={() => toggle("notif")}
          onClose={() => setOpenMenu(null)}
        />

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
