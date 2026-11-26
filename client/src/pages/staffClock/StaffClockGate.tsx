import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { BellRing, Check, ChevronLeft, ChevronRight, Clock, CreditCard, ScanLine, ShieldAlert, Volume2, VolumeX, X } from 'lucide-react';
import '../../styles/staffClock.css';
import '../../styles/staffGate.css';
import { ApiError } from '../../api/client';
import { staffClockApi, type Overview } from '../../api/staffClock';
import { usePermissions } from '../../hooks/usePermissions';
import { useToast } from '../../context/ToastContext';
import { UserAvatar } from '../../components/common/UserAvatar';
import { ErrorState } from '../../components/common/ErrorState';
import { StaffHistoryModal } from './StaffHistoryModal';
import { agoText, gateHeadline, gateModel, hhmm, toMin, type GateCheck, type GateKind, type GateMode, type GateWaiting } from './gate';

/**
 * Gate view (/staff/clock/gate): for the leader standing at the gate. One screen,
 * live: how many are in, the countdown to the next start, who is still expected
 * (late first), who just walked in, and the check-ins that wait for a yes.
 * A phone shows one list at a time (dark, large targets); a desktop shows three
 * columns. "Leaving" turns it into the end-of-day picture.
 */

const REFRESH_MS = 20_000;
const SOUND_KEY = 'tendo.gate.sound';
type Tab = 'wait' | 'events' | 'check';
type Sheet = { kind: 'person'; who: GateWaiting } | { kind: 'all' } | null;

/** A short, soft tone for each new arrival (only after the leader turns sound on). */
function chime(ctx: AudioContext | null) {
  if (!ctx) return;
  try {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sine';
    o.frequency.value = 880;
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.12, ctx.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35);
    o.connect(g).connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + 0.4);
  } catch { /* no sound is fine */ }
}

const Ring: React.FC<{ done: number; total: number; label: string }> = ({ done, total, label }) => {
  const r = 56;
  const c = 2 * Math.PI * r;
  const share = total ? Math.min(1, done / total) : 0;
  return (
    <div className="gt-ring">
      <svg role="img" aria-label={`${done} of ${total} ${label}`} viewBox="0 0 128 128">
        <circle cx="64" cy="64" r={r} className="gt-ring-track" />
        {share > 0 && <circle cx="64" cy="64" r={r} className="gt-ring-fill" strokeDasharray={`${share * c} ${c}`} transform="rotate(-90 64 64)" />}
      </svg>
      <div className="gt-ring-text"><b className="sc-num">{done}</b><span>of {total} {label}</span></div>
    </div>
  );
};

