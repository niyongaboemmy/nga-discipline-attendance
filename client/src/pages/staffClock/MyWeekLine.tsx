import React, { useEffect, useRef, useState } from 'react';
import { LogOut, Monitor, Smartphone } from 'lucide-react';
import { ApiError } from '../../api/client';
import { staffClockApi, type MyWeek, type MyWeekDay } from '../../api/staffClock';
import { useToast } from '../../context/ToastContext';

/**
 * The signed-in person's week in one line (their Tendo home card): one capsule per
 * day with the hours they are expected, filled by how much of the day they were at
 * school, then the week's numbers. A capsule shows its day on hover, focus or tap.
 */

const KIND: Record<MyWeekDay['kind'], string> = {
  on_time: 'On time', late: 'Late', absent: 'Absent', today: 'Today', planned: 'Working day', off: 'Day off', closed: 'School closed', untracked: 'Before check-in started',
};
const mins = (t: string | null) => (t ? Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5)) : null);
const dur = (m: number) => `${Math.floor(m / 60)}h${m % 60 ? ` ${String(m % 60).padStart(2, '0')}` : ''}`;
const fmt = (date: string, opts: Intl.DateTimeFormatOptions) => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-GB', { ...opts, timeZone: 'UTC' });

/** Minutes at school on a day (up to now on a day still open), and the share of the expected day. */
function worked(d: MyWeekDay, w: MyWeek): { minutes: number | null; share: number } {
  const a = mins(d.in);
  if (a == null) return { minutes: null, share: 0 };
  const b = mins(d.out) ?? (d.date === w.today ? w.nowMinutes : null);
  if (b == null || b < a) return { minutes: null, share: 1 };
  const s = mins(d.start);
  const e = mins(d.end);
  const planned = s != null && e != null && e > s ? e - s : null;
  return { minutes: b - a, share: planned ? Math.min(1, (b - a) / planned) : 1 };
}

