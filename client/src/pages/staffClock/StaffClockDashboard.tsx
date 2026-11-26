import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ChevronLeft, ChevronRight, Download, ArrowUpRight, LogOut, CalendarClock } from 'lucide-react';
import { DashboardLayout } from '../../components/Layout/DashboardLayout';
import { ErrorState } from '../../components/common/ErrorState';
import { useToast } from '../../context/ToastContext';
import { usePermissions } from '../../hooks/usePermissions';
import { ApiError } from '../../api/client';
import { staffClockApi, type ClockReport, type Overview, type OverviewRow, type ReportDay, type ReportGroup } from '../../api/staffClock';
import { StaffClockHeader, Spinner } from './StaffClockHeader';
import { StaffClockSetup } from './StaffClockSetup';
import { AttentionStrip, ListSheet, type SheetPerson } from './StaffClockAttention';
import { StaffHistoryModal, type HistoryNavPerson } from './StaffHistoryModal';
import { DayReport } from './StaffClockDayReport';
import { Columns, GroupCards, HeatLegend, MonthGrid, SplitBar, TermCalendar, WeekdayBars, WeeklyChart } from './StaffClockReportParts';
import { dayRate, delta, fmtDate, medianTime, pct, sumDays } from './reportMath';

/**
 * Staff attendance dashboard (design "V3d · Calendar + insights").
 *
 * First look: today. Then the period picked in the header (today, a date, a
 * range of dates, the whole term), the term on month calendars, three patterns
 * and the staff groups. The page shows numbers only; names open in a side
 * sheet when someone asks for them.
 */

type Mode = 'today' | 'date' | 'range' | 'term';
type Sheet = { title: string; subtitle?: string; people: SheetPerson[]; empty: string; loading?: boolean };

