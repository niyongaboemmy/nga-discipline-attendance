import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Ban, ChevronRight, CreditCard, LayoutGrid, List, Radio, RefreshCw, Router, Search, UserCheck, UserPlus, X,
} from 'lucide-react';
import { DashboardLayout } from '../components/Layout/DashboardLayout';
import { ErrorState } from '../components/common/ErrorState';
import { apiGet, apiPost } from '../api/client';
import { useToast } from '../context/ToastContext';
import { usePermissions } from '../hooks/usePermissions';
import { useRfidStream } from '../hooks/useRfidStream';
import { relativeTime } from '../utils/time';
import type { CardCounts, RfidCard, RosterStatus } from '../api/rfid';
import {
  defer, errMsg, olderThan, readCardsView, showUid, writeCardsView, type AssignTarget, type CardsView,
} from '../utils/rfidCards';
import { CardFace, CardStatusBadge, StudentAvatar } from '../components/rfid/CardBits';
import { AssignCardModal } from '../components/rfid/CardModals';
import { ScannerFeed } from '../components/rfid/ScannerFeed';
import { ScanLogTab } from '../components/rfid/ScanLogTab';
import { ScannersTab } from '../components/rfid/ScannersTab';

type Tab = 'cards' | 'scans' | 'scanners';
const TABS: Tab[] = ['cards', 'scans', 'scanners'];
type Filter = 'all' | 'unassigned' | 'active' | 'blocked';
const PAGE_SIZE = 48;

export const RfidCards: React.FC = () => {
  const { can } = usePermissions();
  const canManage = can('RFID_CARDS_MANAGE');
  const canScans = can('RFID_SCANS_VIEW');
  const initialTab = new URLSearchParams(window.location.search).get('tab') as Tab;
  const [tab, setTab] = useState<Tab>(TABS.includes(initialTab) ? initialTab : 'cards');
  const [assignTarget, setAssignTarget] = useState<AssignTarget | null>(null);
  // Bumped after any change so everything on the page refetches.
  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => setVersion((v) => v + 1), []);

  const selectTab = (t: Tab) => {
    setTab(t);
    const url = new URL(window.location.href);
    url.searchParams.set('tab', t);
    window.history.replaceState(null, '', url);
  };

  return (
    <DashboardLayout>
      <div className="page-header">
        <div>
          <h1 className="page-title">Attendance Cards</h1>
          <p className="page-subtitle">Every card the scanner reads shows up here. Tap a new card, then assign it to a student.</p>
        </div>
        <RosterStatusLine canManage={canManage} version={version} onSynced={refresh} />
      </div>

      <ScannerFeed canManage={canManage} onAssign={setAssignTarget} />

      <div className="segmented mb-4" role="tablist" aria-label="Attendance card sections">
        {([
          ['cards', 'Cards', <CreditCard size={14} key="i" />],
          ...(canScans ? [['scans', 'Scan log', <Radio size={14} key="i" />]] : []),
          ['scanners', 'Scanners', <Router size={14} key="i" />],
        ] as [Tab, string, React.ReactNode][]).map(([key, label, icon]) => (
          <button key={key} role="tab" aria-selected={tab === key}
            className={`segmented-btn${tab === key ? ' is-active' : ''}`} onClick={() => selectTab(key)}>
            {icon} {label}
          </button>
        ))}
      </div>

      {tab === 'cards' && <CardsPanel canManage={canManage} version={version} onAssign={setAssignTarget} />}
      {tab === 'scans' && canScans && <ScanLogTab version={version} />}
      {tab === 'scanners' && <ScannersTab canManage={canManage} version={version} onChanged={refresh} />}

      {assignTarget && (
        <AssignCardModal card={assignTarget} onClose={() => setAssignTarget(null)} onDone={() => { setAssignTarget(null); refresh(); }} />
      )}
    </DashboardLayout>
  );
};

// ───────────────────────────── Roster status ─────────────────────────────

