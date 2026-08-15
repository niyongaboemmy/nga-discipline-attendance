import React from 'react';
import { Navbar } from './Navbar';

interface DashboardLayoutProps {
  children: React.ReactNode;
}

/** App chrome: a single glass top navbar over the page content. */
export const DashboardLayout: React.FC<DashboardLayoutProps> = ({ children }) => (
  <div className="app-shell">
    <Navbar />
    <main className="app-content">{children}</main>
  </div>
);
