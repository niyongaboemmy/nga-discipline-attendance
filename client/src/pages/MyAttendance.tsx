import React, { useState, useEffect, useMemo } from 'react';
import { DashboardLayout } from '../components/Layout/DashboardLayout';
import { LoadingSpinner } from '../components/common/LoadingSpinner';
import { ErrorState } from '../components/common/ErrorState';
import { apiGet, ApiError } from '../api/client';
import { AlertTriangle, TrendingUp, CalendarClock, MapPin, User } from 'lucide-react';

interface AttendanceRecord {
  id: number;
  class_id: string;
  class_name: string;
  session_date: string;
  period: string;
  status: 'present' | 'absent' | 'late' | 'excused';
  notes: string;
}
interface Period { time: string; subject: string; room: string; teacher: string }
interface DaySchedule { day: string; periods: Period[] }

const rateClass = (r: number) => (r >= 90 ? 'is-success' : r >= 80 ? 'is-warning' : 'is-danger');
const tier = (r: number) => (r >= 90 ? { label: 'safe', cls: 'badge-success' } : r >= 80 ? { label: 'warning', cls: 'badge-warning' } : { label: 'at risk', cls: 'badge-danger' });
const mondayOf = (d: Date) => { const x = new Date(d); const day = (x.getDay() + 6) % 7; x.setDate(x.getDate() - day); return x.toISOString().split('T')[0]; };
const todayName = new Date().toLocaleDateString('en-US', { weekday: 'long' });

type Tab = 'history' | 'schedule';

/** The single "my attendance" destination — merges what used to be three
 *  separate pages (MyAttendance, Analytics, Schedule): presence summary,
 *  weekly trend + at-risk courses, session history, and the weekly
 *  timetable, all in one place instead of scattered across the nav. */
