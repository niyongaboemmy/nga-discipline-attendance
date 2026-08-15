import React, { useState, useEffect, useMemo } from 'react';
import { DashboardLayout } from '../components/Layout/DashboardLayout';
import { LoadingSpinner } from '../components/common/LoadingSpinner';
import { TrendingUp, AlertTriangle, AlertCircle, Inbox, Gavel, Award } from 'lucide-react';

interface Rec { id: number; class_name: string; session_date: string; status: 'present' | 'absent' | 'late' | 'excused'; }
interface ConductRec { type: 'demerit' | 'merit'; points: number; }

const rateClass = (r: number) => (r >= 90 ? 'is-success' : r >= 80 ? 'is-warning' : 'is-danger');
const tier = (r: number) => (r >= 90 ? { label: 'safe', cls: 'badge-success' } : r >= 80 ? { label: 'warning', cls: 'badge-warning' } : { label: 'at risk', cls: 'badge-danger' });
const authHeaders = () => ({ Authorization: `Bearer ${localStorage.getItem('sso_token')}` });
const mondayOf = (d: Date) => { const x = new Date(d); const day = (x.getDay() + 6) % 7; x.setDate(x.getDate() - day); return x.toISOString().split('T')[0]; };

export const Analytics: React.FC = () => {
  const [records, setRecords] = useState<Rec[] | null>(null);
  const [conduct, setConduct] = useState<{ records: ConductRec[]; conductScore: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true); setError(null);
    try {
      const res = await fetch('/api/attendance/me', { headers: authHeaders() });
      if (!res.ok) throw new Error('Could not load your attendance.');
      const result = await res.json();
      if (!result.success) throw new Error(result.message || 'Server error.');
      setRecords(result.data);
      // Conduct is supplementary — don't fail analytics if it errors.
      try {
        const cRes = await fetch('/api/discipline/me', { headers: authHeaders() });
        if (cRes.ok) { const c = await cRes.json(); if (c.success) setConduct(c.data); }
      } catch { /* non-fatal */ }
    } catch (err) { setError((err as Error).message); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const derived = useMemo(() => {
    const recs = records || [];
    const total = recs.length;
    const ok = recs.filter((r) => r.status !== 'absent').length;
    const overallRate = total ? Math.round((ok / total) * 100) : 0;

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

    const atRisk = courses.filter((c) => c.rate < 80);
    return { total, overallRate, courses, weeks, atRisk };
  }, [records]);

  return (
    <DashboardLayout>
      <div className="page-header">
        <div>
          <h1 className="page-title">Insights &amp; Analytics</h1>
          <p className="page-subtitle">Metrics computed from your recorded attendance.</p>
        </div>
      </div>

      {loading ? (
        <div style={{ padding: '80px 0' }}><LoadingSpinner /></div>
      ) : error ? (
        <div className="card"><div className="empty-state"><AlertCircle size={28} /><span className="text-sm">{error}</span><button className="btn btn-outline btn-sm mt-2" onClick={load}>Retry</button></div></div>
      ) : derived.total === 0 ? (
        <div className="card"><div className="empty-state"><Inbox size={28} /><span className="text-sm">No attendance data to analyze yet.</span></div></div>
      ) : (
        <>
          <div className="grid grid-3 mb-6">
            <div className="stat-card" style={{ ['--accent-color' as string]: 'var(--success)' }}>
              <span className="stat-label">Compliance Score</span>
              <div className="stat-value">{derived.overallRate}%</div>
              <div className="progress mt-3"><div className={`progress-fill ${rateClass(derived.overallRate)}`} style={{ width: `${derived.overallRate}%` }} /></div>
              <p className="text-xs text-secondary mt-2">{derived.overallRate >= 85 ? 'Good standing — keep it up.' : 'Below the 85% benchmark.'}</p>
            </div>

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

          {conduct && (
            <section className="card card-pad mb-6">
              <div className="flex items-center justify-between flex-wrap gap-3 mb-3">
                <span className="section-title">Conduct</span>
                <span className={`badge ${conduct.conductScore >= 85 ? 'badge-success' : conduct.conductScore >= 70 ? 'badge-warning' : 'badge-danger'}`}>
                  {conduct.conductScore}/100
                </span>
              </div>
              <div className="progress mb-4"><div className={`progress-fill ${conduct.conductScore >= 85 ? 'is-success' : conduct.conductScore >= 80 ? 'is-warning' : 'is-danger'}`} style={{ width: `${conduct.conductScore}%` }} /></div>
              <div className="grid grid-stats" style={{ gap: '12px' }}>
                <div className="flex items-center gap-2"><Award size={16} className="text-success" /><div><div className="text-xl font-bold text-success">{conduct.records.filter((r) => r.type === 'merit').length}</div><div className="text-xs text-secondary">Merits</div></div></div>
                <div className="flex items-center gap-2"><Gavel size={16} className="text-danger" /><div><div className="text-xl font-bold text-danger">{conduct.records.filter((r) => r.type === 'demerit').length}</div><div className="text-xs text-secondary">Demerits</div></div></div>
              </div>
            </section>
          )}

          <section className="card">
            <div className="card-header"><span className="section-title">Attendance by course</span></div>
            <div className="card-body flex flex-col gap-5">
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
          </section>
        </>
      )}
    </DashboardLayout>
  );
};
