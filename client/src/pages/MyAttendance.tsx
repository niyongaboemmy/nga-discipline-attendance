import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { DashboardLayout } from '../components/Layout/DashboardLayout';
import { LoadingSpinner } from '../components/common/LoadingSpinner';
import { ErrorState } from '../components/common/ErrorState';
import { Modal } from '../components/common/Modal';
import { useToast } from '../context/ToastContext';
import { apiGet, apiPost, ApiError } from '../api/client';
import {
  AlertTriangle, TrendingUp, CalendarClock, MapPin, User, BookOpen, ShieldCheck,
  CheckCircle2, XCircle, Clock, FileText, CalendarDays,
} from 'lucide-react';
import './MyAttendance.css';

type Status = 'present' | 'absent' | 'late' | 'excused';

interface DaySubject { subjectId: number; subjectName: string; status: Status; notes: string; period: string }
interface Day {
  date: string;
  classId: string | null;
  className: string | null;
  homeroom: { status: Status; notes: string; period: string } | null;
  subjects: DaySubject[];
  excuseStatus: 'pending' | 'approved' | 'rejected' | null;
}
interface Summary {
  total: number; present: number; late: number; excused: number; absent: number;
  rate: number; threshold: number;
}
interface SubjectRow {
  subject_id: number; subject_name: string; session_date: string; status: Status;
}
interface MeResponse { summary: Summary; days: Day[]; homeroom: any[]; subjects: SubjectRow[] }

interface Period { time: string; subject: string; room: string; teacher: string }
interface DaySchedule { day: string; periods: Period[] }

const STATUS_META: Record<Status, { label: string; badge: string; icon: React.ReactNode }> = {
  present: { label: 'Present', badge: 'badge-success', icon: <CheckCircle2 size={13} /> },
  late: { label: 'Late', badge: 'badge-warning', icon: <Clock size={13} /> },
  excused: { label: 'Excused', badge: 'badge-info', icon: <ShieldCheck size={13} /> },
  absent: { label: 'Absent', badge: 'badge-danger', icon: <XCircle size={13} /> },
};

