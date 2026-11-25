import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, Clock, AlertTriangle, ChevronLeft, ChevronRight, Search, Download } from 'lucide-react';
import { DashboardLayout } from '../../components/Layout/DashboardLayout';
import { ErrorState } from '../../components/common/ErrorState';
import { useToast } from '../../context/ToastContext';
import { usePermissions } from '../../hooks/usePermissions';
import { ApiError } from '../../api/client';
import { staffClockApi, initialsOf, type Overview, type OverviewRow } from '../../api/staffClock';
import { StaffClockHeader, Spinner } from './StaffClockHeader';

/** Staff attendance dashboard (prototype "Admin: staff attendance dashboard"). */

type Tab = 'all' | 'late' | 'notIn' | 'review' | 'phones';

const addDays = (date: string, n: number) => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const dayLabel = (o: Overview | null, date: string | null) => {
  if (!date) return 'Today';
  if (o?.isToday) return 'Today';
  return new Date(`${date}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
};

const STATUS: Record<OverviewRow['status'], [string, string]> = {
  present: ['On time', 'sc-tone-green'],
  late: ['Late', 'sc-tone-amber'],
  not_in: ['Not in yet', 'sc-tone-muted'],
  invalid: ['Marked invalid', 'sc-tone-red'],
};

export const StaffClockDashboard: React.FC = () => {
  const toast = useToast();
  const { can } = usePermissions();
  const [date, setDate] = useState<string | null>(null);
  const [data, setData] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('all');
  const [search, setSearch] = useState('');
  const [hover, setHover] = useState(-1);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async (d: string | null = date) => {
    setLoading(true);
    setError(null);
    try {
      setData(await staffClockApi.overview(d ?? undefined));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not load staff attendance.');
    } finally {
      setLoading(false);
    }
  }, [date]);

  useEffect(() => {
    void Promise.resolve().then(() => load(date));
  }, [date, load]);

  // Live: refresh every minute while looking at today.
  useEffect(() => {
    if (!data?.isToday) return;
    const id = window.setInterval(() => void staffClockApi.overview().then(setData).catch(() => undefined), 60_000);
    return () => window.clearInterval(id);
  }, [data?.isToday]);

  const rows = useMemo(() => {
    if (!data) return [];
    const q = search.trim().toLowerCase();
    return data.rows.filter((r) => {
      if (q && !r.name.toLowerCase().includes(q)) return false;
      if (tab === 'late') return r.status === 'late';
      if (tab === 'notIn') return r.status === 'not_in';
      return true;
    });
  }, [data, tab, search]);

  const act = async (key: string, fn: () => Promise<unknown>, ok: string) => {
    setBusyId(key);
    try {
      await fn();
      toast.success(ok);
      await load();
    } catch (e) {
      toast.error('Not saved', e instanceof ApiError ? e.message : 'Try again.');
    } finally {
      setBusyId(null);
    }
  };

  const exportCsv = async () => {
    const d = data?.date;
    if (!d) return;
    try {
      const res = await fetch(`/api/staff/clock/export?from=${d}&to=${d}`, { headers: { Authorization: `Bearer ${localStorage.getItem('sso_token') ?? ''}` } });
      if (!res.ok) throw new Error();
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `staff-attendance-${d}.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
      toast.success('Export downloaded');
    } catch {
      toast.error('Export failed', 'Try again.');
    }
  };

  const k = data?.kpis;
  const counts: Record<Tab, number> = {
    all: data?.rows.length ?? 0,
    late: data?.rows.filter((r) => r.status === 'late').length ?? 0,
    notIn: data?.rows.filter((r) => r.status === 'not_in').length ?? 0,
    review: data?.review.length ?? 0,
    phones: data?.phones.pending.length ?? 0,
  };
  const maxBar = Math.max(4, ...(data?.arrivals ?? []).map((b) => b.onTime + b.late));
  const cutIdx = data ? data.arrivals.findIndex((b) => b.from >= data.rules.lateAfter) : -1;
  const nowLabel = data ? new Date(data.serverNow).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '';

  return (
    <DashboardLayout>
      <div className="sc-page">
        <StaffClockHeader
          title="Staff attendance"
          lead={data ? `${new Date(`${data.date}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' })}${data.isToday ? ` · updated ${nowLabel}` : ''}` : 'Loading…'}
          pending={counts.phones}
          actions={
            <>
              <div className="sc-seg" role="group" aria-label="Day">
                <button aria-label="Previous day" onClick={() => setDate(addDays(data?.date ?? new Date().toISOString().slice(0, 10), -1))}><ChevronLeft size={18} /></button>
                <button aria-pressed={!!data?.isToday} onClick={() => setDate(null)}>{dayLabel(data, date)}</button>
                <button aria-label="Next day" disabled={!!data?.isToday} onClick={() => data && setDate(addDays(data.date, 1))}><ChevronRight size={18} /></button>
              </div>
              <button className="sc-btn" onClick={() => void exportCsv()} disabled={!data}><Download size={16} /> Export</button>
            </>
          }
        />

        {error && <ErrorState message={error} onRetry={() => void load()} />}
        {data && !data.rules.enabled && (
          <div className="sc-notice">
            <b>The staff clock is off.</b>
            <p>Set the school zone and switch the clock on in <Link to="/staff/clock/zone">School zone</Link>. Staff then check in from the link on their own phone or tablet.</p>
          </div>
        )}

        {loading && !data ? (
          <div className="sc-kpis">{[0, 1, 2, 3, 4].map((i) => <div key={i} className="sc-skel" style={{ height: 118, borderRadius: 20 }} />)}</div>
        ) : k && (
          <div className="sc-kpis">
            <div className="sc-kpi">
              <div className="sc-kpi-label">Checked in</div>
              <div className="sc-kpi-value"><b>{k.checkedIn}</b><span>of {k.staff} staff</span></div>
              <div className="sc-bar"><div style={{ width: `${k.staff ? Math.round((k.checkedIn / k.staff) * 100) : 0}%` }} /></div>
            </div>
            <div className="sc-kpi">
              <div className="sc-kpi-label" style={{ color: 'var(--status-present)' }}><Check size={15} /> On time</div>
              <div className="sc-kpi-value"><b>{k.onTime}</b><span>{k.checkedIn ? `${Math.round((k.onTime / k.checkedIn) * 100)}% of check-ins` : 'no check-ins yet'}</span></div>
              <div className="sc-kpi-foot">By {data!.rules.lateAfter}</div>
            </div>
            <div className="sc-kpi">
              <div className="sc-kpi-label" style={{ color: 'var(--status-late)' }}><Clock size={15} /> Late</div>
              <div className="sc-kpi-value"><b>{k.late}</b><span>{k.medianLateMinutes != null ? `median ${k.medianLateMinutes} min late` : 'nobody late'}</span></div>
              <div className="sc-kpi-foot">After {data!.rules.lateAfter}</div>
            </div>
            <div className="sc-kpi">
              <div className="sc-kpi-label">Not in yet</div>
              <div className="sc-kpi-value"><b>{k.notIn}</b><span>{k.checkedOut} checked out</span></div>
              <button className="sc-btn sc-btn-soft sc-btn-sm" style={{ marginTop: 8 }} onClick={() => setTab('notIn')}>See who</button>
            </div>
            <div className="sc-kpi">
              <div className="sc-kpi-label" style={{ color: 'var(--status-late)' }}><AlertTriangle size={15} /> Needs review</div>
              <div className="sc-kpi-value"><b>{k.needsReview}</b><span>unusual check-ins</span></div>
              <button className="sc-btn sc-btn-sm" style={{ marginTop: 8 }} onClick={() => setTab('review')} disabled={!k.needsReview}>Review</button>
            </div>
          </div>
        )}

        {data && (
          <div className="sc-row">
            <section className="sc-card sc-grow">
              <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
                <div><h2>Arrivals</h2><p className="sc-card-sub">Check-ins per 15 minutes</p></div>
                <div className="sc-legend">
                  <span><i style={{ background: 'var(--primary)' }} />On time</span>
                  <span><i style={{ background: '#93c5fd' }} />Late</span>
                </div>
              </div>
              <div className="sc-chart" onMouseLeave={() => setHover(-1)}>
                <div className="sc-chart-y"><span>{maxBar}</span><span>{Math.round(maxBar / 2)}</span><span>0</span></div>
                <div className="sc-chart-grid" style={{ top: 0 }} />
                <div className="sc-chart-grid" style={{ top: 92 }} />
                <div className="sc-chart-grid" style={{ top: 184, background: 'var(--border-strong)' }} />
                {cutIdx > 0 && (
                  <div className="sc-chart-cut" style={{ left: `calc(28px + (100% - 28px) * ${cutIdx / data.arrivals.length})` }}>
                    <span>Late after {data.rules.lateAfter}</span>
                  </div>
                )}
                <div className="sc-chart-bars" style={{ gridTemplateColumns: `repeat(${data.arrivals.length}, minmax(0, 1fr))` }}>
                  {data.arrivals.map((b, i) => {
                    const total = b.onTime + b.late;
                    const h = Math.round((total / maxBar) * 184);
                    return (
                      <div key={b.from} className="sc-chart-col" onMouseEnter={() => setHover(i)} title={`${b.from}–${b.to} · ${total} staff`}>
                        {hover === i && <span className="sc-chart-tip" style={{ bottom: h + 8 }}>{b.from}–{b.to} · {total} staff{b.late ? ` (${b.late} late)` : ''}</span>}
                        <div style={{ height: h, background: b.late && !b.onTime ? '#93c5fd' : 'var(--primary)' }} />
                      </div>
                    );
                  })}
                </div>
                <div className="sc-chart-x" style={{ gridTemplateColumns: `repeat(${data.arrivals.length}, minmax(0, 1fr))` }}>
                  {data.arrivals.map((b, i) => <span key={b.from}>{i % 2 === 0 ? b.from : ''}</span>)}
                </div>
              </div>
            </section>

            <section className="sc-card sc-side" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <h2>Phones</h2>
              <div className="sc-kpi-value" style={{ marginTop: 0 }}><b style={{ fontSize: 30 }}>{data.phones.registered}</b><span>of {data.phones.staff} staff registered</span></div>
              <div style={{ display: 'flex', height: 8, gap: 2, borderRadius: 999, overflow: 'hidden' }}>
                <div style={{ flex: data.phones.registered || 0.0001, background: 'var(--primary)' }} />
                <div style={{ flex: Math.max(0, data.phones.staff - data.phones.registered) || 0.0001, background: 'var(--primary-light)' }} />
              </div>
              {data.phones.pending.map((d) => (
                <div key={d.id} className="sc-notice">
                  <b>New {d.form_factor} waiting</b>
                  <p className="sc-clip" title={d.user_name}>{d.user_name} · {d.label}</p>
                  {can('STAFF_DEVICES_MANAGE') && (
                    <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
                      <button className="sc-btn sc-btn-primary sc-btn-sm" disabled={busyId === `d${d.id}`} onClick={() => void act(`d${d.id}`, () => staffClockApi.deviceAction(d.id, 'approve'), `${d.user_name} can check in now`)}>Approve</button>
                      <button className="sc-btn sc-btn-sm" disabled={busyId === `d${d.id}`} onClick={() => void act(`d${d.id}`, () => staffClockApi.deviceAction(d.id, 'decline'), 'Device declined')}>Decline</button>
                    </div>
                  )}
                </div>
              ))}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, fontSize: 14, color: 'var(--text-secondary)' }}>
                <span>{data.phones.unregistered.length} staff have not registered</span>
                {can('STAFF_DEVICES_MANAGE') && <Link className="sc-btn sc-btn-soft sc-btn-sm" to="/staff/clock/devices">Link & cards</Link>}
              </div>
            </section>
          </div>
        )}

        {data && (
          <section className="sc-card">
            <div className="sc-filters">
              <div role="tablist" aria-label="Filter staff" style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {([['all', 'Everyone'], ['late', 'Late'], ['notIn', 'Not in yet'], ['review', 'Needs review']] as Array<[Tab, string]>).map(([key, label]) => (
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

            {tab === 'review' ? (
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
                    <thead><tr><th>Staff</th><th>In</th><th>Status</th><th>Out</th><th>Distance</th><th>How</th></tr></thead>
                    <tbody>
                      {rows.map((r) => (
                        <tr key={r.userId}>
                          <td><span className="sc-who"><span className="sc-avatar">{initialsOf(r.name)}</span><span><b className="sc-clip" title={r.name}>{r.name}</b><small className="sc-clip">{r.role}</small></span></span></td>
                          <td className="sc-num" style={{ fontWeight: 600 }}>{r.checkIn ?? '—'}</td>
                          <td><span className={`sc-pill ${STATUS[r.status][1]}`}><i />{STATUS[r.status][0]}</span>{r.needsReview && <span className="sc-pill sc-tone-amber" style={{ marginLeft: 6 }}>Review</span>}</td>
                          <td className="sc-num sc-muted">{r.checkOut ?? (r.outStatus === 'auto_closed' ? 'Not checked out' : '—')}{r.outStatus === 'early' ? ' · early' : ''}</td>
                          <td className="sc-num">{r.distance != null ? `${Math.round(r.distance)} m` : '—'}</td>
                          <td className="sc-muted">{r.source === 'card' ? 'Staff card' : r.device ?? (r.source ? 'Phone' : 'Not registered')}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="sc-list">
                  {rows.map((r) => (
                    <div key={r.userId} className="sc-item">
                      <span className="sc-avatar" style={{ width: 38, height: 38 }}>{initialsOf(r.name)}</span>
                      <span className="sc-item-main">
                        <b className="sc-clip" title={r.name}>{r.name}</b>
                        <small className="sc-clip sc-muted">{r.role}{r.distance != null ? ` · ${Math.round(r.distance)} m` : ''}</small>
                      </span>
                      <span className="sc-item-side">
                        <b className="sc-num">{r.checkIn ?? '—'}</b>
                        <span className={`sc-pill ${STATUS[r.status][1]}`} style={{ height: 24, fontSize: 12 }}><i />{STATUS[r.status][0]}</span>
                      </span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </section>
        )}
        {loading && data && <div style={{ position: 'fixed', right: 24, bottom: 24 }} aria-label="Refreshing"><Spinner /></div>}
      </div>
    </DashboardLayout>
  );
};
