import React from 'react';
import { Navbar } from './Navbar';
import { useAcademicPeriod } from '../../context/AcademicPeriodContext';

interface DashboardLayoutProps {
  children: React.ReactNode;
}

/** App chrome: a single glass top navbar over the page content.
 *  The content is remounted (via `key`) whenever the academic period switches,
 *  so every page's data-fetch effects rerun against the new period. */
export const DashboardLayout: React.FC<DashboardLayoutProps> = ({ children }) => {
  const { academicPeriodVersion } = useAcademicPeriod();
  return (
    <div className="app-shell">
      <Navbar />
      <main className="app-content" key={academicPeriodVersion}>{children}</main>
    </div>
  );
};