export const MyWeekLine: React.FC = () => {
  const [w, setW] = useState<MyWeek | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [pinned, setPinned] = useState(false);
  const [confirmOut, setConfirmOut] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const toast = useToast();
  const root = useRef<HTMLDivElement>(null);
  const signOut = async () => {
    setSigningOut(true);
    try {
      await staffClockApi.signOutMyDevice();
      toast.success('Device signed out', 'Sign in with Google again on the check-in page when you next check in.');
      setConfirmOut(false);
      setW((cur) => (cur ? { ...cur, device: null } : cur));
    } catch (e) {
      toast.error('Not signed out', e instanceof ApiError ? e.message : 'Check the connection and try again.');
    } finally {
      setSigningOut(false);
    }
  };

  useEffect(() => {
    let alive = true;
    staffClockApi.myWeek().then((v) => alive && setW(v)).catch(() => alive && setFailed(true));
    return () => { alive = false; };
  }, []);
  useEffect(() => {
    if (!pinned) return;
    const away = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) { setPinned(false); setOpen(null); } };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { setPinned(false); setOpen(null); } };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [pinned]);

  if (failed) return null;
  if (!w) return <div className="wl" aria-busy="true" aria-label="Loading your week"><div className="wl-days">{[0, 1, 2, 3, 4, 5, 6].map((i) => <span key={i} className="sc-skel wl-skel" />)}</div><span className="sc-skel wl-skel-sum" /></div>;

  const s = w.summary;
  const workedMinutes = w.days.reduce((n, d) => n + (worked(d, w).minutes ?? 0), 0);
  const sel = open ? w.days.find((d) => d.date === open) ?? null : null;
  const selAt = sel ? w.days.indexOf(sel) : -1;
  const selWork = sel ? worked(sel, w) : null;

  return (
    <>
    <div className="wl" ref={root} data-testid="my-week-line">
      <div className="wl-days" role="group" aria-label={`Your week${w.own ? ' (your own hours)' : ''}`}>
        {w.days.map((d) => {
          const k = worked(d, w);
          const line = d.in ?? d.start ?? (d.kind === 'closed' ? 'Closed' : 'Off');
          return (
            <button key={d.date} type="button" className={`wl-day k-${d.kind}${d.date === w.today ? ' is-today' : ''}${open === d.date ? ' is-open' : ''}`}
              aria-label={`${fmt(d.date, { weekday: 'long', day: 'numeric', month: 'long' })}: ${KIND[d.kind]}${d.start ? `, expected ${d.start} to ${d.end}` : ''}${d.in ? `, in ${d.in}` : ''}${d.out ? `, out ${d.out}` : ''}`}
              aria-expanded={open === d.date}
              onMouseEnter={() => !pinned && setOpen(d.date)} onMouseLeave={() => !pinned && setOpen(null)}
              onFocus={() => !pinned && setOpen(d.date)} onBlur={() => !pinned && setOpen(null)}
              onClick={() => { const same = pinned && open === d.date; setPinned(!same); setOpen(same ? null : d.date); }}>
              <span className="wl-name">{fmt(d.date, { weekday: 'short' })}</span>
              <span className="wl-track"><i style={{ width: `${Math.round(k.share * 100)}%` }} /></span>
              <span className="wl-time">{line}</span>
            </button>
          );
        })}
        {sel && (
          <div className="wl-pop" role="status" style={{ '--wl-at': selAt } as React.CSSProperties} data-testid="week-pop">
            <b>{fmt(sel.date, { weekday: 'long', day: 'numeric', month: 'short' })}</b>
            <span className={`wl-pill k-${sel.kind}`}><i />{KIND[sel.kind]}</span>
            {sel.start && sel.end && <span>Expected {sel.start} – {sel.end}</span>}
            {sel.in && <span>In {sel.in}{sel.out ? ` · out ${sel.out}` : sel.noOut ? ' · no check-out' : ''}</span>}
            {selWork?.minutes != null && <span>{dur(selWork.minutes)} at school{sel.early ? ' · left early' : ''}</span>}
          </div>
        )}
      </div>
      <div className="wl-sum">
        <span className="wl-big"><b className="sc-num">{s.worked}</b><small>of {s.workDays} days this week</small></span>
        <span className="wl-chips">
          <span title="Time at school this week, of the hours planned">{dur(workedMinutes)} <small>of {dur(s.plannedMinutes)}</small></span>
          {s.late > 0 && <span className="late">{s.late} late</span>}
          {s.absent > 0 && <span className="abs">{s.absent} absent</span>}
          {w.month.workDays > 0 && <span title="Days you came this month, of your working days so far">{w.month.worked}/{w.month.workDays} <small>this month</small></span>}
        </span>
      </div>
    </div>
    {w.device && (
      <div className="wl-device" data-testid="my-device">
        <span className="wl-device-ico">{w.device.form_factor === 'desktop' ? <Monitor size={17} /> : <Smartphone size={17} />}</span>
        <span className="wl-device-text"><b className="sc-clip">{w.device.label || 'My check-in device'}</b><small className="sc-clip">{w.device.status === 'active' ? 'Signed in for check-in' : 'Waiting for approval'} · {w.device.google_email}</small></span>
        {confirmOut ? (
          <span className="wl-device-actions">
            <span className="wl-device-ask">Sign this device out?</span>
            <button type="button" className="sc-btn sc-btn-sm" disabled={signingOut} onClick={() => setConfirmOut(false)}>Cancel</button>
            <button type="button" className="sc-btn sc-btn-primary sc-btn-sm" disabled={signingOut} onClick={() => void signOut()} data-testid="my-device-signout-yes">{signingOut ? 'Signing out…' : 'Yes, sign out'}</button>
          </span>
        ) : (
          <button type="button" className="sc-btn sc-btn-sm" onClick={() => setConfirmOut(true)} title="Lost phone or shared computer: sign it out, then sign in again where you check in" data-testid="my-device-signout"><LogOut size={14} /> Sign out device</button>
        )}
      </div>
    )}
    </>
  );
};
