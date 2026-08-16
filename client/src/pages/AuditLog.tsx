import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { DashboardLayout } from '../components/Layout/DashboardLayout';
import { ErrorState } from '../components/common/ErrorState';
import { apiGet, ApiError } from '../api/client';
import { SearchableSelect } from '../components/common/SearchableSelect';
import {
  Inbox, Search, X, ChevronRight, Plus, Pencil, Trash2, LogIn, Shield,
  RotateCcw, History,
} from 'lucide-react';

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

interface Cursor { before_at: string; before_id: number; }

const PAGE_SIZE = 30;

/**
 * Operation classes, following the convention GitHub's audit log uses:
 * every `noun.verb` action maps to one of a small set of operations, so
 * icons and emphasis key off ~5 classes rather than one colour per action —
 * which is what keeps a long log readable instead of a rainbow.
 */
type Operation = 'create' | 'modify' | 'remove' | 'access' | 'auth';

const VERB_OPERATION: Record<string, Operation> = {
  create: 'create', add: 'create', assign: 'create', import: 'create', log: 'create',
  update: 'modify', edit: 'modify', adjust: 'modify', review: 'modify', switch: 'modify',
  mark: 'modify', approve: 'modify', reject: 'modify',
  delete: 'remove', retire: 'remove', remove: 'remove', revoke: 'remove',
  view: 'access', export: 'access', sync: 'access',
  login: 'auth', logout: 'auth',
};

const OPERATION_META: Record<Operation, { icon: React.ReactNode; tone: string; label: string }> = {
  create: { icon: <Plus size={13} />, tone: 'is-create', label: 'Created' },
  modify: { icon: <Pencil size={13} />, tone: 'is-modify', label: 'Changed' },
  remove: { icon: <Trash2 size={13} />, tone: 'is-remove', label: 'Removed' },
  access: { icon: <LogIn size={13} />, tone: 'is-access', label: 'Accessed' },
  auth: { icon: <Shield size={13} />, tone: 'is-auth', label: 'Auth' },
};

const titleCase = (s: string) => s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

function operationOf(action: string): Operation {
  const verb = action.split('.').pop() || '';
  return VERB_OPERATION[verb] ?? 'modify';
}

/** "discipline_rule.create" on entity "discipline_rule#4" -> readable phrase. */
function describe(e: AuditEntry): { verb: string; target: string } {
  const parts = e.action.split('.');
  const verb = titleCase(parts[parts.length - 1] || e.action).toLowerCase();
  const noun = titleCase(parts.slice(0, -1).join(' ') || e.entity_type);
  const target = e.entity_id ? `${noun} #${e.entity_id}` : noun;
  return { verb, target };
}

/** Only the fields that actually changed, old -> new, when the audit payload
 *  carries previousValue/newValue. Falls back to a flat key list. */
function parseDetails(raw: string | null): {
  diff: Array<{ key: string; from: unknown; to: unknown }>;
  rest: Array<[string, unknown]>;
  json: string | null;
} {
  if (!raw) return { diff: [], rest: [], json: null };
  let obj: any;
  try { obj = JSON.parse(raw); } catch { return { diff: [], rest: [['detail', raw]], json: raw }; }
  if (!obj || typeof obj !== 'object') return { diff: [], rest: [], json: raw };

  const { previousValue, newValue, ...rest } = obj;
  const diff: Array<{ key: string; from: unknown; to: unknown }> = [];
  if (previousValue && newValue && typeof previousValue === 'object' && typeof newValue === 'object') {
    const keys = new Set([...Object.keys(previousValue), ...Object.keys(newValue)]);
    for (const k of keys) {
      if (JSON.stringify(previousValue[k]) !== JSON.stringify(newValue[k])) {
        diff.push({ key: k, from: previousValue[k], to: newValue[k] });
      }
    }
  } else if (obj.from && obj.to) {
    diff.push({ key: 'value', from: obj.from, to: obj.to });
    delete (rest as any).from; delete (rest as any).to;
  }
  return {
    diff,
    rest: Object.entries(rest).filter(([, v]) => v !== undefined),
    json: JSON.stringify(obj, null, 2),
  };
}

const show = (v: unknown) =>
  v === null || v === undefined ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v);

const DAY_MS = 86_400_000;

/** Relative while it's still recent, absolute once it isn't — an audit trail
 *  is read as evidence, so old entries need a real timestamp. The <time>
 *  element carries the exact value for hover and for screen readers. */
