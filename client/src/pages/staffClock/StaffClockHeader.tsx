import React from 'react';
import { NavLink } from 'react-router-dom';
import { usePermissions } from '../../hooks/usePermissions';
import '../../styles/staffClock.css';

/** Title + the staff clock's own tabs (Dashboard · School zone · Phones & cards · Scan a card). */
export const StaffClockHeader: React.FC<{ title: string; lead: string; actions?: React.ReactNode; pending?: number }> = ({ title, lead, actions, pending }) => {
  const { can } = usePermissions();
  const tabs = [
    { to: '/staff/clock', label: 'Dashboard', show: can('STAFF_ATTENDANCE_VIEW_ALL'), end: true },
    { to: '/staff/clock/zone', label: 'School zone', show: can(['STAFF_ATTENDANCE_ZONES_MANAGE', 'STAFF_ATTENDANCE_VIEW_ALL']) },
    { to: '/staff/clock/devices', label: 'Phones & cards', show: can('STAFF_DEVICES_MANAGE'), count: pending },
    { to: '/staff/clock/scan', label: 'Scan a card', show: can('STAFF_CLOCK_SCAN') },
  ].filter((t) => t.show);
  return (
    <>
      {tabs.length > 1 && (
        <nav className="sc-tabs" aria-label="Staff clock">
          {tabs.map((t) => (
            <NavLink key={t.to} to={t.to} end={t.end} className={({ isActive }) => `sc-tab${isActive ? ' active' : ''}`}>
              {t.label}
              {!!t.count && <span className="sc-tab-count">{t.count}</span>}
            </NavLink>
          ))}
        </nav>
      )}
      <div className="sc-head">
        <div className="sc-head-text">
          <h1>{title}</h1>
          <p>{lead}</p>
        </div>
        {actions && <div className="sc-head-actions">{actions}</div>}
      </div>
    </>
  );
};

export const Spinner: React.FC = () => <span className="sc-spin" aria-hidden="true" />;
