import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import QRCode from 'qrcode';
import {
  AlertTriangle, ArrowLeft, ArrowRight, Check, Clock, Copy, Crosshair, KeyRound, MapPin, Power, Printer, QrCode, Share2, Smartphone, Users,
} from 'lucide-react';
import { DashboardLayout } from '../../components/Layout/DashboardLayout';
import { useToast } from '../../context/ToastContext';
import { usePermissions } from '../../hooks/usePermissions';
import { ApiError } from '../../api/client';
import { staffClockApi, initialsOf, type ClockConfig, type ClockRules, type Overview } from '../../api/staffClock';
import { distanceM, sampleLocation, GeoError } from '../../clock/geo';
import { StaffClockHeader, Spinner } from './StaffClockHeader';
import { StaffClockZone } from './StaffClockZone';
import { announceClockChange } from './clockEvents';

/**
 * The setup guide (/staff/clock/setup?step=...): one screen per step, the work done in
 * place -- map, times, an on-site test, the switch, the link to share, who registered.
 * A rail shows every step's state (a progress strip on phones); Back / Next stay at the
 * bottom of the screen.
 */

type StepKey = 'google' | 'zone' | 'times' | 'test' | 'open' | 'share' | 'phones';
const ORDER: StepKey[] = ['google', 'zone', 'times', 'test', 'open', 'share', 'phones'];
const META: Record<StepKey, { title: string; short: string; icon: React.ReactNode }> = {
  google: { title: 'Google sign-in', short: 'Google', icon: <KeyRound size={16} /> },
  zone: { title: 'Draw the school zone', short: 'Zone', icon: <MapPin size={16} /> },
  times: { title: 'Check the times', short: 'Times', icon: <Clock size={16} /> },
  test: { title: 'Test it on site', short: 'Test', icon: <Crosshair size={16} /> },
  open: { title: 'Turn the clock on', short: 'Turn on', icon: <Power size={16} /> },
  share: { title: 'Share the link', short: 'Share', icon: <Share2 size={16} /> },
  phones: { title: 'Staff register', short: 'Staff', icon: <Users size={16} /> },
};

type TimeKey = 'opens' | 'lateAfter' | 'earlyLeaveBefore' | 'minShiftMinutes' | 'maxAccuracy';
const TIME_FIELDS: Array<[TimeKey, string, string, 'time' | 'number', string?]> = [
  ['opens', 'Check-in opens', 'The earliest anyone can check in.', 'time'],
  ['lateAfter', 'Late after', 'Checking in after this counts as late.', 'time'],
  ['earlyLeaveBefore', 'Early leave before', 'Checking out before this counts as leaving early.', 'time'],
  ['minShiftMinutes', 'Check-out opens after', 'Minutes after check-in. Stops a double tap checking someone out.', 'number', 'min'],
  ['maxAccuracy', 'Location precision', 'Phones less precise than this are asked to try again.', 'number', 'm'],
];

