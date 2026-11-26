import React, { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Check, ChevronDown, ChevronUp, Copy, Printer, ArrowRight, AlertTriangle } from 'lucide-react';
import { useToast } from '../../context/ToastContext';
import { usePermissions } from '../../hooks/usePermissions';
import { ApiError } from '../../api/client';
import { staffClockApi, type ClockConfig } from '../../api/staffClock';
import { Spinner } from './StaffClockHeader';
import { CLOCK_CHANGED, announceClockChange } from './clockEvents';

/**
 * "Set up staff check-in": the admin's guided path from nothing to staff checking in.
 * Each step says why it matters and links straight to where it is done; the first
 * open step is expanded. Steps are derived from real data (zones, clock on, phones),
 * except "rules", "tested" and "shared", which the server remembers (STAFF_CLOCK_SETUP).
 */


interface Step {
  key: string;
  title: string;
  why: string;
  done: boolean;
  blocked?: string;
  action?: React.ReactNode;
  progress?: { value: number; total: number };
}

/** Checklist step -> setup guide step. */
const GUIDE_STEP: Record<string, string> = { google: 'google', zone: 'zone', rules: 'times', tested: 'test', open: 'open', shared: 'share', phones: 'phones' };

export const StaffClockSetup: React.FC<{ place: 'dashboard' | 'zone' }> = ({ place }) => {
  const toast = useToast();
  const navigate = useNavigate();
  const { can } = usePermissions();
  const canEdit = can('STAFF_ATTENDANCE_ZONES_MANAGE');
  const canViewAll = can('STAFF_ATTENDANCE_VIEW_ALL');
  const [cfg, setCfg] = useState<ClockConfig | null>(null);
  const [phones, setPhones] = useState<{ registered: number; staff: number } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // Folded by default (one line: progress + next step); it opens on tap and remembers.
  const [open, setOpen] = useState<boolean>(() => place !== 'zone' && localStorage.getItem('tendo.clockSetup.collapsed') === '0');

  const load = useCallback(async () => {
    try {
      const c = await staffClockApi.config();
      setCfg(c);
      if (canViewAll) {
        const o = await staffClockApi.overview().catch(() => null);
        if (o) setPhones({ registered: o.phones.registered, staff: o.phones.staff });
      }
    } catch {
      /* the page shows its own error */
    }
  }, [canViewAll]);

  useEffect(() => {
    void Promise.resolve().then(load);
    const on = () => void load();
    window.addEventListener(CLOCK_CHANGED, on);
    return () => window.removeEventListener(CLOCK_CHANGED, on);
  }, [load]);

  if (!cfg) return <div className="sc-skel" style={{ height: 88, borderRadius: 24 }} />;

  const mark = async (step: 'rules' | 'tested' | 'shared') => {
    try {
      await staffClockApi.saveRules({ setupDone: [step] });
      announceClockChange();
    } catch {
      /* not critical */
    }
  };
  const goZone = (anchor: string) => {
    if (place === 'zone') {
      const el = document.getElementById(anchor);
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el?.classList.add('sc-flash');
      window.setTimeout(() => el?.classList.remove('sc-flash'), 1600);
    } else navigate(`/staff/clock/zone#${anchor}`);
  };
  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(cfg.link.url);
      toast.success('Link copied', 'Send it to staff by WhatsApp, Tupo or e-mail.');
    } catch {
      toast.info('Copy this link', cfg.link.url);
    }
    void mark('shared');
  };
  const turnOn = async () => {
    setBusy('open');
    try {
      await staffClockApi.saveRules({ enabled: true });
      toast.success('Staff clock is on', 'Next: share the link with staff.');
      announceClockChange();
    } catch (e) {
      toast.error('Not turned on', e instanceof ApiError ? e.message : 'Try again.');
    } finally {
      setBusy(null);
    }
  };

  const done = new Set(cfg.rules.setupDone ?? []);
  const zoneCount = cfg.zones.filter((z) => z.active).length;
  const steps: Step[] = [
    {
      key: 'google',
      title: 'Google sign-in is ready',
      why: 'Staff register their phone with their Google account.',
      done: cfg.googleConfigured,
      blocked: cfg.googleConfigured ? undefined : 'Ask Amashuri support to set up Google sign-in for Tendo.',
    },
    {
      key: 'zone',
      title: 'Draw the school zone',
      why: 'Check-in works only inside it. Stand at school, press “Use my location”, adjust the circle, then Save.',
      done: zoneCount > 0,
      action: <button className="sc-btn sc-btn-primary sc-btn-sm" onClick={() => goZone('zone-map')}>Draw the zone <ArrowRight size={15} /></button>,
    },
    {
      key: 'rules',
      title: 'Check the times',
      why: 'When check-in opens, when someone is late and when leaving is early.',
      done: done.has('rules'),
      action: (
        <>
          <button className="sc-btn sc-btn-sm" onClick={() => goZone('zone-rules')}>Review times</button>
          {canEdit && <button className="sc-btn sc-btn-soft sc-btn-sm" onClick={() => { void mark('rules'); toast.success('Times confirmed'); }}>They look right</button>}
        </>
      ),
    },
    {
      key: 'tested',
      title: 'Test it where staff arrive',
      why: 'Stand at the gate or staffroom and make sure you are inside the zone.',
      done: done.has('tested'),
      action: <button className="sc-btn sc-btn-sm" onClick={() => goZone('zone-test')}>Test from where I stand</button>,
    },
    {
      key: 'open',
      title: 'Turn the clock on',
      why: 'Staff can then register and check in. The old desktop clock-in closes.',
      done: cfg.rules.enabled,
      blocked: zoneCount === 0 ? 'Draw the zone first.' : undefined,
      action: canEdit ? <button className="sc-btn sc-btn-primary sc-btn-sm" disabled={busy === 'open'} onClick={() => void turnOn()}>{busy === 'open' && <Spinner />}Turn on</button> : undefined,
    },
    {
      key: 'shared',
      title: 'Share the link with staff',
      why: `Staff open ${cfg.link.display} on their own phone. Print the poster for the staffroom.`,
      done: done.has('shared'),
      action: (
        <>
          <button className="sc-btn sc-btn-primary sc-btn-sm" onClick={() => void copyLink()}><Copy size={14} /> Copy link</button>
          <Link className="sc-btn sc-btn-sm" to="/staff/clock/poster" onClick={() => void mark('shared')}><Printer size={14} /> Poster</Link>
        </>
      ),
    },
    {
      key: 'phones',
      title: 'Staff register their phones',
      why: 'Follow who has registered. Print QR cards for staff without a smartphone.',
      done: !!phones && phones.staff > 0 && phones.registered >= phones.staff,
      progress: phones ? { value: phones.registered, total: phones.staff } : undefined,
      action: <Link className="sc-btn sc-btn-sm" to="/staff/clock/devices">Phones & QR cards <ArrowRight size={15} /></Link>,
    },
  ];
  const doneCount = steps.filter((s) => s.done).length;
  const current = steps.find((s) => !s.done);
  const complete = !current || (current.key === 'phones' && cfg.rules.enabled);
  // Set up: the dashboard's Attention strip takes over from here.
  // On the dashboard the checklist is only for getting started: once check-in is on,
  // what is left (testing, phones) shows in the attention strip and the Setup guide tab.
  if (place === 'dashboard' && (complete || cfg.rules.enabled)) return null;

  return (
    <section className="sc-card sc-setup" aria-label="Set up staff check-in">
      <button className="sc-setup-head" onClick={() => { setOpen(!open); localStorage.setItem('tendo.clockSetup.collapsed', open ? '1' : '0'); }} aria-expanded={open}>
        <span className={`sc-setup-badge${complete ? ' done' : ''}`}>{complete ? <Check size={18} /> : `${doneCount}/${steps.length}`}</span>
        <span style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
          <b>{complete ? 'Staff check-in is set up' : 'Set up staff check-in'}</b>
          <small>{complete ? (phones ? `${phones.registered} of ${phones.staff} staff have registered a phone.` : 'Staff can check in from the link.') : `Next: ${current!.title.toLowerCase()}`}</small>
        </span>
        <span className="sc-setup-bar" aria-hidden="true"><span style={{ width: `${(doneCount / steps.length) * 100}%` }} /></span>
        {open ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
      </button>
      {open && (
        <ol className="sc-steps">
          {steps.map((s, i) => {
            const isCurrent = current?.key === s.key;
            return (
              <li key={s.key} className={`sc-step${s.done ? ' done' : ''}${isCurrent ? ' current' : ''}`}>
                <span className="sc-step-dot">{s.done ? <Check size={15} /> : i + 1}</span>
                <div className="sc-step-body">
                  <b>{s.title}</b>
                  {(isCurrent || !s.done) && <p>{s.why}</p>}
                  {s.progress && (
                    <div className="sc-step-progress">
                      <span className="sc-bar" style={{ marginTop: 0, flex: 1 }}><span style={{ display: 'block', height: '100%', borderRadius: 999, background: 'var(--primary)', width: `${s.progress.total ? (s.progress.value / s.progress.total) * 100 : 0}%` }} /></span>
                      <small>{s.progress.value} of {s.progress.total}</small>
                    </div>
                  )}
                  {s.blocked && !s.done && <p className="sc-step-blocked"><AlertTriangle size={14} />{s.blocked}</p>}
                  {isCurrent && !s.blocked && (
                    <div className="sc-step-actions">
                      <Link className="sc-btn sc-btn-primary sc-btn-sm" to={`/staff/clock/setup?step=${GUIDE_STEP[s.key] ?? 'google'}`}>Do this step <ArrowRight size={15} /></Link>
                      {s.action}
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
};
