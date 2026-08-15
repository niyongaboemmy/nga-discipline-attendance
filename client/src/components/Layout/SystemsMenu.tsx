import React from 'react';
import { GraduationCap, ShieldCheck, ClipboardList } from 'lucide-react';

interface AppEntry {
  name: string;
  href?: string;
  icon: React.ReactNode;
  current?: boolean;
}

const apps: AppEntry[] = [
  { name: 'Discipline Portal', icon: <ShieldCheck size={20} />, current: true },
  { name: 'NGA Central MIS', href: import.meta.env.VITE_MIS_HOME_URL, icon: <GraduationCap size={20} /> },
  { name: 'TaskMentor', href: import.meta.env.VITE_TASKMENTOR_HOME_URL, icon: <ClipboardList size={20} /> },
];

interface SystemsMenuProps {
  isOpen: boolean;
  onClose: () => void;
}

/** Cross-app switcher ("waffle" menu), matching the NGA Central MIS / TaskMentor
 *  top bar. This app has no SSO systems API of its own, so the list is a static
 *  set of the known NGA apps rather than the dynamic, per-user list the siblings
 *  fetch — visually it's the same "Apps" grid. */
export const SystemsMenu: React.FC<SystemsMenuProps> = ({ isOpen, onClose }) => {
  if (!isOpen) return null;
  return (
    <div className="menu systems-menu animate-fade-in">
      <div className="menu-header">
        <span className="text-sm font-semibold">Apps</span>
        <div className="text-xs text-secondary">NGA Ecosystem</div>
      </div>
      <div className="systems-menu-grid">
        {apps.map((app) => (
          <a
            key={app.name}
            href={app.current ? undefined : app.href}
            target={app.current ? undefined : '_blank'}
            rel={app.current ? undefined : 'noopener noreferrer'}
            onClick={app.current ? (e) => { e.preventDefault(); onClose(); } : onClose}
            className={`systems-menu-item${app.current ? ' is-current' : ''}`}
            aria-current={app.current ? 'page' : undefined}
          >
            <span className="systems-menu-icon">{app.icon}</span>
            <span>{app.name}</span>
          </a>
        ))}
      </div>
    </div>
  );
};