export const StaffClockGuide: React.FC = () => {
  const toast = useToast();
  const navigate = useNavigate();
  const { can } = usePermissions();
  const canEdit = can('STAFF_ATTENDANCE_ZONES_MANAGE');
  const [params, setParams] = useSearchParams();
  const [cfg, setCfg] = useState<ClockConfig | null>(null);
  const [ov, setOv] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [times, setTimes] = useState<Pick<ClockRules, TimeKey> | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);
  const [qr, setQr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const c = await staffClockApi.config();
      setCfg(c);
      setTimes({ opens: c.rules.opens, lateAfter: c.rules.lateAfter, earlyLeaveBefore: c.rules.earlyLeaveBefore, minShiftMinutes: c.rules.minShiftMinutes, maxAccuracy: c.rules.maxAccuracy });
      setError(null);
      if (can('STAFF_ATTENDANCE_VIEW_ALL')) setOv(await staffClockApi.overview().catch(() => null));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not load the setup.');
    }
  }, [can]);
  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);

  const done = useMemo(() => {
    const d = new Set(cfg?.rules.setupDone ?? []);
    const zones = cfg?.zones.filter((z) => z.active).length ?? 0;
    return {
      google: !!cfg?.googleConfigured,
      zone: zones > 0,
      times: d.has('rules'),
      test: d.has('tested'),
      open: !!cfg?.rules.enabled,
      share: d.has('shared'),
      phones: !!ov && ov.phones.staff > 0 && ov.phones.registered >= ov.phones.staff,
    } as Record<StepKey, boolean>;
  }, [cfg, ov]);

  const firstOpen = ORDER.find((k) => !done[k]) ?? 'phones';
  const step: StepKey = (ORDER as string[]).includes(params.get('step') ?? '') ? (params.get('step') as StepKey) : firstOpen;
  const index = ORDER.indexOf(step);
  const go = (k: StepKey) => {
    setParams({ step: k }, { replace: false });
    setTest(null);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  // Keep the current step's chip in view on the phone strip.
  useEffect(() => {
    document.querySelector('.sc-guide-chip.current')?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
  }, [step]);

  // The live "who has registered" list refreshes itself on the last step.
  useEffect(() => {
    if (step !== 'phones') return;
    const id = window.setInterval(() => void staffClockApi.overview().then(setOv).catch(() => undefined), 20_000);
    return () => window.clearInterval(id);
  }, [step]);

  useEffect(() => {
    if (!cfg) return;
    let alive = true;
    QRCode.toDataURL(cfg.link.url, { margin: 1, width: 480, errorCorrectionLevel: 'M' }).then((u) => alive && setQr(u)).catch(() => undefined);
    return () => { alive = false; };
  }, [cfg]);

  const mark = async (k: 'rules' | 'tested' | 'shared') => {
    await staffClockApi.saveRules({ setupDone: [k] }).catch(() => undefined);
    announceClockChange();
    await load();
  };

  const saveTimes = async () => {
    if (!times) return;
    setBusy('times');
    try {
      await staffClockApi.saveRules({ ...times, setupDone: ['rules'] });
      toast.success('Times saved');
      announceClockChange();
      await load();
      go('test');
    } catch (e) {
      toast.error('Not saved', e instanceof ApiError ? e.message : 'Try again.');
    } finally {
      setBusy(null);
    }
  };

  const runTest = async () => {
    if (!cfg) return;
    setBusy('test');
    setTest(null);
    try {
      const { best } = await sampleLocation({ maxMs: 8000 });
      const zones = cfg.zones.filter((z) => z.active && z.center_lat != null);
      let bestZone: { name: string; gap: number } | null = null;
      for (const z of zones) {
        const d = distanceM(best, { lat: z.center_lat!, lng: z.center_lng! });
        const gap = d - ((z.radius_m ?? 0) + Math.min(best.accuracy, cfg.rules.allowance ?? 50));
        if (!bestZone || gap < bestZone.gap) bestZone = { name: z.name, gap };
      }
      if (best.accuracy > cfg.rules.maxAccuracy) setTest({ ok: false, text: `This device’s location is not precise enough (± ${Math.round(best.accuracy)} m). Step outside or turn on GPS and test again.` });
      else if (!bestZone) setTest({ ok: false, text: 'Draw a zone first.' });
      else if (bestZone.gap <= 0) {
        setTest({ ok: true, text: `You are inside ${bestZone.name} (precision ± ${Math.round(best.accuracy)} m). Staff standing here can check in.` });
        await mark('tested');
      } else setTest({ ok: false, text: `You are ${Math.round(bestZone.gap)} m outside ${bestZone.name}. Make the circle bigger or move it, then test again.` });
    } catch (e) {
      setTest({ ok: false, text: e instanceof GeoError && e.kind === 'denied' ? 'Location is blocked for this site. Allow it in the browser and test again.' : 'Location not found. Try near a window or outside.' });
    } finally {
      setBusy(null);
    }
  };

  const setOpen = async (on: boolean) => {
    setBusy('open');
    try {
      await staffClockApi.saveRules({ enabled: on });
      toast.success(on ? 'Staff check-in is on' : 'Staff check-in is off', on ? 'Next: share the link with staff.' : undefined);
      announceClockChange();
      await load();
      if (on) go('share');
    } catch (e) {
      toast.error('Not changed', e instanceof ApiError ? e.message : 'Try again.');
    } finally {
      setBusy(null);
    }
  };

  const shareText = cfg ? `Staff attendance at ${cfg.school.name}: open ${cfg.link.url} on your phone, Continue with Google once, then tap Check in when you arrive and Check out before you leave.` : '';
  const copy = async () => {
    if (!cfg) return;
    try {
      await navigator.clipboard.writeText(shareText);
      toast.success('Message copied', 'Paste it in your staff WhatsApp group, Tupo or e-mail.');
    } catch {
      toast.info('Copy this link', cfg.link.url);
    }
    void mark('shared');
  };
  const nativeShare = async () => {
    if (!cfg || !navigator.share) return copy();
    try {
      await navigator.share({ title: 'Staff attendance', text: shareText, url: cfg.link.url });
      void mark('shared');
    } catch {
      /* cancelled */
    }
  };

  const canNext = step === 'zone' ? done.zone : step === 'open' ? done.open || !canEdit : true;
  const next = ORDER[index + 1];
  const prev = ORDER[index - 1];
  const doneCount = ORDER.filter((k) => done[k]).length;

  if (!canEdit && !can('STAFF_ATTENDANCE_VIEW_ALL')) {
    return <DashboardLayout><div className="sc-page"><div className="sc-notice"><b>Only school admins set up staff check-in.</b><p>Ask your school admin.</p></div></div></DashboardLayout>;
  }

  return (
    <DashboardLayout>
      <div className="sc-page sc-guide-page">
        <StaffClockHeader title="Set up staff check-in" lead={`${doneCount} of ${ORDER.length} steps done. Each step takes a minute; you can come back any time.`} />
        {error && <div className="sc-notice"><b>{error}</b></div>}

        {/* phones: a compact strip */}
        <div className="sc-guide-strip" role="tablist" aria-label="Setup steps">
          {ORDER.map((k, i) => (
            <button key={k} role="tab" aria-selected={k === step} className={`sc-guide-chip${done[k] ? ' done' : ''}${k === step ? ' current' : ''}`} onClick={() => go(k)}>
              <span>{done[k] ? <Check size={13} /> : i + 1}</span>{META[k].short}
            </button>
          ))}
        </div>

        <div className="sc-guide">
          <nav className="sc-guide-rail" aria-label="Setup steps">
            <div className="sc-guide-rail-head"><b>{doneCount}/{ORDER.length}</b><span className="sc-setup-bar" aria-hidden="true"><span style={{ width: `${(doneCount / ORDER.length) * 100}%` }} /></span></div>
            {ORDER.map((k, i) => (
              <button key={k} className={`sc-guide-step${done[k] ? ' done' : ''}${k === step ? ' current' : ''}`} onClick={() => go(k)} aria-current={k === step ? 'step' : undefined}>
                <span className="sc-step-dot">{done[k] ? <Check size={15} /> : i + 1}</span>
                <span className="sc-guide-step-text"><b>{META[k].title}</b><small>{done[k] ? 'Done' : k === firstOpen ? 'Next' : 'To do'}</small></span>
              </button>
            ))}
          </nav>

          <section className="sc-guide-main" aria-live="polite">
            {!cfg ? (
              <div className="sc-skel" style={{ height: 420, borderRadius: 24 }} />
            ) : (
              <>
                <div className="sc-guide-title">
                  <span className="sc-guide-icon">{META[step].icon}</span>
                  <div>
                    <small>Step {index + 1} of {ORDER.length}</small>
                    <h2>{META[step].title}</h2>
                  </div>
                  {done[step] && <span className="sc-pill sc-tone-green" style={{ marginLeft: 'auto' }}><Check size={14} /> Done</span>}
                </div>

                {step === 'google' && (
                  <div className="sc-guide-body">
                    <p>Staff prove who they are with their Google account, once, when they register their phone. Nobody types a password on the clock.</p>
                    {cfg.googleConfigured ? (
                      <div className="sc-ok"><Check size={18} />Google sign-in is set up for Tendo.</div>
                    ) : (
                      <div className="sc-bad"><AlertTriangle size={18} />Google sign-in is not set up on this server yet. Ask Amashuri support.</div>
                    )}
                    <div className="sc-info"><Smartphone size={18} />Staff whose Amashuri e-mail is not a Google account can link one from their Amashuri profile (“Staff attendance” card).</div>
                  </div>
                )}

                {step === 'zone' && (
                  <div className="sc-guide-body">
                    <p>Check-in only works inside this area. <b>Stand at school</b>, press <b>Use my location</b>, or search the school and pick it. Drag the pin or the white handle to fit the grounds, then <b>Save zone</b>.</p>
                    <StaffClockZone embedded={{ onSaved: () => void load() }} />
                  </div>
                )}

                {step === 'times' && times && (
                  <div className="sc-guide-body">
                    <p>These use the school’s clock ({cfg.school.timezone}), never the time on a phone.</p>
                    <div className="sc-guide-fields">
                      {TIME_FIELDS.map(([k, label, hint, type, unit]) => (
                        <label key={k} className="sc-guide-field">
                          <span><b>{label}</b><small>{hint}</small></span>
                          <span className="sc-guide-input">
                            <input className="sc-input sc-input-time" type={type} disabled={!canEdit} min={type === 'number' ? 0 : undefined}
                              value={String(times[k])} onChange={(e) => setTimes({ ...times, [k]: type === 'number' ? Number(e.target.value) : e.target.value })} />
                            {unit && <small>{unit}</small>}
                          </span>
                        </label>
                      ))}
                    </div>
                    {canEdit && <button className="sc-btn sc-btn-primary" onClick={() => void saveTimes()} disabled={busy === 'times'}>{busy === 'times' && <Spinner />}Save times and continue</button>}
                  </div>
                )}

                {step === 'test' && (
                  <div className="sc-guide-body">
                    <p>Go where staff arrive (the gate, the staffroom) with this phone or laptop, then test. It uses the same rule as a check-in.</p>
                    <button className="sc-btn sc-btn-primary sc-guide-big" onClick={() => void runTest()} disabled={busy === 'test' || !done.zone}>
                      {busy === 'test' ? <Spinner /> : <Crosshair size={20} />}Test from where I stand
                    </button>
                    {!done.zone && <div className="sc-bad"><AlertTriangle size={18} />Draw the zone first.</div>}
                    {test && <div className={test.ok ? 'sc-ok' : 'sc-bad'} role="status">{test.ok ? <Check size={18} /> : <AlertTriangle size={18} />}<span style={{ overflowWrap: 'anywhere' }}>{test.text}</span></div>}
                    {test && !test.ok && <button className="sc-btn sc-btn-sm" onClick={() => go('zone')} style={{ alignSelf: 'flex-start' }}>Adjust the zone</button>}
                  </div>
                )}

                {step === 'open' && (
                  <div className="sc-guide-body">
                    <p>When it is on, staff can register and check in from the link. The old check-in button on the Tendo Staff Attendance page stops working, so everyone uses their phone (or a QR card).</p>
                    <div className="sc-guide-summary">
                      <div><small>Zones</small><b>{cfg.zones.filter((z) => z.active).map((z) => `${z.name} (${z.radius_m} m)`).join(', ') || 'None yet'}</b></div>
                      <div><small>Late after</small><b>{cfg.rules.lateAfter}</b></div>
                      <div><small>Early leave before</small><b>{cfg.rules.earlyLeaveBefore}</b></div>
                    </div>
                    <div className={`sc-guide-switch${cfg.rules.enabled ? ' on' : ''}`}>
                      <span><b>{cfg.rules.enabled ? 'Staff check-in is on' : 'Staff check-in is off'}</b><small>{cfg.rules.enabled ? 'Staff can use the link now.' : done.zone ? 'Ready to turn on.' : 'Draw a zone first.'}</small></span>
                      {canEdit && (
                        <button className="sc-switch sc-switch-lg" role="switch" aria-checked={cfg.rules.enabled} aria-label="Staff check-in" disabled={busy === 'open' || (!cfg.rules.enabled && !done.zone)} onClick={() => void setOpen(!cfg.rules.enabled)}><span /></button>
                      )}
                    </div>
                  </div>
                )}

                {step === 'share' && (
                  <div className="sc-guide-body sc-guide-share">
                    <div className="sc-guide-qr">{qr ? <img src={qr} alt={`QR code for ${cfg.link.url}`} /> : <div className="sc-skel" style={{ width: 220, height: 220 }} />}</div>
                    <div className="sc-guide-share-text">
                      <p>Staff scan this code or open the link on <b>their own phone</b>. Send it to the staff group and put the poster up where staff arrive.</p>
                      <a className="sc-guide-link" href={cfg.link.url} target="_blank" rel="noopener noreferrer">{cfg.link.display}</a>
                      {!cfg.rules.enabled && <div className="sc-bad"><AlertTriangle size={18} />The clock is off: staff will see “not open yet”. <button className="sc-btn sc-btn-sm" onClick={() => go('open')}>Turn it on</button></div>}
                      <div className="sc-step-actions">
                        <button className="sc-btn sc-btn-primary" onClick={() => void copy()}><Copy size={16} /> Copy message</button>
                        {'share' in navigator && <button className="sc-btn" onClick={() => void nativeShare()}><Share2 size={16} /> Share</button>}
                        <a className="sc-btn" href={`https://wa.me/?text=${encodeURIComponent(shareText)}`} target="_blank" rel="noopener noreferrer" onClick={() => void mark('shared')}>WhatsApp</a>
                        <Link className="sc-btn" to="/staff/clock/poster" onClick={() => void mark('shared')}><Printer size={16} /> Poster</Link>
                      </div>
                    </div>
                  </div>
                )}

                {step === 'phones' && (
                  <div className="sc-guide-body">
                    {!ov ? <div className="sc-skel" style={{ height: 160 }} /> : (
                      <>
                        <div className="sc-guide-progress">
                          <b>{ov.phones.registered}</b><span>of {ov.phones.staff} staff have registered a phone</span>
                          <span className="sc-bar" style={{ flex: '1 1 100%' }}><span style={{ display: 'block', height: '100%', borderRadius: 999, background: 'var(--primary)', width: `${ov.phones.staff ? (ov.phones.registered / ov.phones.staff) * 100 : 0}%` }} /></span>
                          <small>Updates by itself every 20 seconds.</small>
                        </div>
                        {ov.phones.pending.length > 0 && (
                          <div className="sc-notice">
                            <b>{ov.phones.pending.length} new phone{ov.phones.pending.length > 1 ? 's' : ''} waiting for your approval</b>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
                              {ov.phones.pending.map((d) => (
                                <div key={d.id} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                                  <span className="sc-clip" style={{ flex: 1, minWidth: 0 }}>{d.user_name} · {d.label}</span>
                                  <button className="sc-btn sc-btn-primary sc-btn-sm" disabled={busy === `d${d.id}`} onClick={async () => { setBusy(`d${d.id}`); try { await staffClockApi.deviceAction(d.id, 'approve'); toast.success(`${d.user_name} can check in now`); await load(); } catch (e) { toast.error('Not approved', e instanceof ApiError ? e.message : ''); } finally { setBusy(null); } }}>Approve</button>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                        <div>
                          <div className="sc-guide-list-head"><b>Not registered yet ({ov.phones.unregistered.length})</b>
                            {can('STAFF_DEVICES_MANAGE') && ov.phones.unregistered.length > 0 && <Link className="sc-btn sc-btn-sm" to="/staff/clock/devices"><QrCode size={15} /> QR cards for staff without a phone</Link>}
                          </div>
                          {ov.phones.unregistered.length === 0 ? <div className="sc-ok"><Check size={18} />Everyone has registered.</div> : (
                            <div className="sc-guide-people">
                              {ov.phones.unregistered.slice(0, 60).map((p) => (
                                <span key={p.id} className="sc-guide-person" title={p.name}><span className="sc-avatar" style={{ width: 28, height: 28, fontSize: 11 }}>{initialsOf(p.name)}</span><span className="sc-clip">{p.name}</span></span>
                              ))}
                            </div>
                          )}
                        </div>
                      </>
                    )}
                  </div>
                )}
              </>
            )}
          </section>
        </div>

        <div className="sc-savebar sc-guide-nav" role="navigation" aria-label="Setup navigation">
          <button className="sc-btn" disabled={!prev} onClick={() => prev && go(prev)}><ArrowLeft size={16} /> Back</button>
          <span className="sc-savebar-text"><i aria-hidden="true" style={{ background: done[step] ? 'var(--status-present)' : 'var(--status-late)' }} />Step {index + 1} of {ORDER.length}</span>
          {next ? (
            <button className="sc-btn sc-btn-primary" disabled={!canNext} title={!canNext ? (step === 'zone' ? 'Save a zone first' : 'Turn the clock on first') : undefined} onClick={() => go(next)}>Next <ArrowRight size={16} /></button>
          ) : (
            <button className="sc-btn sc-btn-primary" onClick={() => navigate('/staff/clock')}>Finish <Check size={16} /></button>
          )}
        </div>
      </div>
    </DashboardLayout>
  );
};
