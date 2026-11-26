import React, { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Check, Clock, ChevronLeft, ChevronRight, Download, ArrowUpRight, LogOut, UserX, CalendarClock } from 'lucide-react';
import { DashboardLayout } from '../../components/Layout/DashboardLayout';
import { ErrorState } from '../../components/common/ErrorState';
import { useToast } from '../../context/ToastContext';
import { usePermissions } from '../../hooks/usePermissions';
import { ApiError } from '../../api/client';
import { staffClockApi, type Overview } from '../../api/staffClock';
import { StaffClockHeader, Spinner } from './StaffClockHeader';
import { StaffClockSetup } from './StaffClockSetup';
import { AttentionStrip, ListSheet, Ring, type SheetPerson } from './StaffClockAttention';
import { StaffHistoryModal } from './StaffHistoryModal';

/** Staff attendance dashboard (prototype "Admin: staff attendance dashboard"). */

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

export const StaffClockDashboard: React.FC = () => {
  const toast = useToast();
  const { can } = usePermissions();
  const [date, setDate] = useState<string | null>(null);
  const [data, setData] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const [person, setPerson] = useState<{ id: string; name: string } | null>(null);
  const [hover, setHover] = useState(-1);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [sheet, setSheet] = useState<null | 'notIn' | 'noOut' | 'recent'>(null);

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
  const counts = { phones: data?.phones.pending.length ?? 0 };
  const missingOut = data?.missing?.noCheckoutToday ?? [];
  const recentOut = data?.missing?.recentNoCheckout ?? [];
  const dayName = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short', timeZone: 'UTC' });
  const sheetPeople: SheetPerson[] =
    sheet === 'notIn' ? (data?.rows ?? []).filter((r) => r.status === 'not_in').map((r) => ({ id: r.userId, personId: r.userId, name: r.name, meta: `${r.role}${r.device ? '' : ' · no phone registered'}` }))
    : sheet === 'noOut' ? missingOut.map((m) => ({ id: m.userId, personId: m.userId, name: m.name, meta: `In at ${m.checkIn ?? '—'}`, tag: m.autoClosed ? 'Closed' : undefined }))
    : sheet === 'recent' ? recentOut.map((m) => ({ id: `${m.userId}-${m.date}`, personId: m.userId, name: m.name, meta: `In at ${m.checkIn ?? '—'}`, group: dayName(m.date) }))
    : [];
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
        {can(['STAFF_ATTENDANCE_ZONES_MANAGE', 'STAFF_DEVICES_MANAGE']) && <StaffClockSetup place="dashboard" />}
        {data && data.isToday && (
          <AttentionStrip
            data={data}
            canSetup={can('STAFF_ATTENDANCE_ZONES_MANAGE')}
            onReview={() => navigate('/staff/clock/people?tab=review')}
            onPhones={() => document.getElementById('sc-phones')?.scrollIntoView({ behavior: 'smooth', block: 'center' })}
          />
        )}

        {loading && !data ? (
          <div className="sc-kpis">{[0, 1, 2, 3, 4].map((i) => <div key={i} className="sc-skel" style={{ height: 118, borderRadius: 20 }} />)}</div>
        ) : k && (
          <div className="sc-kpis">
            <div className="sc-kpi sc-kpi-hero">
              <Ring value={k.checkedIn} total={k.staff} size={76} />
              <div>
                <div className="sc-kpi-label">Checked in</div>
                <div className="sc-kpi-value"><b>{k.checkedIn}</b><span>/ {k.staff}</span></div>
              </div>
            </div>
            <div className="sc-kpi">
              <div className="sc-kpi-label" style={{ color: 'var(--status-present)' }}><Check size={15} /> On time</div>
              <div className="sc-kpi-value"><b>{k.onTime}</b></div>
              <div className="sc-kpi-foot">by {data!.rules.lateAfter}</div>
            </div>
            <div className="sc-kpi">
              <div className="sc-kpi-label" style={{ color: 'var(--status-late)' }}><Clock size={15} /> Late</div>
              <div className="sc-kpi-value"><b>{k.late}</b>{k.medianLateMinutes != null && <span>~{k.medianLateMinutes} min</span>}</div>
              <div className="sc-kpi-foot">after {data!.rules.lateAfter}</div>
            </div>
            <button type="button" className={`sc-kpi sc-kpi-tap${k.notIn ? '' : ' sc-kpi-dim'}`} data-kpi="notIn" onClick={() => setSheet('notIn')}>
              <ArrowUpRight size={16} className="sc-kpi-go" />
              <div className="sc-kpi-label"><UserX size={15} /> {data!.isToday ? 'Not in yet' : 'Absent'}</div>
              <div className="sc-kpi-value"><b>{k.notIn}</b></div>
              <div className="sc-kpi-foot">tap to see who</div>
            </button>
            <button type="button" className={`sc-kpi sc-kpi-tap${missingOut.length ? ' sc-kpi-warn' : ' sc-kpi-dim'}`} data-kpi="noOut" onClick={() => setSheet('noOut')}>
              <ArrowUpRight size={16} className="sc-kpi-go" />
              <div className="sc-kpi-label"><LogOut size={15} /> No check-out</div>
              <div className="sc-kpi-value"><b>{data!.missing?.checkoutOpen === false ? '–' : missingOut.length}</b></div>
              <div className="sc-kpi-foot">{data!.missing?.checkoutOpen === false ? `opens ${data!.rules.earlyLeaveBefore}` : `${k.checkedOut} checked out`}</div>
            </button>
            <button type="button" className={`sc-kpi sc-kpi-tap${recentOut.length ? ' sc-kpi-warn' : ' sc-kpi-dim'}`} data-kpi="recent" onClick={() => setSheet('recent')}>
              <ArrowUpRight size={16} className="sc-kpi-go" />
              <div className="sc-kpi-label"><CalendarClock size={15} /> Missed</div>
              <div className="sc-kpi-value"><b>{recentOut.length}</b></div>
              <div className="sc-kpi-foot">check-outs · 7 days</div>
            </button>
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

            <section id="sc-phones" className="sc-card sc-side" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
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

        {loading && data && <div style={{ position: 'fixed', right: 24, bottom: 24 }} aria-label="Refreshing"><Spinner /></div>}
        {sheet && data && (
          <ListSheet
            title={sheet === 'notIn' ? (data.isToday ? 'Not in yet' : 'Absent') : sheet === 'noOut' ? 'No check-out' : 'Missed check-outs'}
            subtitle={sheet === 'recent' ? 'Checked in, never checked out · last 7 days' : dayName(data.date)}
            people={sheetPeople}
            empty={sheet === 'notIn' ? 'Everyone is in' : sheet === 'noOut' ? (data.missing?.checkoutOpen === false ? `Check-out opens at ${data.rules.earlyLeaveBefore}` : 'Everyone checked out') : 'No missed check-outs'}
            onClose={() => setSheet(null)}
            onPick={(p) => p.personId && setPerson({ id: p.personId, name: p.name })}
          />
        )}
        {person && <StaffHistoryModal personId={person.id} name={person.name} onClose={() => setPerson(null)} />}
      </div>
    </DashboardLayout>
  );
};