/** Where the student list comes from, and a way to refresh it. */
const RosterStatusLine: React.FC<{ canManage: boolean; version: number; onSynced: () => void }> = ({ canManage, version, onSynced }) => {
  const toast = useToast();
  const [status, setStatus] = useState<RosterStatus | null>(null);
  const [syncing, setSyncing] = useState(false);

  useEffect(() => defer(() => {
    apiGet<RosterStatus>('/api/rfid/roster/status').then((r) => setStatus(r.data ?? null)).catch(() => setStatus(null));
  }), [version]);

  const sync = async () => {
    setSyncing(true);
    try {
      const r = await apiPost('/api/rfid/roster/sync');
      toast.success('Students synced', r.message);
      onSynced();
    } catch (err) {
      toast.error('Sync failed', errMsg(err, 'Could not reach the MIS.'));
    } finally {
      setSyncing(false);
    }
  };

  if (!status) return null;
  const lastOk = status.lastSuccessful?.finished_at;
  const problem = !status.credentialsConfigured
    ? 'Tendo can’t read students from the MIS yet (no service credentials on the server).'
    : status.students === 0 ? 'No students yet. Sync them from the MIS.'
    : !!status.last?.error && status.last.id !== status.lastSuccessful?.id ? `Last sync failed: ${status.last.error}` : null;

  return (
    <div className={`rfid-roster${problem ? ' is-problem' : ''}`} title={problem ?? undefined}>
      <div className="text-sm">
        <strong>{status.students}</strong> student{status.students === 1 ? '' : 's'} from the MIS
        <div className="text-xs text-secondary">
          {problem ?? (lastOk ? `Synced ${relativeTime(lastOk)}${olderThan(lastOk, 24 * 3600_000) ? ' · out of date' : ''}` : 'Never synced')}
        </div>
      </div>
      {canManage && status.credentialsConfigured && (
        <button className="btn btn-outline btn-sm" onClick={sync} disabled={syncing}>
          <RefreshCw size={14} className={syncing ? 'spin' : ''} /> {syncing ? 'Syncing…' : 'Sync now'}
        </button>
      )}
    </div>
  );
};

// ───────────────────────────── Cards ─────────────────────────────

