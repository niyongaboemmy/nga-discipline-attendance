import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AlertTriangle, ChevronLeft, ChevronRight, Search, ChevronRight as Go } from 'lucide-react';
import { DashboardLayout } from '../../components/Layout/DashboardLayout';
import { ErrorState } from '../../components/common/ErrorState';
import { SkeletonTable } from '../../components/common/Skeleton';
import { useToast } from '../../context/ToastContext';
import { usePermissions } from '../../hooks/usePermissions';
import { ApiError } from '../../api/client';
import { staffClockApi, initialsOf, type Overview, type OverviewRow } from '../../api/staffClock';
import { StaffClockHeader } from './StaffClockHeader';
import { StaffHistoryModal } from './StaffHistoryModal';

/** Staff tab: everyone for the chosen day, filters, review queue; a row opens the person's history. */

type Tab = 'all' | 'late' | 'notIn' | 'review';

const STATUS: Record<OverviewRow['status'], [string, string]> = {
  present: ['On time', 'sc-tone-green'],
  late: ['Late', 'sc-tone-amber'],
  not_in: ['Not in yet', 'sc-tone-muted'],
  invalid: ['Marked invalid', 'sc-tone-red'],
};
const addDays = (date: string, n: number) => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

export const StaffClockPeople: React.FC = () => {
  const toast = useToast();
  const { can } = usePermissions();
  const [params, setParams] = useSearchParams();
  const [date, setDate] = useState<string | null>(null);
  const [data, setData] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [person, setPerson] = useState<{ id: string; name: string; role: string | null } | null>(null);
  const tab = (['all', 'late', 'notIn', 'review'].includes(params.get('tab') ?? '') ? params.get('tab') : 'all') as Tab;
  const setTab = (t: Tab) => setParams((p) => { const n = new URLSearchParams(p); if (t === 'all') n.delete('tab'); else n.set('tab', t); return n; }, { replace: true });

  const load = useCallback(async (d: string | null) => {
    setLoading(true);
    setError(null);
    try {
      setData(await staffClockApi.overview(d ?? undefined));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not load staff.');
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void Promise.resolve().then(() => load(date)); }, [date, load]);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (data?.rows ?? []).filter((r) => {
      if (q && !r.name.toLowerCase().includes(q)) return false;
      if (tab === 'late') return r.status === 'late';
      if (tab === 'notIn') return r.status === 'not_in';
      return true;
    });
  }, [data, tab, search]);
  const counts: Record<Tab, number> = {
    all: data?.rows.length ?? 0,
    late: data?.rows.filter((r) => r.status === 'late').length ?? 0,
    notIn: data?.rows.filter((r) => r.status === 'not_in').length ?? 0,
    review: data?.review.length ?? 0,
  };

  const act = async (key: string, fn: () => Promise<unknown>, ok: string) => {
    setBusyId(key);
    try {
      await fn();
      toast.success(ok);
      await load(date);
    } catch (e) {
      toast.error('Not saved', e instanceof ApiError ? e.message : 'Try again.');
    } finally {
      setBusyId(null);
    }
  };
  const open = (r: OverviewRow) => setPerson({ id: r.userId, name: r.name, role: r.role });
  const dayText = data ? new Date(`${data.date}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }) : '';

  return (
    <DashboardLayout>
      <div className="sc-page">
        <StaffClockHeader
          title="Staff"
          lead={data ? `${dayText} · tap someone to see their history` : 'Everyone and their day'}
          pending={data?.phones.pending.length}
          actions={
            <div className="sc-seg" role="group" aria-label="Day">
              <button aria-label="Previous day" onClick={() => setDate(addDays(data?.date ?? new Date().toISOString().slice(0, 10), -1))}><ChevronLeft size={18} /></button>
              <button aria-pressed={!!data?.isToday} onClick={() => setDate(null)}>{!data || data.isToday ? 'Today' : new Date(`${data.date}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })}</button>
              <button aria-label="Next day" disabled={!data || data.isToday} onClick={() => data && setDate(addDays(data.date, 1))}><ChevronRight size={18} /></button>
            </div>
          }
        />
        {error && <ErrorState message={error} onRetry={() => void load(date)} />}

        <section className="sc-card" id="sc-staff-list">
          <div className="sc-filters">
            <div role="tablist" aria-label="Filter staff" style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {([['all', 'Everyone'], ['late', 'Late'], ['notIn', data && !data.isToday ? 'Absent' : 'Not in yet'], ['review', 'Needs review']] as Array<[Tab, string]>).map(([key, label]) => (
                <button key={key} role="tab" aria-selected={tab === key} className="sc-chip" onClick={() => setTab(key)}>
                  {label}<span className="sc-chip-count">{counts[key]}</span>
                </button>
              ))}
            </div>
            <div style={{ flex: 1 }} />
            {tab !== 'review' && (
              <label className="sc-search">
                <Search size={16} />
                <span className="sr-only">Search staff</span>
                <input placeholder="Search staff" value={search} onChange={(e) => setSearch(e.target.value)} />
              </label>
            )}
          </div>

          {loading && !data ? (
            <SkeletonTable rows={8} cols={6} label="Loading staff" />
          ) : !data ? null : tab === 'review' ? (
            data.review.length === 0 ? (
              <div className="sc-empty">Nothing to review. Every check-in looks normal.</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 14 }}>
                {data.review.map((r) => (
                  <div key={r.recordId} className="sc-review">
                    <span className="sc-avatar" style={{ width: 40, height: 40 }}>{initialsOf(r.name)}</span>
                    <div className="sc-review-text">
                      <b>{r.name} · checked in {r.at}</b>
                      {r.flagText.map((f) => <div key={f} className="sc-flag"><AlertTriangle size={14} />{f}</div>)}
                      <div className="sc-muted" style={{ fontSize: 13, marginTop: 3 }}>
                        {r.distance != null ? `${Math.round(r.distance)} m from the zone centre` : ''}{r.accuracy != null ? ` · precision ± ${Math.round(r.accuracy)} m` : ''}
                      </div>
                    </div>
                    {can('STAFF_DEVICES_MANAGE') && (
                      <div style={{ display: 'flex', gap: 8 }}>
                        <button className="sc-btn sc-btn-primary sc-btn-sm" disabled={busyId === `r${r.recordId}`} onClick={() => void act(`r${r.recordId}`, () => staffClockApi.review(r.recordId, 'accepted'), `Accepted: ${r.name}`)}>Accept</button>
                        <button className="sc-btn sc-btn-sm" disabled={busyId === `r${r.recordId}`} onClick={() => {
                          const note = window.prompt(`Why is ${r.name}'s check-in invalid?`);
                          if (note && note.trim()) void act(`r${r.recordId}`, () => staffClockApi.review(r.recordId, 'invalid', note.trim()), 'Marked invalid (reason saved to the audit log)');
                        }}>Mark invalid</button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )
          ) : rows.length === 0 ? (
            <div className="sc-empty">{search ? 'No staff match this search.' : tab === 'late' ? 'Nobody is late.' : tab === 'notIn' ? 'Everyone is in.' : 'No staff yet.'}</div>
          ) : (
            <>
              <div className="sc-table-wrap sc-responsive">
                <table className="sc-table">
                  <thead><tr><th>Staff</th><th>In</th><th>Status</th><th>Out</th><th>Distance</th><th>How</th><th aria-label="History" /></tr></thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.userId} className="sc-row-btn" tabIndex={0} onClick={() => open(r)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(r); } }} data-person={r.userId}>
                        <td><span className="sc-who"><span className="sc-avatar">{initialsOf(r.name)}</span><span><b className="sc-clip" title={r.name}>{r.name}</b><small className="sc-clip">{r.role}</small></span></span></td>
                        <td className="sc-num" style={{ fontWeight: 600 }}>{r.checkIn ?? '—'}</td>
                        <td><span className={`sc-pill ${STATUS[r.status][1]}`}><i />{STATUS[r.status][0]}</span>{r.needsReview && <span className="sc-pill sc-tone-amber" style={{ marginLeft: 6 }}>Review</span>}</td>
                        <td className="sc-num sc-muted">{r.checkOut ?? (r.outStatus === 'auto_closed' ? 'Not checked out' : '—')}{r.outStatus === 'early' ? ' · early' : ''}</td>
                        <td className="sc-num">{r.distance != null ? `${Math.round(r.distance)} m` : '—'}</td>
                        <td className="sc-muted">{r.source === 'card' ? 'Staff card' : r.device ?? (r.source ? 'Phone' : 'Not registered')}</td>
                        <td className="sc-muted" style={{ width: 36 }}><Go size={16} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="sc-list">
                {rows.map((r) => (
                  <button key={r.userId} className="sc-item" onClick={() => open(r)}>
                    <span className="sc-avatar" style={{ width: 38, height: 38 }}>{initialsOf(r.name)}</span>
                    <span className="sc-item-main">
                      <b className="sc-clip" title={r.name}>{r.name}</b>
                      <small className="sc-clip sc-muted">{r.role}{r.distance != null ? ` · ${Math.round(r.distance)} m` : ''}</small>
                    </span>
                    <span className="sc-item-side">
                      <b className="sc-num">{r.checkIn ?? '—'}</b>
                      <span className={`sc-pill ${STATUS[r.status][1]}`} style={{ height: 24, fontSize: 12 }}><i />{STATUS[r.status][0]}</span>
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}
        </section>
      </div>
      {person && <StaffHistoryModal personId={person.id} name={person.name} role={person.role} onClose={() => setPerson(null)} />}
    </DashboardLayout>
  );
};