const long = (date: string) => fmtDate(date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const short = (date: string) => fmtDate(date, { day: 'numeric', month: 'short' });
const MODES: Array<[Mode, string]> = [['today', 'Today'], ['date', 'Custom date'], ['range', 'Date range'], ['term', 'Whole term']];

export const StaffClockDashboard: React.FC = () => {
  const toast = useToast();
  const { can } = usePermissions();
  const navigate = useNavigate();

  const [report, setReport] = useState<ClockReport | null>(null);
  const [todayOv, setTodayOv] = useState<Overview | null>(null);
  const [dayOv, setDayOv] = useState<Overview | null>(null);
  const [dayLoading, setDayLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [mode, setMode] = useState<Mode>('today');
  const [selected, setSelected] = useState<string | null>(null);
  const [range, setRange] = useState<{ from: string; to: string } | null>(null);
  const [dateNote, setDateNote] = useState('');

  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [person, setPerson] = useState<{ id: string; name: string; role?: string | null; list?: HistoryNavPerson[]; instant?: boolean; date?: string } | null>(null);
  /** the selected day's staff, open in a window on request */
  const [dayOpen, setDayOpen] = useState(false);
  // Escape also closes the side sheet while it is still loading its names.
  useEffect(() => {
    if (!sheet?.loading) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setSheet(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sheet?.loading]);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setError(null);
    try {
      const [r, o] = await Promise.all([staffClockApi.report(), staffClockApi.overview()]);
      setReport(r);
      setTodayOv(o);
    } catch (e) {
      if (!quiet) setError(e instanceof ApiError ? e.message : 'Could not load staff attendance.');
    }
  }, []);

  useEffect(() => {
    void Promise.resolve().then(() => load());
    // Live: today's numbers move through the morning.
    const id = window.setInterval(() => void load(true), 60_000);
    return () => window.clearInterval(id);
  }, [load]);

  const today = report?.today ?? null;
  // Kept in a ref: the toast functions must not restart the effects below.
  const toastRef = useRef(toast);
  useEffect(() => { toastRef.current = toast; });
  const sel = selected ?? today;

  // The day panel: today's overview is already loaded; any other day is fetched.
  useEffect(() => {
    if (!sel || !today || sel === today) return;
    let live = true;
    void Promise.resolve().then(async () => {
      setDayLoading(true);
      try {
        const o = await staffClockApi.overview(sel);
        if (live) setDayOv(o);
      } catch (e) {
        if (live) toastRef.current.error('Could not load that day', e instanceof ApiError ? e.message : 'Try again.');
      } finally {
        if (live) setDayLoading(false);
      }
    });
    return () => { live = false; };
  }, [sel, today]);

  const days = useMemo(() => report?.days ?? [], [report]);
  const byDate = useMemo(() => new Map(days.map((d) => [d.date, d])), [days]);
  const schoolDates = useMemo(() => days.filter((d) => d.kind === 'school').map((d) => d.date), [days]);
  const minDate = days[0]?.date ?? today ?? '';
  // Default range: this month so far (never before the period starts).
  const activeRange = useMemo(() => {
    if (range) return range;
    if (!today || !report) return null;
    const monthStart = `${today.slice(0, 7)}-01`;
    return { from: monthStart < report.from ? report.from : monthStart, to: today };
  }, [range, today, report]);

  const pick = (date: string) => { setSelected(date); setDateNote(''); };
  /** Open the picked day's staff (all statuses) in a window. */
  const openDay = (date?: string) => { if (date) pick(date); setDayOpen(true); };
  const goToday = () => { if (today) { setSelected(today); setMode('today'); setDateNote(''); } };
  const pickTyped = (value: string) => {
    if (!value) return;
    if (byDate.get(value)?.kind === 'school') pick(value);
    else setDateNote(value < (report?.trackingFrom ?? '') ? 'Check-in had not started on that date.' : 'No school day on that date. Pick a school day.');
  };
  const step = (n: number) => {
    if (!sel) return;
    const i = schoolDates.indexOf(sel);
    const next = i < 0 ? (n < 0 ? [...schoolDates].reverse().find((d) => d < sel) : schoolDates.find((d) => d > sel)) : schoolDates[i + n];
    if (next) pick(next);
  };
  const setRangeEnd = (key: 'from' | 'to', value: string) => {
    if (!value || !activeRange || !today) return;
    const v = value > today ? today : value < minDate ? minDate : value;
    const r = { ...activeRange, [key]: v };
    if (r.from > r.to) { if (key === 'from') r.to = v; else r.from = v; }
    setRange(r);
  };

  // What the headline describes.
  const scope = useMemo(() => {
    if (!report || !today || !sel) return null;
    if (mode === 'today' || mode === 'date') {
      const date = mode === 'today' ? today : sel;
      return { single: true as const, from: date, to: date, day: byDate.get(date) ?? null };
    }
    const r = mode === 'term' ? { from: report.from, to: report.to } : activeRange!;
    return { single: false as const, from: r.from, to: r.to, sum: sumDays(days, r.from, r.to) };
  }, [report, today, sel, mode, byDate, days, activeRange]);

  const act = async (key: string, fn: () => Promise<unknown>, ok: string) => {
    setBusyId(key);
    try {
      await fn();
      toast.success(ok);
      await load(true);
    } catch (e) {
      toast.error('Not saved', e instanceof ApiError ? e.message : 'Try again.');
    } finally {
      setBusyId(null);
    }
  };

  const exportCsv = async () => {
    if (!scope) return;
    try {
      const res = await fetch(`/api/staff/clock/export?from=${scope.from}&to=${scope.to}`, { headers: { Authorization: `Bearer ${localStorage.getItem('sso_token') ?? ''}` } });
      if (!res.ok) throw new Error();
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `staff-attendance-${scope.from}${scope.to !== scope.from ? `-to-${scope.to}` : ''}.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
      toast.success('Export downloaded');
    } catch {
      toast.error('Export failed', 'Try again.');
    }
  };

  /** A person from the day report: their history, stepping through the rows on screen. */
  const openRow = (row: OverviewRow, list: OverviewRow[], o: Overview) => {
    const word = (r: OverviewRow) => (r.status === 'present' ? 'On time' : r.status === 'late' ? 'Late' : r.status === 'invalid' ? 'Marked invalid' : o.isToday ? 'Not in yet' : 'Absent');
    const nav = list.map((r) => ({ id: r.userId, name: r.name, role: r.role, note: `${long(o.date)}: ${word(r)}${r.checkIn ? ` · in ${r.checkIn}` : ''}${r.checkOut ? ` · out ${r.checkOut}` : ''}` }));
    setPerson({ id: row.userId, name: row.name, role: row.role, list: nav });
  };

  /** Staff of a period or a group: asked for only now. */
  const openPeriodStaff = async (title: string, subtitle: string, from: string, to: string, group?: ReportGroup['key']) => {
    setSheet({ title, subtitle, people: [], empty: 'Nobody in this group', loading: true });
    try {
      const res = await staffClockApi.reportStaff(from, to, group);
      setSheet({
        title, subtitle, empty: group ? 'Nobody in this group' : 'Nobody was late or absent',
        people: res.people.map((p) => ({ id: p.userId, personId: p.userId, name: p.name, meta: `${p.late} late · ${p.absent} absent${p.rate != null ? ` · ${p.rate}% attended` : ''}` })),
      });
    } catch (e) {
      setSheet(null);
      toast.error('Could not load the staff', e instanceof ApiError ? e.message : 'Try again.');
    }
  };

  const panel = sel && today && sel === today ? todayOv : dayOv && dayOv.date === sel ? dayOv : null;
  const panelDay = sel ? byDate.get(sel) ?? null : null;
  const termRate = report?.totals.rate ?? null;
  const termDelta = report ? delta(report.totals.rate, report.totals.prevRate) : null;
  const inScope = (date: string) => (mode === 'range' && activeRange ? date >= activeRange.from && date <= activeRange.to : true);
  const missingOut = todayOv?.missing?.noCheckoutToday ?? [];
  const recentOut = todayOv?.missing?.recentNoCheckout ?? [];
  const nowLabel = todayOv ? new Date(todayOv.serverNow).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '';
  const periodName = report?.term ? report.term.name : 'This period';
  const empty = !!report && report.totals.schoolDays === 0;
  const monthDays = today ? sumDays(days, `${today.slice(0, 7)}-01`, today).schoolDays : 0;

  const lead = !report || !scope ? 'Loading…'
    : mode === 'today' ? `Today · ${long(today!)}${nowLabel ? ` · updated ${nowLabel}` : ''}`
    : mode === 'date' ? long(scope.from)
    : mode === 'range' ? `${short(scope.from)} – ${short(scope.to)} · ${scope.single ? 0 : scope.sum.schoolDays} school days · ${report.staff} staff`
    : `${report.term ? `${report.term.name} · ` : ''}${short(report.from)} – ${short(report.to)} · ${report.staff} staff · ${report.totals.schoolDays} school days`;

  const headline = (() => {
    if (!report || !scope) return null;
    if (scope.single) {
      const d: ReportDay | null = scope.day;
      const isToday = scope.from === today;
      const counted = !!d && d.kind === 'school';
      return {
        kicker: isToday ? `Today · ${fmtDate(scope.from)} · live` : long(scope.from),
        live: isToday,
        value: counted ? pct(dayRate(d)) : '–',
        line: counted ? `${d.onTime + d.late} of ${d.staff} staff checked in` : d?.kind === 'off' ? 'No school on this day' : d?.kind === 'untracked' ? 'Check-in had not started yet' : 'Nothing recorded',
        split: counted ? { onTime: d.onTime, late: d.late, absent: d.absent } : { onTime: 0, late: 0, absent: 0 },
        legend: counted ? [`${d.onTime} on time`, `${d.late} late`, `${d.absent} ${isToday ? 'not in yet' : 'absent'}`] : [],
        button: isToday ? "View today's details" : "View this day's details",
        onClick: () => openDay(scope.from),
      };
    }
    const s = scope.sum;
    const share = (v: number) => (s.staffDays ? `${Math.round((v / s.staffDays) * 100)}%` : '–');
    const name = mode === 'term' ? (report.term ? `Whole term · ${report.term.name}` : 'Whole period') : `${short(scope.from)} – ${short(scope.to)}`;
    return {
      kicker: name,
      live: false,
      value: pct(s.rate, 1),
      line: s.schoolDays ? `average over ${s.schoolDays} school day${s.schoolDays === 1 ? '' : 's'}` : 'No school days with check-in in these dates',
      split: { onTime: s.onTime, late: s.late, absent: s.absent },
      legend: s.schoolDays ? [`${share(s.onTime)} on time`, `${share(s.late)} late`, `${share(s.absent)} absent`] : [],
      button: 'View late or absent staff',
      onClick: () => void openPeriodStaff(name, `${s.schoolDays} school days · ${s.late} late arrivals · ${s.absent} absences`, scope.from, scope.to),
    };
  })();

  const cutIdx = report ? report.arrivals.findIndex((b) => b.from >= report.lateAfter) : -1;
  const firstIn = panel ? panel.rows.map((r) => r.checkIn).filter((t): t is string => !!t).sort()[0] ?? null : null;
  const usualIn = panel ? medianTime(panel.rows.map((r) => r.checkIn)) : null;
  const panelRate = panelDay && panelDay.kind === 'school' ? dayRate(panelDay) : null;
  const vsTerm = delta(panelRate, termRate);
  const panelIsToday = !!sel && sel === today;
  const lateOrOut = panel ? panel.rows.filter((r) => r.status === 'late' || r.status === 'not_in').length : 0;

  return (
    <DashboardLayout>
      <div className="sc-page scr">
        <StaffClockHeader
          title="Staff attendance"
          lead={lead}
          pending={todayOv?.phones.pending.length ?? 0}
          actions={
            <>
              {mode === 'date' && sel && (
                <label className="scr-date-label">Date
                  <input className="scr-date" type="date" value={sel} min={minDate} max={today ?? undefined} onChange={(e) => pickTyped(e.target.value)} />
                </label>
              )}
              {mode === 'range' && activeRange && (
                <>
                  <label className="scr-date-label">From
                    <input className="scr-date" type="date" value={activeRange.from} min={minDate} max={today ?? undefined} onChange={(e) => setRangeEnd('from', e.target.value)} />
                  </label>
                  <label className="scr-date-label">to
                    <input className="scr-date" type="date" value={activeRange.to} min={minDate} max={today ?? undefined} onChange={(e) => setRangeEnd('to', e.target.value)} />
                  </label>
                </>
              )}
              <div className="sc-seg" role="group" aria-label="Period">
                {MODES.map(([k, label]) => (
                  <button key={k} aria-pressed={mode === k} onClick={() => (k === 'today' ? goToday() : setMode(k))}>{label}</button>
                ))}
              </div>
              <button className="sc-btn" onClick={() => void exportCsv()} disabled={!scope}><Download size={16} /> Export</button>
            </>
          }
        />

        {error && <ErrorState message={error} onRetry={() => void load()} />}
        {can(['STAFF_ATTENDANCE_ZONES_MANAGE', 'STAFF_DEVICES_MANAGE']) && <StaffClockSetup place="dashboard" />}
        {todayOv && (
          <AttentionStrip
            data={todayOv}
            canSetup={can('STAFF_ATTENDANCE_ZONES_MANAGE')}
            onReview={() => navigate('/staff/clock/people?tab=review')}
            onPhones={() => document.getElementById('sc-phones')?.scrollIntoView({ behavior: 'smooth', block: 'center' })}
          />
        )}

        {!report && !error && (
          <>
            <div className="scr-row-hero"><div className="sc-skel scr-skel-a" /><div className="sc-skel scr-skel-a" /></div>
            <div className="scr-row-hero"><div className="sc-skel scr-skel-b" /><div className="sc-skel scr-skel-b" /></div>
            <div className="scr-row-3">{[0, 1, 2].map((i) => <div key={i} className="sc-skel scr-skel-c" />)}</div>
          </>
        )}

        {report && headline && today && sel && (
          <>
            {empty && (
              <div className="sc-notice">
                <b>The report fills in as staff check in</b>
                <p>Staff check-in {report.trackingFrom < today ? `started on ${long(report.trackingFrom)}` : 'has no finished school day yet'}. Days before that are left empty and never counted as absences.</p>
              </div>
            )}

            <div className="scr-row-hero">
              <section className="sc-card scr-hero" aria-label="Attendance">
                <div className="scr-hero-main">
                  <span className="scr-kicker">{headline.live && <i className="scr-live" />}{headline.kicker}</span>
                  <b className="scr-huge sc-num" data-testid="scr-headline">{headline.value}</b>
                  <span className="scr-line-text">{headline.line}</span>
                  <SplitBar {...headline.split} />
                  {headline.legend.length > 0 && (
                    <div className="scr-legend">
                      <span className="scr-dotlabel"><i className="scr-on" />{headline.legend[0]}</span>
                      <span className="scr-dotlabel"><i className="scr-late" />{headline.legend[1]}</span>
                      <span className="scr-dotlabel"><i className="scr-abs" />{headline.legend[2]}</span>
                    </div>
                  )}
                  <span className="scr-spacer" />
                  <button type="button" className="sc-btn sc-btn-primary scr-hero-btn" onClick={headline.onClick}>{headline.button}</button>
                </div>
                <div className="scr-hero-chart">
                  <div className="scr-chart-head">
                    <span className="scr-term">
                      <small>{periodName}</small><b className="sc-num">{pct(termRate, 1)}</b>
                      {termDelta && <span className={`scr-delta${termDelta.up ? '' : ' is-down'}`} title="Against the same number of weeks just before">{termDelta.text}</span>}
                      <small>· week by week</small>
                    </span>
                    <span className="scr-dotlabel"><i className="scr-on" />{report.term ? 'This term' : 'This period'}</span>
                    {report.weeks.some((w) => w.prevRate != null) && <span className="scr-dotlabel"><i className="scr-prev" />Weeks before</span>}
                  </div>
                  <WeeklyChart weeks={report.weeks} />
                </div>
              </section>

              <section className="sc-card scr-monthcard" aria-label="This month">
                <div className="scr-card-head scr-card-head-tight">
                  <div><h2>This month · {fmtDate(today, { month: 'long' })}</h2><p className="sc-card-sub">{monthDays} school day{monthDays === 1 ? '' : 's'} so far · one square per day</p></div>
                  <HeatLegend less="Less" more="More" />
                </div>
                <MonthGrid days={days} today={today} selected={sel} onPick={pick} />
              </section>
            </div>

            <div className="scr-row-hero">
              <section className="sc-card" aria-label="The term on the calendar">
                <div className="scr-card-head">
                  <div><h2>{report.term ? 'The term on the calendar' : 'The period on the calendar'}</h2><p className="sc-card-sub">Each day is coloured by the share of staff who checked in · click a day</p></div>
                  <HeatLegend />
                </div>
                <TermCalendar days={days} selected={sel} onPick={pick} inScope={inScope} />
              </section>

              <section id="scr-day" className="sc-card scr-daycard" aria-label="Day details">
                <div className="scr-day-nav">
                  <button type="button" className="sc-btn scr-icon-btn" aria-label="Previous school day" onClick={() => step(-1)}><ChevronLeft size={18} /></button>
                  <label className="scr-grow"><span className="scr-sr">Pick a date</span>
                    <input className="scr-date scr-date-wide" type="date" value={sel} min={minDate} max={today} onChange={(e) => pickTyped(e.target.value)} />
                  </label>
                  <button type="button" className="sc-btn scr-icon-btn" aria-label="Next school day" disabled={sel >= today} onClick={() => step(1)}><ChevronRight size={18} /></button>
                  <button type="button" className={`sc-btn${panelIsToday ? ' sc-btn-primary' : ''}`} onClick={goToday}>Today</button>
                </div>
                <div>
                  <p className="sc-card-sub" style={{ margin: 0 }}>{panelIsToday ? 'Today · live' : 'Selected day'}</p>
                  <h2 className="scr-day-title">{long(sel)}</h2>
                  {dateNote && <p className="scr-warn" role="status">{dateNote}</p>}
                </div>
                {!panel || (dayLoading && !panelIsToday) ? (
                  <><div className="sc-skel" style={{ height: 54 }} /><div className="sc-skel" style={{ height: 10 }} /><div className="sc-skel" style={{ height: 76 }} /></>
                ) : (
                  <>
                    <div className="scr-big-row scr-big-row-lg"><b className="sc-num">{panel.kpis.staff ? pct((panel.kpis.checkedIn / panel.kpis.staff) * 100) : '–'}</b><span>of {panel.kpis.staff} staff checked in</span></div>
                    <SplitBar onTime={panel.kpis.onTime} late={panel.kpis.late} absent={panel.kpis.notIn} />
                    <div className="scr-legend">
                      <span className="scr-dotlabel"><i className="scr-on" />{panel.kpis.onTime} on time</span>
                      <span className="scr-dotlabel"><i className="scr-late" />{panel.kpis.late} late</span>
                      <span className="scr-dotlabel"><i className="scr-abs" />{panel.kpis.notIn} {panel.isToday ? 'not in yet' : 'absent'}</span>
                      {!!panel.kpis.dayOff && <span className="scr-dotlabel" title="Not expected this day: their own working week, or the school is closed"><i className="scr-off" />{panel.kpis.dayOff} day off</span>}
                    </div>
                    <div className="scr-tiles">
                      <div className="scr-tile"><b className="sc-num">{firstIn ?? '–'}</b><small>first check-in</small></div>
                      <div className="scr-tile"><b className="sc-num">{usualIn ?? '–'}</b><small>usual check-in</small></div>
                      <div className="scr-tile"><b className="sc-num">{vsTerm ? vsTerm.text : '–'}</b><small>against the {report.term ? 'term' : 'period'}</small></div>
                    </div>
                    <span className="scr-spacer" />
                    <button type="button" className="sc-btn sc-btn-soft scr-hero-btn" onClick={() => openDay()} data-testid="see-day-staff">
                      {lateOrOut === 0 ? `Everyone was in on time · see all ${panel.kpis.staff}` : `See all ${panel.kpis.staff} staff · ${lateOrOut} late or ${panel.isToday ? 'not in' : 'absent'}`}
                    </button>
                  </>
                )}
              </section>
            </div>

            <div className="scr-row-3">
              <section className="sc-card scr-pattern">
                <h2>By day of the week</h2><p className="sc-card-sub">Average share of staff in</p>
                <WeekdayBars weekdays={report.weekdays} />
              </section>
              <section className="sc-card scr-pattern">
                <h2>When staff arrive</h2><p className="sc-card-sub">All check-ins this {report.term ? 'term' : 'period'}, per 15 minutes</p>
                {report.arrivals.length === 0 ? <div className="scr-empty">Appears after the first check-ins.</div> : (
                  <Columns
                    label={`Check-ins per 15 minutes; late after ${report.lateAfter}`}
                    items={report.arrivals.map((b, i) => ({ key: b.from, value: b.onTime + b.late, late: b.late > 0 && b.onTime === 0, label: i % 2 === 0 ? b.from : '', tip: `${b.from}–${b.to} · ${b.onTime + b.late} check-ins${b.late ? ` (${b.late} late)` : ''}` }))}
                    cutIndex={cutIdx} cutLabel={`Late after ${report.lateAfter}`}
                  />
                )}
              </section>
              <section className="sc-card scr-pattern">
                <h2>Late arrivals per week</h2><p className="sc-card-sub">Check-ins after {report.lateAfter}{report.ownPlans ? ` (${report.ownPlans} staff: after their own start)` : ''}</p>
                {report.weeks.length === 0 ? <div className="scr-empty">Appears after the first school week.</div> : (
                  <Columns
                    label="Late arrivals per week" showValues
                    items={report.weeks.map((w, i) => ({ key: w.start, value: w.late, late: true, label: i % Math.ceil(report.weeks.length / 6) === 0 ? short(w.start) : '', tip: `Week of ${short(w.start)}: ${w.late} late arrivals` }))}
                  />
                )}
              </section>
            </div>

            <GroupCards
              groups={report.groups} staff={report.staff} ready={report.countedDays > 0}
              onView={(g) => void openPeriodStaff(g.label, `${g.rule} · ${periodName}`, report.from, report.to, g.key)}
            />

            {todayOv && (
              <div className="sc-row">
                <section className="sc-card sc-grow scr-outs" aria-label="Check-outs">
                  <h2>Check-outs</h2>
                  <p className="sc-card-sub">Staff who checked in and have no check-out</p>
                  <div className="scr-out-rows">
                    <button type="button" className="scr-out" data-kpi="noOut" onClick={() => setSheet({
                      title: 'No check-out', subtitle: long(todayOv.date), empty: todayOv.missing?.checkoutOpen === false ? `Check-out opens at ${todayOv.rules.earlyLeaveBefore}` : 'Everyone checked out',
                      people: missingOut.map((m) => ({ id: m.userId, personId: m.userId, name: m.name, date: m.date, meta: `In at ${m.checkIn ?? '—'}${m.claim ? ` · says left ${m.claim}` : ''}`, tag: m.claim ? 'To confirm' : m.autoClosed ? 'Closed' : undefined })),
                    })}>
                      <LogOut size={18} />
                      <span><b className="sc-num">{todayOv.missing?.checkoutOpen === false ? '–' : missingOut.length}</b> today</span>
                      <small>{todayOv.missing?.checkoutOpen === false ? `opens ${todayOv.rules.earlyLeaveBefore}` : `${todayOv.kpis.checkedOut} checked out`}</small>
                      <ArrowUpRight size={16} />
                    </button>
                    <button type="button" className="scr-out" data-kpi="recent" onClick={() => setSheet({
                      title: 'Missed check-outs', subtitle: 'Checked in, never checked out · last 7 days', empty: 'No missed check-outs',
                      people: recentOut.map((m) => ({ id: `${m.userId}-${m.date}`, personId: m.userId, name: m.name, date: m.date, tag: m.claim ? 'To confirm' : undefined, meta: `In at ${m.checkIn ?? '—'}${m.claim ? ` · says left ${m.claim}` : ''}`, group: fmtDate(m.date, { weekday: 'long', day: 'numeric', month: 'short' }) })),
                    })}>
                      <CalendarClock size={18} />
                      <span><b className="sc-num">{recentOut.length}</b> missed</span>
                      <small>last 7 days</small>
                      <ArrowUpRight size={16} />
                    </button>
                  </div>
                </section>

                <section id="sc-phones" className="sc-card sc-side" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                  <h2>Phones</h2>
                  <div className="sc-kpi-value" style={{ marginTop: 0 }}><b style={{ fontSize: 30 }}>{todayOv.phones.registered}</b><span>of {todayOv.phones.staff} staff registered</span></div>
                  <div style={{ display: 'flex', height: 8, gap: 2, borderRadius: 999, overflow: 'hidden' }}>
                    <div style={{ flex: todayOv.phones.registered || 0.0001, background: 'var(--primary)' }} />
                    <div style={{ flex: Math.max(0, todayOv.phones.staff - todayOv.phones.registered) || 0.0001, background: 'var(--primary-light)' }} />
                  </div>
                  {todayOv.phones.pending.map((d) => (
                    <div key={d.id} className="sc-notice">
                      <b>New {d.form_factor} waiting</b>
                      <p className="sc-clip" title={d.user_name}>{d.user_name} · {d.label}</p>
                      {can('STAFF_DEVICES_MANAGE') && (
                        <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
                          <button className="sc-btn sc-btn-primary sc-btn-sm" disabled={busyId === `d${d.id}`} onClick={() => void act(`d${d.id}`, () => staffClockApi.deviceAction(d.id, 'approve'), `${d.user_name} can check in now`)}>Approve</button>
                          <button className="sc-btn sc-btn-sm" disabled={busyId === `d${d.id}`} onClick={() => void act(`d${d.id}`, () => staffClockApi.deviceAction(d.id, 'decline'), 'Device declined')}>Decline</button>
                        </div>
                      )}
                    </div>
                  ))}
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, fontSize: 14, color: 'var(--text-secondary)' }}>
                    <span>{todayOv.phones.unregistered.length} staff have not registered</span>
                    {can('STAFF_DEVICES_MANAGE') && <Link className="sc-btn sc-btn-soft sc-btn-sm" to="/staff/clock/devices">Link & cards</Link>}
                  </div>
                </section>
              </div>
            )}
          </>
        )}

        {sheet && (sheet.loading ? (
          <div className="sc-sheet-back" onClick={() => setSheet(null)}>
            <aside className="sc-sheet" role="dialog" aria-modal="true" aria-label={sheet.title} onClick={(e) => e.stopPropagation()}>
              <header className="sc-sheet-head"><div style={{ minWidth: 0 }}><h2>{sheet.title}</h2>{sheet.subtitle && <p>{sheet.subtitle}</p>}</div></header>
              <div className="sc-sheet-list" aria-label="Loading staff">{[0, 1, 2, 3, 4].map((i) => <div key={i} className="sc-skel" style={{ height: 46, margin: '6px 0' }} />)}</div>
              <div style={{ display: 'flex', justifyContent: 'center', padding: 12 }}><Spinner /></div>
            </aside>
          </div>
        ) : (
          <ListSheet title={sheet.title} subtitle={sheet.subtitle} people={sheet.people} empty={sheet.empty} onClose={() => setSheet(null)}
            onPick={(p) => {
              if (!p.personId) return;
              const nav = sheet.people.filter((x) => x.personId).map((x) => ({ id: x.personId!, name: x.name, note: [x.group, x.meta].filter(Boolean).join(' · ') }));
              setPerson({ id: p.personId, name: p.name, date: p.date, list: nav.filter((x, i) => nav.findIndex((y) => y.id === x.id) === i) });
            }} />
        ))}
        {dayOpen && sel && today && (
          <DayReport
            overview={panel} date={sel} loading={!panel || (dayLoading && !panelIsToday)}
            onOpen={(r, list) => panel && openRow(r, list, panel)} onClose={() => setDayOpen(false)}
            onStep={(n) => step(n)} canPrev={schoolDates.some((d) => d < sel)} canNext={sel < today && schoolDates.some((d) => d > sel)}
          />
        )}
        {person && (
          <StaffHistoryModal key={person.id} initialDate={person.date} personId={person.id} name={person.name} role={person.role} instant={person.instant}
            list={person.list} onNav={(p) => setPerson((cur) => (cur ? { ...cur, id: p.id, name: p.name, role: p.role, instant: true, date: undefined } : cur))}
            onClose={() => setPerson(null)} onChanged={() => void load(true)} />
        )}
      </div>
    </DashboardLayout>
  );
};
