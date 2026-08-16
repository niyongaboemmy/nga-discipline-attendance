import React, { useState, useEffect, useCallback } from 'react';
import { DashboardLayout } from '../components/Layout/DashboardLayout';
import { LoadingSpinner } from '../components/common/LoadingSpinner';
import { ErrorState } from '../components/common/ErrorState';
import { apiGet, ApiError } from '../api/client';
import { SearchableSelect } from '../components/common/SearchableSelect';
import { Inbox, ChevronLeft, ChevronRight, Search } from 'lucide-react';

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

// Badge color by the action's category (the segment before the first '.') —
// a small lookup instead of one entry per exact action string, so newer
// action types (discipline_rule.create, discipline.adjust, …) render
// correctly instead of silently falling back to neutral.
const CATEGORY_BADGE: Record<string, string> = {
  role: 'badge-primary',
  roles: 'badge-primary',
  users: 'badge-primary',
  discipline: 'badge-info',
  discipline_rule: 'badge-info',
  attendance: 'badge-warning',
  excuse: 'badge-success',
};

/** "discipline_rule.create" -> { label: "Discipline Rule · Create", badgeClass: "badge-info" } */
function formatAction(action: string): { label: string; badgeClass: string } {
  const [category, ...rest] = action.split('.');
  const titleCase = (s: string) => s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  const label = [category, ...rest].map(titleCase).join(' · ');
  return { label, badgeClass: CATEGORY_BADGE[category] || 'badge-neutral' };
}

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
      const res = await apiGet<AuditEntry[]>(`/api/admin/audit?${qs.toString()}`);
      setEntries(res.data || []);
      setTotal(res.total ?? res.data?.length ?? 0);
      if ((res as any).actions) setActions((res as any).actions);
    } catch (err) { setError(err instanceof ApiError ? err.message : 'Could not load the audit log.'); }
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
          <div style={{ minWidth: '180px' }}>
            <SearchableSelect
              value={action}
              onChange={(v) => { setOffset(0); setAction(v); }}
              options={[{ value: '', label: 'All actions' }, ...actions.map((a) => ({ value: a, label: a }))]}
              placeholder="All actions"
              aria-label="Filter by action"
            />
          </div>
        </div>
      </div>

      {error && <div className="mb-4"><ErrorState message={error} onRetry={load} /></div>}

      <div className="card">
        <div className="card-header"><span className="section-title">Entries {total > 0 && `(${total})`}</span></div>
        {loading ? (
          <div style={{ padding: '48px 0' }}><LoadingSpinner /></div>
        ) : entries.length === 0 ? (
          <div className="empty-state"><Inbox size={28} /><span className="text-sm">No audit entries match your filters.</span></div>
        ) : (
          <div className="table-wrap">
            <table className="table table--zebra">
              <thead>
                <tr><th>When</th><th>Actor</th><th>Action</th><th>Entity</th><th>Details</th></tr>
              </thead>
              <tbody>
                {entries.map((e) => {
                  const { label, badgeClass } = formatAction(e.action);
                  return (
                    <tr key={e.id}>
                      <td className="text-secondary" style={{ whiteSpace: 'nowrap' }}>{new Date(e.created_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</td>
                      <td>
                        <div className="font-medium">{e.actor_name || '—'}</div>
                        <div className="text-xs text-secondary mono">{e.actor_id}</div>
                      </td>
                      <td><span className={`badge ${badgeClass}`}>{label}</span></td>
                      <td className="text-sm">{e.entity_type}{e.entity_id ? ` #${e.entity_id}` : ''}</td>
                      <td className="text-sm text-secondary">{formatDetails(e.details)}</td>
                    </tr>
                  );
                })}
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
