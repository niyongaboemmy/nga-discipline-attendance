import React, { useState, useEffect, useCallback } from 'react';
import { DashboardLayout } from '../components/Layout/DashboardLayout';
import { LoadingSpinner } from '../components/common/LoadingSpinner';
import { Inbox, AlertCircle, ChevronLeft, ChevronRight, Search } from 'lucide-react';

interface AuditEntry {
  id: number;
  actor_id: string;
  actor_name: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  details: string | null;
  created_at: string;
}

const ACTION_BADGE: Record<string, string> = {
  'role.assign': 'badge-primary',
  'discipline.create': 'badge-info',
  'discipline.status': 'badge-warning',
  'excuse.review': 'badge-success',
};

const authHeaders = () => ({ Authorization: `Bearer ${localStorage.getItem('sso_token')}` });
const PAGE_SIZE = 50;

const formatDetails = (raw: string | null): string => {
  if (!raw) return '—';
  try {
    const obj = JSON.parse(raw);
    return Object.entries(obj).map(([k, v]) => `${k}: ${v}`).join(', ');
  } catch { return raw; }
};

export const AuditLog: React.FC = () => {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [actions, setActions] = useState<string[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [action, setAction] = useState('');
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const qs = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
      if (action) qs.set('action', action);
      if (search) qs.set('search', search);
      const res = await fetch(`/api/admin/audit?${qs.toString()}`, { headers: authHeaders() });
      if (!res.ok) throw new Error('Could not load the audit log.');
      const result = await res.json();
      if (!result.success) throw new Error(result.message || 'Server error.');
      setEntries(result.data);
      setTotal(result.total ?? result.data.length);
      if (result.actions) setActions(result.actions);
    } catch (err) { setError((err as Error).message); }
    finally { setLoading(false); }
  }, [action, search, offset]);

  useEffect(() => {
    const t = setTimeout(load, search ? 300 : 0);
    return () => clearTimeout(t);
  }, [load]);

  const page = Math.floor(offset / PAGE_SIZE) + 1;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <DashboardLayout>
      <div className="page-header">
        <div>
          <h1 className="page-title">Audit Log</h1>
          <p className="page-subtitle">A record of sensitive actions: role changes, conduct decisions, and excuse reviews.</p>
        </div>
      </div>

      <div className="card card-body mb-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="input-with-icon" style={{ flex: 1, minWidth: '220px' }}>
            <Search className="field-icon" size={16} />
            <input className="input" placeholder="Search actor or entity…" value={search} onChange={(e) => { setOffset(0); setSearch(e.target.value); }} />
          </div>
          <select className="select" style={{ width: 'auto', minWidth: '180px' }} value={action} onChange={(e) => { setOffset(0); setAction(e.target.value); }}>
            <option value="">All actions</option>
            {actions.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </div>
      </div>

      <div className="card">
        <div className="card-header"><span className="section-title">Entries {total > 0 && `(${total})`}</span></div>
        {loading ? (
          <div style={{ padding: '48px 0' }}><LoadingSpinner /></div>
        ) : error ? (
          <div className="empty-state"><AlertCircle size={28} /><span className="text-sm">{error}</span></div>
        ) : entries.length === 0 ? (
          <div className="empty-state"><Inbox size={28} /><span className="text-sm">No audit entries match your filters.</span></div>
        ) : (
          <div className="table-wrap">
            <table className="table table--zebra">
              <thead>
                <tr><th>When</th><th>Actor</th><th>Action</th><th>Entity</th><th>Details</th></tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.id}>
                    <td className="text-secondary" style={{ whiteSpace: 'nowrap' }}>{new Date(e.created_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</td>
                    <td>
                      <div className="font-medium">{e.actor_name || '—'}</div>
                      <div className="text-xs text-secondary mono">{e.actor_id}</div>
                    </td>
                    <td><span className={`badge ${ACTION_BADGE[e.action] || 'badge-neutral'}`}>{e.action}</span></td>
                    <td className="text-sm">{e.entity_type}{e.entity_id ? ` #${e.entity_id}` : ''}</td>
                    <td className="text-sm text-secondary">{formatDetails(e.details)}</td>
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
    </DashboardLayout>
  );
};
