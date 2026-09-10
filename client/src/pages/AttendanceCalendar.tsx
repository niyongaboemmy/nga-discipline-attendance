import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  ChevronLeft, ChevronRight, CalendarDays, CalendarRange, CalendarClock,
  Sun, BookOpen, MapPin, Clock, PenLine, RotateCcw,
} from 'lucide-react';
import { DashboardLayout } from '../components/Layout/DashboardLayout';
import { ErrorState } from '../components/common/ErrorState';
import { StatusChip } from '../components/attendance/StatusChip';
import { RegisterDrawer } from '../components/attendance/RegisterDrawer';
import { usePermissions } from '../hooks/usePermissions';
import {
  getScheduleMonth, getScheduleWeek, getScheduleDay,
  type MonthResponse, type WeekResponse, type DayResponse, type CalendarSession,
} from '../api/schedule';
import { ApiError } from '../api/client';
import { isoDate, clock, DOW_LABEL } from '../utils/time';

type View = 'month' | 'week' | 'day';

const addDays = (d: string, n: number) => { const x = new Date(d + 'T00:00:00'); x.setDate(x.getDate() + n); return isoDate(x); };
const addMonths = (d: string, n: number) => { const x = new Date(d + 'T00:00:00'); x.setMonth(x.getMonth() + n); return isoDate(x); };
const mondayOf = (d: string) => { const x = new Date(d + 'T00:00:00'); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return isoDate(x); };
const toMin = (t: string) => { const [h, m] = t.split(':').map(Number); return (h || 0) * 60 + (m || 0); };
const nowMin = () => { const n = new Date(); return n.getHours() * 60 + n.getMinutes(); };

