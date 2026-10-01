import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Link } from 'react-router-dom';
import { DashboardLayout } from '../components/Layout/DashboardLayout';
import { LoadingSpinner } from '../components/common/LoadingSpinner';
import { ErrorState } from '../components/common/ErrorState';
import { ConfirmDialog } from '../components/common/ConfirmDialog';
import { useToast } from '../context/ToastContext';
import { usePermissions } from '../hooks/usePermissions';
import { apiGet, apiPut, ApiError } from '../api/client';
import { SearchableSelect } from '../components/common/SearchableSelect';
import { DisciplineDetailModal } from '../components/discipline/DisciplineDetailModal';
import { Gavel, Award, Inbox, ChevronLeft, ChevronRight, MoreVertical, FileBarChart, Download, Eye } from 'lucide-react';

interface DisciplineRecord {
  id: number;
  student_id: string;
  student_name: string;
  class_name: string | null;
  type: 'demerit' | 'merit';
  category: string;
  severity: string | null;
  points: number;
  title: string;
  description: string | null;
  incident_date: string;
  location: string | null;
  sanction: string;
  status: 'open' | 'under_review' | 'resolved' | 'dismissed';
  logged_by_name: string | null;
}

interface Overview {
  totals: { total: number; demerits: number; merits: number; open: number; underReview: number };
  topDemerits: { student_id: string; student_name: string; demerit_points: number; count: number }[];
}

const STATUS_BADGE: Record<string, string> = {
  open: 'badge-warning', under_review: 'badge-info', resolved: 'badge-success', dismissed: 'badge-neutral',
};
const STATUS_LABEL: Record<string, string> = {
  open: 'Open', under_review: 'Under review', resolved: 'Resolved', dismissed: 'Dismissed',
};
const SANCTION_LABEL: Record<string, string> = {
  none: '—', warning: 'Warning', parent_contact: 'Parent contact', detention: 'Detention',
  suspension: 'Suspension', community_service: 'Community service', counseling: 'Counseling',
};

const PAGE_SIZE = 25;

