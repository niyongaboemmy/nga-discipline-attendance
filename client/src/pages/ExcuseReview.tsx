import React, { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { DashboardLayout } from '../components/Layout/DashboardLayout';
import { LoadingSpinner } from '../components/common/LoadingSpinner';
import { ErrorState } from '../components/common/ErrorState';
import { Modal } from '../components/common/Modal';
import { useToast } from '../context/ToastContext';
import { usePermissions } from '../hooks/usePermissions';
import { apiGet, apiPut, ApiError } from '../api/client';
import { Check, X, Inbox, FileBarChart, AlertTriangle, CheckCircle2 } from 'lucide-react';

interface Excuse {
  id: number;
  student_id: string;
  student_name: string;
  class_name: string;
  session_type?: 'homeroom' | 'subject';
  subject_name?: string | null;
  session_date: string;
  reason: string;
  description: string;
  status: 'approved' | 'pending' | 'rejected';
  created_at: string;
  reviewer_note: string | null;
  attendanceStatus: string | null;
  isMarkedAbsent: boolean;
  priorExcuseCount: number;
}

const STATUS_BADGE: Record<string, string> = { approved: 'badge-success', pending: 'badge-warning', rejected: 'badge-danger' };
const FILTERS = ['pending', 'approved', 'rejected', 'all'] as const;
type Filter = (typeof FILTERS)[number];

export const ExcuseReview: React.FC = () => {
  const toast = useToast();
  const { can } = usePermissions();
  const [excuses, setExcuses] = useState<Excuse[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('pending');
  const [search, setSearch] = useState('');
  const [busyId, setBusyId] = useState<number | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [noteModal, setNoteModal] = useState<null | { ids: number[]; status: 'approved' | 'rejected' }>(null);
  const [note, setNote] = useState('');
  const [bulkBusy, setBulkBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    setSelected(new Set());
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

  const review = async (ex: Excuse, status: 'approved' | 'rejected', reviewerNote?: string) => {
    setBusyId(ex.id);
    try {
      const res = await apiPut<Excuse>(`/api/attendance/excuse/${ex.id}/status`, { status, reviewerNote });
      toast.success(`Excuse ${status}`, res.data ? `${ex.student_name}` : undefined);
      if (filter !== 'all') setExcuses((list) => list.filter((x) => x.id !== ex.id));
      else setExcuses((list) => list.map((x) => (x.id === ex.id ? { ...x, ...res.data! } : x)));
    } catch (err) {
      toast.error('Could not update', err instanceof ApiError ? err.message : 'Could not reach the server.');
    } finally { setBusyId(null); }
  };

  const runBulk = async (ids: number[], status: 'approved' | 'rejected', reviewerNote?: string) => {
    setBulkBusy(true);
    try {
      const res = await apiPut<{ processed: number; attendanceRowsChanged: number }>(
        '/api/attendance/excuses/bulk', { ids, status, reviewerNote }
      );
      toast.success(
        `${res.data?.processed ?? ids.length} ${status}`,
        res.data?.attendanceRowsChanged ? `${res.data.attendanceRowsChanged} attendance records updated` : undefined
      );
      setNoteModal(null);
      setNote('');
      load();
    } catch (err) {
      toast.error('Bulk update failed', err instanceof ApiError ? err.message : 'Could not reach the server.');
    } finally { setBulkBusy(false); }
  };

  const visible = search
    ? excuses.filter((e) => e.student_name.toLowerCase().includes(search.toLowerCase()) || e.student_id.toLowerCase().includes(search.toLowerCase()))
    : excuses;
  const pendingVisible = visible.filter((e) => e.status === 'pending');
  const allPendingSelected = pendingVisible.length > 0 && pendingVisible.every((e) => selected.has(e.id));

  const toggle = (id: number) =>
    setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const toggleAll = () =>
    setSelected(allPendingSelected ? new Set() : new Set(pendingVisible.map((e) => e.id)));

  return (
    <DashboardLayout>
      <div className="page-header">
        <div>
          <h1 className="page-title">Excuse Review</h1>
          <p className="page-subtitle">Approve or reject absence requests — approving marks the day excused.</p>
        </div>
        {filter === 'pending' && pendingVisible.length > 0 && (
          <span className="badge badge-warning" style={{ marginTop: '6px' }}>{pendingVisible.length} awaiting review</span>
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

      {selected.size > 0 && (
        <div className="card card-body mb-4 flex items-center justify-between flex-wrap gap-3" style={{ borderColor: 'var(--primary)' }}>
          <span className="text-sm font-medium">{selected.size} selected</span>
          <div className="flex gap-2">
            <button className="btn btn-outline btn-sm" disabled={bulkBusy} onClick={() => setNoteModal({ ids: [...selected], status: 'rejected' })}>
              <X size={14} /> Reject all
            </button>
            <button className="btn btn-primary btn-sm" disabled={bulkBusy || !can('EXCUSES_REVIEW')} onClick={() => runBulk([...selected], 'approved')} data-track="tendo.excuse.review_approve">
              <Check size={14} /> Approve all
            </button>
          </div>
        </div>
      )}

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
                <tr>
                  {pendingVisible.length > 0 && (
                    <th style={{ width: 32 }}>
                      <input type="checkbox" checked={allPendingSelected} onChange={toggleAll} aria-label="Select all pending" />
                    </th>
                  )}
                  <th>Student</th><th>Class · Date</th><th>Reason</th><th>Context</th><th>Status</th><th></th>
                </tr>
              </thead>
              <tbody>
                {visible.map((ex) => (
                  <tr key={ex.id}>
                    {pendingVisible.length > 0 && (
                      <td>
                        {ex.status === 'pending' && (
                          <input type="checkbox" checked={selected.has(ex.id)} onChange={() => toggle(ex.id)} aria-label={`Select ${ex.student_name}`} />
                        )}
                      </td>
                    )}
                    <td>
                      <div className="font-medium">{ex.student_name}</div>
                      <div className="text-xs text-secondary mono">{ex.student_id}</div>
                    </td>
                    <td>
                      <div>{ex.session_type === 'subject' ? (ex.subject_name || 'Lesson') : 'Morning check'}</div>
                      <div className="text-xs text-secondary">{ex.class_name} · {ex.session_date}</div>
                    </td>
                    <td>
                      <div>{ex.reason}</div>
                      {ex.description && <div className="text-xs text-secondary truncate" style={{ maxWidth: '240px' }}>{ex.description}</div>}
                      {ex.reviewer_note && <div className="text-xs text-info mt-1">Note: {ex.reviewer_note}</div>}
                    </td>
                    <td>
                      {ex.isMarkedAbsent ? (
                        <span className="badge badge-danger" title="Student is marked absent that day"><AlertTriangle size={11} /> Marked absent</span>
                      ) : ex.attendanceStatus ? (
                        <span className="badge badge-neutral capitalize" title="Current attendance status that day">{ex.attendanceStatus}</span>
                      ) : (
                        <span className="text-xs text-tertiary">No register yet</span>
                      )}
                      {ex.priorExcuseCount > 0 && (
                        <div className="text-xs text-secondary mt-1">{ex.priorExcuseCount} prior request{ex.priorExcuseCount === 1 ? '' : 's'}</div>
                      )}
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
                              className="btn btn-outline btn-sm"
                              disabled={busyId === ex.id || !can('EXCUSES_REVIEW')}
                              onClick={() => setNoteModal({ ids: [ex.id], status: 'rejected' })}
                            >
                              <X size={14} /> Reject
                            </button>
                            <button
                              className="btn btn-primary btn-sm"
                              disabled={busyId === ex.id || !can('EXCUSES_REVIEW')}
                              onClick={() => review(ex, 'approved')}
                              data-track="tendo.excuse.review_approve"
                            >
                              <Check size={14} /> Approve
                            </button>
                          </>
                        )}
                        {ex.status === 'approved' && (
                          <button
                            className="btn btn-outline btn-sm"
                            disabled={busyId === ex.id || !can('EXCUSES_REVIEW')}
                            title="Revert to rejected — this restores the absence"
                            onClick={() => setNoteModal({ ids: [ex.id], status: 'rejected' })}
                          >
                            <X size={14} /> Revoke
                          </button>
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

      <Modal
        open={!!noteModal}
        title={noteModal?.status === 'rejected' ? 'Reject request' : 'Approve request'}
        subtitle={noteModal ? `${noteModal.ids.length} request${noteModal.ids.length === 1 ? '' : 's'}` : ''}
        onClose={() => { setNoteModal(null); setNote(''); }}
        footer={
          <>
            <button className="btn btn-outline" onClick={() => { setNoteModal(null); setNote(''); }} disabled={bulkBusy}>Cancel</button>
            <button
              className={`btn ${noteModal?.status === 'rejected' ? 'btn-danger' : 'btn-primary'}`}
              disabled={bulkBusy}
              onClick={() => noteModal && runBulk(noteModal.ids, noteModal.status, note.trim() || undefined)}
            >
              {noteModal?.status === 'rejected' ? 'Reject' : 'Approve'}
            </button>
          </>
        }
      >
        <div className="field">
          <label className="label">Note to the student (optional)</label>
          <textarea
            className="textarea"
            placeholder={noteModal?.status === 'rejected' ? 'e.g. Please attach a doctor’s note and resubmit as an appeal.' : 'Optional note.'}
            maxLength={500}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
        {noteModal?.status === 'rejected' && (
          <p className="text-xs text-secondary flex items-center gap-1"><CheckCircle2 size={12} /> Rejecting an approved request restores the day to absent.</p>
        )}
      </Modal>
    </DashboardLayout>
  );
};
