import React, { useEffect, useMemo, useRef, useState } from 'react';
import { X, ChevronLeft, ChevronRight, Flame, Clock, UserX, LogOut, TimerOff, CalendarCheck, CreditCard, Monitor, Smartphone } from 'lucide-react';
import { ApiError } from '../../api/client';
import { staffClockApi, initialsOf, type HistoryDay, type HistoryKind, type PersonHistory } from '../../api/staffClock';
import { Skeleton } from '../../components/common/Skeleton';
import { Ring } from './StaffClockAttention';
import { StaffPlanPanel } from './StaffPlanPanel';
import { usePermissions } from '../../hooks/usePermissions';
import { useToast } from '../../context/ToastContext';
import { Spinner } from './StaffClockHeader';

/**
 * One staff member's attendance over the last year: two rings, a few numbers,
 * a GitHub-style year grid (one square per day) and a month calendar with the
 * day's times. Colour + a legend tell the story, words stay short.
 */

const KIND: Record<HistoryKind, { label: string; cls: string }> = {
  on_time: { label: 'On time', cls: 'k-on' },
  late: { label: 'Late', cls: 'k-late' },
  absent: { label: 'Absent', cls: 'k-absent' },
  invalid: { label: 'Marked invalid', cls: 'k-invalid' },
  off: { label: 'No school', cls: 'k-off' },
  today: { label: 'Today', cls: 'k-today' },
  future: { label: '', cls: 'k-future' },
  untracked: { label: 'Before check-in started', cls: 'k-none' },
};
const LEGEND: HistoryKind[] = ['on_time', 'late', 'absent', 'off'];
const WD = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const dow = (date: string) => (new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7; // Mon = 0
const fmtDay = (date: string, opts: Intl.DateTimeFormatOptions = { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) =>
  new Date(`${date}T12:00:00Z`).toLocaleDateString('en-GB', { ...opts, timeZone: 'UTC' });
const monthKey = (date: string) => date.slice(0, 7);
const hours = (m: number | null) => (m == null ? null : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}`);
const tipText = (d: HistoryDay) =>
  `${fmtDay(d.date)} · ${KIND[d.kind].label || '—'}${d.in ? ` · in ${d.in}` : ''}${d.out ? ` · out ${d.out}` : d.noOut ? ' · no check-out' : ''}`;

export interface HistoryNavPerson { id: string; name: string; role?: string | null; note?: string }

export const StaffHistoryModal: React.FC<{
  personId: string; name: string; role?: string | null; onClose: () => void;
  /** the list this person was opened from: step through it with the arrows or ← → */
  list?: HistoryNavPerson[];
  onNav?: (p: HistoryNavPerson) => void;
  /** opened by stepping from another person: no entrance animation */
  instant?: boolean;
  /** open with this day picked (a missed check-out, for instance) */
  initialDate?: string;
  /** open on the working hours instead of the history */
  initialTab?: 'history' | 'hours';
  /** the person's hours were changed: lists behind this window are out of date */
  onChanged?: () => void;
}> = ({ personId, name, role, onClose, list, onNav, instant, initialTab, initialDate, onChanged }) => {
  const toast = useToast();
  const canFixOut = usePermissions().can('STAFF_DEVICES_MANAGE');
  /** the check-out time being typed, for one day */
  const [outDraft, setOutDraft] = useState<{ date: string; time: string } | null>(null);
  const [savingOut, setSavingOut] = useState(false);
  const { can } = usePermissions();
  const canEditPlan = can('STAFF_ATTENDANCE_ZONES_MANAGE');
  const [tab, setTab] = useState<'history' | 'hours' | 'device'>(initialTab ?? 'history');
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [data, setData] = useState<PersonHistory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [month, setMonth] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [tip, setTip] = useState<{ d: HistoryDay; x: number; y: number } | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const dialog = useRef<HTMLDivElement>(null);
  const gridScroll = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    staffClockApi.history(personId)
      .then((h) => { if (live) { setData(h); const start = initialDate && initialDate >= h.from && initialDate <= h.to ? initialDate : h.to; setMonth((m) => m ?? monthKey(start)); setPicked((p) => p ?? start); } })
      .catch((e) => { if (live) setError(e instanceof ApiError ? e.message : 'Could not load the history.'); });
    return () => { live = false; };
  }, [personId, reloadKey, initialDate]);

  const at = list ? list.findIndex((p) => p.id === personId) : -1;
  const prevP = at > 0 ? list![at - 1] : null;
  const nextP = at >= 0 && at < list!.length - 1 ? list![at + 1] : null;
  const navRef = useRef({ prevP, nextP, onNav });
  useEffect(() => { navRef.current = { prevP, nextP, onNav }; });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      const n = navRef.current;
      if (!n.onNav || (e.target as HTMLElement)?.tagName === 'INPUT') return;
      if (e.key === 'ArrowLeft' && n.prevP) n.onNav(n.prevP);
      if (e.key === 'ArrowRight' && n.nextP) n.onNav(n.nextP);
    };
    window.addEventListener('keydown', onKey);
    dialog.current?.focus();
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
  }, [onClose]);

  // The year grid starts scrolled to the most recent weeks (phones).
  useEffect(() => {
    if (data && gridScroll.current) gridScroll.current.scrollLeft = gridScroll.current.scrollWidth;
  }, [data]);

  const byDate = useMemo(() => new Map((data?.days ?? []).map((d) => [d.date, d])), [data]);

  // Year grid: columns of weeks (Mon..Sun), padded so the first column starts on a Monday.
  const weeks = useMemo(() => {
    if (!data) return [] as Array<Array<HistoryDay | null>>;
    const cols: Array<Array<HistoryDay | null>> = [];
    let col: Array<HistoryDay | null> = Array(dow(data.days[0].date)).fill(null);
    for (const d of data.days) {
      col.push(d);
      if (col.length === 7) { cols.push(col); col = []; }
    }
    if (col.length) cols.push([...col, ...Array(7 - col.length).fill(null)]);
    return cols;
  }, [data]);
  const monthMarks = useMemo(() => {
    const marks: Array<{ i: number; label: string }> = [];
    let last = '';
    weeks.forEach((w, i) => {
      const first = w.find((d) => d && d.date.slice(8) <= '07' ) ?? null;
      const key = first ? monthKey(first.date) : '';
      if (first && key !== last) { marks.push({ i, label: fmtDay(first.date, { month: 'short' }) }); last = key; }
    });
    return marks;
  }, [weeks]);

  // Month calendar.
  const cal = useMemo(() => {
    if (!month) return [] as Array<{ date: string; day: HistoryDay | null; inMonth: boolean }>;
    const first = `${month}-01`;
    const start = new Date(`${first}T12:00:00Z`);
    start.setUTCDate(start.getUTCDate() - dow(first));
    const cells = [];
    for (let i = 0; i < 42; i++) {
      const d = new Date(start);
      d.setUTCDate(start.getUTCDate() + i);
      const iso = d.toISOString().slice(0, 10);
      cells.push({ date: iso, day: byDate.get(iso) ?? null, inMonth: iso.startsWith(month) });
    }
    while (cells.length > 35 && cells.slice(-7).every((c) => !c.inMonth)) cells.splice(-7);
    return cells;
  }, [month, byDate]);
  const shiftMonth = (n: number) => {
    if (!month) return;
    const d = new Date(`${month}-15T12:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() + n);
    setMonth(d.toISOString().slice(0, 7));
  };
  const canPrev = !!data && !!month && month > monthKey(data.from);
  const canNext = !!data && !!month && month < monthKey(data.to);
  const monthStats = useMemo(() => {
    const ds = (data?.days ?? []).filter((d) => month && d.date.startsWith(month));
    return { on: ds.filter((d) => d.kind === 'on_time').length, late: ds.filter((d) => d.kind === 'late').length, absent: ds.filter((d) => d.kind === 'absent').length };
  }, [data, month]);

  const sel = picked ? byDate.get(picked) ?? null : null;
  const outTime = sel && outDraft?.date === sel.date ? outDraft.time : '';
  const setOutTime = (time: string) => setOutDraft(sel ? { date: sel.date, time } : null);
  const signOut = async (deviceId: number) => {
    setSigningOut(true);
    try {
      await staffClockApi.deviceAction(deviceId, 'revoke', 'Signed out by the office');
      toast.success('Device signed out', 'They sign in with Google again the next time they open the check-in page.');
      setConfirmSignOut(false);
      setReloadKey((k) => k + 1);
      onChanged?.();
    } catch (e) {
      toast.error('Not signed out', e instanceof ApiError ? e.message : 'Check the connection and try again.');
    } finally {
      setSigningOut(false);
    }
  };
  const saveOut = async (recordId: number, time: string) => {
    setSavingOut(true);
    try {
      const res = await staffClockApi.setCheckout(recordId, time);
      toast.success(res.message || 'Check-out saved', res.data?.outStatus === 'early' ? 'Counted as leaving early for that day.' : 'The day is complete now.');
      setOutTime('');
      setReloadKey((k) => k + 1);
      onChanged?.();
    } catch (e) {
      toast.error('Check-out not saved', e instanceof ApiError ? e.message : 'Check the connection and try again.');
    } finally {
      setSavingOut(false);
    }
  };
  const s = data?.summary;
  const pick = (d: HistoryDay) => { setPicked(d.date); setMonth(monthKey(d.date)); };

  return (
    <div className="sh-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`sh-dialog${instant ? ' sh-instant' : ''}`} role="dialog" aria-modal="true" aria-label={`${name}: attendance history`} tabIndex={-1} ref={dialog} data-testid="staff-history">
        <header className="sh-head">
          <span className="sc-avatar sh-avatar">{initialsOf(data?.person.name ?? name)}</span>
          <div className="sh-who">
            <b className="sc-clip">{data?.person.name ?? name}</b>
            <small>{role || data?.person.role || 'Staff'}{data ? ` · ${fmtDay(data.from, { month: 'short', year: 'numeric' })} – ${fmtDay(data.to, { month: 'short', year: 'numeric' })}` : ''}</small>
          </div>
          {list && onNav && at >= 0 && list.length > 1 && (
            <div className="sh-nav" role="group" aria-label="Other staff in this list">
              <button onClick={() => prevP && onNav(prevP)} disabled={!prevP} aria-label={prevP ? `Previous: ${prevP.name}` : 'No previous'} title={prevP ? `${prevP.name} (←)` : undefined}><ChevronLeft size={16} /></button>
              <span className="sc-num">{at + 1} / {list.length}</span>
              <button onClick={() => nextP && onNav(nextP)} disabled={!nextP} aria-label={nextP ? `Next: ${nextP.name}` : 'No next'} title={nextP ? `${nextP.name} (→)` : undefined}><ChevronRight size={16} /></button>
            </div>
          )}
          <button className="sh-close" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </header>
        {list && at >= 0 && list[at].note && <div className="sh-context">{list[at].note}</div>}
        <div className="sh-tabs" role="tablist" aria-label="Sections">
          <button role="tab" aria-selected={tab === 'history'} onClick={() => setTab('history')}>History</button>
          <button role="tab" aria-selected={tab === 'hours'} onClick={() => setTab('hours')} data-testid="tab-hours">
            Working hours{data?.plan?.own && <i className="sh-tab-dot" title="Own hours" />}
          </button>
          <button role="tab" aria-selected={tab === 'device'} onClick={() => setTab('device')} data-testid="tab-device">Device</button>
        </div>

        {error ? (
          <div className="sc-empty">{error}</div>
        ) : !data || !s ? (
          <div className="sh-body" role="status" aria-busy="true" aria-label="Loading history">
            <div className="sh-hero">{[0, 1].map((i) => <div key={i} className="sh-ringcard"><Skeleton w={76} h={76} r={999} /><span style={{ flex: 1, display: 'grid', gap: 8 }}><Skeleton w="60%" h={12} /><Skeleton w="40%" h={22} /></span></div>)}</div>
            <div className="sh-stats">{[0, 1, 2, 3].map((i) => <Skeleton key={i} h={64} r={16} />)}</div>
            <Skeleton h={128} r={16} />
            <Skeleton h={260} r={16} />
          </div>
        ) : tab === 'device' ? (
          <div className="sh-body" data-testid="staff-device">
            {data.device ? (
              <div className="sd">
                <div className="sd-head">
                  <span className="sd-ico">{data.device.form_factor === 'desktop' ? <Monitor size={20} /> : <Smartphone size={20} />}</span>
                  <div className="sd-main">
                    <b className="sc-clip">{data.device.label || 'Registered device'}</b>
                    <small className="sc-clip">{data.device.google_email}</small>
                  </div>
                  <span className={`sc-pill ${data.device.status === 'active' ? 'sc-tone-blue' : 'sc-tone-amber'}`}><i />{data.device.status === 'active' ? 'Signed in' : 'Waiting for approval'}</span>
                </div>
                <dl className="sd-facts">
                  <div><dt>Registered</dt><dd>{fmtDay(data.device.registered_at.slice(0, 10), { day: 'numeric', month: 'short', year: 'numeric' })}</dd></div>
                  <div><dt>Last check-in tap</dt><dd>{data.device.last_used_at ? fmtDay(data.device.last_used_at.slice(0, 10), { day: 'numeric', month: 'short', year: 'numeric' }) : 'Not yet'}</dd></div>
                  <div><dt>Reminders</dt><dd>{data.device.reminders ? 'On' : 'Off'}</dd></div>
                  <div><dt>Staff card</dt><dd>{data.card ? 'Has one' : 'None'}</dd></div>
                </dl>
                <p className="sp-help">The check-in page has no sign-out button. Signing the device out here removes it from {data.person.name.split(' ')[0]}'s account: the page asks them to sign in with Google again, on this or another phone. Their attendance history stays.</p>
                {canFixOut && (confirmSignOut ? (
                  <div className="sd-confirm" role="alertdialog" aria-label="Sign out this device?">
                    <b>Sign {data.person.name.split(' ')[0]} out of this device?</b>
                    <div className="sd-actions">
                      <button className="sc-btn sc-btn-sm" disabled={signingOut} onClick={() => setConfirmSignOut(false)}>Cancel</button>
                      <button className="sc-btn sc-btn-primary sc-btn-sm" disabled={signingOut} onClick={() => void signOut(data.device!.id)} data-testid="device-signout-yes">{signingOut ? <Spinner /> : null} {signingOut ? 'Signing out…' : 'Yes, sign out'}</button>
                    </div>
                  </div>
                ) : (
                  <div className="sd-actions">
                    <button className="sc-btn sc-btn-sm sc-btn-danger" onClick={() => setConfirmSignOut(true)} data-testid="device-signout"><LogOut size={15} /> Sign out this device</button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="sc-empty">
                No phone or browser is signed in for {data.person.name.split(' ')[0]}.{data.card ? ' They check in with a staff card.' : ' They register from the school\'s check-in link.'}
              </div>
            )}
          </div>
        ) : tab === 'hours' ? (
          <div className="sh-body">
            {data.plan ? (
              <StaffPlanPanel key={`${personId}:${data.plan.effectiveFrom ?? 'school'}:${data.plan.updatedAt ?? ''}`} personId={personId} name={data.person.name} plan={data.plan} today={data.today} canEdit={canEditPlan}
                onSaved={() => { setReloadKey((k) => k + 1); onChanged?.(); }} />
            ) : <div className="sc-empty">Working hours are not available.</div>}
          </div>
        ) : (
          <div className="sh-body">
            <div className="sh-hero">
              <div className="sh-ringcard">
                <Ring value={s.attended} total={Math.max(1, s.schoolDays)} size={76} label={`Present ${s.attended} of ${s.schoolDays} school days`} />
                <div><span className="sh-label">Attendance</span><b className="sh-big">{s.attended}<small> / {s.schoolDays} days</small></b></div>
              </div>
              <div className="sh-ringcard">
                <Ring value={s.onTime} total={Math.max(1, s.attended)} size={76} label={`On time ${s.onTime} of ${s.attended} days`} />
                <div><span className="sh-label">On time</span><b className="sh-big">{s.onTime}<small> of {s.attended}</small></b></div>
              </div>
            </div>

            <div className="sh-stats">
              <div className="sh-stat" data-tone="blue"><Flame size={18} /><b>{s.streak}</b><span>day streak{s.bestStreak > s.streak ? ` · best ${s.bestStreak}` : ''}</span></div>
              <div className="sh-stat"><Clock size={18} /><b>{s.avgIn ?? '—'}</b><span>usual arrival</span></div>
              <div className="sh-stat" data-tone={s.late ? 'amber' : undefined}><TimerOff size={18} /><b>{s.late}</b><span>late</span></div>
              <div className="sh-stat" data-tone={s.absent ? 'red' : undefined}><UserX size={18} /><b>{s.absent}</b><span>absent</span></div>
              <div className="sh-stat" data-tone={s.noOut + s.early ? 'amber' : undefined}><LogOut size={18} /><b>{s.noOut + s.early}</b><span>{s.noOut} no check-out · {s.early} early</span></div>
            </div>

            <section className="sh-card">
              <div className="sh-card-head">
                <b>Last 12 months</b>
                <div className="sh-legend">
                  {LEGEND.map((k) => <span key={k}><i className={`sh-cell ${KIND[k].cls}`} />{KIND[k].label}</span>)}
                </div>
              </div>
              <div className="sh-year" ref={gridScroll} onMouseLeave={() => setTip(null)}>
                <div className="sh-year-inner" style={{ gridTemplateColumns: `28px repeat(${weeks.length}, 13px)` }}>
                  <span />
                  {weeks.map((_, i) => {
                    const m = monthMarks.find((x) => x.i === i);
                    return <span key={i} className="sh-month">{m?.label ?? ''}</span>;
                  })}
                  {WD.map((w, r) => (
                    <React.Fragment key={w}>
                      <span className="sh-wd">{r % 2 === 0 ? w : ''}</span>
                      {weeks.map((col, c) => {
                        const d = col[r];
                        if (!d) return <span key={c} className="sh-cell k-blank" />;
                        const flag = (d.noOut || d.early) && (d.kind === 'on_time' || d.kind === 'late');
                        return (
                          <button
                            key={c}
                            className={`sh-cell ${KIND[d.kind].cls}${flag ? ' has-flag' : ''}${picked === d.date ? ' is-picked' : ''}`}
                            aria-label={tipText(d)}
                            onClick={() => pick(d)}
                            onMouseEnter={(e) => {
                              const r2 = (e.currentTarget as HTMLElement).getBoundingClientRect();
                              setTip({ d, x: r2.left + r2.width / 2, y: r2.top });
                            }}
                          />
                        );
                      })}
                    </React.Fragment>
                  ))}
                </div>
              </div>
            </section>

            <div className="sh-split">
              <section className="sh-card">
                <div className="sh-card-head">
                  <div className="sh-month-nav">
                    <button onClick={() => shiftMonth(-1)} disabled={!canPrev} aria-label="Previous month"><ChevronLeft size={16} /></button>
                    <b>{month ? fmtDay(`${month}-01`, { month: 'long', year: 'numeric' }) : ''}</b>
                    <button onClick={() => shiftMonth(1)} disabled={!canNext} aria-label="Next month"><ChevronRight size={16} /></button>
                  </div>
                  <div className="sh-mini">
                    <span className="k-on-t">{monthStats.on}</span><span className="k-late-t">{monthStats.late}</span><span className="k-absent-t">{monthStats.absent}</span>
                  </div>
                </div>
                <div className="sh-cal">
                  {WD.map((w) => <span key={w} className="sh-cal-wd">{w.slice(0, 2)}</span>)}
                  {cal.map(({ date, day, inMonth }) => (
                    <button
                      key={date}
                      className={`sh-day ${day ? KIND[day.kind].cls : 'k-future'}${inMonth ? '' : ' is-out'}${picked === date ? ' is-picked' : ''}`}
                      disabled={!day}
                      onClick={() => day && setPicked(date)}
                      aria-label={day ? tipText(day) : fmtDay(date)}
                    >
                      <span className="sh-day-n">{Number(date.slice(8))}</span>
                      {day?.in && <span className="sh-day-t">{day.in}</span>}
                      {day && (day.noOut || day.early) && <i className="sh-day-flag" />}
                    </button>
                  ))}
                </div>
              </section>

              <section className="sh-card sh-daycard" aria-live="polite">
                {sel ? (
                  <>
                    <span className="sh-label">{fmtDay(sel.date, { weekday: 'long', day: 'numeric', month: 'long' })}</span>
                    <span className={`sh-pill ${KIND[sel.kind].cls}`}><i />{sel.kind === 'off' && data.plan?.own ? 'Day off' : KIND[sel.kind].label || '—'}</span>
                    <div className="sh-times">
                      <div><span>In</span><b>{sel.in ?? '—'}</b></div>
                      <div className="sh-times-line"><i style={{ width: sel.minutes ? `${Math.min(100, (sel.minutes / 600) * 100)}%` : 0 }} /></div>
                      <div><span>Out</span><b>{sel.out ?? '—'}</b></div>
                    </div>
                    <div className="sh-tags">
                      {sel.minutes != null && <span><CalendarCheck size={14} />{hours(sel.minutes)} at school</span>}
                      {sel.start && sel.end && <span><Clock size={14} />expected {sel.start} – {sel.end}</span>}
                      {sel.extra && <span><CalendarCheck size={14} />came on a day off</span>}
                      {sel.kind === 'late' && (sel.start ?? data.rules.lateAfter) && <span data-tone="amber"><TimerOff size={14} />after {sel.start ?? data.rules.lateAfter}</span>}
                      {sel.early && <span data-tone="amber"><LogOut size={14} />left before {sel.end ?? data.rules.earlyLeaveBefore}</span>}
                      {sel.noOut && <span data-tone="amber"><LogOut size={14} />no check-out</span>}
                      {sel.manualOut && <span><LogOut size={14} />check-out entered by the office</span>}
                      {sel.card && <span><CreditCard size={14} />staff card</span>}
                    </div>
                    {sel.noOut && sel.recordId != null && canFixOut && (
                      <div className="sh-fixout" data-testid="fix-out">
                        <b>Forgot to check out</b>
                        <small>{sel.claim ? `${(data.person.name.split(' ')[0])} says they left at ${sel.claim}. Confirm it or enter another time.` : 'Enter the time they left. Early or on time follows their hours that day.'}</small>
                        <div className="sh-fixout-row">
                          <input className="sp-time" type="time" aria-label="Check-out time" value={outTime || sel.claim || ''} onChange={(e) => setOutTime(e.target.value)} />
                          <button className="sc-btn sc-btn-primary sc-btn-sm" disabled={savingOut || !(outTime || sel.claim) || (!!sel.in && (outTime || sel.claim || '') <= sel.in)} onClick={() => void saveOut(sel.recordId as number, outTime || sel.claim || '')}>
                            {savingOut ? <Spinner /> : null} {savingOut ? 'Saving…' : sel.claim && !outTime ? 'Confirm' : 'Save check-out'}
                          </button>
                        </div>
                      </div>
                    )}
                    {sel.noOut && sel.claim && !canFixOut && <small className="sc-muted">Says they left at {sel.claim}. Waiting for the office.</small>}
                  </>
                ) : (
                  <span className="sh-label">Pick a day</span>
                )}
              </section>
            </div>
          </div>
        )}
        {tip && tab === 'history' && (
          <div className="sh-tip" style={{ left: tip.x, top: tip.y }} role="tooltip">
            <b>{fmtDay(tip.d.date, { weekday: 'short', day: 'numeric', month: 'short' })}</b>
            <span className={`sh-pill ${KIND[tip.d.kind].cls}`}><i />{KIND[tip.d.kind].label || '—'}</span>
            {(tip.d.in || tip.d.out) && <span className="sh-tip-t">{tip.d.in ?? '—'} → {tip.d.out ?? (tip.d.noOut ? 'no check-out' : '—')}</span>}
          </div>
        )}
      </div>
    </div>
  );
};