export const MyAttendance: React.FC = () => {
  const [records, setRecords] = useState<AttendanceRecord[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('history');
  const [schedule, setSchedule] = useState<DaySchedule[]>([]);
  const [scheduleLoading, setScheduleLoading] = useState(false);
  const [scheduleLoaded, setScheduleLoaded] = useState(false);

  const load = async () => {
    setLoading(true); setError(null);
    try {
      const res = await apiGet<AttendanceRecord[]>('/api/attendance/me');
      setRecords(res.data ?? []);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load your attendance.');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, []);

  // Schedule is fetched lazily the first time its tab is opened — it depends
  // on the class derived from attendance history, so it can't run before
  // that first fetch resolves anyway.
  useEffect(() => {
    if (tab !== 'schedule' || scheduleLoaded || !records) return;
    (async () => {
      setScheduleLoading(true);
      try {
        const classId = records[0]?.class_id || '';
        const path = classId ? `/api/mis/schedule?class_id=${classId}` : '/api/mis/schedule';
        const res = await apiGet<DaySchedule[]>(path);
        setSchedule(res.data ?? []);
      } catch (err) {
        console.error('Error fetching schedule:', err);
      } finally {
        setScheduleLoading(false);
        setScheduleLoaded(true);
      }
    })();
  }, [tab, scheduleLoaded, records]);

  const total = records?.length ?? 0;
  const present = records?.filter((r) => r.status === 'present').length ?? 0;
  const late = records?.filter((r) => r.status === 'late').length ?? 0;
  const excused = records?.filter((r) => r.status === 'excused').length ?? 0;
  const absent = records?.filter((r) => r.status === 'absent').length ?? 0;
  const rate = total > 0 ? Math.round(((present + late + excused) / total) * 100) : 100;
  const isLow = rate < 80;

  const segs = [
    { n: present, c: 'var(--success)' }, { n: late, c: 'var(--warning)' },
    { n: excused, c: 'var(--info)' }, { n: absent, c: 'var(--danger)' },
  ].filter((s) => s.n > 0);

  // From Analytics.tsx: per-course breakdown, weekly trend, at-risk courses.
  const derived = useMemo(() => {
    const recs = records || [];
    const courses = Object.values(recs.reduce((acc, r) => {
      acc[r.class_name] = acc[r.class_name] || { className: r.class_name, total: 0, attended: 0 };
      acc[r.class_name].total += 1;
      if (r.status !== 'absent') acc[r.class_name].attended += 1;
      return acc;
    }, {} as Record<string, { className: string; total: number; attended: number }>))
      .map((c) => ({ ...c, rate: Math.round((c.attended / c.total) * 100) }))
      .sort((a, b) => a.rate - b.rate);

    const weekMap = recs.reduce((acc, r) => {
      const k = mondayOf(new Date(r.session_date));
      acc[k] = acc[k] || { total: 0, ok: 0 };
      acc[k].total += 1; if (r.status !== 'absent') acc[k].ok += 1;
      return acc;
    }, {} as Record<string, { total: number; ok: number }>);
    const weeks = Object.entries(weekMap).sort(([a], [b]) => a.localeCompare(b)).slice(-5)
      .map(([k, v]) => ({ label: new Date(k).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), rate: Math.round((v.ok / v.total) * 100) }));

    return { courses, weeks, atRisk: courses.filter((c) => c.rate < 80) };
  }, [records]);

  return (
    <DashboardLayout>
      <div className="page-header">
        <div>
          <h1 className="page-title">My Attendance</h1>
          <p className="page-subtitle">Your presence, trends, and weekly schedule.</p>
        </div>
        <span className="text-sm text-secondary" style={{ marginTop: '6px' }}>{total} sessions recorded</span>
      </div>

      {loading ? (
        <div style={{ padding: '80px 0' }}><LoadingSpinner /></div>
      ) : error ? (
        <ErrorState message={error} onRetry={load} />
      ) : (
        <>
          {/* Summary */}
          <div className="card card-pad mb-4">
            <div className="flex items-center justify-between flex-wrap gap-4 mb-4">
              <div className="flex items-end gap-2">
                <span style={{ fontSize: '36px', fontWeight: 700, letterSpacing: '-0.03em', lineHeight: 1, color: isLow ? 'var(--danger)' : 'var(--success)' }}>{rate}%</span>
                <span className="text-secondary text-sm mb-1">presence rate</span>
              </div>
              <span className={`badge ${isLow ? 'badge-danger' : 'badge-success'}`}>{isLow ? 'Below minimum' : 'Good standing'}</span>
            </div>
            {segs.length > 0 && (
              <div className="flex mb-4" style={{ height: '10px', gap: '2px', borderRadius: 'var(--radius-full)', overflow: 'hidden' }}>
                {segs.map((s, i) => <div key={i} style={{ flex: s.n, background: s.c }} />)}
              </div>
            )}
            <div className="grid grid-stats" style={{ gap: '12px' }}>
              {[['Present', present, 'text-success'], ['Late', late, 'text-warning'], ['Excused', excused, 'text-info'], ['Absent', absent, 'text-danger']].map(([l, v, cls]) => (
                <div key={l as string}>
                  <div className={`text-2xl font-bold ${cls}`}>{v as number}</div>
                  <div className="text-xs text-secondary">{l as string}</div>
                </div>
              ))}
            </div>
          </div>

          {isLow && (
            <div className="alert alert-danger mb-4">
              <AlertTriangle size={16} />
              <span>Your presence rate is below the 80% minimum. Please contact your instructor.</span>
            </div>
          )}

          {total > 0 && (
            <div className="grid grid-2 mb-4" style={{ gap: '16px' }}>
              <div className="card card-pad">
                <div className="flex items-center gap-2 mb-3"><TrendingUp size={16} className="text-brand" /><span className="section-title">Weekly trend</span></div>
                {derived.weeks.length === 0 ? (
                  <p className="text-sm text-secondary">Not enough data yet.</p>
                ) : (
                  <div className="flex items-end gap-2" style={{ height: '90px' }}>
                    {derived.weeks.map((d) => (
                      <div key={d.label} className="flex flex-col items-center gap-1" style={{ flex: 1 }}>
                        <div className="w-full" style={{ background: 'var(--primary)', borderRadius: '4px 4px 0 0', height: `${Math.max(d.rate, 6)}%`, opacity: 0.85 }} />
                        <span className="text-xs text-secondary">{d.label}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="card card-pad">
                <div className="flex items-center gap-2 mb-2"><AlertTriangle size={16} className="text-danger" /><span className="section-title">Action items</span></div>
                {derived.atRisk.length === 0 ? (
                  <p className="text-sm text-secondary">No courses below the threshold. Nice work.</p>
                ) : (
                  <ul style={{ paddingLeft: '16px', margin: 0 }} className="text-sm text-secondary">
                    {derived.atRisk.map((c) => (
                      <li key={c.className}>{c.className} is at <strong className="text-danger">{c.rate}%</strong></li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}

          {/* History / Schedule */}
          <div className="segmented mb-4" style={{ maxWidth: '280px' }}>
            <button type="button" className={`segmented-btn${tab === 'history' ? ' is-active' : ''}`} onClick={() => setTab('history')}>History</button>
            <button type="button" className={`segmented-btn${tab === 'schedule' ? ' is-active' : ''}`} onClick={() => setTab('schedule')}>Schedule</button>
          </div>

          {tab === 'history' ? (
            <div className="card">
              <div className="card-header"><span className="section-title">Session history</span></div>
              {total === 0 ? (
                <div className="empty-state">No attendance records yet.</div>
              ) : (
                <div className="table-wrap">
                  <table className="table table--zebra">
                    <thead>
                      <tr><th>Class</th><th>Date</th><th>Period</th><th>Status</th><th>Notes</th></tr>
                    </thead>
                    <tbody>
                      {records!.map((r) => (
                        <tr key={r.id}>
                          <td className="font-medium">{r.class_name}</td>
                          <td>{new Date(r.session_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</td>
                          <td className="text-secondary">{r.period}</td>
                          <td><span className={`badge badge-${r.status}`}>{r.status}</span></td>
                          <td className={r.notes ? '' : 'text-tertiary'}>{r.notes || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {derived.courses.length > 0 && (
                <div className="card-body flex flex-col gap-5" style={{ borderTop: '1px solid var(--border)' }}>
                  <span className="section-title">Attendance by course</span>
                  {derived.courses.map((c) => {
                    const t = tier(c.rate);
                    return (
                      <div key={c.className} className="flex items-center gap-4">
                        <div style={{ width: '40%', minWidth: 0 }}>
                          <div className="text-sm font-medium truncate">{c.className}</div>
                          <div className="text-xs text-secondary">{c.attended} / {c.total} attended</div>
                        </div>
                        <div className="progress" style={{ flex: 1 }}><div className={`progress-fill ${rateClass(c.rate)}`} style={{ width: `${c.rate}%` }} /></div>
                        <span className="text-sm font-semibold" style={{ width: '44px', textAlign: 'right' }}>{c.rate}%</span>
                        <span className={`badge ${t.cls}`}>{t.label}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ) : scheduleLoading ? (
            <div style={{ padding: '48px 0' }}><LoadingSpinner /></div>
          ) : schedule.length === 0 ? (
            <div className="card">
              <div className="empty-state" style={{ padding: '64px 24px' }}>
                <CalendarClock size={32} />
                <span className="text-base font-semibold">No schedule available</span>
                <span className="text-sm" style={{ maxWidth: '360px' }}>
                  {total === 0
                    ? 'Your class schedule will appear once you have an attendance record.'
                    : "Your class timetable hasn't been published yet."}
                </span>
              </div>
            </div>
          ) : (
            <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '16px' }}>
              {schedule.map((d) => {
                const isToday = d.day === todayName;
                return (
                  <section key={d.day} className="card" style={isToday ? { borderColor: 'var(--primary)' } : undefined}>
                    <div className="card-header">
                      <span className="section-title">{d.day}</span>
                      {isToday && <span className="badge badge-primary">Today</span>}
                    </div>
                    <div className="card-body flex flex-col gap-3">
                      {d.periods.map((p, i) => (
                        <div key={i} className="border rounded" style={{ padding: '10px 12px', background: 'var(--bg-subtle)' }}>
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-sm font-semibold">{p.subject}</span>
                            <span className="text-xs text-secondary mono">{p.time}</span>
                          </div>
                          <div className="flex items-center gap-3 text-xs text-secondary mt-1 flex-wrap">
                            <span className="flex items-center gap-1"><MapPin size={12} /> {p.room}</span>
                            <span className="flex items-center gap-1"><User size={12} /> {p.teacher}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </section>
                );
              })}
            </div>
          )}
        </>
      )}
    </DashboardLayout>
  );
};
