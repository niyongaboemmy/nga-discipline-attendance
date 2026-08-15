import React, { useState, useEffect, useCallback } from 'react';
import { DashboardLayout } from '../components/Layout/DashboardLayout';
import { LoadingSpinner } from '../components/common/LoadingSpinner';
import { useToast } from '../context/ToastContext';
import { usePermissions } from '../hooks/usePermissions';
import { Check, X, Inbox, AlertCircle, Calendar } from 'lucide-react';

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

const authHeaders = () => ({ Authorization: `Bearer ${localStorage.getItem('sso_token')}` });

export const ExcuseReview: React.FC = () => {
  const toast = useToast();
  const { can } = usePermissions();
  const [excuses, setExcuses] = useState<Excuse[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('pending');
  const [busyId, setBusyId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const qs = filter === 'all' ? '' : `?status=${filter}`;
      const res = await fetch(`/api/attendance/excuses${qs}`, { headers: authHeaders() });
      if (!res.ok) throw new Error('Could not load excuse requests.');
      const result = await res.json();
      if (!result.success) throw new Error(result.message || 'Server error.');
      setExcuses(result.data);
    } catch (err) { setError((err as Error).message); }
    finally { setLoading(false); }
  }, [filter]);

  useEffect(() => { load(); }, [load]);

  const review = async (ex: Excuse, status: 'approved' | 'rejected') => {
    setBusyId(ex.id);
    try {
      const res = await fetch(`/api/attendance/excuse/${ex.id}/status`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ status }),
      });
      const result = await res.json();
      if (res.ok && result.success) {
        toast.success(`Excuse ${status}`, `${ex.student_name} · ${ex.class_name}`);
        // Drop it from a status-specific view; otherwise update in place.
        if (filter !== 'all') setExcuses((list) => list.filter((x) => x.id !== ex.id));
        else setExcuses((list) => list.map((x) => (x.id === ex.id ? result.data : x)));
      } else {
        toast.error('Could not update', result.message);
      }
    } catch {
      toast.error('Network error', 'Could not reach the server.');
    } finally { setBusyId(null); }
  };

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
        <div className="flex flex-wrap gap-2">
          {FILTERS.map((f) => (
            <button key={f} className={`chip capitalize${filter === f ? ' is-active' : ''}`} onClick={() => setFilter(f)}>{f}</button>
          ))}
        </div>
      </div>

      {loading ? (
        <div style={{ padding: '64px 0' }}><LoadingSpinner /></div>
      ) : error ? (
        <div className="card"><div className="empty-state"><AlertCircle size={28} /><span className="text-sm">{error}</span></div></div>
      ) : excuses.length === 0 ? (
        <div className="card"><div className="empty-state"><Inbox size={28} /><span className="text-sm">No {filter === 'all' ? '' : filter} excuse requests.</span></div></div>
      ) : (
        <div className="flex flex-col gap-3">
          {excuses.map((ex) => (
            <div key={ex.id} className="card card-pad flex flex-col gap-3">
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div style={{ minWidth: 0 }}>
                  <div className="text-sm font-semibold">{ex.student_name} <span className="text-secondary mono text-xs">· {ex.student_id}</span></div>
                  <div className="text-xs text-secondary flex items-center gap-1 mt-1">
                    <Calendar size={12} /> {ex.class_name} · {ex.session_date} · {ex.reason}
                  </div>
                </div>
                <span className={`badge ${STATUS_BADGE[ex.status]} capitalize`}>{ex.status}</span>
              </div>
              {ex.description && (
                <div className="border rounded text-sm" style={{ padding: '10px 12px', background: 'var(--bg-subtle)' }}>{ex.description}</div>
              )}
              {ex.status === 'pending' && (
                <div className="flex gap-2 justify-end">
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
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </DashboardLayout>
  );
};
