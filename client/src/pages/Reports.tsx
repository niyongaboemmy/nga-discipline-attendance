import React, { useState, useEffect } from 'react';
import { DashboardLayout } from '../components/Layout/DashboardLayout';
import { LoadingSpinner } from '../components/common/LoadingSpinner';
import { ErrorState } from '../components/common/ErrorState';
import { apiGet, ApiError } from '../api/client';
import { Download, TrendingUp, Users, BarChart2, ArrowUpRight, ArrowDownRight, Minus, Gavel, AlertOctagon } from 'lucide-react';
import { reportingApi, type CombinedReport } from '../api/reporting';

interface ClassStat { classId: string; className: string; rate: number; totalCount: number; }
interface TrendStat { date: string; rate: number; }
interface ReportsOverview { overallRate: number; totalStudentsTracked: number; classes: ClassStat[]; trends: TrendStat[]; }
interface ConductOverview {
  totals: { total: number; demerits: number; merits: number; open: number; underReview: number };
  topDemerits: { student_id: string; student_name: string; demerit_points: number; count: number }[];
}

const rateClass = (r: number) => (r >= 90 ? 'is-success' : r >= 80 ? 'is-warning' : 'is-danger');
const rateBadge = (r: number) => (r >= 90 ? 'badge-success' : r >= 80 ? 'badge-warning' : 'badge-danger');

