import React, { useEffect, useState } from 'react';
import { useToast } from '../../context/ToastContext';
import { Link } from 'react-router-dom';
import { AlertTriangle, ArrowRight, CalendarClock, CheckCircle2, Clock, ExternalLink, KeyRound, LogIn, LogOut, MapPin, Power, UserX, Copy } from 'lucide-react';
import '../../styles/staffClock.css';
import { apiGet } from '../../api/client';
import { staffClockApi, type Overview } from '../../api/staffClock';
import { usePermissions } from '../../hooks/usePermissions';
import { useAuth } from '../../context/AuthContext';
import { Ring } from './StaffClockAttention';

/**
 * Tendo Home: staff attendance at a glance.
 *  - admins: setup still missing (one chip each, straight to the fix) + today's
 *    summary (ring, not in, no check-out, missed check-outs) -> the dashboard lists;
 *  - staff: their own day (not checked in / in at 07:40 / missed a check-out).
 */

interface MyLog { date: string; clock_in: string | null; clock_out: string | null }

const hhmm = (v: string | null) => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? (/^\d{2}:\d{2}/.test(v) ? v.slice(0, 5) : null) : d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
};
const localDate = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const dayName = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

const AdminCard: React.FC<{ canSetup: boolean }> = ({ canSetup }) => {
  const [o, setO] = useState<Overview | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    staffClockApi.overview().then((v) => alive && setO(v)).catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [canSetup]);
  if (failed) return null;
  if (!o) return <div className="sc-skel" style={{ height: 132, borderRadius: 24, marginBottom: 16 }} />;

  const h = o.health;
  const setup: Array<{ key: string; icon: React.ReactNode; label: string; step: string }> = [];
  if (canSetup && h) {
    if (!h.google) setup.push({ key: 'google', icon: <KeyRound size={15} />, label: 'Google sign-in', step: 'google' });
    if (!h.zones) setup.push({ key: 'zone', icon: <MapPin size={15} />, label: 'School zone', step: 'zone' });
    if (!h.enabled) setup.push({ key: 'open', icon: <Power size={15} />, label: 'Turn check-in on', step: 'open' });
    if (h.zones && !h.tested) setup.push({ key: 'tested', icon: <CheckCircle2 size={15} />, label: 'Test the zone', step: 'test' });
  }
  const k = o.kpis;
  const noOut = o.missing?.noCheckoutToday.length ?? 0;
  const missed = o.missing?.recentNoCheckout.length ?? 0;

  return (
    <section className="sc-home" aria-label="Staff attendance today" data-testid="clock-home-admin">
      {setup.length > 0 && (
        <div className="sc-home-setup" role="alert">
          <span className="sc-attn-ico sc-attn-amber"><AlertTriangle size={18} /></span>
          <div className="sc-home-setup-main">
            <b>Staff check-in is not ready</b>
            <div className="sc-home-chips">
              {setup.map((s) => (
                <Link key={s.key} to={`/staff/clock/setup?step=${s.step}`} className="sc-home-chip">{s.icon}{s.label}</Link>
              ))}
            </div>
          </div>
          <Link to="/staff/clock/setup" className="sc-btn sc-btn-primary sc-btn-sm">Finish setup <ArrowRight size={15} /></Link>
        </div>
      )}
      <Link to="/staff/clock" className="sc-home-today">
        <Ring value={k.checkedIn} total={k.staff} size={72} />
        <div className="sc-home-title">
          <b>Staff today</b>
          <small>{k.checkedIn} of {k.staff} in{k.late ? ` · ${k.late} late` : ''}</small>
        </div>
        <div className="sc-home-stats">
          <span className={k.notIn ? 'warn' : ''}><UserX size={16} /><b>{k.notIn}</b>not in</span>
          <span className={noOut ? 'warn' : ''}><LogOut size={16} /><b>{o.missing?.checkoutOpen === false ? '–' : noOut}</b>no check-out</span>
          <span className={missed ? 'warn' : ''}><CalendarClock size={16} /><b>{missed}</b>missed · 7 days</span>
        </div>
        <ArrowRight size={18} className="sc-attn-go" />
      </Link>
    </section>
  );
};

