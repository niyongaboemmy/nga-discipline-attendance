import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  CalendarDays, ChevronLeft, ChevronRight, Sun, BookOpen, MapPin, Clock,
  PenLine, RotateCcw, CalendarRange,
} from 'lucide-react';
import { DashboardLayout } from '../components/Layout/DashboardLayout';
import { LoadingSpinner } from '../components/common/LoadingSpinner';
import { ErrorState } from '../components/common/ErrorState';
import { StatusChip } from '../components/attendance/StatusChip';
import { usePermissions } from '../hooks/usePermissions';
import { useAuth } from '../context/AuthContext';
import { getScheduleDay, type DaySession, type DayResponse } from '../api/schedule';
import { ApiError } from '../api/client';
import { isoDate, clock } from '../utils/time';

const addDays = (d: string, n: number) => {
  const dt = new Date(d + 'T00:00:00');
  dt.setDate(dt.getDate() + n);
  return isoDate(dt);
};
const nowMinutes = () => {
  const n = new Date();
  return n.getHours() * 60 + n.getMinutes();
};
const toMin = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
};
const prettyDate = (d: string) =>
  new Date(d + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });

const SessionCard: React.FC<{
  s: DaySession;
  isToday: boolean;
  canMark: boolean;
  onOpen: (s: DaySession) => void;
}> = ({ s, isToday, canMark, onOpen }) => {
  const start = toMin(s.startTime);
  const end = s.endTime ? toMin(s.endTime) : start + 40;
  const now = nowMinutes();
  const isNow = isToday && now >= start && now < end;
  const isFuture = isToday && now < start;
  const isPastMissing = isToday && now >= end && s.status === 'missing';

  const cls = [
    'agenda-card',
    isNow && 'is-now',
    isFuture && 'is-future',
    isPastMissing && 'is-past-missing',
  ].filter(Boolean).join(' ');

  const spine = s.color || undefined;

  return (
    <div className={cls} style={spine ? ({ ['--spine' as string]: spine }) : undefined}>
      <div className="agenda-time">
        <span className="t-start">{clock(s.startTime)}</span>
        {s.endTime && <span className="t-end">{clock(s.endTime)}</span>}
      </div>
      <div className="agenda-spine" />
      <div className="agenda-body">
        <div className="agenda-title">
          {s.kind === 'homeroom'
            ? <><Sun size={15} className="homeroom-icon" /> Morning check · {s.className}</>
            : <><BookOpen size={15} style={{ color: spine || 'var(--text-secondary)' }} /> {s.subjectName || 'Lesson'}</>}
        </div>
        <div className="agenda-meta">
          {s.kind === 'subject' && <span>{s.className}</span>}
          {s.room && <span><MapPin size={11} /> {s.room}</span>}
          {isNow && <span style={{ color: 'var(--primary)', fontWeight: 600 }}><Clock size={11} /> In progress</span>}
        </div>
        {s.status === 'recorded' && (
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
            {canMark && (
              <button className="btn btn-outline btn-sm" onClick={() => onOpen(s)}>
                <PenLine size={13} /> Edit
              </button>
            )}
          </>
        ) : canMark ? (
          <button className="btn btn-primary btn-sm" onClick={() => onOpen(s)}>
            <PenLine size={13} /> Take register
          </button>
        ) : (
          <StatusChip kind={s.ownStatus ?? 'missing'} label={s.ownStatus ? undefined : 'Awaiting'} />
        )}
      </div>
    </div>
  );
};

