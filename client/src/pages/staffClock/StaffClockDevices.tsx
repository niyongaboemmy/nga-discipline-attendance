import React, { useCallback, useEffect, useMemo, useState } from 'react';
import QRCode from 'qrcode';
import { Check, Minus, Printer, QrCode, Search, Smartphone, X } from 'lucide-react';
import { DashboardLayout } from '../../components/Layout/DashboardLayout';
import { ErrorState } from '../../components/common/ErrorState';
import { useToast } from '../../context/ToastContext';
import { ApiError } from '../../api/client';
import { staffClockApi, initialsOf, type ClockDevice, type IssuedCard } from '../../api/staffClock';
import { StaffClockHeader, Spinner } from './StaffClockHeader';

/**
 * Phones & cards: approve / remove the devices staff check in with, and print QR
 * cards for staff without a smartphone (scanned by a colleague with STAFF_CLOCK_SCAN).
 */

const STATE: Record<ClockDevice['status'], [string, string]> = {
  active: ['Active', 'sc-tone-green'],
  pending: ['Waiting approval', 'sc-tone-amber'],
  revoked: ['Removed', 'sc-tone-muted'],
  replaced: ['Replaced', 'sc-tone-muted'],
  declined: ['Declined', 'sc-tone-muted'],
};
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');

function schoolInitials(name: string) {
  const w = name.split(/\s+/).filter(Boolean);
  return (w.length === 1 ? w[0].slice(0, 3) : w.slice(0, 3).map((x) => x[0]).join('')).toUpperCase();
}

