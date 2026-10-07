import React, { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Navbar } from './Navbar';
import { Sidebar } from './Sidebar';
import { useAcademicPeriod } from '../../context/AcademicPeriodContext';
import OfflineBanner from '../../offline/OfflineBanner';

interface DashboardLayoutProps {
  children: React.ReactNode;
}

/** App chrome: fixed top bar + collapsible sidebar, matching the shared
 *  NGA MIS / TaskMentor layout. The content is remounted (via `key`)
 *  whenever the academic period switches, so every page's data-fetch
 *  effects rerun against the new period. */
export const DashboardLayout: React.FC<DashboardLayoutProps> = ({ children }) => {
  const { academicPeriodVersion, hasSelection, loading, years, misHasActivePeriod } = useAcademicPeriod();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  // Only warn once we've actually finished checking — avoids a flash on load.
  const showWarning = !loading && years.length > 0 && !hasSelection;

  return (
    <div className="app-shell">
      <Navbar onOpenMobileMenu={() => setMobileMenuOpen(true)} />
      <div className="app-body">
        <Sidebar mobileOpen={mobileMenuOpen} onCloseMobile={() => setMobileMenuOpen(false)} />
        <div className="app-content-col">
          {showWarning && (
            <div
              className="flex items-center gap-2 text-sm no-print"
              style={{ background: 'var(--warning-light)', color: 'var(--warning)', padding: '10px 20px' }}
              role="alert"
            >
              <AlertTriangle size={16} />
              <span>
                {misHasActivePeriod
                  ? 'No academic year/term selected. Use the picker in the top bar — until then, records shown may span every period.'
                  : 'The MIS has no academic year/term marked as active. Please select one from the top bar.'}
              </span>
            </div>
          )}
          <OfflineBanner />
          <main className="app-content" key={academicPeriodVersion}>{children}</main>
        </div>
      </div>
    </div>
  );
};
