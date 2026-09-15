import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ChevronLeft, ChevronRight, CalendarDays, CalendarRange, CalendarClock,
  CheckCircle2, XCircle, Clock, ShieldCheck, CircleDashed, MapPin, BookOpen, Sun,
} from 'lucide-react';
import { DashboardLayout } from '../components/Layout/DashboardLayout';
import { ErrorState } from '../components/common/ErrorState';
import { StudentSessionHoverCard, type StudentHoverTarget } from '../components/attendance/StudentSessionHoverCard';
import {
  getScheduleMonth, getScheduleWeek, getScheduleDay, sessionDetailLink,
  type MonthResponse, type WeekResponse, type DayResponse, type CalendarSession, type AttStatus,
} from '../api/schedule';
import { ApiError } from '../api/client';
import { isoDate, clock, DOW_LABEL } from '../utils/time';

/**
 * A student's own attendance, read-only. Deliberately not the teacher/admin
 * AttendanceCalendar — there is nothing to record here, so no drawer, no
 * "overdue" alarm styling, no click-to-mark. Just: was I here, or not, for
 * each lesson — a tick, a cross, a clock, a shield, or a quiet "not yet".
 * Every session is a link to its detail page (/attendance/session) for the
 * full picture — room, teacher, and their own mark, without truncation.
 */

/** Keyboard activation for the div-as-link session rows. */
const onActivate = (go: () => void) => (e: React.KeyboardEvent) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); }
};

type View = 'month' | 'week' | 'day';

const addDays = (d: string, n: number) => { const x = new Date(d + 'T00:00:00'); x.setDate(x.getDate() + n); return isoDate(x); };
const addMonths = (d: string, n: number) => { const x = new Date(d + 'T00:00:00'); x.setMonth(x.getMonth() + n); return isoDate(x); };
const mondayOf = (d: string) => { const x = new Date(d + 'T00:00:00'); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return isoDate(x); };

