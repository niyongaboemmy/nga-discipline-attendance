import React from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';
import { DashboardLayout } from '../components/Layout/DashboardLayout';
import { HeroBanner } from '../components/common/HeroBanner';
import { useAuth } from '../context/AuthContext';
import { navItems } from '../components/Layout/navConfig';

const greeting = () => {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
};

const roleBlurb: Record<string, string> = {
  admin: 'Manage users, discipline rules, and oversee the whole system from here.',
  teacher: 'Mark attendance, log conduct records, and review your classes.',
  student: 'Check your attendance, conduct record, and submit excuses.',
};

/** The shared landing page every role sees right after signing in — a
 *  single, unambiguous "you're in" screen inside the full app chrome,
 *  before they head to their role-specific tools via the sidebar. Replaces
 *  jumping straight to /admin or /dashboard, which gave no consistent
 *  first impression across roles. */
export const Welcome: React.FC = () => {
  const { user } = useAuth();
  if (!user) return null;

  // Same nav items the sidebar shows for this role, minus Settings/Dashboard
  // itself — this page IS the dashboard's entry point, not a duplicate of it.
  const quickLinks = navItems.filter(
    (item) => item.roles.includes(user.role) && item.path !== '/settings' && item.path !== '/dashboard'
  );

  return (
    <DashboardLayout>
      <HeroBanner name={user.name} role={user.role} title={`${greeting()}, ${user.name.split(' ')[0]}!`}>
        {roleBlurb[user.role] || 'Welcome to Tendo.'}
      </HeroBanner>

      <section className="card mt-6">
        <div className="card-header">
          <div>
            <div className="card-title">Quick links</div>
            <div className="card-subtitle">Jump straight to what you use most</div>
          </div>
        </div>
        <div className="card-body">
          <div className="grid grid-stats" style={{ gap: '12px' }}>
            {quickLinks.map((item) => (
              <Link key={item.path} to={item.path} className="stat-card" style={{ textDecoration: 'none' }}>
                <div className="flex items-center justify-between">
                  <span className="stat-icon"><item.icon size={18} /></span>
                  <ChevronRight size={16} />
                </div>
                <div className="stat-label mt-2">{item.label}</div>
              </Link>
            ))}
          </div>
        </div>
      </section>
    </DashboardLayout>
  );
};
