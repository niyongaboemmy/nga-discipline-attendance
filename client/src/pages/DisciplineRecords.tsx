import React, { useState, useEffect, useCallback } from 'react';
import { DashboardLayout } from '../components/Layout/DashboardLayout';
import { LoadingSpinner } from '../components/common/LoadingSpinner';
import { ConfirmDialog } from '../components/common/ConfirmDialog';
import { useToast } from '../context/ToastContext';
import { Gavel, Award, AlertCircle, Inbox, ChevronLeft, ChevronRight } from 'lucide-react';

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

const authHeaders = () => ({ Authorization: `Bearer ${localStorage.getItem('sso_token')}` });
const PAGE_SIZE = 25;

export const DisciplineRecords: React.FC = () => {
  const toast = useToast();
  const [overview, setOverview] = useState<Overview | null>(null);
  const [records, setRecords] = useState<DisciplineRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [dismissTarget, setDismissTarget] = useState<DisciplineRecord | null>(null);

  const [filters, setFilters] = useState({ type: '', status: '', search: '' });
  const [offset, setOffset] = useState(0);

  const loadOverview = useCallback(async () => {
    try {
      const res = await fetch('/api/discipline/overview', { headers: authHeaders() });
      if (res.ok) { const r = await res.json(); if (r.success) setOverview(r.data); }
    } catch { /* non-fatal */ }
  }, []);

  const loadRecords = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const qs = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
      if (filters.type) qs.set('type', filters.type);
      if (filters.status) qs.set('status', filters.status);
      if (filters.search) qs.set('search', filters.search);
      const res = await fetch(`/api/discipline?${qs.toString()}`, { headers: authHeaders() });
      if (!res.ok) throw new Error('Could not load discipline records.');
      const r = await res.json();
      if (!r.success) throw new Error(r.message || 'Server error.');
      setRecords(r.data);
      setTotal(r.total ?? r.data.length);
    } catch (err) { setError((err as Error).message); }
    finally { setLoading(false); }
  }, [filters, offset]);

  useEffect(() => { loadOverview(); }, [loadOverview]);

  // Debounce search; immediate for selects.
  useEffect(() => {
    const t = setTimeout(loadRecords, filters.search ? 300 : 0);
    return () => clearTimeout(t);
  }, [loadRecords]);

  const updateStatus = async (rec: DisciplineRecord, status: string) => {
    setBusyId(rec.id);
    try {
      const res = await fetch(`/api/discipline/${rec.id}/status`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ status }),
      });
      const r = await res.json();
      if (res.ok && r.success) {
        setRecords((list) => list.map((x) => (x.id === rec.id ? r.data : x)));
        loadOverview();
        toast.success('Record updated', `${rec.student_name} · ${status.replace('_', ' ')}`);
      } else {
        toast.error('Could not update', r.message);
      }
    } catch {
      toast.error('Network error', 'Could not update the record.');
    } finally { setBusyId(null); }
  };

  const setFilter = (patch: Partial<typeof filters>) => { setOffset(0); setFilters((f) => ({ ...f, ...patch })); };

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
            <select className="select" value={filters.type} onChange={(e) => setFilter({ type: e.target.value })}>
              <option value="">All</option><option value="demerit">Demerits</option><option value="merit">Merits</option>
            </select>
          </div>
          <div className="field">
            <label className="label">Status</label>
            <select className="select" value={filters.status} onChange={(e) => setFilter({ status: e.target.value })}>
              <option value="">All</option>
              <option value="open">Open</option><option value="under_review">Under review</option>
              <option value="resolved">Resolved</option><option value="dismissed">Dismissed</option>
            </select>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-header"><span className="section-title">Records {total > 0 && `(${total})`}</span></div>
        {loading ? (
          <div style={{ padding: '48px 0' }}><LoadingSpinner /></div>
        ) : error ? (
          <div className="empty-state"><AlertCircle size={28} /><span className="text-sm">{error}</span></div>
        ) : records.length === 0 ? (
          <div className="empty-state"><Inbox size={28} /><span className="text-sm">No discipline records match your filters.</span></div>
        ) : (
          <div className="table-wrap">
            <table className="table table--zebra">
              <thead>
                <tr>
                  <th>Student</th><th>Type</th><th>Category</th><th>Date</th>
                  <th>Sanction</th><th>Status</th><th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {records.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <div className="font-medium">{r.student_name}</div>
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
                    <td>
                      {r.type === 'demerit' ? (
                        <div className="flex gap-1 flex-wrap">
                          {r.status === 'open' && (
                            <button className="btn btn-outline btn-sm" disabled={busyId === r.id} onClick={() => updateStatus(r, 'under_review')}>Review</button>
                          )}
                          {(r.status === 'open' || r.status === 'under_review') && (
                            <>
                              <button className="btn btn-outline btn-sm" disabled={busyId === r.id} onClick={() => updateStatus(r, 'resolved')}>Resolve</button>
                              <button className="btn btn-outline btn-sm" disabled={busyId === r.id} onClick={() => setDismissTarget(r)}>Dismiss</button>
                            </>
                          )}
                          {(r.status === 'resolved' || r.status === 'dismissed') && <span className="text-xs text-tertiary">Closed</span>}
                        </div>
                      ) : <span className="text-xs text-tertiary">—</span>}
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