export const Today: React.FC = () => {
  const navigate = useNavigate();
  const { can } = usePermissions();
  const { user } = useAuth();
  const canMark = can('ATTENDANCE_MARK');
  const [date, setDate] = useState(isoDate());
  const [data, setData] = useState<DayResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await getScheduleDay(date));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load your schedule.');
    } finally {
      setLoading(false);
    }
  }, [date]);

  useEffect(() => { load(); }, [load]);

  const isToday = date === isoDate();
  const { homeroom, lessons } = useMemo(() => {
    const sessions = data?.sessions ?? [];
    return {
      homeroom: sessions.filter((s) => s.kind === 'homeroom'),
      lessons: sessions.filter((s) => s.kind === 'subject'),
    };
  }, [data]);

  const open = (s: DaySession) => navigate(s.deepLink);

  return (
    <DashboardLayout>
      <div className="page-header">
        <div>
          <h1 className="page-title">{isToday ? 'Today' : prettyDate(date)}</h1>
          <p className="page-subtitle">
            {canMark
              ? 'Your timetable for the day — take each register straight from its lesson.'
              : 'Your lessons for the day and their attendance.'}
          </p>
        </div>
        <button className="btn btn-outline btn-sm" onClick={() => navigate('/schedule')}>
          <CalendarRange size={14} /> Full week
        </button>
      </div>

      <div className="today-head">
        <div className="today-datestrip">
          <button className="icon-btn" aria-label="Previous day" onClick={() => setDate(addDays(date, -1))}>
            <ChevronLeft size={18} />
          </button>
          <div className="input-with-icon">
            <CalendarDays className="field-icon" size={15} />
            <input
              className="input"
              type="date"
              value={date}
              aria-label="Schedule date"
              onChange={(e) => setDate(e.target.value || isoDate())}
              style={{ paddingLeft: 34 }}
            />
          </div>
          <button className="icon-btn" aria-label="Next day" onClick={() => setDate(addDays(date, 1))}>
            <ChevronRight size={18} />
          </button>
          {!isToday && (
            <button className="btn btn-ghost btn-sm" onClick={() => setDate(isoDate())}>Today</button>
          )}
        </div>

        {data && data.progress.total > 0 && (
          <div className="today-progress">
            <span>{data.progress.done} of {data.progress.total} registers done</span>
            <div className="progress">
              <div
                className={`progress-fill ${data.progress.done === data.progress.total ? 'is-success' : ''}`}
                style={{ width: `${(data.progress.done / data.progress.total) * 100}%` }}
              />
            </div>
            <button className="icon-btn" aria-label="Refresh" onClick={load}><RotateCcw size={15} /></button>
          </div>
        )}
      </div>

      {loading ? (
        <div style={{ padding: '64px 0' }}><LoadingSpinner /></div>
      ) : error ? (
        <ErrorState message={error} onRetry={load} />
      ) : !data?.timetableAvailable ? (
        <div className="card">
          <div className="empty-state" style={{ padding: '56px 20px' }}>
            <CalendarDays size={30} />
            <span className="text-sm">No timetable is available for {user?.name?.split(' ')[0] ?? 'you'} on this day.</span>
            <span className="text-xs text-secondary mt-1">
              The schedule is read live from the Central MIS calendar. If you expect lessons here,
              check the academic term in the top bar.
            </span>
            {canMark && (
              <button className="btn btn-outline btn-sm mt-3" onClick={() => navigate('/attendance/mark')}>
                <PenLine size={14} /> Record a register manually
              </button>
            )}
          </div>
        </div>
      ) : data.sessions.length === 0 ? (
        <div className="card">
          <div className="empty-state" style={{ padding: '56px 20px' }}>
            <Sun size={30} />
            <span className="text-sm">Nothing scheduled for {prettyDate(date)}.</span>
          </div>
        </div>
      ) : (
        <div className="agenda">
          {homeroom.length > 0 && (
            <>
              <div className="agenda-group-label">Morning check</div>
              {homeroom.map((s) => (
                <SessionCard key={`hr-${s.classId}`} s={s} isToday={isToday} canMark={canMark} onOpen={open} />
              ))}
            </>
          )}
          {lessons.length > 0 && (
            <>
              <div className="agenda-group-label">Lessons</div>
              {lessons.map((s) => (
                <SessionCard key={`sl-${s.slotId ?? `${s.classId}-${s.subjectId}-${s.startTime}`}`} s={s} isToday={isToday} canMark={canMark} onOpen={open} />
              ))}
            </>
          )}
        </div>
      )}
    </DashboardLayout>
  );
};

export default Today;
