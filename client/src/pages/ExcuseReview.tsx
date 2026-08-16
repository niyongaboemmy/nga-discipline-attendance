import React, { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { DashboardLayout } from '../components/Layout/DashboardLayout';
import { LoadingSpinner } from '../components/common/LoadingSpinner';
import { ErrorState } from '../components/common/ErrorState';
import { useToast } from '../context/ToastContext';
import { usePermissions } from '../hooks/usePermissions';
import { apiGet, apiPut, ApiError } from '../api/client';
import { Check, X, Inbox, FileBarChart } from 'lucide-react';

interface Excuse {
  id: number;
  student_id: string;
  student_name: string;
  class_name: string;
  session_date: string;
  reason: string;
  description: string;
  status: 'approved' | 'pending' | 'rejected';
  created_at: string;
}

const STATUS_BADGE: Record<string, string> = { approved: 'badge-success', pending: 'badge-warning', rejected: 'badge-danger' };
const FILTERS = ['pending', 'approved', 'rejected', 'all'] as const;
type Filter = (typeof FILTERS)[number];

/** Operational review queue — same table pattern as DisciplineRecords, not
 *  a personal card feed, since this is staff triaging a queue rather than a
 *  student browsing their own history. */
export const ExcuseReview: React.FC = () => {
  const toast = useToast();
  const { can } = usePermissions();
  const [excuses, setExcuses] = useState<Excuse[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('pending');
  const [search, setSearch] = useState('');
  const [busyId, setBusyId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const qs = filter === 'all' ? '' : `?status=${filter}`;
      const res = await apiGet<Excuse[]>(`/api/attendance/excuses${qs}`);
      setExcuses(res.data || []);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load excuse requests.');
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => { load(); }, [load]);

  const review = async (ex: Excuse, status: 'approved' | 'rejected') => {
    setBusyId(ex.id);
    try {
      const res = await apiPut<Excuse>(`/api/attendance/excuse/${ex.id}/status`, { status });
      toast.success(`Excuse ${status}`, `${ex.student_name} · ${ex.class_name}`);
      // Drop it from a status-specific view; otherwise update in place.
      if (filter !== 'all') setExcuses((list) => list.filter((x) => x.id !== ex.id));
      else setExcuses((list) => list.map((x) => (x.id === ex.id ? res.data! : x)));
    } catch (err) {
      toast.error('Could not update', err instanceof ApiError ? err.message : 'Could not reach the server.');
    } finally { setBusyId(null); }
  };

  const visible = search
    ? excuses.filter((e) => e.student_name.toLowerCase().includes(search.toLowerCase()) || e.student_id.toLowerCase().includes(search.toLowerCase()))
    : excuses;
  const pendingCount = excuses.filter((e) => e.status === 'pending').length;

  return (
    <DashboardLayout>
      <div className="page-header">
        <div>
          <h1 className="page-title">Excuse Review</h1>
          <p className="page-subtitle">Approve or reject student leave and absence requests.</p>
        </div>
        {filter === 'pending' && pendingCount > 0 && (
          <span className="badge badge-warning" style={{ marginTop: '6px' }}>{pendingCount} awaiting review</span>
        )}
      </div>

      <div className="card card-body mb-4">
        <div className="flex flex-wrap items-center gap-3">
          <input className="input" style={{ flex: 1, minWidth: '200px' }} placeholder="Search student name or ID…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <div className="flex flex-wrap gap-2 mt-3">
          {FILTERS.map((f) => (
            <button key={f} className={`chip capitalize${filter === f ? ' is-active' : ''}`} onClick={() => setFilter(f)}>{f}</button>
          ))}
        </div>
      </div>

      {error && <div className="mb-4"><ErrorState message={error} onRetry={load} /></div>}

      <div className="card">
        {loading ? (
          <div style={{ padding: '64px 0' }}><LoadingSpinner /></div>
        ) : visible.length === 0 ? (
          <div className="empty-state"><Inbox size={28} /><span className="text-sm">No {filter === 'all' ? '' : filter} excuse requests{search ? ' match your search' : ''}.</span></div>
        ) : (
          <div className="table-wrap">
            <table className="table table--zebra">
              <thead>
                <tr><th>Student</th><th>Class</th><th>Date</th><th>Reason</th><th>Status</th><th></th></tr>
              </thead>
              <tbody>
                {visible.map((ex) => (
                  <tr key={ex.id}>
                    <td>
                      <div className="font-medium">{ex.student_name}</div>
                      <div className="text-xs text-secondary mono">{ex.student_id}</div>
                    </td>
                    <td>{ex.class_name}</td>
                    <td>{ex.session_date}</td>
                    <td>
                      <div>{ex.reason}</div>
                      {ex.description && <div className="text-xs text-secondary truncate" style={{ maxWidth: '260px' }}>{ex.description}</div>}
                    </td>
                    <td><span className={`badge ${STATUS_BADGE[ex.status]} capitalize`}>{ex.status}</span></td>
                    <td>
                      <div className="flex gap-1 flex-wrap justify-end">
                        <Link to={`/reports/student/${ex.student_id}`} className="btn btn-outline btn-sm" title="View full report">
                          <FileBarChart size={14} />
                        </Link>
                        {ex.status === 'pending' && (
                          <>
                            <button
                              className="btn btn-danger btn-sm"
                              disabled={busyId === ex.id || !can('EXCUSES_REVIEW')}
                              title={can('EXCUSES_REVIEW') ? undefined : "You don't have permission to review excuses."}
                              onClick={() => review(ex, 'rejected')}
                            >
                              <X size={14} /> Reject
                            </button>
                            <button
                              className="btn btn-primary btn-sm"
                              disabled={busyId === ex.id || !can('EXCUSES_REVIEW')}
                              title={can('EXCUSES_REVIEW') ? undefined : "You don't have permission to review excuses."}
                              onClick={() => review(ex, 'approved')}
                            >
                              <Check size={14} /> Approve
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </DashboardLayout>
  );
};
