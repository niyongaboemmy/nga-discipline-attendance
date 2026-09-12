import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ChevronLeft, ChevronRight, CalendarDays, CalendarRange, CalendarClock,
  CheckCircle2, XCircle, Clock, ShieldCheck, CircleDashed, MapPin, BookOpen, Sun,
} from 'lucide-react';
import { DashboardLayout } from '../components/Layout/DashboardLayout';
import { ErrorState } from '../components/common/ErrorState';
import {
  getScheduleMonth, getScheduleWeek, getScheduleDay,
  type MonthResponse, type WeekResponse, type DayResponse, type CalendarSession, type AttStatus,
} from '../api/schedule';
import { ApiError } from '../api/client';
import { isoDate, clock, DOW_LABEL } from '../utils/time';

/**
 * A student's own attendance, read-only. Deliberately not the teacher/admin
 * AttendanceCalendar — there is nothing to record here, so no drawer, no
 * "overdue" alarm styling, no click-to-mark. Just: was I here, or not, for
 * each lesson — a tick, a cross, a clock, a shield, or a quiet "not yet".
 */

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
  const today = isoDate();
  const days = data.days.filter((d) => (d.dayOfWeek >= 1 && d.dayOfWeek <= 5) || d.date === today || d.sessions.length > 0);

  return (
    <div className="sc-week">
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
                all.map((s, i) => <SessionRow key={i} s={s} compact />)
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
};

/* -------------------------------------------------------------------------- */
/* Shared session row (used by week + day)                                  */
/* -------------------------------------------------------------------------- */
const SessionRow: React.FC<{ s: CalendarSession; compact?: boolean }> = ({ s, compact }) => (
  <div className={`sc-session${compact ? ' is-compact' : ''}`} style={s.color ? ({ ['--spine' as string]: s.color }) : undefined}>
    <div className="sc-session-spine" />
    <div className="sc-session-body">
      <div className="sc-session-title">
        {s.kind === 'homeroom' ? <><Sun size={14} className="sc-homeroom-icon" /> Morning check</> : <><BookOpen size={14} style={{ color: s.color || 'var(--text-secondary)' }} /> {s.subjectName}</>}
      </div>
      <div className="sc-session-meta">
        <span><Clock size={11} /> {clock(s.startTime)}{s.endTime ? `–${clock(s.endTime)}` : ''}</span>
        {s.room && <span><MapPin size={11} /> {s.room}</span>}
        {s.kind === 'subject' && !s.isMine && s.teacherName && <span>{s.teacherName}</span>}
      </div>
    </div>
    <StatusBadge status={s.ownStatus} />
  </div>
);

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
        {homeroom.map((s, i) => <SessionRow key={`hr-${i}`} s={s} />)}
      </>}
      {lessons.length > 0 && <>
        <div className="sc-group-label">Lessons</div>
        {lessons.map((s, i) => <SessionRow key={`sl-${i}`} s={s} />)}
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
          <p className="page-subtitle">Your lessons and whether you were marked present.</p>
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