const CardsPanel: React.FC<{
  canManage: boolean; version: number; onAssign: (c: AssignTarget) => void;
}> = ({ canManage, version, onAssign }) => {
  const navigate = useNavigate();
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [view, setView] = useState<CardsView>(readCardsView);
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState<RfidCard[]>([]);
  const [total, setTotal] = useState(0);
  const [counts, setCounts] = useState<CardCounts | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const reqId = useRef(0);

  const load = useCallback(async () => {
    const mine = ++reqId.current;
    setError(null);
    try {
      const qs = new URLSearchParams({ scanned: '1', status: filter, limit: String(PAGE_SIZE), offset: String(page * PAGE_SIZE) });
      if (search.trim()) qs.set('search', search.trim());
      const r = await apiGet<RfidCard[]>(`/api/rfid/cards?${qs}`);
      if (mine !== reqId.current) return;
      setRows(r.data ?? []);
      setTotal(r.total ?? 0);
      setCounts((r as { counts?: CardCounts }).counts ?? null);
    } catch (err) {
      if (mine === reqId.current) setError(errMsg(err, 'Could not load cards.'));
    } finally {
      if (mine === reqId.current) setLoading(false);
    }
  }, [filter, search, page]);

  useEffect(() => defer(load, search ? 300 : 0), [load, version, search]);

  // A tap on the scanner updates the list in place and briefly highlights the card.
  useRfidStream((e) => {
    if (e.type !== 'scan') return;
    void load();
    if (e.uid) {
      const uid = e.uid;
      setFresh((s) => new Set(s).add(uid));
      setTimeout(() => setFresh((s) => { const n = new Set(s); n.delete(uid); return n; }), 4000);
    }
  }, { onReconnect: load });

  const choose = (f: Filter) => { setFilter(f); setPage(0); };
  const switchView = (v: CardsView) => { setView(v); writeCardsView(v); };
  const open = (c: RfidCard) => navigate(`/attendance/cards/${c.id}`);
  const assign = (c: RfidCard) => onAssign({ id: c.id, uid: c.uid, label: c.label });

  const tiles: { key: Filter; label: string; value: number | undefined; icon: React.ReactNode; accent: string; hint?: string }[] = [
    { key: 'all', label: 'Cards scanned', value: counts?.total, icon: <CreditCard size={16} />, accent: 'var(--primary)' },
    { key: 'unassigned', label: 'Waiting to assign', value: counts?.unassigned, icon: <UserPlus size={16} />, accent: 'var(--warning)', hint: 'Needs action' },
    { key: 'active', label: 'Assigned', value: counts?.active, icon: <UserCheck size={16} />, accent: 'var(--success)' },
    { key: 'blocked', label: 'Disabled or lost', value: counts?.blocked, icon: <Ban size={16} />, accent: 'var(--danger)' },
  ];

  return (
    <>
      <div className="rfid-tiles mb-4">
        {tiles.map((t) => (
          <button key={t.key} className={`stat-card admin-stat${filter === t.key ? ' is-selected' : ''}`}
            style={{ ['--accent-color' as string]: t.accent }} onClick={() => choose(t.key)} aria-pressed={filter === t.key}>
            <div className="flex items-center justify-between">
              <span className="stat-icon">{t.icon}</span>
              {t.hint && (t.value ?? 0) > 0 && <span className="badge badge-warning">{t.hint}</span>}
            </div>
            <div className="stat-value">{t.value ?? '–'}</div>
            <span className="stat-label">{t.label}</span>
          </button>
        ))}
      </div>

      <div className="rfid-toolbar mb-4">
        <div className="rp-search rfid-toolbar-search">
          <Search className="field-icon" size={15} />
          <input className="input" placeholder="Search by card number or student…" value={search}
            aria-label="Search cards" onChange={(e) => { setSearch(e.target.value); setPage(0); }} />
          {search && <button className="rp-search-clear" onClick={() => { setSearch(''); setPage(0); }} aria-label="Clear search"><X size={13} /></button>}
        </div>
        <div className="segmented" role="group" aria-label="Layout">
          <button className={`segmented-btn${view === 'grid' ? ' is-active' : ''}`} aria-pressed={view === 'grid'} onClick={() => switchView('grid')}>
            <LayoutGrid size={14} /> Grid
          </button>
          <button className={`segmented-btn${view === 'list' ? ' is-active' : ''}`} aria-pressed={view === 'list'} onClick={() => switchView('list')}>
            <List size={14} /> List
          </button>
        </div>
      </div>

      {error && <div className="mb-4"><ErrorState message={error} onRetry={load} /></div>}

      {loading && rows.length === 0 ? (
        <div className={view === 'grid' ? 'rfid-grid' : 'card p-4 flex flex-col gap-2'}>
          {[0, 1, 2, 3].map((i) => <div key={i} className={view === 'grid' ? 'rfid-tile rfid-tile--skeleton' : 'rp-skeleton'} />)}
        </div>
      ) : rows.length === 0 ? (
        <div className="card">
          <div className="empty-state" style={{ padding: '56px 16px' }}>
            <CreditCard size={30} />
            {search || filter !== 'all' ? (
              <>
                <span className="text-sm">No cards match.</span>
                <button className="btn btn-outline btn-sm mt-3" onClick={() => { setSearch(''); choose('all'); }}>Show all cards</button>
              </>
            ) : (
              <>
                <span className="text-sm font-medium">No cards scanned yet</span>
                <span className="text-xs text-secondary mt-1">Tap a card on the scanner. It shows up here within a couple of seconds, ready to assign.</span>
              </>
            )}
          </div>
        </div>
      ) : view === 'grid' ? (
        <div className="rfid-grid">
          {rows.map((c) => (
            <article key={c.id} className={`rfid-tile${fresh.has(c.uid) ? ' is-fresh' : ''}`}>
              <Link to={`/attendance/cards/${c.id}`} className="rfid-tile-face" aria-label={`Open card ${showUid(c.uid)}`}>
                <CardFace uid={c.uid} label={c.label} status={c.status} fresh={fresh.has(c.uid)}
                  holder={c.holder ? { name: c.holder.studentName, className: c.holder.className } : null} />
              </Link>
              <div className="rfid-tile-body">
                <div className="rfid-tile-meta">
                  <span>{c.lastSeenAt ? `Scanned ${relativeTime(c.lastSeenAt)}` : 'Never scanned'}</span>
                  <span>{c.taps} tap{c.taps === 1 ? '' : 's'}</span>
                </div>
                <div className="rfid-tile-actions">
                  {c.status === 'unassigned' && canManage ? (
                    <button className="btn btn-primary btn-sm" onClick={() => assign(c)}><UserPlus size={13} /> Assign</button>
                  ) : <CardStatusBadge status={c.status} />}
                  <Link to={`/attendance/cards/${c.id}`} className="btn btn-ghost btn-sm">Details <ChevronRight size={13} /></Link>
                </div>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <div className="card">
          <div className="table-wrap">
            <table className="table table--hover rfid-table">
              <thead>
                <tr><th>Card</th><th>Status</th><th>Held by</th><th>Last scanned</th><th aria-label="Actions" /></tr>
              </thead>
              <tbody>
                {rows.map((c) => (
                  <tr key={c.id} className={`row-hover${fresh.has(c.uid) ? ' rfid-fresh' : ''}`} onClick={() => open(c)}>
                    <td>
                      <Link to={`/attendance/cards/${c.id}`} className="rfid-card-link" onClick={(e) => e.stopPropagation()}>
                        <code className="mono font-semibold">{showUid(c.uid)}</code>
                        {c.label && <span className="text-xs text-secondary">No. {c.label}</span>}
                      </Link>
                    </td>
                    <td><CardStatusBadge status={c.status} /></td>
                    <td>
                      {c.holder ? (
                        <div className="rfid-holder">
                          <StudentAvatar name={c.holder.studentName} size="sm" />
                          <div>
                            <div className="font-medium">{c.holder.studentName}</div>
                            <div className="text-xs text-secondary">{c.holder.className ?? 'No class'}</div>
                          </div>
                        </div>
                      ) : <span className="text-tertiary">Nobody yet</span>}
                    </td>
                    <td className="text-sm">
                      {c.lastSeenAt ? relativeTime(c.lastSeenAt) : '—'}
                      <div className="text-xs text-tertiary">{c.taps} tap{c.taps === 1 ? '' : 's'}</div>
                    </td>
                    <td className="text-right" onClick={(e) => e.stopPropagation()}>
                      {c.status === 'unassigned' && canManage ? (
                        <button className="btn btn-primary btn-sm" onClick={() => assign(c)}><UserPlus size={13} /> Assign</button>
                      ) : (
                        <Link to={`/attendance/cards/${c.id}`} className="btn btn-ghost btn-sm" aria-label={`Open card ${showUid(c.uid)}`}><ChevronRight size={15} /></Link>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {total > PAGE_SIZE && (
        <div className="pager mt-4">
          <span className="text-xs text-secondary">Showing {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} of {total}</span>
          <div className="flex gap-2">
            <button className="btn btn-outline btn-sm" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</button>
            <button className="btn btn-outline btn-sm" disabled={(page + 1) * PAGE_SIZE >= total} onClick={() => setPage(page + 1)}>Next</button>
          </div>
        </div>
      )}
    </>
  );
};

export default RfidCards;
