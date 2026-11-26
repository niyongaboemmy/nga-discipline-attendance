import React, { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Navbar } from './Navbar';
import { Sidebar } from './Sidebar';
import { useAcademicPeriod } from '../../context/AcademicPeriodContext';
import OfflineBanner from '../../offline/OfflineBanner';

const COLLAPSE_STORAGE_KEY = 'discipline_sidebar_collapsed';
/** Same widths as Amashuri: under 640 the menu is a drawer, under 1040 it starts as the rail only. */
const PHONE_MAX = 640;
const RAIL_ONLY_MAX = 1040;

const readCollapsed = (): boolean => {
  try {
    return localStorage.getItem(COLLAPSE_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
};

interface DashboardLayoutProps {
  children: React.ReactNode;
}

/** App chrome: fixed top bar + the rail-and-panel menu, matching Amashuri's layout. The content is remounted (via `key`)
 *  whenever the academic period switches, so every page's data-fetch
 *  effects rerun against the new period. */
export const DashboardLayout: React.FC<DashboardLayoutProps> = ({ children }) => {
  const { academicPeriodVersion, hasSelection, loading, years, misHasActivePeriod } = useAcademicPeriod();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [width, setWidth] = useState(() => window.innerWidth);
  // On a wide screen the choice is remembered; on a narrow one it starts as the rail each time.
  const [widePref, setWidePref] = useState(readCollapsed);
  const [narrowCollapsed, setNarrowCollapsed] = useState(true);

  useEffect(() => {
    const onResize = () => {
      const w = window.innerWidth;
      setWidth(w);
      if (w >= PHONE_MAX) setMobileMenuOpen(false);
      if (w < RAIL_ONLY_MAX) setNarrowCollapsed(true);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const phone = width < PHONE_MAX;
  const narrow = width < RAIL_ONLY_MAX;
  const collapsed = narrow ? narrowCollapsed : widePref;
  const toggleCollapsed = () => {
    if (narrow) {
      setNarrowCollapsed((v) => !v);
      return;
    }
    setWidePref((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(COLLAPSE_STORAGE_KEY, next ? '1' : '0');
      } catch {
        /* localStorage unavailable: the choice just isn't remembered */
      }
      return next;
    });
  };
  const closeMobile = () => setMobileMenuOpen(false);
  // Only warn once we've actually finished checking — avoids a flash on load.
  const showWarning = !loading && years.length > 0 && !hasSelection;

  return (
    <div className="app-shell">
      <Navbar onOpenMobileMenu={() => setMobileMenuOpen((o) => !o)} />
      <div className="app-body">
        {!phone ? (
          <Sidebar collapsed={collapsed} onToggle={toggleCollapsed} />
        ) : (
          mobileMenuOpen && (
            <>
              <div className="sidebar-scrim" onClick={closeMobile} aria-hidden="true" />
              <Sidebar drawer onToggle={closeMobile} onNavigate={closeMobile} />
            </>
          )
        )}
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