export const DisciplineRecords: React.FC = () => {
  const toast = useToast();
  const { can } = usePermissions();
  const [overview, setOverview] = useState<Overview | null>(null);
  const [records, setRecords] = useState<DisciplineRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [dismissTarget, setDismissTarget] = useState<DisciplineRecord | null>(null);
  const [menuOpenId, setMenuOpenId] = useState<number | null>(null);
  const [detailId, setDetailId] = useState<number | null>(null);
  const tableRef = useRef<HTMLDivElement>(null);

  const [filters, setFilters] = useState({ type: '', status: '', search: '' });
  const [offset, setOffset] = useState(0);

  const loadOverview = useCallback(async () => {
    try {
      const res = await apiGet<Overview>('/api/discipline/overview');
      setOverview(res.data ?? null);
    } catch { /* non-fatal */ }
  }, []);

  const loadRecords = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const qs = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
      if (filters.type) qs.set('type', filters.type);
      if (filters.status) qs.set('status', filters.status);
      if (filters.search) qs.set('search', filters.search);
      const res = await apiGet<DisciplineRecord[]>(`/api/discipline?${qs.toString()}`);
      setRecords(res.data || []);
      setTotal(res.total ?? res.data?.length ?? 0);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load discipline records.');
    } finally {
      setLoading(false);
    }
  }, [filters, offset]);

  useEffect(() => { loadOverview(); }, [loadOverview]);

  // Debounce search; immediate for selects.
  useEffect(() => {
    const t = setTimeout(loadRecords, filters.search ? 300 : 0);
    return () => clearTimeout(t);
  }, [loadRecords]);

  // Close the row-actions popover on an outside click.
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (tableRef.current && !tableRef.current.contains(e.target as Node)) setMenuOpenId(null);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const updateStatus = async (rec: DisciplineRecord, status: string) => {
    setBusyId(rec.id);
    setMenuOpenId(null);
    try {
      const res = await apiPut<DisciplineRecord>(`/api/discipline/${rec.id}/status`, { status });
      setRecords((list) => list.map((x) => (x.id === rec.id ? res.data! : x)));
      loadOverview();
      toast.success('Record updated', `${rec.student_name} · ${status.replace('_', ' ')}`);
    } catch (err) {
      toast.error('Could not update', err instanceof ApiError ? err.message : 'Could not update the record.');
    } finally {
      setBusyId(null);
    }
  };

  const setFilter = (patch: Partial<typeof filters>) => { setOffset(0); setFilters((f) => ({ ...f, ...patch })); };

  const exportCSV = () => {
    let csv = 'Student Name,Student ID,Type,Category,Severity,Points,Title,Date,Sanction,Status\n';
    records.forEach((r) => {
      csv += `"${r.student_name}",${r.student_id},${r.type},"${r.category}",${r.severity ?? ''},${r.points},"${r.title}",${r.incident_date},${r.sanction},${r.status}\n`;
    });
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `discipline-records-${new Date().toISOString().split('T')[0]}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const stats = overview?.totals;
  const page = Math.floor(offset / PAGE_SIZE) + 1;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <DashboardLayout>
      <div className="page-header">
        <div>
          <h1 className="page-title">Discipline Records</h1>
          <p className="page-subtitle">Review conduct records, sanctions, and their status.</p>
        </div>
        <button className="btn btn-outline" onClick={exportCSV} disabled={!records.length} data-track="tendo.discipline_records.export">
          <Download size={16} /> Export CSV
        </button>
      </div>

      {/* Overview cards */}
      <div className="grid grid-stats mb-4" style={{ gap: '12px' }}>
        {[
          ['Total records', stats?.total ?? 0, 'text-primary'],
          ['Demerits', stats?.demerits ?? 0, 'text-danger'],
          ['Merits', stats?.merits ?? 0, 'text-success'],
          ['Open', stats?.open ?? 0, 'text-warning'],
          ['Under review', stats?.underReview ?? 0, 'text-info'],
        ].map(([label, value, cls]) => (
          <div key={label as string} className="card card-pad">
            <div className={`text-2xl font-bold ${cls}`}>{value as number}</div>
            <div className="text-xs text-secondary">{label as string}</div>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="card card-pad mb-4">
        <div className="flex flex-wrap gap-3 items-end">
          <div className="field" style={{ flex: '1 1 220px' }}>
            <label className="label">Search</label>
            <input className="input" placeholder="Student name, ID or title…" value={filters.search} onChange={(e) => setFilter({ search: e.target.value })} />
          </div>
          <div className="field">
            <label className="label">Type</label>
            <SearchableSelect
              value={filters.type}
              onChange={(v) => setFilter({ type: v })}
              options={[
                { value: '', label: 'All' },
                { value: 'demerit', label: 'Demerits' },
                { value: 'merit', label: 'Merits' },
              ]}
              placeholder="All"
              aria-label="Filter by type"
            />
          </div>
          <div className="field">
            <label className="label">Status</label>
            <SearchableSelect
              value={filters.status}
              onChange={(v) => setFilter({ status: v })}
              options={[
                { value: '', label: 'All' },
                { value: 'open', label: 'Open' },
                { value: 'under_review', label: 'Under review' },
                { value: 'resolved', label: 'Resolved' },
                { value: 'dismissed', label: 'Dismissed' },
              ]}
              placeholder="All"
              aria-label="Filter by status"
            />
          </div>
        </div>
      </div>

      {error && <div className="mb-4"><ErrorState message={error} onRetry={loadRecords} /></div>}

      <div className="card" ref={tableRef}>
        <div className="card-header"><span className="section-title">Records {total > 0 && `(${total})`}</span></div>
        {loading ? (
          <div style={{ padding: '48px 0' }}><LoadingSpinner /></div>
        ) : records.length === 0 ? (
          <div className="empty-state"><Inbox size={28} /><span className="text-sm">No discipline records match your filters.</span></div>
        ) : (
          <div className="table-wrap">
            <table className="table table--zebra">
              <thead>
                <tr>
                  <th>Student</th><th>Type</th><th>Category</th><th>Date</th>
                  <th>Sanction</th><th>Status</th><th></th>
                </tr>
              </thead>
              <tbody>
                {records.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <button
                        className="font-medium"
                        style={{ textAlign: 'left', background: 'none', border: 0, padding: 0, cursor: 'pointer', color: 'var(--text-link, var(--primary))' }}
                        onClick={() => setDetailId(r.id)}
                      >
                        {r.student_name}
                      </button>
                      <div className="text-xs text-secondary">{r.title}</div>
                    </td>
                    <td>
                      <span className={`badge ${r.type === 'merit' ? 'badge-success' : 'badge-danger'}`}>
                        {r.type === 'merit' ? <Award size={12} /> : <Gavel size={12} />}
                        {r.type === 'merit' ? '+' : '−'}{r.points}
                      </span>
                    </td>
                    <td>
                      <div>{r.category}</div>
                      {r.severity && <div className="text-xs text-secondary capitalize">{r.severity}</div>}
                    </td>
                    <td>{new Date(r.incident_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</td>
                    <td className={r.sanction === 'none' ? 'text-tertiary' : ''}>{SANCTION_LABEL[r.sanction] ?? r.sanction}</td>
                    <td><span className={`badge ${STATUS_BADGE[r.status]}`}>{STATUS_LABEL[r.status]}</span></td>
                    <td style={{ position: 'relative', textAlign: 'right' }}>
                      <button
                        className="icon-btn"
                        aria-label="Row actions"
                        onClick={() => setMenuOpenId((id) => (id === r.id ? null : r.id))}
                      >
                        <MoreVertical size={16} />
                      </button>
                      {menuOpenId === r.id && (
                        <div className="menu menu--right animate-fade-in" style={{ position: 'absolute', right: 8, top: '100%', zIndex: 20 }}>
                          <button className="menu-item" onClick={() => { setDetailId(r.id); setMenuOpenId(null); }}>
                            <Eye size={16} /><span>Open details</span>
                          </button>
                          <Link to={`/reports/student/${r.student_id}`} className="menu-item" onClick={() => setMenuOpenId(null)}>
                            <FileBarChart size={16} /><span>View full report</span>
                          </Link>
                          {r.type === 'demerit' && r.status === 'open' && (
                            <button className="menu-item" disabled={busyId === r.id || !can('DISCIPLINE_REVIEW')} onClick={() => updateStatus(r, 'under_review')}>
                              Mark under review
                            </button>
                          )}
                          {r.type === 'demerit' && (r.status === 'open' || r.status === 'under_review') && (
                            <>
                              <button className="menu-item" disabled={busyId === r.id || !can('DISCIPLINE_REVIEW')} onClick={() => updateStatus(r, 'resolved')}>
                                Resolve
                              </button>
                              <button
                                className="menu-item menu-item--danger"
                                disabled={busyId === r.id || !can('DISCIPLINE_REVIEW')}
                                onClick={() => { setDismissTarget(r); setMenuOpenId(null); }}
                              >
                                Dismiss
                              </button>
                            </>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {total > PAGE_SIZE && (
          <div className="flex items-center justify-between" style={{ padding: '12px 16px', borderTop: '1px solid var(--border)' }}>
            <span className="text-sm text-secondary">Page {page} of {pageCount}</span>
            <div className="flex gap-2">
              <button className="btn btn-outline btn-sm" disabled={offset === 0} onClick={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}><ChevronLeft size={14} /> Prev</button>
              <button className="btn btn-outline btn-sm" disabled={page >= pageCount} onClick={() => setOffset((o) => o + PAGE_SIZE)}>Next <ChevronRight size={14} /></button>
            </div>
          </div>
        )}
      </div>

      {detailId != null && (
        <DisciplineDetailModal
          id={detailId}
          onClose={() => setDetailId(null)}
          onChanged={() => { loadRecords(); loadOverview(); }}
        />
      )}

      <ConfirmDialog
        open={!!dismissTarget}
        title="Dismiss this record?"
        message={dismissTarget ? `Dismiss the ${dismissTarget.category} demerit for ${dismissTarget.student_name}? It will be marked dismissed and excluded from follow-up.` : ''}
        confirmLabel="Dismiss"
        danger
        loading={!!dismissTarget && busyId === dismissTarget.id}
        onCancel={() => setDismissTarget(null)}
        onConfirm={async () => {
          if (!dismissTarget) return;
          const t = dismissTarget;
          setDismissTarget(null);
          await updateStatus(t, 'dismissed');
        }}
      />
    </DashboardLayout>
  );
};