const monthTitle = (d: string) => new Date(d + 'T00:00:00').toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
const dayTitle = (d: string) =>
  d === isoDate() ? 'Today' : new Date(d + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
const rangeTitle = (a: string, b: string) => {
  const f = (s: string) => new Date(s + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return `${f(a)} – ${f(b)}`;
};

const STATUS_META: Record<AttStatus, { label: string; icon: React.ReactNode; className: string }> = {
  present: { label: 'Present', icon: <CheckCircle2 size={13} />, className: 'is-present' },
  absent: { label: 'Absent', icon: <XCircle size={13} />, className: 'is-absent' },
  late: { label: 'Late', icon: <Clock size={13} />, className: 'is-late' },
  excused: { label: 'Excused', icon: <ShieldCheck size={13} />, className: 'is-excused' },
};

const StatusBadge: React.FC<{ status: AttStatus | null; size?: 'sm' | 'md' }> = ({ status, size = 'sm' }) => {
  const meta = status ? STATUS_META[status] : null;
  return (
    <span className={`sc-status ${meta ? meta.className : 'is-pending'} ${size === 'md' ? 'is-md' : ''}`}>
      {meta ? meta.icon : <CircleDashed size={13} />}
      {meta ? meta.label : 'Not yet recorded'}
    </span>
  );
};

/* -------------------------------------------------------------------------- */
/* Month                                                                     */
/* -------------------------------------------------------------------------- */
const MonthView: React.FC<{ data: MonthResponse; cursor: string; onPickDay: (d: string) => void }> = ({ data, cursor, onPickDay }) => {
  const byDate = useMemo(() => new Map(data.days.map((d) => [d.date, d])), [data]);
  const lead = (new Date(data.first + 'T00:00:00').getDay() + 6) % 7;
  const gridStart = addDays(data.first, -lead);
  const cells = Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));
  const today = isoDate();
  const curMonth = cursor.slice(0, 7);

  return (
    <div className="sc-month">
      <div className="sc-month-dows">{['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => <span key={d}>{d}</span>)}</div>
      <div className="sc-month-grid">
        {cells.map((date) => {
          const d = byDate.get(date);
          const outside = date.slice(0, 7) !== curMonth;
          const isToday = date === today;
          const statuses = d?.ownStatuses ?? [];
          const hasAbsent = statuses.includes('absent');
          const hasLate = statuses.includes('late');
          const tone = statuses.length === 0 ? '' : hasAbsent ? 'is-absent' : hasLate ? 'is-late' : 'is-present';
          return (
            <button key={date} className={`sc-daycell${outside ? ' is-outside' : ''}${isToday ? ' is-today' : ''}`} onClick={() => onPickDay(date)}>
              <span className="sc-daynum">{new Date(date + 'T00:00:00').getDate()}</span>
              {statuses.length > 0 && (
                <span className={`sc-daydot ${tone}`} title={`${statuses.length} lesson${statuses.length === 1 ? '' : 's'}`} />
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
const WeekView: React.FC<{ data: WeekResponse }> = ({ data }) => {
  const navigate = useNavigate();
  const today = isoDate();
  // School week: Monday–Friday only. A weekend column with "No lessons" adds
  // width and noise for no reason — a real Saturday/Sunday lesson is rare
  // enough that it doesn't earn a permanent seventh/sixth column.
  const days = data.days.filter((d) => d.dayOfWeek >= 1 && d.dayOfWeek <= 5);

  // Hover/focus preview — the compact card truncates a long subject name to
  // fit the column; hovering (or tabbing to it) reveals the full detail in a
  // floating card instead of forcing every column wider to fit the longest
  // name in the whole week. A short intent delay avoids popping cards open
  // on a mouse just passing through, and holds open when moving from the
  // trigger onto the card itself.
  const [hover, setHover] = useState<StudentHoverTarget | null>(null);
  const showTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const scheduleShow = useCallback((session: CalendarSession, date: string, rect: DOMRect) => {
    clearTimeout(hideTimer.current);
    clearTimeout(showTimer.current);
    showTimer.current = setTimeout(() => setHover({ session, date, rect }), 150);
  }, []);
  const scheduleHide = useCallback(() => {
    clearTimeout(showTimer.current);
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setHover(null), 150);
  }, []);
  const cancelHide = useCallback(() => clearTimeout(hideTimer.current), []);
  useEffect(() => () => { clearTimeout(showTimer.current); clearTimeout(hideTimer.current); }, []);
  // The card is positioned from a one-off snapshot, not tracked live — close
  // it on scroll rather than let it drift from its trigger.
  useEffect(() => {
    if (!hover) return;
    const close = () => setHover(null);
    window.addEventListener('scroll', close, true);
    return () => window.removeEventListener('scroll', close, true);
  }, [hover]);

  return (
    <div className="sc-week">
      {/* eslint-disable react-hooks/refs -- scheduleShow/scheduleHide/cancelHide
          close over the show/hide timer refs, but are only ever invoked from
          the mouse/focus event handlers below (or on scroll-close), never
          during render. This is the identical, already-shipped hover-intent
          pattern from AttendanceCalendar.tsx's WeekView, which this
          experimental React Compiler diagnostic does not flag there — a
          false positive here, not a real bug (confirmed: useCallback-wrapping
          the handlers made no difference, ruling out an identity/closure
          explanation). */}
      {days.map((d) => {
        const homeroom = d.sessions.filter((s) => s.kind === 'homeroom');
        const lessons = [...d.sessions.filter((s) => s.kind === 'subject')].sort((a, b) => a.startTime.localeCompare(b.startTime));
        const all = [...homeroom, ...lessons];
        return (
          <div key={d.date} className={`sc-week-day${d.date === today ? ' is-today' : ''}`}>
            <div className="sc-week-day-head">
              <span className="sc-week-dow">{DOW_LABEL[d.dayOfWeek]}</span>
              <span className="sc-week-date">{new Date(d.date + 'T00:00:00').getDate()}</span>
            </div>
            <div className="sc-week-sessions">
              {all.length === 0 ? (
                <span className="sc-week-empty">No lessons</span>
              ) : (
                all.map((s, i) => (
                  // Inlined rather than delegated to <SessionRow> — the hover
                  // handlers below read/write a ref (the show/hide timers),
                  // which must stay on the actual native element rather than
                  // wrap a separate child component.
                  <div
                    key={i}
                    className="sc-session is-compact is-clickable"
                    style={s.color ? ({ ['--spine' as string]: s.color }) : undefined}
                    role="link"
                    tabIndex={0}
                    aria-label={`${s.kind === 'homeroom' ? 'Morning check' : s.subjectName} — view details`}
                    onClick={() => navigate(sessionDetailLink(s, d.date))}
                    onKeyDown={onActivate(() => navigate(sessionDetailLink(s, d.date)))}
                    onMouseEnter={(e) => scheduleShow(s, d.date, e.currentTarget.getBoundingClientRect())}
                    onMouseLeave={scheduleHide}
                    onFocus={(e) => scheduleShow(s, d.date, e.currentTarget.getBoundingClientRect())}
                    onBlur={scheduleHide}
                  >
                    <div className="sc-session-body">
                      <div className="sc-session-title">
                        {s.kind === 'homeroom'
                          ? <><Sun size={14} className="sc-homeroom-icon" /> <span>Morning check</span></>
                          : <><BookOpen size={14} style={{ color: s.color || 'var(--text-secondary)' }} /> <span>{s.subjectName}</span></>}
                      </div>
                      <div className="sc-session-meta">
                        <span><Clock size={11} /> {clock(s.startTime)}{s.endTime ? `–${clock(s.endTime)}` : ''}</span>
                        {s.room && <span><MapPin size={11} /> {s.room}</span>}
                        {s.kind === 'subject' && !s.isMine && s.teacherName && <span className="sc-session-teacher">{s.teacherName}</span>}
                      </div>
                    </div>
                    {/* Inlined (not <StatusBadge>) for the same reason as
                        above — no custom component under the ref-driven
                        hover handlers on this element. */}
                    <span className={`sc-status ${s.ownStatus ? STATUS_META[s.ownStatus].className : 'is-pending'}`}>
                      {s.ownStatus ? STATUS_META[s.ownStatus].icon : <CircleDashed size={13} />}
                      {s.ownStatus ? STATUS_META[s.ownStatus].label : 'Not yet recorded'}
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>
        );
      })}

      {hover && (
        <StudentSessionHoverCard target={hover} onMouseEnter={cancelHide} onMouseLeave={scheduleHide} />
      )}
      {/* eslint-enable react-hooks/refs */}
    </div>
  );
};

/* -------------------------------------------------------------------------- */
/* Shared session row (used by week + day)                                  */
/* -------------------------------------------------------------------------- */
const SessionRow: React.FC<{ s: CalendarSession; date: string; compact?: boolean }> = ({ s, date, compact }) => {
  const navigate = useNavigate();
  const go = () => navigate(sessionDetailLink(s, date));
  return (
  <div
    className={`sc-session is-clickable${compact ? ' is-compact' : ''}`}
    style={s.color ? ({ ['--spine' as string]: s.color }) : undefined}
    role="link"
    tabIndex={0}
    aria-label={`${s.kind === 'homeroom' ? 'Morning check' : s.subjectName} — view details`}
    onClick={go}
    onKeyDown={onActivate(go)}
  >
    <div className="sc-session-body">
      <div className="sc-session-title">
        {s.kind === 'homeroom'
          ? <><Sun size={14} className="sc-homeroom-icon" /> <span>Morning check</span></>
          : <><BookOpen size={14} style={{ color: s.color || 'var(--text-secondary)' }} /> <span>{s.subjectName}</span></>}
      </div>
      <div className="sc-session-meta">
        <span><Clock size={11} /> {clock(s.startTime)}{s.endTime ? `–${clock(s.endTime)}` : ''}</span>
        {s.room && <span><MapPin size={11} /> {s.room}</span>}
        {s.kind === 'subject' && !s.isMine && s.teacherName && <span className="sc-session-teacher">{s.teacherName}</span>}
      </div>
    </div>
    <StatusBadge status={s.ownStatus} />
  </div>
  );
};

/* -------------------------------------------------------------------------- */
/* Day (agenda)                                                              */
/* -------------------------------------------------------------------------- */
const DayView: React.FC<{ data: DayResponse }> = ({ data }) => {
  const homeroom = data.sessions.filter((s) => s.kind === 'homeroom');
  const lessons = [...data.sessions.filter((s) => s.kind === 'subject')].sort((a, b) => a.startTime.localeCompare(b.startTime));

  if (!data.timetableAvailable) {
    return <div className="sc-empty"><CalendarDays size={30} /><span className="text-sm">No timetable for this day.</span></div>;
  }
  if (data.sessions.length === 0) {
    return <div className="sc-empty"><Sun size={30} /><span className="text-sm">Nothing scheduled.</span></div>;
  }

  return (
    <div className="sc-day">
      {homeroom.length > 0 && <>
        <div className="sc-group-label">Morning check</div>
        {homeroom.map((s, i) => <SessionRow key={`hr-${i}`} s={s} date={data.date} />)}
      </>}
      {lessons.length > 0 && <>
        <div className="sc-group-label">Lessons</div>
        {lessons.map((s, i) => <SessionRow key={`sl-${i}`} s={s} date={data.date} />)}
      </>}
    </div>
  );
};

/* -------------------------------------------------------------------------- */
/* Page                                                                      */
/* -------------------------------------------------------------------------- */
export const StudentCalendar: React.FC = () => {
  const [view, setView] = useState<View>('week');
  const [cursor, setCursor] = useState(isoDate());
  const [month, setMonth] = useState<MonthResponse | null>(null);
  const [week, setWeek] = useState<WeekResponse | null>(null);
  const [day, setDay] = useState<DayResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      if (view === 'month') setMonth(await getScheduleMonth(cursor.slice(0, 7)));
      else if (view === 'week') setWeek(await getScheduleWeek(mondayOf(cursor)));
      else setDay(await getScheduleDay(cursor));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load your attendance calendar.');
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
          <h1 className="page-title">Attendance Calendar</h1>
          <p className="page-subtitle">Your lessons and whether you were marked present. Click any lesson for its details.</p>
        </div>
      </div>

      <div className="cal-shell">
        <div className="cal-toolbar">
          <div className="cal-nav">
            <button className="icon-btn" aria-label="Previous" onClick={() => step(-1)}><ChevronLeft size={18} /></button>
            <button className="icon-btn" aria-label="Next" onClick={() => step(1)}><ChevronRight size={18} /></button>
            {!isDefaultCursor && <button className="btn btn-ghost btn-sm" onClick={() => setCursor(isoDate())}>Today</button>}
          </div>
          <div className="cal-title">{title}</div>
          <div className="cal-spacer" />
          <div className="cal-viewtabs" role="tablist">
            {([['month', CalendarDays, 'Month'], ['week', CalendarRange, 'Week'], ['day', CalendarClock, 'Day']] as const).map(([v, Icon, label]) => (
              <button key={v} role="tab" aria-selected={view === v} className={`cal-viewtab${view === v ? ' is-active' : ''}`} onClick={() => setView(v)}>
                <Icon size={14} /> <span className="hide-mobile">{label}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="sc-legend">
          {(Object.keys(STATUS_META) as AttStatus[]).map((k) => (
            <span key={k}>{STATUS_META[k].icon} {STATUS_META[k].label}</span>
          ))}
          <span><CircleDashed size={13} /> Not yet recorded</span>
        </div>

        {loading ? (
          <div className="cal-skel" style={{ height: view === 'day' ? 320 : 480 }} />
        ) : error ? (
          <ErrorState message={error} onRetry={load} />
        ) : view === 'month' && month ? (
          <MonthView data={month} cursor={cursor} onPickDay={(d) => { setCursor(d); setView('day'); }} />
        ) : view === 'week' && week ? (
          <WeekView data={week} />
        ) : view === 'day' && day ? (
          <DayView data={day} />
        ) : null}
      </div>
    </DashboardLayout>
  );
};

export default StudentCalendar;
