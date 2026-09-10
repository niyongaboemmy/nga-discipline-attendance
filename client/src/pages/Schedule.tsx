import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronLeft, ChevronRight, CalendarRange } from 'lucide-react';
import { DashboardLayout } from '../components/Layout/DashboardLayout';
import { LoadingSpinner } from '../components/common/LoadingSpinner';
import { ErrorState } from '../components/common/ErrorState';
import { usePermissions } from '../hooks/usePermissions';
import { getScheduleWeek, type WeekResponse } from '../api/schedule';
import { ApiError } from '../api/client';
import { isoDate, clock, DOW_LABEL } from '../utils/time';

const mondayOf = (d: string) => {
  const dt = new Date(d + 'T00:00:00');
  const back = (dt.getDay() + 6) % 7;
  dt.setDate(dt.getDate() - back);
  return isoDate(dt);
};
const shift = (d: string, days: number) => {
  const dt = new Date(d + 'T00:00:00');
  dt.setDate(dt.getDate() + days);
  return isoDate(dt);
};
const rangeLabel = (a: string, b: string) => {
  const f = (s: string) => new Date(s + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return `${f(a)} – ${f(b)}`;
};

export const Schedule: React.FC = () => {
  const navigate = useNavigate();
  const { can } = usePermissions();
  const canMark = can('ATTENDANCE_MARK');
  const [weekStart, setWeekStart] = useState(mondayOf(isoDate()));
  const [data, setData] = useState<WeekResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const today = isoDate();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await getScheduleWeek(weekStart));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load your schedule.');
    } finally {
      setLoading(false);
    }
  }, [weekStart]);

  useEffect(() => { load(); }, [load]);

  return (
    <DashboardLayout>
      <div className="page-header">
        <div>
          <h1 className="page-title">Schedule</h1>
          <p className="page-subtitle">Your week from the Central MIS calendar. A dot marks whether a register was taken.</p>
        </div>
      </div>

      <div className="week-nav">
        <button className="btn btn-outline btn-sm" onClick={() => setWeekStart(shift(weekStart, -7))}>
          <ChevronLeft size={14} /> Prev
        </button>
        <div className="flex items-center gap-2">
          <CalendarRange size={15} />
          <strong className="text-sm">{data ? rangeLabel(data.weekStart, data.weekEnd) : '…'}</strong>
          {weekStart !== mondayOf(today) && (
            <button className="btn btn-ghost btn-sm" onClick={() => setWeekStart(mondayOf(today))}>This week</button>
          )}
        </div>
        <button className="btn btn-outline btn-sm" onClick={() => setWeekStart(shift(weekStart, 7))}>
          Next <ChevronRight size={14} />
        </button>
      </div>

      {loading ? (
        <div style={{ padding: '64px 0' }}><LoadingSpinner /></div>
      ) : error ? (
        <ErrorState message={error} onRetry={load} />
      ) : (
        <div className="week-grid">
          {(data?.days ?? [])
            .filter((d) => d.sessions.some((s) => s.kind === 'subject') || d.date === today)
            .map((d) => (
              <div key={d.date} className={`week-col${d.date === today ? ' is-today' : ''}`}>
                <div className="week-col-head">
                  <span>{DOW_LABEL[d.dayOfWeek]}</span>
                  <span>{new Date(d.date + 'T00:00:00').getDate()}</span>
                </div>
                <div className="week-col-body">
                  {d.sessions.filter((s) => s.kind === 'subject').length === 0 ? (
                    <div className="week-empty">No lessons</div>
                  ) : (
                    d.sessions
                      .filter((s) => s.kind === 'subject')
                      .map((s, i) => (
                        <button
                          key={i}
                          className="week-slot"
                          style={s.color ? ({ ['--spine' as string]: s.color }) : undefined}
                          onClick={() => canMark ? navigate(s.deepLink) : undefined}
                          disabled={!canMark}
                        >
                          <div className="ws-time">{clock(s.startTime)}{s.endTime ? `–${clock(s.endTime)}` : ''}</div>
                          <div className="ws-title">
                            {s.subjectName || 'Lesson'}
                            <span className={`ws-dot is-${s.status}`} title={s.status === 'recorded' ? 'Register taken' : 'Not recorded'} />
                          </div>
                          <div className="ws-time">{s.className}</div>
                        </button>
                      ))
                  )}
                </div>
              </div>
            ))}
        </div>
      )}
    </DashboardLayout>
  );
};

export default Schedule;
