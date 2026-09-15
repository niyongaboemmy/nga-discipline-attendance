import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { DashboardLayout } from '../components/Layout/DashboardLayout';
import { LoadingSpinner } from '../components/common/LoadingSpinner';
import { HeroBanner } from '../components/common/HeroBanner';
import { attendanceReportApi, type OwnSubjectSummary } from '../api/attendanceReport';
import { rateColor } from '../utils/attendanceComment';
import { TodayAgenda } from '../components/dashboard/TodayAgenda';
import {
  Users, UserCheck, UserX, TrendingUp, TrendingDown, FileText, AlertCircle, Inbox,
  Gavel, Award, BookOpen, Activity, ChevronRight, Sun,
} from 'lucide-react';

interface OverviewData {
  overallRate: number;
  totalStudentsTracked: number;
  today: { total: number; present: number; absent: number; late: number; excused: number };
  classes: Array<{ classId: string; className: string; rate: number; totalCount: number }>;
  trends: Array<{ date: string; rate: number }>;
  recentActivity: Array<{ student_name: string; class_name: string; status: string; updated_at: string }>;
}
/** One real session, flattened out of `/api/attendance/me`'s day-by-day
 *  merge — a homeroom row and each subject row on the same day both become
 *  their own entry here, so the "Recent Sessions" feed shows subject
 *  sessions too instead of only ever showing homeroom. */
interface RecentEvent {
  key: string; date: string; label: string; status: string; period: string;
}
interface ConductTotals { total: number; demerits: number; merits: number; open: number; underReview: number; }

const greeting = () => {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
};
const rateClass = (r: number) => (r >= 90 ? 'is-success' : r >= 80 ? 'is-warning' : 'is-danger');
const statusToTone = (s: string) => (s === 'present' ? 'present' : s === 'late' ? 'late' : s === 'excused' ? 'excused' : 'absent');
const authHeaders = () => ({ Authorization: `Bearer ${localStorage.getItem('sso_token')}` });