const StaffCard: React.FC = () => {
  const { user } = useAuth();
  const toast = useToast();
  const [logs, setLogs] = useState<MyLog[] | null>(null);
  const [days, setDays] = useState<{ today: string; weekAgo: string } | null>(null);
  useEffect(() => {
    let alive = true;
    apiGet<MyLog[]>('/api/staff/attendance/me')
      .then((r) => {
        if (!alive) return;
        const now = Date.now();
        setDays({ today: localDate(new Date(now)), weekAgo: localDate(new Date(now - 7 * 86_400_000)) });
        setLogs(Array.isArray(r?.data) ? r.data : []);
      })
      .catch(() => alive && setLogs([]));
    return () => {
      alive = false;
    };
  }, []);
  if (!logs || !days) return logs ? null : <div className="sc-skel" style={{ height: 76, borderRadius: 24, marginBottom: 16 }} />;
  const { today, weekAgo } = days;
  const mine = logs;
  const t = mine.find((l) => l.date === today);
  const missed = mine.filter((l) => l.date < today && l.date >= weekAgo && l.clock_in && !l.clock_out);
  const link = user?.tenantSlug ? `/c/${user.tenantSlug}` : null;
  const copyLink = async () => {
    const url = `${window.location.origin}${link}`;
    try {
      await navigator.clipboard.writeText(url);
      toast.success('Check-in link copied', 'Open it on your phone, or paste it in a browser.');
    } catch {
      toast.error('Could not copy', url);
    }
  };

  const state = !t?.clock_in
    ? { tone: 'amber', icon: <LogIn size={20} />, title: 'Not checked in today', sub: 'Check in on your phone when you arrive' }
    : !t.clock_out
      ? { tone: 'blue', icon: <Clock size={20} />, title: `In at ${hhmm(t.clock_in)}`, sub: 'Remember to check out before you leave' }
      : { tone: 'green', icon: <CheckCircle2 size={20} />, title: `Done: ${hhmm(t.clock_in)} – ${hhmm(t.clock_out)}`, sub: 'See you tomorrow' };

  return (
    <section className="sc-home" aria-label="My check-in" data-testid="clock-home-staff">
      <div className="sc-home-me">
        <span className={`sc-home-me-ico ${state.tone}`}>{state.icon}</span>
        <div className="sc-home-title">
          <b>{state.title}</b>
          <small>{state.sub}</small>
        </div>
        {link && (
          <div className="sc-home-actions">
            {/* Where the link cannot open (the desktop app), copy it and open it on the phone. */}
            <button type="button" className="sc-btn sc-btn-sm" onClick={() => void copyLink()} title="Copy the check-in link to open it on your phone or in a browser" data-testid="clock-copy-link">
              <Copy size={14} /> Copy link
            </button>
            {!t?.clock_out && (
              <a className="sc-btn sc-btn-primary sc-btn-sm" href={link} target="_blank" rel="noopener noreferrer">
                {t?.clock_in ? 'Check out' : 'Check in'} <ExternalLink size={14} />
              </a>
            )}
          </div>
        )}
      </div>
      {missed.length > 0 && (
        <div className="sc-home-missed" role="status">
          <AlertTriangle size={16} />
          <span>Missed check-out: {missed.map((m) => dayName(m.date)).join(', ')}</span>
          <Link to="/staff/attendance">History</Link>
        </div>
      )}
    </section>
  );
};

export const ClockHomeCard: React.FC = () => {
  const { can } = usePermissions();
  if (can('STAFF_ATTENDANCE_VIEW_ALL')) return <AdminCard canSetup={can('STAFF_ATTENDANCE_ZONES_MANAGE')} />;
  if (can('STAFF_ATTENDANCE_CLOCK')) return <StaffCard />;
  return null;
};