const monthTitle = (d: string) => new Date(d + 'T00:00:00').toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
const dayTitle = (d: string) =>
  d === isoDate() ? 'Today' : new Date(d + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
const rangeTitle = (a: string, b: string) => {
  const f = (s: string) => new Date(s + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return `${f(a)} – ${f(b)}`;
};

/* -------------------------------------------------------------------------- */
/* Month                                                                     */
/* -------------------------------------------------------------------------- */
const MonthView: React.FC<{ data: MonthResponse; cursor: string; onPickDay: (d: string) => void }> = ({
  data, cursor, onPickDay,
}) => {
  const byDate = useMemo(() => new Map(data.days.map((d) => [d.date, d])), [data]);
  const first = data.first;
  const lead = (new Date(first + 'T00:00:00').getDay() + 6) % 7; // Mon=0
  const gridStart = addDays(first, -lead);
  const cells = Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));
  const today = isoDate();
  const curMonth = cursor.slice(0, 7);

  return (
    <div className="cal-month">
      <div className="cal-month-dows">
        {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => <span key={d}>{d}</span>)}
      </div>
      <div className="cal-month-grid">
        {cells.map((date) => {
          const d = byDate.get(date);
          const outside = date.slice(0, 7) !== curMonth;
          const dow = new Date(date + 'T00:00:00').getDay();
          const weekend = dow === 0 || dow === 6;
          const total = d?.progress.total ?? 0;
          const done = d?.progress.done ?? 0;
          const past = date < today;
          const isToday = date === today;
          const pct = total ? Math.round((done / total) * 100) : 0;
          let meterCls = 'is-future';
          let ringColor = 'var(--border-strong)';
          if (total > 0) {
            if (done === total) { meterCls = 'is-done'; ringColor = 'var(--success)'; }
            else if (done > 0) { meterCls = 'is-partial'; ringColor = 'var(--warning)'; }
            else if (past || isToday) { meterCls = 'is-none'; ringColor = 'var(--danger)'; }
            else { meterCls = 'is-future'; ringColor = 'var(--border-strong)'; }
          }
          return (
            <button
              key={date}
              className={`cal-daycell${outside ? ' is-outside' : ''}${weekend ? ' is-weekend' : ''}${isToday ? ' is-today' : ''}${!past && !isToday ? ' is-future' : ''}`}
              onClick={() => onPickDay(date)}
            >
              <span className="cal-daynum">{new Date(date + 'T00:00:00').getDate()}</span>
              {total > 0 && (
                <span className={`cal-daymeter ${meterCls}`}>
                  <span className="cal-ring" style={{ ['--ring' as string]: String(pct), ['--ring-color' as string]: ringColor }} />
                  <span>{done}/{total}</span>
                </span>
              )}
              {(d?.colors.length ?? 0) > 0 && (
                <span className="cal-daydots">
                  {d!.colors.map((c, i) => <span key={i} className="cal-daydot" style={{ ['--dot' as string]: c }} />)}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
};

/* -------------------------------------------------------------------------- */
/* Week                                                                      */
/* -------------------------------------------------------------------------- */
const HOUR_H = 62;

/** Assign overlapping events to side-by-side lanes so their text never
 *  collides — the standard calendar column-packing approach. */
function packLanes<T extends { startTime: string; endTime: string }>(events: T[]) {
  const items = [...events]
    .map((ev) => ({ ev, s: toMin(ev.startTime), e: Math.max(toMin(ev.startTime) + 20, toMin(ev.endTime || ev.startTime)) }))
    .sort((a, b) => a.s - b.s || a.e - b.e);
  const laneEnds: number[] = [];
  const placed = items.map((it) => {
    let lane = laneEnds.findIndex((end) => end <= it.s);
    if (lane === -1) { lane = laneEnds.length; laneEnds.push(it.e); } else { laneEnds[lane] = it.e; }
    return { ...it, lane };
  });
  return placed.map((p) => {
    const clash = placed.filter((q) => q.s < p.e && q.e > p.s);
    return { ev: p.ev, s: p.s, e: p.e, lane: p.lane, lanes: Math.max(...clash.map((q) => q.lane)) + 1 };
  });
}

const WeekView: React.FC<{ data: WeekResponse; onOpen: (s: CalendarSession, date: string) => void }> = ({ data, onOpen }) => {
  const navigate = useNavigate();
  const { can } = usePermissions();
  const canMark = can('ATTENDANCE_MARK');
  const today = isoDate();

  // Always show the working week (Mon–Fri), plus any weekend day that has
  // lessons and always today — an empty weekday stays as an empty column
  // rather than collapsing the grid and looking like a skipped day.
  const days = data.days.filter(
    (d) => (d.dayOfWeek >= 1 && d.dayOfWeek <= 5) || d.date === today || d.sessions.some((s) => s.kind === 'subject')
  );
  const cols = days.length || 1;

  const allSubjects = days.flatMap((d) => d.sessions.filter((s) => s.kind === 'subject'));
  const hasAny = allSubjects.length > 0;

  // Grid window: fit the lessons, falling back to a normal school day.
  const minStart = hasAny ? Math.min(...allSubjects.map((s) => toMin(s.startTime))) - 15 : 7 * 60;
  const maxEnd = hasAny ? Math.max(...allSubjects.map((s) => toMin(s.endTime || s.startTime) + 25)) : 15 * 60;
  const startHour = Math.max(0, Math.floor(minStart / 60));
  const endHour = Math.min(24, Math.ceil(maxEnd / 60));
  const hours = Array.from({ length: endHour - startHour }, (_, i) => startHour + i);
  const gridTop = startHour * 60;
  const bodyH = (endHour - startHour) * HOUR_H;

  const style = { ['--cols' as string]: String(cols), ['--hour-h' as string]: `${HOUR_H}px` };
  const showNow = days.some((d) => d.date === today) && nowMin() >= gridTop && nowMin() <= endHour * 60;
  const anyHomeroom = days.some((d) => d.sessions.some((s) => s.kind === 'homeroom'));

  return (
    <div className="cal-week">
      <div className="cal-week-scroll">
        <div className="cal-week-inner" style={style}>
          <div className="cal-week-head">
            <span />
            {days.map((d) => (
              <div key={d.date} className={`cal-dh${d.date === today ? ' is-today' : ''}`}>
                <div className="cal-dh-dow">{DOW_LABEL[d.dayOfWeek]}</div>
                <div className="cal-dh-date">{new Date(d.date + 'T00:00:00').getDate()}</div>
              </div>
            ))}
          </div>

          {anyHomeroom && (
            <div className="cal-week-homeroom">
              <span className="hr-label"><Sun size={11} /> AM</span>
              {days.map((d) => {
                const hr = d.sessions.find((s) => s.kind === 'homeroom');
                if (!hr) return <div key={d.date} className="cal-hr-cell" />;
                const past = d.date < today || (d.date === today && nowMin() > toMin(hr.startTime) + 15);
                const st = hr.status === 'recorded' ? 'is-recorded' : past ? 'is-missing-past' : '';
                return (
                  <div key={d.date} className="cal-hr-cell">
                    <button className={`cal-hr-pill ${st}`} onClick={() => onOpen(hr, d.date)}>
                      {hr.status === 'recorded' ? <StatusChip kind="recorded" label="Done" /> : <><PenLine size={12} /> <span>Check</span></>}
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          <div className="cal-week-body" style={{ ...style, height: bodyH }}>
            <div className="cal-hours">
              {hours.map((h) => (
                <div key={h} className="cal-hour" style={{ height: HOUR_H }}>{String(h).padStart(2, '0')}:00</div>
              ))}
            </div>
            {days.map((d) => {
              const subjects = d.sessions.filter((s) => s.kind === 'subject');
              const laid = packLanes(subjects);
              return (
                <div key={d.date} className={`cal-daycol${d.date === today ? ' is-today' : ''}`}>
                  {subjects.length === 0 && <span className="cal-daycol-empty">No lessons</span>}
                  {laid.map(({ ev: s, s: sMin, e: eMin, lane, lanes }, i) => {
                    const top = ((sMin - gridTop) / 60) * HOUR_H;
                    const h = Math.max(30, ((eMin - sMin) / 60) * HOUR_H);
                    const past = d.date < today || (d.date === today && nowMin() > eMin);
                    const isNow = d.date === today && nowMin() >= sMin && nowMin() < eMin;
                    const cls = s.status === 'recorded' ? 'is-recorded' : past ? 'is-missing-past' : 'is-future';
                    return (
                      <button
                        key={i}
                        className={`cal-event ${cls}${isNow ? ' is-now' : ''}${lanes > 1 ? ' is-narrow' : ''}`}
                        style={{
                          top, height: h,
                          left: `calc(${(lane / lanes) * 100}% + 2px)`,
                          width: `calc(${100 / lanes}% - 4px)`,
                          ...(s.color ? { ['--spine' as string]: s.color } : {}),
                        }}
                        onClick={() => (canMark ? onOpen(s, d.date) : navigate(s.deepLink))}
                        title={`${clock(s.startTime)}–${clock(s.endTime)} · ${s.subjectName} · ${s.className}${s.room ? ` · ${s.room}` : ''}`}
                      >
                        <div className="ev-time">{clock(s.startTime)}–{clock(s.endTime)}</div>
                        <div className="ev-title">{s.subjectName}</div>
                        <div className="ev-sub">{s.className}{s.room ? ` · ${s.room}` : ''}</div>
                      </button>
                    );
                  })}
                </div>
              );
            })}
            {showNow && <div className="cal-nowline" style={{ top: ((nowMin() - gridTop) / 60) * HOUR_H }} />}
          </div>
        </div>
      </div>
    </div>
  );
};

/* -------------------------------------------------------------------------- */
/* Day (agenda)                                                              */
/* -------------------------------------------------------------------------- */
const DayView: React.FC<{ data: DayResponse; canMark: boolean; onOpen: (s: CalendarSession) => void }> = ({
  data, canMark, onOpen,
}) => {
  const navigate = useNavigate();
  const isToday = data.date === isoDate();
  const now = nowMin();
  const homeroom = data.sessions.filter((s) => s.kind === 'homeroom');
  const lessons = data.sessions.filter((s) => s.kind === 'subject');

  if (!data.timetableAvailable) {
    return (
      <div className="cal-empty">
        <CalendarDays size={30} />
        <span className="text-sm">No timetable for this day.</span>
        <span className="text-xs">Read live from the Central MIS calendar — check the academic term in the top bar.</span>
        {canMark && (
          <button className="btn btn-outline btn-sm mt-2" onClick={() => navigate('/attendance/mark')}>
            <PenLine size={14} /> Record manually
          </button>
        )}
      </div>
    );
  }
  if (data.sessions.length === 0) {
    return <div className="cal-empty"><Sun size={30} /><span className="text-sm">Nothing scheduled.</span></div>;
  }

  const Card: React.FC<{ s: CalendarSession }> = ({ s }) => {
    const start = toMin(s.startTime);
    const end = s.endTime ? toMin(s.endTime) : start + 40;
    const isNow = isToday && now >= start && now < end;
    const isFuture = isToday && now < start;
    const isPastMissing = isToday && now >= end && s.status === 'missing';
    const cls = ['agenda-card', isNow && 'is-now', isFuture && 'is-future', isPastMissing && 'is-past-missing'].filter(Boolean).join(' ');
    return (
      <div className={cls} style={s.color ? ({ ['--spine' as string]: s.color }) : undefined}>
        <div className="agenda-time">
          <span className="t-start">{clock(s.startTime)}</span>
          {s.endTime && <span className="t-end">{clock(s.endTime)}</span>}
        </div>
        <div className="agenda-spine" />
        <div className="agenda-body">
          <div className="agenda-title">
            {s.kind === 'homeroom'
              ? <><Sun size={15} className="homeroom-icon" /> Morning check · {s.className}</>
              : <><BookOpen size={15} style={{ color: s.color || 'var(--text-secondary)' }} /> {s.subjectName || 'Lesson'}</>}
          </div>
          <div className="agenda-meta">
            {s.kind === 'subject' && <span>{s.className}</span>}
            {s.room && <span><MapPin size={11} /> {s.room}</span>}
            {isNow && <span style={{ color: 'var(--primary)', fontWeight: 600 }}><Clock size={11} /> In progress</span>}
          </div>
          {s.status === 'recorded' && s.stats && (
            <div className="agenda-recorded-line">
              <StatusChip kind="present" label={`${s.stats.present} present`} />
              {s.stats.absent > 0 && <StatusChip kind="absent" label={`${s.stats.absent} absent`} />}
              {s.stats.late > 0 && <StatusChip kind="late" label={`${s.stats.late} late`} />}
              {s.stats.excused > 0 && <StatusChip kind="excused" label={`${s.stats.excused} excused`} />}
            </div>
          )}
        </div>
        <div className="agenda-action">
          {s.status === 'recorded' ? (
            <>
              <StatusChip kind="recorded" />
              {canMark && <button className="btn btn-outline btn-sm" onClick={() => onOpen(s)}><PenLine size={13} /> Edit</button>}
            </>
          ) : canMark ? (
            <button className="btn btn-primary btn-sm" onClick={() => onOpen(s)}><PenLine size={13} /> Take register</button>
          ) : (
            <StatusChip kind={s.ownStatus ?? 'missing'} label={s.ownStatus ? undefined : 'Awaiting'} />
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="agenda">
      {homeroom.length > 0 && <>
        <div className="agenda-group-label">Morning check</div>
        {homeroom.map((s) => <Card key={`hr-${s.classId}`} s={s} />)}
      </>}
      {lessons.length > 0 && <>
        <div className="agenda-group-label">Lessons</div>
        {lessons.map((s) => <Card key={`sl-${s.slotId ?? `${s.classId}-${s.subjectId}-${s.startTime}`}`} s={s} />)}
      </>}
    </div>
  );
};

/* -------------------------------------------------------------------------- */
/* Page                                                                      */
/* -------------------------------------------------------------------------- */
export const AttendanceCalendar: React.FC = () => {
  const { can } = usePermissions();
  const canMark = can('ATTENDANCE_MARK');
  const [params, setParams] = useSearchParams();

  const [view, setView] = useState<View>((params.get('view') as View) || 'week');
  const [cursor, setCursor] = useState(params.get('date') || isoDate());
  const [drawer, setDrawer] = useState<{ session: CalendarSession; date: string } | null>(null);

  const [month, setMonth] = useState<MonthResponse | null>(null);
  const [week, setWeek] = useState<WeekResponse | null>(null);
  const [day, setDay] = useState<DayResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const next = new URLSearchParams();
    next.set('view', view);
    next.set('date', cursor);
    setParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, cursor]);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      if (view === 'month') setMonth(await getScheduleMonth(cursor.slice(0, 7)));
      else if (view === 'week') setWeek(await getScheduleWeek(mondayOf(cursor)));
      else setDay(await getScheduleDay(cursor));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load the calendar.');
    } finally {
      setLoading(false);
    }
  }, [view, cursor]);

  useEffect(() => { load(); }, [load]);

  const step = (dir: -1 | 1) => {
    if (view === 'month') setCursor(addMonths(cursor, dir));
    else if (view === 'week') setCursor(addDays(cursor, dir * 7));
    else setCursor(addDays(cursor, dir));
  };

  const title = view === 'month'
    ? monthTitle(cursor)
    : view === 'week'
      ? (week ? rangeTitle(week.weekStart, week.weekEnd) : monthTitle(cursor))
      : dayTitle(cursor);

  const isDefaultCursor =
    view === 'month' ? cursor.slice(0, 7) === isoDate().slice(0, 7)
      : view === 'week' ? mondayOf(cursor) === mondayOf(isoDate())
        : cursor === isoDate();

  return (
    <DashboardLayout>
      <div className="page-header">
        <div>
          <h1 className="page-title">Attendance</h1>
          <p className="page-subtitle">
            {canMark
              ? 'Your calendar is the register. Open any lesson to take attendance.'
              : 'Your lessons and their attendance status.'}
          </p>
        </div>
      </div>

      <div className="cal-shell">
        <div className="cal-toolbar">
          <div className="cal-nav">
            <button className="icon-btn" aria-label="Previous" onClick={() => step(-1)}><ChevronLeft size={18} /></button>
            <button className="icon-btn" aria-label="Next" onClick={() => step(1)}><ChevronRight size={18} /></button>
            {!isDefaultCursor && (
              <button className="btn btn-ghost btn-sm" onClick={() => setCursor(isoDate())}>Today</button>
            )}
          </div>
          <div className="cal-title">{title}</div>
          <div className="cal-spacer" />
          <div className="cal-viewtabs" role="tablist">
            {([['month', CalendarDays, 'Month'], ['week', CalendarRange, 'Week'], ['day', CalendarClock, 'Day']] as const).map(
              ([v, Icon, label]) => (
                <button
                  key={v}
                  role="tab"
                  aria-selected={view === v}
                  className={`cal-viewtab${view === v ? ' is-active' : ''}`}
                  onClick={() => setView(v)}
                >
                  <Icon size={14} /> <span className="hide-mobile">{label}</span>
                </button>
              )
            )}
          </div>
          <button className="icon-btn" aria-label="Refresh" onClick={load}><RotateCcw size={15} /></button>
        </div>

        <div className="cal-legend">
          <span><span className="swatch is-recorded" /> Register taken</span>
          <span><span className="swatch is-missing" /> Not recorded</span>
          <span><span className="swatch is-future" /> Upcoming</span>
          <span><span className="swatch is-now" /> Now</span>
        </div>

        {loading ? (
          <div className="cal-skel" style={{ height: view === 'day' ? 320 : 520 }} />
        ) : error ? (
          <ErrorState message={error} onRetry={load} />
        ) : view === 'month' && month ? (
          <MonthView data={month} cursor={cursor} onPickDay={(d) => { setCursor(d); setView('day'); }} />
        ) : view === 'week' && week ? (
          <WeekView data={week} onOpen={(s, d) => setDrawer({ session: s, date: d })} />
        ) : view === 'day' && day ? (
          <DayView data={day} canMark={canMark} onOpen={(s) => setDrawer({ session: s, date: cursor })} />
        ) : null}
      </div>

      {drawer && (
        <RegisterDrawer
          session={drawer.session}
          date={drawer.date}
          onClose={() => setDrawer(null)}
          onSaved={load}
        />
      )}
    </DashboardLayout>
  );
};

export default AttendanceCalendar;
