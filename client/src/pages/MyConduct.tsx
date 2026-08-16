import React, { useState, useEffect } from 'react';
import { DashboardLayout } from '../components/Layout/DashboardLayout';
import { LoadingSpinner } from '../components/common/LoadingSpinner';
import { ErrorState } from '../components/common/ErrorState';
import { Gavel, Award, ShieldCheck, AlertTriangle, MapPin, Info } from 'lucide-react';
import { disciplineApi, type TermBalance } from '../api/discipline';
import { apiGet, ApiError } from '../api/client';

interface DisciplineRecord {
  id: number;
  type: 'demerit' | 'merit';
  category: string;
  severity: string | null;
  points: number;
  title: string;
  description: string | null;
  incident_date: string;
  location: string | null;
  sanction: string;
  status: string;
}

const SANCTION_LABEL: Record<string, string> = {
  none: '', warning: 'Warning', parent_contact: 'Parent contacted', detention: 'Detention',
  suspension: 'Suspension', community_service: 'Community service', counseling: 'Counseling',
};

const scoreTone = (score: number) => (score >= 85 ? 'var(--success)' : score >= 70 ? 'var(--warning)' : 'var(--danger)');
const standing = (score: number) => (score >= 85 ? 'Excellent standing' : score >= 70 ? 'Watch list' : 'Needs attention');