const mondayOf = (d: Date) => {
  const x = new Date(d);
  const day = (x.getDay() + 6) % 7;
  x.setDate(x.getDate() - day);
  return x.toISOString().split('T')[0];
};
const todayName = new Date().toLocaleDateString('en-US', { weekday: 'long' });
const fmtDay = (iso: string) =>
  new Date(iso + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

type Tab = 'days' | 'subjects' | 'schedule';

export const MyAttendance: React.FC = () => {
  const toast = useToast();
  const [data, setData] = useState<MeResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('days');
  const [schedule, setSchedule] = useState<DaySchedule[]>([]);
  const [scheduleLoading, setScheduleLoading] = useState(false);
  const [scheduleLoaded, setScheduleLoaded] = useState(false);

  // Request-an-excuse flow, opened from an unexcused absent day.
  const [excuseFor, setExcuseFor] = useState<Day | null>(null);
  const [excuseForm, setExcuseForm] = useState({ reason: '', description: '' });
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await apiGet<MeResponse>('/api/attendance/me');
      setData(res.data ?? null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load your attendance.');
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (tab !== 'schedule' || scheduleLoaded || !data) return;
    (async () => {
      setScheduleLoading(true);
      try {
        const classId = data.days[0]?.classId || '';
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
  }, [tab, scheduleLoaded, data]);

  const summary = data?.summary;
  const isLow = !!summary && summary.rate < summary.threshold;

  const segs = summary
    ? [
        { n: summary.present, c: 'var(--success)' },
        { n: summary.late, c: 'var(--warning)' },
        { n: summary.excused, c: 'var(--info)' },
        { n: summary.absent, c: 'var(--danger)' },
      ].filter((s) => s.n > 0)
    : [];

  // Weekly trend from homeroom days (real scale, labelled).
  const weeks = useMemo(() => {
    const map = new Map<string, { total: number; ok: number }>();
    for (const d of data?.days ?? []) {
      if (!d.homeroom) continue;
      const k = mondayOf(new Date(d.date + 'T00:00:00'));
      const e = map.get(k) ?? { total: 0, ok: 0 };
      e.total += 1;
      if (d.homeroom.status !== 'absent') e.ok += 1;
      map.set(k, e);
    }
    return [...map.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(-6)
      .map(([k, v]) => ({
        label: new Date(k + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
        rate: Math.round((v.ok / v.total) * 100),
      }));
  }, [data]);

  // Per-subject attendance breakdown.
  const bySubject = useMemo(() => {
    const map = new Map<number, { name: string; total: number; attended: number; recent: SubjectRow[] }>();
    for (const r of data?.subjects ?? []) {
      const e = map.get(r.subject_id) ?? { name: r.subject_name, total: 0, attended: 0, recent: [] };
      e.total += 1;
      if (r.status !== 'absent') e.attended += 1;
      e.recent.push(r);
      map.set(r.subject_id, e);
    }
    return [...map.values()]
      .map((s) => ({ ...s, rate: Math.round((s.attended / s.total) * 100) }))
      .sort((a, b) => a.rate - b.rate);
  }, [data]);

  const openExcuse = (day: Day) => {
    setExcuseForm({ reason: '', description: '' });
    setExcuseFor(day);
  };

  const submitExcuse = async () => {
    if (!excuseFor || !excuseForm.reason.trim()) return;
    setSubmitting(true);
    try {
      await apiPost('/api/attendance/excuse', {
        classId: excuseFor.classId,
        className: excuseFor.className ?? 'My class',
        sessionDate: excuseFor.date,
        reason: excuseForm.reason.trim(),
        description: excuseForm.description.trim(),
      });
      toast.success('Excuse requested', `${fmtDay(excuseFor.date)} — awaiting review`);
      setExcuseFor(null);
      load();
    } catch (err) {
      toast.error('Could not submit', err instanceof ApiError ? err.message : 'Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <DashboardLayout>
      <div className="page-header">
        <div>
          <h1 className="page-title">My Attendance</h1>
          <p className="page-subtitle">Your daily presence, subject-by-subject, and weekly trend.</p>
        </div>
        {summary && (
          <span className="text-sm text-secondary" style={{ marginTop: '6px' }}>
            {summary.total} school day{summary.total === 1 ? '' : 's'} recorded
          </span>
        )}
      </div>

      {loading ? (
        <div style={{ padding: '80px 0' }}><LoadingSpinner /></div>
      ) : error ? (
        <ErrorState message={error} onRetry={load} />
      ) : !summary ? (
        <div className="card"><div className="empty-state" style={{ padding: '64px 24px' }}>
          <CalendarDays size={30} />
          <span className="text-base font-semibold">No attendance recorded yet</span>
          <span className="text-sm">Your daily register will show here once your teacher takes it.</span>
        </div></div>
      ) : (
        <>
          {/* Summary */}
          <div className="card card-pad mb-4">
            <div className="flex items-center justify-between flex-wrap gap-4 mb-4">
              <div className="flex items-end gap-2">
                <span style={{ fontSize: '36px', fontWeight: 700, letterSpacing: '-0.03em', lineHeight: 1, color: isLow ? 'var(--danger)' : 'var(--success)' }}>
                  {summary.rate}%
                </span>
                <span className="text-secondary text-sm mb-1">daily attendance</span>
              </div>
              <span className={`badge ${isLow ? 'badge-danger' : 'badge-success'}`}>
                {isLow ? `Below the ${summary.threshold}% minimum` : 'Good standing'}
              </span>
            </div>
            {segs.length > 0 && (
              <div className="flex mb-1" style={{ height: '10px', gap: '2px', borderRadius: 'var(--radius-full)', overflow: 'hidden' }}>
                {segs.map((s, i) => <div key={i} style={{ flex: s.n, background: s.c }} />)}
              </div>
            )}
            <p className="text-xs text-secondary mb-4">
              Present, late and excused all count towards your rate — only an unexcused absence counts against it.
            </p>
            <div className="grid grid-stats" style={{ gap: '12px' }}>
              {([['Present', summary.present, 'text-success'], ['Late', summary.late, 'text-warning'], ['Excused', summary.excused, 'text-info'], ['Absent', summary.absent, 'text-danger']] as const).map(([l, v, cls]) => (
                <div key={l}>
                  <div className={`text-2xl font-bold ${cls}`}>{v}</div>
                  <div className="text-xs text-secondary">{l}</div>
                </div>
              ))}
            </div>
          </div>

          {isLow && (
            <div className="alert alert-danger mb-4">
              <AlertTriangle size={16} />
              <span>Your attendance is below the {summary.threshold}% minimum. Speak with your instructor, and request an excuse for any absence you have evidence for.</span>
            </div>
          )}

          {/* Trend + at-risk subjects */}
          <div className="grid grid-2 mb-4" style={{ gap: '16px' }}>
            <div className="card card-pad">
              <div className="flex items-center gap-2 mb-3"><TrendingUp size={16} className="text-brand" /><span className="section-title">Weekly trend</span></div>
              {weeks.length === 0 ? (
                <p className="text-sm text-secondary">Not enough data yet.</p>
              ) : (
                <div className="att-trend">
                  {weeks.map((w) => (
                    <div key={w.label} className="att-trend-col">
                      <span className="att-trend-val">{w.rate}%</span>
                      <div className="att-trend-track">
                        <div
                          className="att-trend-bar"
                          style={{ height: `${w.rate}%`, background: w.rate < summary.threshold ? 'var(--danger)' : 'var(--success)' }}
                        />
                      </div>
                      <span className="att-trend-label">{w.label}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="card card-pad">
              <div className="flex items-center gap-2 mb-2"><BookOpen size={16} className="text-danger" /><span className="section-title">Subjects to watch</span></div>
              {bySubject.filter((s) => s.rate < summary.threshold).length === 0 ? (
                <p className="text-sm text-secondary">
                  {bySubject.length === 0 ? 'No subject attendance recorded yet.' : 'Every subject is above the threshold. Nice work.'}
                </p>
              ) : (
                <ul style={{ paddingLeft: '16px', margin: 0 }} className="text-sm text-secondary flex flex-col gap-1">
                  {bySubject.filter((s) => s.rate < summary.threshold).map((s) => (
                    <li key={s.name}>{s.name} — <strong className="text-danger">{s.rate}%</strong> ({s.attended}/{s.total})</li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          {/* Tabs */}
          <div className="segmented mb-4" style={{ maxWidth: '360px' }}>
            <button type="button" className={`segmented-btn${tab === 'days' ? ' is-active' : ''}`} onClick={() => setTab('days')}>By day</button>
            <button type="button" className={`segmented-btn${tab === 'subjects' ? ' is-active' : ''}`} onClick={() => setTab('subjects')}>By subject</button>
            <button type="button" className={`segmented-btn${tab === 'schedule' ? ' is-active' : ''}`} onClick={() => setTab('schedule')}>Schedule</button>
          </div>

          {tab === 'days' && (
            <div className="flex flex-col gap-2">
              {data.days.length === 0 ? (
                <div className="card"><div className="empty-state">No days recorded yet.</div></div>
              ) : data.days.map((d) => {
                const hm = d.homeroom;
                const canRequestExcuse = hm?.status === 'absent' && !d.excuseStatus;
                return (
                  <div key={d.date} className="card card-pad att-day">
                    <div className="att-day-head">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold text-sm">{fmtDay(d.date)}</span>
                        {hm && (
                          <span className={`badge ${STATUS_META[hm.status].badge}`}>
                            {STATUS_META[hm.status].icon} {STATUS_META[hm.status].label}
                          </span>
                        )}
                        {d.excuseStatus && (
                          <span className={`badge ${d.excuseStatus === 'approved' ? 'badge-success' : d.excuseStatus === 'pending' ? 'badge-warning' : 'badge-neutral'}`}>
                            Excuse {d.excuseStatus}
                          </span>
                        )}
                      </div>
                      {canRequestExcuse && (
                        <button className="btn btn-outline btn-sm" onClick={() => openExcuse(d)}>
                          <FileText size={13} /> Request excuse
                        </button>
                      )}
                    </div>
                    {hm?.notes && <p className="text-xs text-secondary mt-1">Note: {hm.notes}</p>}
                    {d.subjects.length > 0 && (
                      <div className="att-day-subjects">
                        {d.subjects.map((s) => (
                          <span key={s.subjectId} className={`att-subject-pill is-${s.status}`} title={`${s.subjectName}: ${STATUS_META[s.status].label}`}>
                            {STATUS_META[s.status].icon}
                            <span>{s.subjectName}</span>
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {tab === 'subjects' && (
            <div className="card">
              <div className="card-header"><span className="section-title">Attendance by subject</span></div>
              {bySubject.length === 0 ? (
                <div className="empty-state">No subject sessions recorded yet.</div>
              ) : (
                <div className="card-body flex flex-col gap-5">
                  {bySubject.map((s) => (
                    <div key={s.name} className="flex items-center gap-4">
                      <div style={{ width: '40%', minWidth: 0 }}>
                        <div className="text-sm font-medium truncate">{s.name}</div>
                        <div className="text-xs text-secondary">{s.attended} / {s.total} attended</div>
                      </div>
                      <div className="progress" style={{ flex: 1 }}>
                        <div
                          className="progress-fill"
                          style={{ width: `${s.rate}%`, background: s.rate < summary.threshold ? 'var(--danger)' : s.rate < 90 ? 'var(--warning)' : 'var(--success)' }}
                        />
                      </div>
                      <span className="text-sm font-semibold" style={{ width: '44px', textAlign: 'right' }}>{s.rate}%</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {tab === 'schedule' && (
            scheduleLoading ? (
              <div style={{ padding: '48px 0' }}><LoadingSpinner /></div>
            ) : schedule.length === 0 ? (
              <div className="card"><div className="empty-state" style={{ padding: '64px 24px' }}>
                <CalendarClock size={32} />
                <span className="text-base font-semibold">No schedule available</span>
                <span className="text-sm" style={{ maxWidth: '360px' }}>Your class timetable hasn't been published yet.</span>
              </div></div>
            ) : (
              <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '16px' }}>
                {schedule.map((sd) => {
                  const isToday = sd.day === todayName;
                  return (
                    <section key={sd.day} className="card" style={isToday ? { borderColor: 'var(--primary)' } : undefined}>
                      <div className="card-header">
                        <span className="section-title">{sd.day}</span>
                        {isToday && <span className="badge badge-primary">Today</span>}
                      </div>
                      <div className="card-body flex flex-col gap-3">
                        {sd.periods.map((p, i) => (
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
            )
          )}
        </>
      )}

      <Modal
        open={!!excuseFor}
        title="Request an excuse"
        subtitle={excuseFor ? `${excuseFor.className ?? 'Your class'} · ${fmtDay(excuseFor.date)}` : ''}
        onClose={() => setExcuseFor(null)}
        footer={
          <>
            <button className="btn btn-outline" onClick={() => setExcuseFor(null)} disabled={submitting}>Cancel</button>
            <button className="btn btn-primary" onClick={submitExcuse} disabled={submitting || !excuseForm.reason.trim()}>
              {submitting ? 'Submitting…' : 'Submit request'}
            </button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <div className="field">
            <label className="label">Reason</label>
            <input
              className="input"
              placeholder="e.g. Medical appointment"
              maxLength={100}
              value={excuseForm.reason}
              onChange={(e) => setExcuseForm((f) => ({ ...f, reason: e.target.value }))}
            />
          </div>
          <div className="field">
            <label className="label">Details for the reviewer</label>
            <textarea
              className="textarea"
              placeholder="What happened, and any evidence you can provide."
              maxLength={2000}
              value={excuseForm.description}
              onChange={(e) => setExcuseForm((f) => ({ ...f, description: e.target.value }))}
            />
          </div>
          <p className="text-xs text-secondary">
            If it's approved, this day is marked <strong>excused</strong> and stops counting against your rate.
          </p>
        </div>
      </Modal>
    </DashboardLayout>
  );
};