export const Reports: React.FC = () => {
  const [data, setData] = useState<ReportsOverview | null>(null);
  const [conduct, setConduct] = useState<ConductOverview | null>(null);
  const [combined, setCombined] = useState<CombinedReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true); setError(null);
    try {
      const [res, cRes] = await Promise.all([
        apiGet<ReportsOverview>('/api/reports/overview'),
        apiGet<ConductOverview>('/api/discipline/overview'),
      ]);
      setData(res.data ?? null);
      setConduct(cRes.data ?? null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load reports.');
    }

    // C: combined attendance + discipline risk — students who are both
    // low-attendance AND low-conduct-balance, not visible from either
    // report alone (see modules/reporting/reporting.service.ts). Kept
    // non-fatal: a failure here shouldn't blank out the rest of the page.
    try {
      const combinedRes = await reportingApi.combined();
      setCombined(combinedRes.data ?? null);
    } catch (err) { console.error('Error fetching combined report:', err); }

    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const exportCSV = () => {
    if (!data) return;
    let csv = 'Class ID,Class Name,Attendance Rate (%),Total Logs\n';
    data.classes.forEach((c) => { csv += `${c.classId},"${c.className}",${c.rate},${c.totalCount}\n`; });
    if (conduct) {
      csv += '\nDiscipline Summary\n';
      csv += `Total records,${conduct.totals.total}\n`;
      csv += `Demerits,${conduct.totals.demerits}\n`;
      csv += `Merits,${conduct.totals.merits}\n`;
      csv += `Open cases,${conduct.totals.open + conduct.totals.underReview}\n`;
    }
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `nga-reports-${new Date().toISOString().split('T')[0]}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  if (loading) return <DashboardLayout><div style={{ padding: '80px 0' }}><LoadingSpinner /></div></DashboardLayout>;
  if (error) return <DashboardLayout><ErrorState message={error} onRetry={load} /></DashboardLayout>;

  return (
    <DashboardLayout>
      <div className="page-header">
        <div>
          <h1 className="page-title">Reports</h1>
          <p className="page-subtitle">School-wide attendance performance.</p>
        </div>
        <button className="btn btn-outline" onClick={exportCSV} disabled={!data}>
          <Download size={16} /> Export CSV
        </button>
      </div>

      {data && (
        <>
          {/* Summary cards */}
          <div className="grid grid-3 mb-6">
            <div className="stat-card" style={{ ['--accent-color' as string]: 'var(--primary)' }}>
              <div className="flex items-center justify-between">
                <span className="stat-label">Overall Rate</span><span className="stat-icon"><TrendingUp size={18} /></span>
              </div>
              <div className="stat-value">{data.overallRate}%</div>
            </div>
            <div className="stat-card" style={{ ['--accent-color' as string]: 'var(--success)' }}>
              <div className="flex items-center justify-between">
                <span className="stat-label">Total Sessions</span><span className="stat-icon"><Users size={18} /></span>
              </div>
              <div className="stat-value">{data.totalStudentsTracked}</div>
            </div>
            <div className="stat-card" style={{ ['--accent-color' as string]: 'var(--info)' }}>
              <div className="flex items-center justify-between">
                <span className="stat-label">Active Classes</span><span className="stat-icon"><BarChart2 size={18} /></span>
              </div>
              <div className="stat-value">{data.classes.length}</div>
            </div>
          </div>

          <div className="grid grid-main">
            {/* Class breakdown */}
            <section className="card">
              <div className="card-header"><span className="section-title">Attendance rate by class</span></div>
              <div className="card-body flex flex-col gap-5">
                {data.classes.length === 0 ? (
                  <div className="empty-state">No classes registered.</div>
                ) : data.classes.map((c) => (
                  <div key={c.classId} className="flex items-center gap-4">
                    <div style={{ width: '40%', minWidth: 0 }}>
                      <div className="text-sm font-medium truncate">{c.className}</div>
                      <div className="text-xs text-secondary">{c.totalCount} sessions</div>
                    </div>
                    <div className="progress" style={{ flex: 1 }}>
                      <div className={`progress-fill ${rateClass(c.rate)}`} style={{ width: `${c.rate}%` }} />
                    </div>
                    <span className={`badge ${rateBadge(c.rate)}`} style={{ minWidth: '48px', justifyContent: 'center' }}>{c.rate}%</span>
                  </div>
                ))}
              </div>
            </section>

            {/* Side panels */}
            <div className="flex flex-col gap-4">
              <section className="card card-pad">
                <span className="section-title">Performance tiers</span>
                <p className="text-sm text-secondary mt-2 mb-4">Classes below 80% trigger alerts to instructors and administrators.</p>
                <div className="flex flex-col gap-3">
                  {[['Exemplary', '≥ 90%', 'var(--success)'], ['Acceptable', '80–89%', 'var(--warning)'], ['Critical', 'Below 80%', 'var(--danger)']].map(([t, d, color]) => (
                    <div key={t as string} className="flex items-center gap-3">
                      <span style={{ width: '10px', height: '10px', borderRadius: '3px', background: color as string, flexShrink: 0 }} />
                      <div>
                        <div className="text-sm font-medium">{t as string}</div>
                        <div className="text-xs text-secondary">{d as string} presence rate</div>
                      </div>
                    </div>
                  ))}
                </div>
              </section>

              {data.trends.length > 0 && (
                <section className="card card-pad">
                  <span className="section-title">Recent trend</span>
                  <p className="text-xs text-secondary mt-1">Change vs. the previous session day.</p>
                  <div className="flex flex-col gap-2 mt-3">
                    {data.trends.slice(-5).map((t, i, arr) => {
                      const prev = i > 0 ? arr[i - 1].rate : null;
                      const delta = prev === null ? null : t.rate - prev;
                      return (
                        <div key={i} className="flex justify-between items-center text-sm">
                          <span className="text-secondary">{new Date(t.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
                          <span className={`font-semibold flex items-center gap-1 ${delta === null ? 'text-secondary' : delta > 0 ? 'text-success' : delta < 0 ? 'text-danger' : 'text-secondary'}`}>
                            {delta === null ? <Minus size={14} /> : delta > 0 ? <ArrowUpRight size={14} /> : delta < 0 ? <ArrowDownRight size={14} /> : <Minus size={14} />}
                            {t.rate}%{delta !== null && delta !== 0 && <span className="text-xs">({delta > 0 ? '+' : ''}{delta})</span>}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </section>
              )}
            </div>
          </div>

          {conduct && (
            <div className="grid grid-main mt-6">
              <section className="card card-pad">
                <span className="section-title">Discipline &amp; conduct</span>
                <div className="grid grid-stats mt-3" style={{ gap: '12px' }}>
                  {[
                    ['Total records', conduct.totals.total, 'text-primary'],
                    ['Demerits', conduct.totals.demerits, 'text-danger'],
                    ['Merits', conduct.totals.merits, 'text-success'],
                    ['Open cases', conduct.totals.open + conduct.totals.underReview, 'text-warning'],
                  ].map(([l, v, cls]) => (
                    <div key={l as string}>
                      <div className={`text-2xl font-bold ${cls}`}>{v as number}</div>
                      <div className="text-xs text-secondary">{l as string}</div>
                    </div>
                  ))}
                </div>
              </section>

              <section className="card card-pad">
                <div className="flex items-center gap-2 mb-3"><Gavel size={16} className="text-danger" /><span className="section-title">Most demerit points</span></div>
                {conduct.topDemerits.length === 0 ? (
                  <p className="text-sm text-secondary">No demerits recorded.</p>
                ) : (
                  <div className="flex flex-col gap-2">
                    {conduct.topDemerits.map((s) => (
                      <div key={s.student_id} className="flex items-center justify-between text-sm">
                        <span className="truncate">{s.student_name}</span>
                        <span className="badge badge-danger">{s.demerit_points} pts</span>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </div>
          )}
          {combined && combined.studentsAtCombinedRisk.length > 0 && (
            <section className="card card-pad mt-6">
              <div className="flex items-center gap-2 mb-1">
                <AlertOctagon size={16} className="text-danger" />
                <span className="section-title">Combined risk — low attendance and low conduct</span>
              </div>
              <p className="text-sm text-secondary mb-3">
                Students under 80% attendance and under 80/100 conduct balance this term — compounding
                risk that isn't visible from either report alone.
              </p>
              <div className="flex flex-col gap-2">
                {combined.studentsAtCombinedRisk.map((s) => (
                  <div key={s.studentId} className="flex items-center justify-between text-sm">
                    <span className="truncate">{s.studentName}</span>
                    <div className="flex gap-2">
                      <span className="badge badge-danger">{s.attendanceRate}% attendance</span>
                      <span className="badge badge-warning">{s.conductBalance} conduct</span>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </DashboardLayout>
  );
};