const StatCard: React.FC<{
  label: string; value: string | number; accent: string; icon: React.ReactNode;
  tag?: string; trend?: { dir: 'up' | 'down'; text: string }; sub?: string;
}> = ({ label, value, accent, icon, tag, trend, sub }) => (
  <div className="stat-card" style={{ ['--accent-color' as string]: accent }}>
    <div className="flex items-center justify-between">
      <span className="stat-icon">{icon}</span>
      {tag && <span className="stat-tag">{tag}</span>}
    </div>
    <div className="stat-value">{value}</div>
    <span className="stat-label">{label}</span>
    {trend ? (
      <div>
        <span className={`stat-trend-chip ${trend.dir}`}>
          {trend.dir === 'up' ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
          {trend.text}
        </span>
      </div>
    ) : sub ? (
      <div className="text-xs text-secondary mt-2">{sub}</div>
    ) : null}
  </div>
);

const Feed: React.FC<{ items: OverviewData['recentActivity'] }> = ({ items }) => {
  if (!items.length) return <div className="empty-state"><FileText size={24} /><span className="text-sm">No recent activity</span></div>;
  return (
    <div className="feed">
      {items.map((a, i) => (
        <div key={i} className="feed-item">
          <div className={`feed-dot is-${statusToTone(a.status)}`} />
          <div style={{ flex: 1 }}>
            <div className="text-sm"><span className="font-semibold">{a.student_name}</span><span className="text-secondary"> · </span><span className="capitalize font-medium">{a.status}</span></div>
            <div className="text-xs text-secondary">{a.class_name}</div>
          </div>
          <span className="feed-time">{new Date(a.updated_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
        </div>
      ))}
    </div>
  );
};

// ---- Teacher / Admin ----
const StaffDashboard: React.FC<{ stats: OverviewData; conduct: ConductTotals | null }> = ({ stats, conduct }) => {
  const presentShare = stats.today.total ? Math.round((stats.today.present / stats.today.total) * 100) : 0;
  const absentShare = stats.today.total ? Math.round((stats.today.absent / stats.today.total) * 100) : 0;
  const rateTrend = stats.trends.length >= 2 ? stats.trends[stats.trends.length - 1].rate - stats.trends[stats.trends.length - 2].rate : 0;

  return (
    <>
      <TodayAgenda />
      <div className="grid grid-stats mb-6">
        <StatCard label="Total Students" value={stats.totalStudentsTracked} accent="var(--primary)" icon={<Users size={18} />} tag="Term" sub="Tracked this term" />
        <StatCard label="Present Today" value={stats.today.present} accent="var(--success)" icon={<UserCheck size={18} />} tag="Today" trend={{ dir: 'up', text: `${presentShare}% of total` }} />
        <StatCard label="Absent Today" value={stats.today.absent} accent="var(--danger)" icon={<UserX size={18} />} tag="Today" trend={{ dir: 'down', text: `${absentShare}% of total` }} />
        <StatCard label="Attendance Rate" value={`${stats.overallRate}%`} accent="var(--info)" icon={<TrendingUp size={18} />} tag="Overall" trend={{ dir: rateTrend >= 0 ? 'up' : 'down', text: `${rateTrend >= 0 ? '+' : ''}${rateTrend}% vs prev` }} />
      </div>

      <div className="grid grid-main">
        <section className="card">
          <div className="card-header">
            <div className="flex items-center gap-3">
              <span className="section-icon"><BookOpen size={16} /></span>
              <div>
                <div className="flex items-center gap-2">
                  <span className="section-title">Class Performance</span>
                  <span className="count-badge">{stats.classes.length} Active</span>
                </div>
                <div className="card-subtitle">Sessions recorded and attendance rates</div>
              </div>
            </div>
            <Link to="/attendance/records" className="btn btn-ghost btn-sm">View All <ChevronRight size={14} /></Link>
          </div>
          <div className="card-body">
            {stats.classes.length === 0 ? (
              <div className="empty-state"><Inbox size={24} /><span className="text-sm">No attendance recorded yet</span></div>
            ) : stats.classes.map((c) => (
              <div key={c.classId} className="list-item">
                <div style={{ minWidth: 0 }}>
                  <span className="code-chip">{c.classId}</span>
                  <div className="font-semibold mt-2">{c.className}</div>
                  <div className="text-xs text-secondary mt-1">{c.totalCount} sessions recorded</div>
                </div>
                <div className="flex items-center gap-3 flex-wrap">
                  <div className="progress" style={{ width: '110px' }}><div className={`progress-fill ${rateClass(c.rate)}`} style={{ width: `${c.rate}%` }} /></div>
                  <span className="text-sm font-semibold">{c.rate}%</span>
                  <Link to="/attendance/mark" className="btn btn-primary btn-sm">Mark now <ChevronRight size={14} /></Link>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="card">
          <div className="card-header">
            <div className="flex items-center gap-3">
              <span className="section-icon"><Activity size={16} /></span>
              <span className="section-title">Recent Activity</span>
            </div>
          </div>
          <div className="card-body"><Feed items={stats.recentActivity} /></div>
        </section>
      </div>

      {conduct && (
        <section className="card mt-6">
          <div className="card-header">
            <div className="flex items-center gap-3">
              <span className="section-icon"><Gavel size={16} /></span>
              <div>
                <div className="flex items-center gap-2">
                  <span className="section-title">Conduct Overview</span>
                  {conduct.open + conduct.underReview > 0 && (
                    <span className="count-badge">{conduct.open + conduct.underReview} Open</span>
                  )}
                </div>
                <div className="card-subtitle">Merits, demerits and open cases</div>
              </div>
            </div>
            <Link to="/discipline/records" className="btn btn-ghost btn-sm">View Records <ChevronRight size={14} /></Link>
          </div>
          <div className="card-body grid grid-stats" style={{ gap: '12px' }}>
            {[
              ['Total records', conduct.total, 'text-primary', <FileText size={16} key="i" />],
              ['Demerits', conduct.demerits, 'text-danger', <Gavel size={16} key="i" />],
              ['Merits', conduct.merits, 'text-success', <Award size={16} key="i" />],
              ['Open cases', conduct.open + conduct.underReview, 'text-warning', <AlertCircle size={16} key="i" />],
            ].map(([l, v, cls, icon]) => (
              <div key={l as string} className="flex items-center gap-3">
                <span className={cls as string}>{icon as React.ReactNode}</span>
                <div>
                  <div className={`text-xl font-bold ${cls}`}>{v as number}</div>
                  <div className="text-xs text-secondary">{l as string}</div>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </>
  );
};

// ---- Student ----
const sectionName = (r: Pick<OwnSubjectSummary, 'kind' | 'subjectName'>) => (r.kind === 'homeroom' ? 'Homeroom' : r.subjectName || 'Unknown subject');

/** Every enrolled section, side by side — including ones with nothing
 *  recorded yet (shown zero-filled with a muted tag rather than omitted).
 *  This is what replaces the old homeroom-only records list: a student
 *  whose teacher never marks homeroom but does mark subjects used to see a
 *  fully blank dashboard, because only the homeroom array fed this page. */
const StudentDashboard: React.FC<{ overview: OwnSubjectSummary[]; recent: RecentEvent[] }> = ({ overview, recent }) => {
  const present = overview.reduce((n, r) => n + r.present, 0);
  const late = overview.reduce((n, r) => n + r.late, 0);
  const excused = overview.reduce((n, r) => n + r.excused, 0);
  const absent = overview.reduce((n, r) => n + r.absent, 0);
  const total = present + late + excused + absent;

  return (
    <>
      <div className="grid grid-stats mb-6">
        <StatCard label="Present" value={present} accent="var(--success)" icon={<UserCheck size={18} />} tag="Sessions" sub={total ? `${Math.round((present / total) * 100)}% of total` : 'No sessions yet'} />
        <StatCard label="Late" value={late} accent="var(--warning)" icon={<AlertCircle size={18} />} tag="Sessions" />
        <StatCard label="Excused" value={excused} accent="var(--info)" icon={<FileText size={18} />} tag="Sessions" />
        <StatCard label="Absent" value={absent} accent="var(--danger)" icon={<UserX size={18} />} tag="Sessions" sub={absent > 0 && total ? `${Math.round((absent / total) * 100)}% of total` : undefined} />
      </div>

      <TodayAgenda />

      <div className="grid grid-main">
        <section className="card">
          <div className="card-header">
            <div className="flex items-center gap-3">
              <span className="section-icon"><BookOpen size={16} /></span>
              <div>
                <div className="flex items-center gap-2">
                  <span className="section-title">My Classes</span>
                  <span className="count-badge">{overview.length} Enrolled</span>
                </div>
                <div className="card-subtitle">Every subject, side by side — including ones not yet recorded</div>
              </div>
            </div>
            <Link to="/attendance/report" className="btn btn-ghost btn-sm">Compare all <ChevronRight size={14} /></Link>
          </div>
          <div className="card-body" style={{ padding: 0 }}>
            <div className="ar-listgroup" style={{ border: 'none', boxShadow: 'none', margin: 0 }}>
              {overview.map((r) => {
                const key = r.kind === 'homeroom' ? 'homeroom' : String(r.subjectId);
                return (
                  <Link key={key} to="/attendance/report" className={`ar-listitem${!r.hasData ? ' is-empty' : ''}`}>
                    <span className="ar-listitem-icon">{r.kind === 'homeroom' ? <Sun size={16} /> : <BookOpen size={16} />}</span>
                    <span className="ar-listitem-main">
                      <span className="ar-listitem-name">{sectionName(r)}</span>
                      <span className="ar-listitem-meta">
                        <span>{r.present} present</span>
                        <span>{r.absent} absent</span>
                        {r.late > 0 && <span>{r.late} late</span>}
                        {r.excused > 0 && <span>{r.excused} excused</span>}
                      </span>
                    </span>
                    {r.hasData ? (
                      <>
                        <span className="ar-listitem-bar">
                          <span className="ar-listitem-bar-fill" style={{ width: `${r.rate}%`, background: rateColor(r.rate) }} />
                        </span>
                        <span className="ar-listitem-rate" style={{ color: rateColor(r.rate) }}>{r.rate}%</span>
                      </>
                    ) : (
                      <span className="ar-listitem-empty-tag">No sessions yet</span>
                    )}
                    <ChevronRight size={16} className="ar-listitem-chevron" />
                  </Link>
                );
              })}
            </div>
          </div>
        </section>

        <section className="card">
          <div className="card-header">
            <div className="flex items-center gap-3">
              <span className="section-icon"><Activity size={16} /></span>
              <span className="section-title">Recent Sessions</span>
            </div>
          </div>
          <div className="card-body">
            {recent.length === 0 ? (
              <div className="empty-state"><Inbox size={24} /><span className="text-sm">No sessions recorded yet</span></div>
            ) : (
              <div className="feed">
                {recent.map((r) => (
                  <div key={r.key} className="feed-item">
                    <div className={`feed-dot is-${statusToTone(r.status)}`} />
                    <div style={{ flex: 1 }}>
                      <div className="text-sm"><span className="font-semibold">{r.label}</span><span className="text-secondary"> · </span><span className="capitalize font-medium">{r.status}</span></div>
                      <div className="text-xs text-secondary">{r.period}</div>
                    </div>
                    <span className="feed-time">{new Date(r.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>
      </div>
    </>
  );
};

export const Dashboard: React.FC = () => {
  const { user } = useAuth();
  const [stats, setStats] = useState<OverviewData | null>(null);
  const [conduct, setConduct] = useState<ConductTotals | null>(null);
  const [overview, setOverview] = useState<OwnSubjectSummary[] | null>(null);
  const [recentEvents, setRecentEvents] = useState<RecentEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true); setError(null);
    const role = user?.role;
    try {
      if (role === 'student') {
        // Two calls: the zero-filled "every section" overview (never empty
        // just because homeroom wasn't marked — see getOwnSubjectsOverview)
        // drives the stat cards and class list, while /api/attendance/me's
        // day-by-day merge feeds the recent-sessions feed with both
        // homeroom AND subject events (previously only homeroom fed this
        // page at all, so a student with subject-only records saw a
        // completely blank dashboard).
        const [overviewRes, meRes] = await Promise.all([
          attendanceReportApi.myAllSubjects(),
          fetch('/api/attendance/me', { headers: authHeaders() }).then(async (res) => {
            if (!res.ok) throw new Error('Could not load your attendance.');
            const result = await res.json();
            if (!result.success) throw new Error(result.message || 'Server error.');
            return result.data;
          }),
        ]);
        setOverview(overviewRes.data ?? []);

        const events: RecentEvent[] = [];
        for (const day of meRes?.days ?? []) {
          if (day.homeroom) {
            events.push({ key: `${day.date}-homeroom`, date: day.date, label: 'Homeroom', status: day.homeroom.status, period: day.homeroom.period });
          }
          for (const s of day.subjects ?? []) {
            events.push({ key: `${day.date}-${s.subjectId}`, date: day.date, label: s.subjectName || 'Subject', status: s.status, period: s.period });
          }
        }
        events.sort((a, b) => (a.date < b.date ? 1 : -1));
        setRecentEvents(events.slice(0, 6));
      } else {
        const res = await fetch('/api/reports/overview', { headers: authHeaders() });
        if (!res.ok) throw new Error('Could not load the overview.');
        const result = await res.json();
        if (!result.success) throw new Error(result.message || 'Server error.');
        setStats(result.data);
        // Conduct overview is supplementary — failures shouldn't break the dashboard.
        try {
          const cRes = await fetch('/api/discipline/overview', { headers: authHeaders() });
          if (cRes.ok) { const c = await cRes.json(); if (c.success) setConduct(c.data.totals); }
        } catch { /* non-fatal */ }
      }
    } catch (err) {
      setError((err as Error).message || 'Could not reach the server.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [user]);

  // Hero subline tailored to what the data says right now — rolled up
  // across every enrolled section, not just homeroom.
  const overviewTotal = overview?.reduce((n, r) => n + r.total, 0) ?? 0;
  const overviewOk = overview?.reduce((n, r) => n + r.present + r.late + r.excused, 0) ?? 0;
  const studentRate = overviewTotal > 0 ? Math.round((overviewOk / overviewTotal) * 100) : null;

  return (
    <DashboardLayout>
      {user && (
        <HeroBanner name={user.name} role={user.role} title={`${greeting()}, ${user.name.split(' ')[0]}!`}>
          {user.role === 'student' ? (
            studentRate !== null ? (
              <>Your overall presence is <strong>{studentRate}%</strong> across <strong>{overviewTotal} sessions</strong>. Keep up the momentum! 🚀</>
            ) : (
              <>Welcome to your attendance and conduct overview.</>
            )
          ) : stats && stats.today.total > 0 ? (
            <>You have <strong>{stats.today.present} of {stats.today.total}</strong> students present today · overall rate <strong>{stats.overallRate}%</strong></>
          ) : (
            <>No attendance marked yet today — jump into <strong>Mark Attendance</strong> to get started. 🚀</>
          )}
        </HeroBanner>
      )}

      {loading ? (
        <div style={{ padding: '80px 0' }}><LoadingSpinner /></div>
      ) : error ? (
        <div className="card"><div className="empty-state"><AlertCircle size={28} /><span className="text-sm">{error}</span>
          <button className="btn btn-outline btn-sm mt-2" onClick={load}>Retry</button></div></div>
      ) : user?.role === 'student' ? (
        <StudentDashboard overview={overview || []} recent={recentEvents} />
      ) : stats ? (
        <StaffDashboard stats={stats} conduct={conduct} />
      ) : null}
    </DashboardLayout>
  );
};