export const StaffClockGate: React.FC = () => {
  const { can } = usePermissions();
  const toast = useToast();
  const [ov, setOv] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadedAt, setLoadedAt] = useState(() => Date.now());
  /** this device's clock, read on a timer (never during render) */
  const [now, setNow] = useState(() => Date.now());
  const [mode, setMode] = useState<GateMode>('in');
  const [tab, setTab] = useState<Tab>('wait');
  const [filter, setFilter] = useState<'all' | GateKind>('all');
  const [sent, setSent] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [sheet, setSheet] = useState<Sheet>(null);
  const [person, setPerson] = useState<{ id: string; name: string } | null>(null);
  const [sound, setSound] = useState(() => { try { return localStorage.getItem(SOUND_KEY) === '1'; } catch { return false; } });
  const audio = useRef<AudioContext | null>(null);
  const seen = useRef<Set<string> | null>(null);
  const soundRef = useRef(sound);
  useEffect(() => { soundRef.current = sound; }, [sound]);

  const load = useCallback(async () => {
    try {
      const v = await staffClockApi.overview();
      setOv(v);
      setLoadedAt(Date.now());
      setNow(Date.now());
      setError(null);
      // A new check-in since the last look: the tone, so the leader need not watch the screen.
      const keys = new Set(v.rows.filter((r) => r.checkIn).map((r) => `${r.userId}@${r.checkIn}`));
      if (seen.current && soundRef.current && [...keys].some((k) => !seen.current!.has(k))) chime(audio.current);
      seen.current = keys;
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Check the connection and try again.');
    }
  }, []);

  useEffect(() => {
    const first = window.setTimeout(() => void load(), 0);
    const poll = window.setInterval(() => { if (!document.hidden) void load(); }, REFRESH_MS);
    const clock = window.setInterval(() => setNow(Date.now()), 10_000);
    const onShow = () => { if (!document.hidden) void load(); };
    document.addEventListener('visibilitychange', onShow);
    return () => { window.clearTimeout(first); window.clearInterval(poll); window.clearInterval(clock); document.removeEventListener('visibilitychange', onShow); };
  }, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !document.querySelector('.sh-overlay')) setSheet(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // The school's clock: the server's minute, moved on by the time since it answered.
  const local = new Date(now);
  const nowMin = ov?.now ? (toMin(ov.now.at) ?? 0) + Math.max(0, Math.floor((now - loadedAt) / 60_000)) : local.getHours() * 60 + local.getMinutes();
  const model = useMemo(() => (ov ? gateModel(ov, nowMin, mode) : null), [ov, nowMin, mode]);
  const head = model ? gateHeadline(model) : null;
  const key = (id: string) => `${mode}:${id}`;
  const toRemind = model ? model.remindIds.filter((id) => !sent.has(key(id))) : [];

  const remind = async (ids: string[], label: string) => {
    if (!ids.length || busy) return;
    setBusy(label);
    try {
      const res = await staffClockApi.nudge(mode, ids);
      const d = res.data;
      const rest = d ? [d.noReminders ? `${d.noReminders} without reminders on their phone` : '', d.already ? `${d.already} already reminded today` : '', d.notNeeded ? `${d.notNeeded} no longer need it` : ''].filter(Boolean).join(' · ') : '';
      if (d?.sent) toast.success(d.sent === 1 ? 'Reminder sent' : `Reminders sent to ${d.sent} people`, rest || 'They get a notification on their phone.');
      else toast.info('Nobody could be reminded', rest || 'Ask them to turn reminders on from the check-in page.');
      setSent((cur) => new Set([...cur, ...ids.map(key)]));
      setSheet(null);
      void load();
    } catch (e) {
      toast.error('Reminder not sent', e instanceof ApiError ? e.message : 'Check the connection and try again.');
    } finally {
      setBusy(null);
    }
  };

  const confirmHere = async (c: GateCheck) => {
    if (busy) return;
    setBusy(`check${c.recordId}`);
    try {
      await staffClockApi.review(c.recordId, 'accepted', 'Seen at the gate');
      toast.success(`${c.name} confirmed`, 'The check-in counts.');
      await load();
    } catch (e) {
      toast.error('Not confirmed', e instanceof ApiError ? e.message : 'Check the connection and try again.');
    } finally {
      setBusy(null);
    }
  };

  const toggleSound = () => {
    const on = !sound;
    setSound(on);
    try { localStorage.setItem(SOUND_KEY, on ? '1' : '0'); } catch { /* private mode */ }
    if (on) {
      try {
        audio.current = audio.current ?? new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
        void audio.current.resume();
        chime(audio.current);
      } catch { /* no audio on this device */ }
      toast.info('Sound on', 'A short tone for every new check-in.');
    } else toast.info('Sound off');
  };

  const words = mode === 'in'
    ? { ring: 'here', wait: 'Expected', waitTitle: 'Still expected', events: 'Arrived', eventsTitle: 'Live arrivals', emptyWait: 'Everyone expected today is in.', emptyEvents: 'Nobody has checked in yet.', late: 'Late', soon: 'Due soon', later: 'Later' }
    : { ring: 'left', wait: 'Inside', waitTitle: 'Still inside', events: 'Left', eventsTitle: 'Just left', emptyWait: 'Nobody is inside.', emptyEvents: 'Nobody has checked out yet.', late: 'Day over', soon: 'Ending soon', later: 'Later' };

  const waiting = model ? (filter === 'all' ? model.waiting : model.waiting.filter((w) => w.kind === filter)) : [];
  const clock = hhmm(nowMin);
  const dateLabel = ov ? new Date(`${ov.date}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }) : '';
  const remindLabel = toRemind.length ? `Remind ${toRemind.length === 1 ? '1 person' : `all ${toRemind.length}`}` : model?.remindIds.length ? 'All reminded' : 'Nobody to remind';

  return (
    <div className="gt" data-tab={tab} data-mode={mode} data-testid="gate">
      <header className="gt-top">
        <Link to="/staff/clock" className="gt-back" aria-label="Back to Staff attendance" data-testid="gate-back"><ChevronLeft size={22} /><span>Staff attendance</span></Link>
        <h1 className="gt-title">Gate</h1>
        <div className="gt-seg gt-mode" role="group" aria-label="Arriving or leaving">
          <button type="button" aria-pressed={mode === 'in'} onClick={() => { setMode('in'); setFilter('all'); }}>Arriving</button>
          <button type="button" aria-pressed={mode === 'out'} onClick={() => { setMode('out'); setFilter('all'); }} data-testid="gate-leaving">Leaving</button>
        </div>
        <span className="gt-grow" />
        <span className="gt-date">{dateLabel}</span>
        <span className="gt-live" aria-label={`Live, ${clock}`}><i /><em>Live · </em><b className="sc-num">{clock}</b></span>
        {can('STAFF_CLOCK_SCAN') && <Link to="/staff/clock/scan" className="gt-btn gt-top-scan"><ScanLine size={18} />Scan card</Link>}
        <button type="button" className="gt-icon" aria-pressed={sound} aria-label={sound ? 'Sound for each check-in: on' : 'Sound for each check-in: off'} onClick={toggleSound}>{sound ? <Volume2 size={21} /> : <VolumeX size={21} />}</button>
      </header>

      {error && !ov && <div className="gt-fill"><ErrorState message={error} onRetry={() => void load()} /></div>}
      {!ov && !error && (
        <div className="gt-main" aria-label="Loading the gate" aria-busy="true">
          <div className="gt-left"><div className="gt-hero"><div className="sc-skel gt-skel-ring" /><div className="sc-skel gt-skel-card" /></div></div>
          <section className="gt-col gt-col-wait">{[0, 1, 2, 3, 4, 5].map((i) => <div key={i} className="sc-skel gt-skel-row" />)}</section>
          <section className="gt-col gt-col-feed">{[0, 1, 2, 3, 4, 5].map((i) => <div key={i} className="sc-skel gt-skel-row" />)}</section>
        </div>
      )}

      {ov && model && head && (
        <div className="gt-main">
          {error && <p className="gt-stale" role="status">No connection. Showing {hhmm(toMin(ov.now?.at) ?? nowMin)}. <button type="button" onClick={() => void load()}>Try again</button></p>}
          <div className="gt-left">
            <div className="gt-hero">
              <Ring done={model.done} total={model.total} label={words.ring} />
              <div className="gt-hero-side">
                <div className="gt-next" data-tone={head.tone} data-testid="gate-next">
                  <span>{head.kicker}</span>
                  <b>{head.line}</b>
                  <Clock size={24} aria-hidden />
                </div>
                <p className="gt-mini sc-num">
                  <span><b>{model.waiting.length}</b> {mode === 'in' ? 'expected' : 'inside'}</span>
                  <span data-warn={model.counts.late > 0 || undefined}><b>{model.counts.late}</b> {mode === 'in' ? 'late' : 'over'}</span>
                  <span><b>{model.dayOff}</b> off</span>
                </p>
              </div>
            </div>
            <dl className="gt-counts sc-num">
              <div><dt><i data-dot="blue" />On time</dt><dd>{model.onTime}</dd></div>
              <div><dt><i data-dot="amber" />Arrived late</dt><dd>{model.lateArrived}</dd></div>
              <div><dt><i data-dot="gray" />{words.waitTitle}</dt><dd>{model.waiting.length}</dd></div>
              <div><dt><i data-dot="amber" />To check</dt><dd>{model.checks.length}</dd></div>
              <div><dt><i data-dot="muted" />Day off today</dt><dd>{model.dayOff}</dd></div>
            </dl>
            <div className="gt-actions">
              <button type="button" className="gt-btn gt-btn-primary" disabled={!toRemind.length || !!busy} onClick={() => setSheet({ kind: 'all' })} data-testid="gate-remind-all"><BellRing size={20} />{remindLabel}</button>
              {can('STAFF_CLOCK_SCAN') && <Link to="/staff/clock/scan" className="gt-btn gt-actions-scan"><ScanLine size={20} />Scan card</Link>}
            </div>
          </div>

          <div className="gt-seg gt-tabs" role="group" aria-label="Lists">
            <button type="button" aria-pressed={tab === 'wait'} onClick={() => setTab('wait')}>{words.wait} <b className="sc-num">{model.waiting.length}</b></button>
            <button type="button" aria-pressed={tab === 'events'} onClick={() => setTab('events')} data-testid="gate-tab-events">{words.events} <b className="sc-num">{model.events.length}</b></button>
            <button type="button" aria-pressed={tab === 'check'} onClick={() => setTab('check')} data-testid="gate-tab-check" data-warn={model.checks.length > 0 || undefined}>Check <b className="sc-num">{model.checks.length}</b></button>
          </div>

          <section className="gt-col gt-col-wait" aria-label={words.waitTitle}>
            <div className="gt-col-head">
              <h2>{words.waitTitle}</h2>
              <div className="gt-chips" role="group" aria-label="Filter">
                {([['all', `All ${model.waiting.length}`], ['late', `${words.late} ${model.counts.late}`], ['soon', `${words.soon} ${model.counts.soon}`], ['later', `${words.later} ${model.counts.later}`]] as Array<['all' | GateKind, string]>).map(([k, label]) => (
                  <button key={k} type="button" aria-pressed={filter === k} onClick={() => setFilter(k)}>{label}</button>
                ))}
              </div>
            </div>
            <div className="gt-list" data-testid="gate-waiting">
              {waiting.length === 0 && <p className="gt-empty"><Check size={26} />{model.waiting.length ? 'Nobody in this group.' : words.emptyWait}</p>}
              {waiting.map((w) => {
                const done = sent.has(key(w.userId));
                return (
                  <div key={w.userId} className="gt-row" data-kind={w.kind}>
                    <button type="button" className="gt-row-main" onClick={() => setSheet({ kind: 'person', who: w })} aria-label={`${w.name}, ${w.status}. Open details`}>
                      <UserAvatar decorative userId={w.userId} name={w.name} px={44} className="gt-av" />
                      <span className="gt-row-text">
                        <b>{w.name}</b>
                        <small className="sc-num">{done ? 'Reminded just now' : [w.hours, w.own ? 'own hours' : '', w.reminders ? '' : 'no reminders'].filter(Boolean).join(' · ')}</small>
                      </span>
                      <span className="gt-tag sc-num">{w.status}</span>
                    </button>
                    {w.canRemind && (done
                      ? <span className="gt-sent" aria-label="Reminded"><Check size={18} /></span>
                      : <button type="button" className="gt-bell" aria-label={`Remind ${w.name} to check ${mode}`} disabled={!!busy} onClick={() => void remind([w.userId], w.userId)}><BellRing size={19} /><span>Remind</span></button>)}
                  </div>
                );
              })}
            </div>
          </section>

          <section className="gt-col gt-col-feed" aria-label={words.eventsTitle}>
            <div className="gt-col-head">
              <h2>{words.eventsTitle}</h2>
              <span className="gt-note sc-num">{model.events.length} so far{model.checks.length ? ` · ${model.checks.length} to check` : ''}</span>
            </div>
            <div className="gt-list">
              <div className="gt-checks" data-testid="gate-checks">
                {model.checks.length === 0 && <p className="gt-empty gt-empty-check"><Check size={26} />Nothing to check.</p>}
                {model.checks.map((c) => (
                  <div key={c.recordId} className="gt-check">
                    <span className="gt-check-ico"><ShieldAlert size={20} /></span>
                    <span className="gt-row-text">
                      <b>{c.name}</b>
                      <small className="sc-num">{c.at ? `${c.at} · ` : ''}{c.reason}</small>
                    </span>
                    {can('STAFF_DEVICES_MANAGE')
                      ? <button type="button" className="gt-btn gt-btn-dark gt-btn-sm" disabled={!!busy} onClick={() => void confirmHere(c)} data-testid="gate-confirm">Here</button>
                      : null}
                    <Link to="/staff/clock/people?tab=review" className="gt-btn gt-btn-sm" aria-label={`Review ${c.name}'s check-in`}>Review</Link>
                  </div>
                ))}
              </div>
              <div className="gt-events" data-testid="gate-events">
                {model.events.length === 0 && <p className="gt-empty">{words.emptyEvents}</p>}
                {model.events.map((e, i) => (
                  <button key={e.userId} type="button" className="gt-event" data-new={(i === 0 && e.ago <= 2) || undefined} data-warn={e.warn || undefined} onClick={() => setPerson({ id: e.userId, name: e.name })} aria-label={`${e.name}, ${e.at}, ${e.tag}. Open history`}>
                    <b className="gt-event-at sc-num">{e.at}</b>
                    <UserAvatar decorative userId={e.userId} name={e.name} px={40} className="gt-av gt-av-sm" />
                    <span className="gt-row-text">
                      <b>{e.name}</b>
                      <small>{agoText(e.ago)} · {e.card ? <><CreditCard size={13} aria-hidden /> staff card</> : 'phone'}{e.needsReview ? ' · to check' : ''}</small>
                    </span>
                    <span className="gt-tag">{e.tag}</span>
                  </button>
                ))}
              </div>
            </div>
          </section>
        </div>
      )}

      {sheet && model && (
        <div className="gt-sheet-back" onClick={() => setSheet(null)}>
          <div className="gt-sheet" role="dialog" aria-modal="true" aria-label={sheet.kind === 'all' ? 'Send reminders' : sheet.who.name} onClick={(e) => e.stopPropagation()} data-testid="gate-sheet">
            <span className="gt-sheet-grip" aria-hidden />
            <button type="button" className="gt-icon gt-sheet-close" aria-label="Close" onClick={() => setSheet(null)}><X size={20} /></button>
            {sheet.kind === 'all' ? (
              <>
                <h2>Remind {toRemind.length === 1 ? '1 person' : `${toRemind.length} people`}?</h2>
                <p>{mode === 'in' ? 'A notification asks them to check in.' : 'A notification asks them to check out.'}{model.noReminders ? ` ${model.noReminders} ${model.noReminders === 1 ? 'person has' : 'people have'} reminders off: tell them in person.` : ''}</p>
                <dl className="gt-facts sc-num">
                  <div><dt>{mode === 'in' ? 'Late now' : 'Day over'}</dt><dd data-warn>{model.waiting.filter((w) => w.kind === 'late' && toRemind.includes(w.userId)).length}</dd></div>
                  {mode === 'in' && <div><dt>Due in the next 30 min</dt><dd>{model.waiting.filter((w) => w.kind === 'soon' && toRemind.includes(w.userId)).length}</dd></div>}
                </dl>
                <button type="button" className="gt-btn gt-btn-primary" disabled={!!busy || !toRemind.length} onClick={() => void remind(toRemind, 'all')} data-testid="gate-send">{busy === 'all' ? 'Sending…' : 'Send reminders'}</button>
                <button type="button" className="gt-btn" onClick={() => setSheet(null)}>Cancel</button>
              </>
            ) : (
              <>
                <h2>{sheet.who.name}</h2>
                <p>{[sheet.who.role, sheet.who.hours, sheet.who.own ? 'own hours' : ''].filter(Boolean).join(' · ')}</p>
                <dl className="gt-facts sc-num">
                  <div><dt>Now</dt><dd data-warn={sheet.who.kind === 'late' || undefined}>{sheet.who.status}</dd></div>
                  <div><dt>Reminders</dt><dd>{sent.has(key(sheet.who.userId)) ? 'Reminded just now' : sheet.who.reminders ? 'On' : 'Off on their phone'}</dd></div>
                </dl>
                {sheet.who.canRemind && !sent.has(key(sheet.who.userId)) && (
                  <button type="button" className="gt-btn gt-btn-primary" disabled={!!busy} onClick={() => void remind([sheet.who.userId], sheet.who.userId)}><BellRing size={19} />{busy === sheet.who.userId ? 'Sending…' : 'Remind now'}</button>
                )}
                <button type="button" className="gt-btn" onClick={() => { setPerson({ id: sheet.who.userId, name: sheet.who.name }); setSheet(null); }}>Full history<ChevronRight size={18} /></button>
              </>
            )}
          </div>
        </div>
      )}

      {person && (
        <StaffHistoryModal key={person.id} personId={person.id} name={person.name}
          list={model ? [...model.waiting, ...model.events].map((p) => ({ id: p.userId, name: p.name })).filter((p, i, a) => a.findIndex((x) => x.id === p.id) === i) : []}
          onNav={(p) => setPerson({ id: p.id, name: p.name })} onClose={() => setPerson(null)} onChanged={() => void load()} />
      )}
    </div>
  );
};

export default StaffClockGate;
