import React, { useState, useEffect } from 'react';
import { DashboardLayout } from '../components/Layout/DashboardLayout';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { apiGet, apiPut, ApiError } from '../api/client';
import { User, Bell } from 'lucide-react';

interface NotifPrefs { emailNotifications: boolean; absenceAlerts: boolean; weeklySummary: boolean }
const DEFAULT_PREFS: NotifPrefs = { emailNotifications: true, absenceAlerts: true, weeklySummary: false };

type Tab = 'account' | 'notifications';
const TABS: { key: Tab; label: string; icon: React.ReactNode }[] = [
  { key: 'account', label: 'Account & security', icon: <User size={18} /> },
  { key: 'notifications', label: 'Notifications', icon: <Bell size={18} /> },
];

const Toggle: React.FC<{ checked: boolean; onChange: (v: boolean) => void }> = ({ checked, onChange }) => (
  <label className="toggle">
    <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    <span className="track" />
  </label>
);

const Row: React.FC<{ title: string; desc: string; children: React.ReactNode }> = ({ title, desc, children }) => (
  <div className="flex items-center justify-between gap-4" style={{ padding: '14px 0', borderBottom: '1px solid var(--border)' }}>
    <div>
      <div className="text-sm font-semibold">{title}</div>
      <div className="text-xs text-secondary mt-1">{desc}</div>
    </div>
    <div className="flex-shrink-0">{children}</div>
  </div>
);

/** Two tabs, not four: Appearance was a straight duplicate of the navbar's
 *  theme toggle (removed — one place to change theme, not two), and
 *  Security was a single read-only row that now lives inside Account since
 *  both are "info synced from the MIS", not separate concerns worth their
 *  own tab. */
export const Settings: React.FC = () => {
  const { user } = useAuth();
  const toast = useToast();
  const [tab, setTab] = useState<Tab>('account');

  // Notification preferences — loaded from and persisted to the server.
  const [notif, setNotif] = useState<NotifPrefs>(DEFAULT_PREFS);
  const [savedNotif, setSavedNotif] = useState<NotifPrefs>(DEFAULT_PREFS);
  const [saving, setSaving] = useState(false);
  const notifDirty = JSON.stringify(notif) !== JSON.stringify(savedNotif);

  useEffect(() => {
    (async () => {
      try {
        const res = await apiGet<{ preferences: Partial<NotifPrefs> }>('/api/settings');
        const p = { ...DEFAULT_PREFS, ...res.data?.preferences };
        setNotif(p);
        setSavedNotif(p);
      } catch (err) { console.error('Error loading settings:', err); }
    })();
  }, []);

  const saveNotif = async () => {
    setSaving(true);
    try {
      await apiPut('/api/settings', { preferences: notif });
      setSavedNotif(notif);
      toast.success('Preferences saved');
    } catch (err) {
      toast.error('Could not save', err instanceof ApiError ? err.message : 'Network error. Could not reach the server.');
    } finally { setSaving(false); }
  };

  return (
    <DashboardLayout>
      <div className="page-header">
        <div>
          <h1 className="page-title">Settings</h1>
          <p className="page-subtitle">Manage your preferences and account details.</p>
        </div>
      </div>

      <div className="grid grid-sidebar" style={{ ['--sidebar-col-width' as string]: '220px', gap: '24px', alignItems: 'start' }}>
        <nav className="vtabs">
          {TABS.map((t) => (
            <button key={t.key} className={`vtab${tab === t.key ? ' is-active' : ''}`} onClick={() => setTab(t.key)}>
              {t.icon}{t.label}
            </button>
          ))}
        </nav>

        <div className="card card-pad">
          {tab === 'account' && (
            <>
              <span className="section-title">Account</span>
              <p className="text-sm text-secondary mt-1 mb-3">Synced from Discipline. Contact your administrator to make changes.</p>
              <Row title="Full name" desc={user?.name || '—'}><span /></Row>
              <Row title="Account ID" desc=""><span className="mono text-sm">{user?.id}</span></Row>
              <Row title="Email" desc=""><span className="text-sm">{user?.email || '—'}</span></Row>
              <Row title="Role" desc=""><span className="badge badge-primary">{user?.role}</span></Row>
              <Row title="Single sign-on" desc="Your session is secured via Discipline OAuth2">
                <span className="badge badge-success">Active</span>
              </Row>
              <Row title="Password" desc="Managed by Discipline">
                <a href="https://mis.amashuri.com/login" target="_blank" rel="noopener noreferrer" className="btn btn-outline btn-sm">Manage in MIS</a>
              </Row>
            </>
          )}

          {tab === 'notifications' && (
            <>
              <span className="section-title">Notifications</span>
              <p className="text-sm text-secondary mt-1 mb-3">Choose what updates you receive.</p>
              <Row title="Email notifications" desc="Receive portal updates by email">
                <Toggle checked={notif.emailNotifications} onChange={(v) => setNotif((n) => ({ ...n, emailNotifications: v }))} />
              </Row>
              <Row title="Absence alerts" desc="Notify me when an absence is recorded">
                <Toggle checked={notif.absenceAlerts} onChange={(v) => setNotif((n) => ({ ...n, absenceAlerts: v }))} />
              </Row>
              <Row title="Weekly summary" desc="A weekly attendance digest">
                <Toggle checked={notif.weeklySummary} onChange={(v) => setNotif((n) => ({ ...n, weeklySummary: v }))} />
              </Row>
              <div className="flex justify-end mt-4">
                <button className="btn btn-primary" disabled={!notifDirty || saving} onClick={saveNotif}>
                  {saving ? 'Saving…' : 'Save changes'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </DashboardLayout>
  );
};