export const MyConduct: React.FC = () => {
  const [records, setRecords] = useState<DisciplineRecord[]>([]);
  const [score, setScore] = useState(100);
  const [termBalance, setTermBalance] = useState<TermBalance | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiGet<{ records: DisciplineRecord[]; conductScore: number }>('/api/discipline/me');
      if (res.data) { setRecords(res.data.records); setScore(res.data.conductScore); }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load your conduct records.');
    }

    // B.3: this term's ledger balance, scoped independently of the record
    // list above (which already filters by term, but the ledger view is
    // the explicit per-term source of truth — see modules/discipline/ledger.service.ts).
    // Kept non-fatal: a failure here shouldn't blank out the rest of the page.
    try {
      const balanceRes = await disciplineApi.myTermBalance();
      setTermBalance(balanceRes.data ?? null);
    } catch (err) { console.error('Error fetching term balance:', err); }

    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const merits = records.filter((r) => r.type === 'merit');
  const demerits = records.filter((r) => r.type === 'demerit');
  const meritPoints = merits.reduce((s, r) => s + r.points, 0);
  const demeritPoints = demerits.reduce((s, r) => s + r.points, 0);

  return (
    <DashboardLayout>
      <div className="page-header">
        <div>
          <h1 className="page-title">My Conduct</h1>
          <p className="page-subtitle">Your behaviour record and conduct score.</p>
        </div>
        <span className="text-sm text-secondary" style={{ marginTop: '6px' }}>{records.length} records</span>
      </div>

      {loading ? (
        <div style={{ padding: '80px 0' }}><LoadingSpinner /></div>
      ) : error ? (
        <ErrorState message={error} onRetry={load} />
      ) : (
        <>
          {/* Score summary */}
          <div className="card card-pad mb-4">
            <div className="flex items-center justify-between flex-wrap gap-4 mb-4">
              <div className="flex items-end gap-2">
                <span style={{ fontSize: '36px', fontWeight: 700, letterSpacing: '-0.03em', lineHeight: 1, color: scoreTone(score) }}>{score}</span>
                <span className="text-secondary text-sm mb-1">/ 100 conduct score</span>
              </div>
              <span className={`badge ${score >= 85 ? 'badge-success' : score >= 70 ? 'badge-warning' : 'badge-danger'}`}>{standing(score)}</span>
            </div>
            <div className="flex mb-4" style={{ height: '10px', borderRadius: 'var(--radius-full)', overflow: 'hidden', background: 'var(--bg-subtle)' }}>
              <div style={{ width: `${score}%`, background: scoreTone(score) }} />
            </div>
            <div className="grid grid-stats" style={{ gap: '12px' }}>
              {[
                ['Merits', merits.length, 'text-success'],
                ['Merit points', `+${meritPoints}`, 'text-success'],
                ['Demerits', demerits.length, 'text-danger'],
                ['Demerit points', `−${demeritPoints}`, 'text-danger'],
              ].map(([l, v, cls]) => (
                <div key={l as string}>
                  <div className={`text-2xl font-bold ${cls}`}>{v as React.ReactNode}</div>
                  <div className="text-xs text-secondary">{l as string}</div>
                </div>
              ))}
            </div>
          </div>

          {termBalance && (
            <div className="card card-pad mb-4">
              <div className="flex items-center justify-between flex-wrap gap-2 mb-1">
                <span className="section-title" style={{ margin: 0 }}>This term's balance</span>
                <span className="text-xs text-secondary">{termBalance.eventCount} record{termBalance.eventCount === 1 ? '' : 's'} this term</span>
              </div>
              <p className="text-xs text-secondary mb-3 flex items-center gap-1">
                <Info size={12} /> This is the official ledger total for the current term — the same number your teachers and admins see. The score above is your overall standing across every record listed below.
              </p>
              <div className="grid grid-stats" style={{ gap: '12px' }}>
                <div>
                  <div className="text-2xl font-bold" style={{ color: scoreTone(termBalance.balance) }}>{termBalance.balance}</div>
                  <div className="text-xs text-secondary">Term balance / 100</div>
                </div>
                <div>
                  <div className="text-2xl font-bold text-success">+{termBalance.meritPoints}</div>
                  <div className="text-xs text-secondary">Merit points this term</div>
                </div>
                <div>
                  <div className="text-2xl font-bold text-danger">−{termBalance.demeritPoints}</div>
                  <div className="text-xs text-secondary">Demerit points this term</div>
                </div>
              </div>
            </div>
          )}

          {score < 70 && (
            <div className="alert alert-danger mb-4">
              <AlertTriangle size={16} />
              <span>Your conduct score is low. Please speak with your class teacher about improving it.</span>
            </div>
          )}

          {/* Record list */}
          <div className="flex flex-col gap-3">
            <span className="section-title">Conduct history</span>
            {records.length === 0 ? (
              <div className="card"><div className="empty-state"><ShieldCheck size={28} /><span className="text-sm">No conduct records — keep it up!</span></div></div>
            ) : records.map((r) => (
              <div key={r.id} className="card card-pad flex flex-col gap-2">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-3" style={{ minWidth: 0 }}>
                    <div
                      className="flex items-center justify-center"
                      style={{
                        width: '38px', height: '38px', borderRadius: 'var(--radius-md, 11px)', flexShrink: 0,
                        background: r.type === 'merit' ? 'var(--success-light)' : 'var(--danger-light)',
                        color: r.type === 'merit' ? 'var(--success)' : 'var(--danger)',
                      }}
                    >
                      {r.type === 'merit' ? <Award size={18} /> : <Gavel size={18} />}
                    </div>
                    <div style={{ minWidth: 0 }}>
                      <div className="text-sm font-semibold">{r.title}</div>
                      <div className="text-xs text-secondary capitalize">{r.category}{r.severity ? ` · ${r.severity}` : ''}</div>
                    </div>
                  </div>
                  <span className={`badge ${r.type === 'merit' ? 'badge-success' : 'badge-danger'}`}>
                    {r.type === 'merit' ? '+' : '−'}{r.points} pts
                  </span>
                </div>
                {r.description && <p className="text-sm">{r.description}</p>}
                <div className="flex items-center gap-3 text-xs text-secondary flex-wrap">
                  <span>{new Date(r.incident_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span>
                  {r.location && <span className="flex items-center gap-1"><MapPin size={12} /> {r.location}</span>}
                  {r.sanction && r.sanction !== 'none' && <span className="badge badge-neutral">{SANCTION_LABEL[r.sanction]}</span>}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </DashboardLayout>
  );
};