export const StaffClockDevices: React.FC = () => {
  const toast = useToast();
  const [devices, setDevices] = useState<ClockDevice[] | null>(null);
  const [staff, setStaff] = useState<Array<{ id: string; name: string; hasPhone: boolean }>>([]);
  const [cards, setCards] = useState<Array<{ id: number; user_id: string; user_name: string; issued_at: string; last_used_at: string | null }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [filter, setFilter] = useState<'current' | 'all'>('current');
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [pickSearch, setPickSearch] = useState('');
  const [printing, setPrinting] = useState<{ school: string; cards: Array<IssuedCard & { qr: string }> } | null>(null);
  const [removeFor, setRemoveFor] = useState<ClockDevice | null>(null);
  const [reason, setReason] = useState('');

  const load = useCallback(async () => {
    setError(null);
    try {
      const [d, o, c] = await Promise.all([staffClockApi.devices(), staffClockApi.overview(), staffClockApi.cards()]);
      setDevices(d);
      const phones = new Set(d.filter((x) => x.status === 'active').map((x) => x.user_id));
      setStaff(o.rows.map((r) => ({ id: r.userId, name: r.name, hasPhone: phones.has(r.userId) })).sort((a, b) => Number(a.hasPhone) - Number(b.hasPhone) || a.name.localeCompare(b.name)));
      setCards(c);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not load devices.');
    }
  }, []);
  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (devices ?? []).filter((d) => (filter === 'all' || d.status === 'active' || d.status === 'pending') && (!q || d.user_name.toLowerCase().includes(q) || (d.label ?? '').toLowerCase().includes(q)));
  }, [devices, filter, search]);
  const pending = (devices ?? []).filter((d) => d.status === 'pending').length;
  const cardOf = new Map(cards.map((c) => [c.user_id, c]));

  const act = async (d: ClockDevice, action: 'approve' | 'decline' | 'revoke', why?: string) => {
    setBusy(`d${d.id}`);
    try {
      await staffClockApi.deviceAction(d.id, action, why);
      toast.success(action === 'approve' ? `${d.user_name} can check in now` : action === 'decline' ? 'Device declined' : 'Device removed', action === 'revoke' ? `${d.user_name} registers again from the link.` : undefined);
      setRemoveFor(null);
      setReason('');
      await load();
    } catch (e) {
      toast.error('Not saved', e instanceof ApiError ? e.message : 'Try again.');
    } finally {
      setBusy(null);
    }
  };

  const issue = async () => {
    const people = staff.filter((s) => picked.has(s.id)).map((s) => ({ id: s.id, name: s.name }));
    if (!people.length) return;
    const replacing = people.filter((p) => cardOf.has(p.id)).length;
    if (replacing && !window.confirm(`${replacing} of these people already have a card. Printing again cancels their old card. Continue?`)) return;
    setBusy('issue');
    try {
      const res = await staffClockApi.issueCards(people);
      const withQr = await Promise.all(res.cards.map(async (c) => ({ ...c, qr: await QRCode.toDataURL(c.code, { errorCorrectionLevel: 'M', margin: 1, width: 340 }) })));
      setPrinting({ school: res.school, cards: withQr });
      setPicked(new Set());
      toast.success(withQr.length === 1 ? 'Card ready to print' : `${withQr.length} cards ready to print`);
      await load();
    } catch (e) {
      toast.error('Cards not made', e instanceof ApiError ? e.message : 'Try again.');
    } finally {
      setBusy(null);
    }
  };

  const pickList = staff.filter((s) => !pickSearch.trim() || s.name.toLowerCase().includes(pickSearch.trim().toLowerCase()));

  return (
    <DashboardLayout>
      <div className="sc-page">
        <StaffClockHeader title="Phones & cards" lead="The phone or tablet each person checks in with, and printed QR cards for staff without a smartphone." pending={pending} />
        {error && <ErrorState message={error} onRetry={() => void load()} />}

        <section className="sc-card">
          <div className="sc-filters">
            <h2 style={{ marginRight: 8 }}>Devices</h2>
            <div className="sc-seg" role="group" aria-label="Which devices">
              <button aria-pressed={filter === 'current'} onClick={() => setFilter('current')}>In use</button>
              <button aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>History</button>
            </div>
            <div style={{ flex: 1 }} />
            <label className="sc-search"><Search size={16} /><span className="sr-only">Search devices</span><input placeholder="Search staff or device" value={search} onChange={(e) => setSearch(e.target.value)} /></label>
          </div>
          {!devices ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 14 }}>{[0, 1, 2, 3].map((i) => <div key={i} className="sc-skel" style={{ height: 50 }} />)}</div>
          ) : shown.length === 0 ? (
            <div className="sc-empty">No devices yet. Share the staff link so staff can register their phones.</div>
          ) : (
            <>
              <div className="sc-table-wrap sc-responsive">
                <table className="sc-table">
                  <thead><tr><th>Staff</th><th>Device</th><th>Registered</th><th>Last used</th><th>State</th><th><span className="sr-only">Actions</span></th></tr></thead>
                  <tbody>
                    {shown.map((d) => (
                      <tr key={d.id}>
                        <td><span className="sc-who"><span className="sc-avatar">{initialsOf(d.user_name)}</span><span><b className="sc-clip" title={d.user_name}>{d.user_name}</b><small className="sc-clip">{d.google_email}</small></span></span></td>
                        <td>{d.label ?? '—'}<div className="sc-muted" style={{ fontSize: 12, textTransform: 'capitalize' }}>{d.form_factor}</div></td>
                        <td className="sc-muted">{when(d.registered_at)}</td>
                        <td className="sc-muted">{when(d.last_used_at)}</td>
                        <td><span className={`sc-pill ${STATE[d.status][1]}`}>{STATE[d.status][0]}</span>{d.revoke_reason && d.status !== 'active' && <div className="sc-muted" style={{ fontSize: 12, marginTop: 2 }}>{d.revoke_reason.replace(/_/g, ' ')}</div>}</td>
                        <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                          {d.status === 'pending' && (
                            <>
                              <button className="sc-btn sc-btn-primary sc-btn-sm" disabled={busy === `d${d.id}`} onClick={() => void act(d, 'approve')}>Approve</button>{' '}
                              <button className="sc-btn sc-btn-sm" disabled={busy === `d${d.id}`} onClick={() => void act(d, 'decline')}>Decline</button>
                            </>
                          )}
                          {d.status === 'active' && <button className="sc-btn sc-btn-sm sc-btn-danger" onClick={() => { setRemoveFor(d); setReason(''); }}>Remove</button>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="sc-list">
                {shown.map((d) => (
                  <div key={d.id} className="sc-item">
                    <span className="sc-avatar" style={{ width: 38, height: 38 }}>{initialsOf(d.user_name)}</span>
                    <span className="sc-item-main"><b className="sc-clip" title={d.user_name}>{d.user_name}</b><small className="sc-muted sc-clip">{d.label}</small></span>
                    <span className="sc-item-side">
                      <span className={`sc-pill ${STATE[d.status][1]}`} style={{ height: 24, fontSize: 12 }}>{STATE[d.status][0]}</span>
                      {d.status === 'pending' && <button className="sc-btn sc-btn-primary sc-btn-sm" onClick={() => void act(d, 'approve')}>Approve</button>}
                      {d.status === 'active' && <button className="sc-btn sc-btn-sm sc-btn-danger" onClick={() => { setRemoveFor(d); setReason(''); }}>Remove</button>}
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}
        </section>

        <section className="sc-card">
          <div className="sc-filters">
            <div style={{ flex: '1 1 320px' }}>
              <h2>Staff QR cards</h2>
              <p className="sc-card-sub">For staff without a smartphone. A colleague allowed to scan cards checks them in and out at school with the “Scan a card” page. Printing again cancels the old card.</p>
            </div>
            <button className="sc-btn sc-btn-primary" disabled={!picked.size || busy === 'issue'} onClick={() => void issue()}>
              {busy === 'issue' ? <Spinner /> : <QrCode size={16} />} Make {picked.size || ''} card{picked.size === 1 ? '' : 's'}
            </button>
          </div>
          <div className="sc-filters" style={{ marginTop: 12 }}>
            <label className="sc-search"><Search size={16} /><span className="sr-only">Search staff</span><input placeholder="Search staff" value={pickSearch} onChange={(e) => setPickSearch(e.target.value)} /></label>
            <button className="sc-btn sc-btn-sm" onClick={() => setPicked(new Set(staff.filter((s) => !s.hasPhone).map((s) => s.id)))}>Select everyone without a phone</button>
            {!!picked.size && <button className="sc-btn sc-btn-sm" onClick={() => setPicked(new Set())}>Clear</button>}
          </div>
          {!devices ? (
            <div className="sc-picks" aria-busy="true">{[0, 1, 2, 3, 4, 5].map((i) => <div key={i} className="sc-pick"><span className="sc-skel" style={{ width: 22, height: 22, borderRadius: 999 }} /><span className="sc-skel" style={{ width: 36, height: 36, borderRadius: 999 }} /><span className="sc-skel" style={{ height: 12, width: `${40 + i * 7}%` }} /></div>)}</div>
          ) : (() => {
            const shownPicked = pickList.filter((s) => picked.has(s.id)).length;
            const all = pickList.length > 0 && shownPicked === pickList.length;
            const some = shownPicked > 0 && !all;
            const toggle = (id: string, on: boolean) => setPicked((p) => { const n = new Set(p); if (on) n.add(id); else n.delete(id); return n; });
            return (
              <>
                <label className={`sc-pick sc-pick-all${all || some ? ' is-on' : ''}`}>
                  <input type="checkbox" className="sr-only" checked={all} ref={(el) => { if (el) el.indeterminate = some; }}
                    onChange={() => setPicked((p) => { const n = new Set(p); pickList.forEach((s) => (all ? n.delete(s.id) : n.add(s.id))); return n; })} />
                  <span className="sc-tick" aria-hidden>{all ? <Check size={14} strokeWidth={3} /> : some ? <Minus size={14} strokeWidth={3} /> : null}</span>
                  <b>{all ? 'All selected' : some ? `${shownPicked} selected` : 'Select all'}</b>
                  <span className="sc-muted">{pickList.length} shown</span>
                </label>
                <div className="sc-picks" role="group" aria-label="Staff for QR cards">
                  {pickList.map((s) => {
                    const on = picked.has(s.id);
                    return (
                      <label key={s.id} className={`sc-pick${on ? ' is-on' : ''}`} title={s.name}>
                        <input type="checkbox" className="sr-only" checked={on} onChange={(e) => toggle(s.id, e.target.checked)} />
                        <span className="sc-tick" aria-hidden>{on && <Check size={14} strokeWidth={3} />}</span>
                        <span className="sc-avatar sc-pick-avatar">{initialsOf(s.name)}</span>
                        <span className="sc-pick-name"><b className="sc-clip">{s.name}</b></span>
                        <span className="sc-pick-tags">
                          <span className={`sc-mini${s.hasPhone ? ' is-ok' : ''}`} title={s.hasPhone ? 'Has a phone' : 'No phone'}><Smartphone size={13} />{s.hasPhone ? 'Phone' : 'No phone'}</span>
                          {cardOf.has(s.id) && <span className="sc-mini is-card" title="Has a card"><QrCode size={13} />Card</span>}
                        </span>
                      </label>
                    );
                  })}
                  {pickList.length === 0 && <div className="sc-empty">No staff match this search.</div>}
                </div>
              </>
            );
          })()}
          {cards.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <div className="sc-muted" style={{ fontSize: 13, fontWeight: 600 }}>Cards in use ({cards.length})</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
                {cards.map((c) => (
                  <span key={c.id} className="sc-pill sc-tone-blue" style={{ height: 32 }} title={`Printed ${when(c.issued_at)} · last used ${when(c.last_used_at)}`}>
                    <span className="sc-clip" style={{ maxWidth: 200 }}>{c.user_name}</span>
                    <button aria-label={`Cancel ${c.user_name}'s card`} style={{ border: 0, background: 'transparent', color: 'inherit', cursor: 'pointer', display: 'flex', borderRadius: 999 }}
                      onClick={async () => { if (!window.confirm(`Cancel ${c.user_name}'s card? It stops working at once.`)) return; try { await staffClockApi.revokeCard(c.id); toast.success('Card cancelled'); await load(); } catch (e) { toast.error('Not cancelled', e instanceof ApiError ? e.message : ''); } }}>
                      <X size={14} />
                    </button>
                  </span>
                ))}
              </div>
            </div>
          )}
        </section>

        {printing && (
          <section className="sc-card">
            <div className="sc-filters">
              <h2 style={{ flex: 1 }}>Ready to print ({printing.cards.length})</h2>
              <button className="sc-btn sc-btn-primary" onClick={() => window.print()}><Printer size={16} /> Print</button>
              <button className="sc-btn" onClick={() => setPrinting(null)}>Done</button>
            </div>
            <p className="sc-card-sub">Cut along the dashed lines. Keep a card safe: anyone holding it can be checked in by a scanner at school.</p>
            <div className="sc-print" style={{ marginTop: 14 }}>
              <div className="sc-cards-sheet">
                {printing.cards.map((c) => (
                  <div key={c.cardId} className="sc-qr-card">
                    <div className="sc-qr-school"><span className="sc-qr-logo">{schoolInitials(printing.school)}</span>{printing.school}</div>
                    <img src={c.qr} alt={`QR card for ${c.name}`} />
                    <b>{c.name}</b>
                    <small>Staff attendance card · show it at the office to check in and out</small>
                  </div>
                ))}
              </div>
            </div>
          </section>
        )}

        {removeFor && (
          <div className="modal-backdrop" style={{ position: 'fixed', inset: 0, background: 'rgba(17,24,39,.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
            onClick={(e) => e.target === e.currentTarget && setRemoveFor(null)}>
            <div role="dialog" aria-modal="true" aria-label="Remove device" className="sc-card" style={{ width: 460, maxWidth: 'calc(100% - 32px)', display: 'flex', flexDirection: 'column', gap: 14 }}>
              <h2 style={{ overflowWrap: 'anywhere' }}>Remove {removeFor.user_name}’s {removeFor.form_factor}?</h2>
              <p className="sc-card-sub" style={{ margin: 0 }}>{removeFor.label}. It stops working at once; they register a new one from the staff link.</p>
              <label className="sc-field">Reason (kept in the audit log)
                <input className="sc-input" autoFocus value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} placeholder="Lost phone" />
              </label>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button className="sc-btn" onClick={() => setRemoveFor(null)}>Cancel</button>
                <button className="sc-btn sc-btn-primary" disabled={!reason.trim() || busy === `d${removeFor.id}`} onClick={() => void act(removeFor, 'revoke', reason.trim())}>
                  {busy === `d${removeFor.id}` && <Spinner />}Remove
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </DashboardLayout>
  );
};