const Timestamp: React.FC<{ iso: string }> = ({ iso }) => {
  const d = new Date(iso);
  const age = Date.now() - d.getTime();
  const exact = d.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });

  let label: string;
  if (age < 60_000) label = 'just now';
  else if (age < 3_600_000) label = `${Math.floor(age / 60_000)}m ago`;
  else if (age < DAY_MS) label = `${Math.floor(age / 3_600_000)}h ago`;
  else label = d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

  return <time dateTime={d.toISOString()} title={exact}>{label}</time>;
};

const dayKey = (iso: string) => new Date(iso).toDateString();
const dayLabel = (iso: string) => {
  const d = new Date(iso);
  const today = new Date().toDateString();
  const yesterday = new Date(Date.now() - DAY_MS).toDateString();
  if (d.toDateString() === today) return 'Today';
  if (d.toDateString() === yesterday) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
};

const RANGES = [
  { value: '', label: 'Any time' },
  { value: '1', label: 'Last 24 hours' },
  { value: '7', label: 'Last 7 days' },
  { value: '30', label: 'Last 30 days' },
];

export const AuditLog: React.FC = () => {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [actions, setActions] = useState<string[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [action, setAction] = useState('');
  const [search, setSearch] = useState('');
  const [range, setRange] = useState('');
  const [cursor, setCursor] = useState<Cursor | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [expanded, setExpanded] = useState<number | null>(null);
  // Guards against a stale in-flight response overwriting a newer one when
  // filters change quickly.
  const requestId = useRef(0);

  const fetchPage = useCallback(async (next: Cursor | null) => {
    const mine = ++requestId.current;
    next ? setLoadingMore(true) : setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (action) qs.set('action', action);
      if (search) qs.set('search', search);
      if (next) { qs.set('before_at', next.before_at); qs.set('before_id', String(next.before_id)); }
      const res = await apiGet<AuditEntry[]>(`/api/admin/audit?${qs.toString()}`);
      if (mine !== requestId.current) return;
      const rows = res.data || [];
      setEntries((prev) => (next ? [...prev, ...rows] : rows));
      setTotal((res as any).total ?? rows.length);
      setHasMore(Boolean((res as any).hasMore));
      setCursor((res as any).nextCursor ?? null);
      const list = (res as any).actions;
      if (Array.isArray(list)) setActions(list);
    } catch (err) {
      if (mine !== requestId.current) return;
      setError(err instanceof ApiError ? err.message : 'Could not load the audit log.');
    } finally {
      if (mine === requestId.current) { setLoading(false); setLoadingMore(false); }
    }
  }, [action, search]);

  // Debounced only for typing; changing a dropdown should feel immediate.
  useEffect(() => {
    const t = setTimeout(() => fetchPage(null), search ? 300 : 0);
    return () => clearTimeout(t);
  }, [fetchPage]);

  // The date range filters client-side: the endpoint has no date parameter,
  // and adding one would page awkwardly against the keyset cursor.
  const visible = useMemo(() => {
    if (!range) return entries;
    const cutoff = Date.now() - Number(range) * DAY_MS;
    return entries.filter((e) => new Date(e.created_at).getTime() >= cutoff);
  }, [entries, range]);

  const filtering = !!(search || action || range);
  const clearFilters = () => { setSearch(''); setAction(''); setRange(''); };

  // Date separators, computed once per render pass over the visible rows.
  const firstOfDay = useMemo(() => {
    const seen = new Set<string>();
    const ids = new Set<number>();
    for (const e of visible) {
      const k = dayKey(e.created_at);
      if (!seen.has(k)) { seen.add(k); ids.add(e.id); }
    }
    return ids;
  }, [visible]);

  return (
    <DashboardLayout>
      <div className="page-header">
        <div>
          <h1 className="page-title">Audit Log</h1>
          <p className="page-subtitle">
            A record of sensitive actions: role changes, conduct decisions, and excuse reviews.
          </p>
        </div>
        {total > 0 && <span className="badge badge-neutral">{total} recorded</span>}
      </div>

      {/* Filters */}
      <div className="card card-body mb-4">
        <div className="flex flex-wrap items-center gap-2">
          <div className="rp-search" style={{ flex: 1, minWidth: 220 }}>
            <Search className="field-icon" size={15} />
            <input
              className="input"
              placeholder="Search actor or entity…"
              value={search}
              aria-label="Search the audit log"
              onChange={(e) => setSearch(e.target.value)}
            />
            {search && (
              <button className="rp-search-clear" onClick={() => setSearch('')} aria-label="Clear search">
                <X size={13} />
              </button>
            )}
          </div>
          <div style={{ minWidth: 190 }}>
            <SearchableSelect
              value={action}
              onChange={setAction}
              options={[{ value: '', label: 'All actions' }, ...actions.map((a) => ({ value: a, label: titleCase(a.replace('.', ' · ')), hint: a }))]}
              placeholder="All actions"
              aria-label="Filter by action"
            />
          </div>
          <div style={{ minWidth: 150 }}>
            <SearchableSelect
              value={range}
              onChange={setRange}
              options={RANGES}
              aria-label="Filter by date range"
            />
          </div>
          {filtering && (
            <button className="rp-chip is-on" onClick={clearFilters}>
              <X size={12} /> Clear filters
            </button>
          )}
        </div>
      </div>

      {error && <div className="mb-4"><ErrorState message={error} onRetry={() => fetchPage(null)} /></div>}

      <div className="card">
        {loading ? (
          <div className="p-4 flex flex-col gap-2">
            {[0, 1, 2, 3, 4, 5].map((i) => <div key={i} className="rp-skeleton" />)}
          </div>
        ) : visible.length === 0 ? (
          <div className="empty-state" style={{ padding: '56px 0' }}>
            <Inbox size={28} />
            {filtering ? (
              <>
                <span className="text-sm">No entries match these filters.</span>
                <button className="btn btn-outline btn-sm mt-3" onClick={clearFilters}>
                  <RotateCcw size={14} /> Clear filters
                </button>
              </>
            ) : (
              <>
                <span className="text-sm">Nothing has been recorded yet.</span>
                <span className="text-xs text-secondary mt-1">
                  Role changes, conduct decisions and excuse reviews will appear here.
                </span>
              </>
            )}
          </div>
        ) : (
          <ul className="audit-list">
            {visible.map((e) => {
              const op = operationOf(e.action);
              const meta = OPERATION_META[op];
              const { verb, target } = describe(e);
              const isOpen = expanded === e.id;
              const parsed = parseDetails(e.details);
              const hasDetail = parsed.diff.length > 0 || parsed.rest.length > 0;

              return (
                <React.Fragment key={e.id}>
                  {firstOfDay.has(e.id) && (
                    <li className="audit-day" aria-hidden="true">{dayLabel(e.created_at)}</li>
                  )}
                  <li className={`audit-row${isOpen ? ' is-open' : ''}`}>
                    <button
                      type="button"
                      className="audit-main"
                      aria-expanded={isOpen}
                      aria-controls={hasDetail ? `audit-detail-${e.id}` : undefined}
                      onClick={() => setExpanded(isOpen ? null : e.id)}
                    >
                      <span className={`audit-op ${meta.tone}`} title={meta.label}>{meta.icon}</span>
                      <span className="audit-body">
                        <span className="audit-sentence">
                          <strong>{e.actor_name || e.actor_id}</strong> {verb} <strong>{target}</strong>
                        </span>
                        <span className="audit-meta">
                          <Timestamp iso={e.created_at} />
                          <span className="audit-dot">·</span>
                          <code>{e.action}</code>
                        </span>
                      </span>
                      {hasDetail && (
                        <ChevronRight size={15} className={`audit-caret${isOpen ? ' is-open' : ''}`} />
                      )}
                    </button>

                    {isOpen && hasDetail && (
                      <div className="audit-detail" id={`audit-detail-${e.id}`}>
                        {parsed.diff.length > 0 && (
                          <table className="audit-diff">
                            <thead>
                              <tr><th>Field</th><th>Before</th><th>After</th></tr>
                            </thead>
                            <tbody>
                              {parsed.diff.map((d) => (
                                <tr key={d.key}>
                                  <th scope="row">{titleCase(d.key)}</th>
                                  <td><span className="audit-before">{show(d.from)}</span></td>
                                  <td><span className="audit-after">{show(d.to)}</span></td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}
                        {parsed.rest.length > 0 && (
                          <dl className="audit-attrs">
                            {parsed.rest.map(([k, v]) => (
                              <React.Fragment key={k}>
                                <dt>{titleCase(k)}</dt>
                                <dd>{show(v)}</dd>
                              </React.Fragment>
                            ))}
                          </dl>
                        )}
                        <details className="audit-raw">
                          <summary>Raw record</summary>
                          <pre>{parsed.json}</pre>
                        </details>
                      </div>
                    )}
                  </li>
                </React.Fragment>
              );
            })}
          </ul>
        )}

        {!loading && visible.length > 0 && (
          <div className="card-footer pager">
            <span className="text-xs text-secondary">
              Showing {visible.length} of {total}
              {range && ' in the selected period'}
            </span>
            {hasMore ? (
              <button
                className="btn btn-outline btn-sm"
                onClick={() => cursor && fetchPage(cursor)}
                disabled={loadingMore || !cursor}
              >
                <History size={14} /> {loadingMore ? 'Loading…' : 'Load older entries'}
              </button>
            ) : (
              <span className="text-xs text-tertiary">End of the log</span>
            )}
          </div>
        )}
      </div>
    </DashboardLayout>
  );
};
