import React, { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Ban, CalendarClock, Hash, History, Radio, RotateCcw, Undo2, UserPlus, Users } from 'lucide-react';
import { DashboardLayout } from '../components/Layout/DashboardLayout';
import { ErrorState } from '../components/common/ErrorState';
import { apiGet, apiPost } from '../api/client';
import type { CardDetail } from '../api/rfid';
import { useToast } from '../context/ToastContext';
import { usePermissions } from '../hooks/usePermissions';
import { useRfidStream } from '../hooks/useRfidStream';
import { fmtSchoolClock, fmtSchoolWhen, relativeTime } from '../utils/time';
import { defer, errMsg, isBlocked, showUid, type AssignTarget } from '../utils/rfidCards';
import { CardFace, CardStatusBadge, OutcomeBadge, StudentAvatar } from '../components/rfid/CardBits';
import { AssignCardModal, CardActionModal, CardLabelModal, type CardAction } from '../components/rfid/CardModals';

const END_REASON: Record<string, string> = {
  reassigned: 'Card given to someone else',
  replaced: 'Replaced by a new card',
  lost: 'Card lost',
  disabled: 'Card disabled',
  retired: 'Card retired',
};

/** One card: who holds it, what can be done with it, and everything it has done. */
export const RfidCardDetail: React.FC = () => {
  const { id } = useParams();
  const toast = useToast();
  const { can } = usePermissions();
  const canManage = can('RFID_CARDS_MANAGE');
  const [card, setCard] = useState<CardDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [dialog, setDialog] = useState<null | { kind: 'assign' } | { kind: 'label' } | { kind: CardAction }>(null);
  const [fresh, setFresh] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await apiGet<CardDetail>(`/api/rfid/cards/${id}`);
      setCard(r.data ?? null);
      setError(null);
    } catch (err) {
      if ((err as { status?: number }).status === 404) setNotFound(true);
      else setError(errMsg(err, 'Could not load this card.'));
    }
  }, [id]);
  useEffect(() => defer(load), [load]);

  // New taps of this card appear without a refresh.
  useRfidStream((e) => {
    if (e.type !== 'scan' || !card || e.uid !== card.uid) return;
    void load();
    setFresh(true);
    setTimeout(() => setFresh(false), 4000);
  }, { onReconnect: load });

  const reEnable = async () => {
    if (!card) return;
    try {
      await apiPost(`/api/rfid/cards/${card.id}/status`, { status: 'unassigned' });
      toast.success('Card re-enabled', 'It can be assigned again.');
      void load();
    } catch (err) {
      toast.error('Could not re-enable', errMsg(err, ''));
    }
  };

  const done = () => { setDialog(null); void load(); };

  if (notFound) {
    return (
      <DashboardLayout>
        <div className="card"><div className="empty-state" style={{ padding: '56px 16px' }}>
          <span className="text-sm">This card doesn’t exist.</span>
          <Link to="/attendance/cards" className="btn btn-outline btn-sm mt-3"><ArrowLeft size={14} /> All cards</Link>
        </div></div>
      </DashboardLayout>
    );
  }

  const target: AssignTarget | null = card ? { id: card.id, uid: card.uid, label: card.label } : null;

  return (
    <DashboardLayout>
      <Link to="/attendance/cards" className="rfid-back"><ArrowLeft size={15} /> Attendance Cards</Link>

      {error && <div className="mb-4"><ErrorState message={error} onRetry={load} /></div>}
      {!card && !error && (
        <div className="rfid-detail">
          <div className="rfid-tile rfid-tile--skeleton" style={{ minHeight: 220 }} />
          <div className="card card-body"><div className="rp-skeleton" /><div className="rp-skeleton mt-2" /></div>
        </div>
      )}

      {card && target && (
        <>
          <div className="page-header">
            <div>
              <h1 className="page-title mono">{showUid(card.uid)}</h1>
              <p className="page-subtitle">
                {card.label ? `Card No. ${card.label} · ` : ''}first scanned {card.firstSeenAt ? fmtSchoolWhen(card.firstSeenAt) : 'never'}
              </p>
            </div>
            <CardStatusBadge status={card.status} />
          </div>

          <div className="rfid-detail mb-5">
            <div>
              <CardFace uid={card.uid} label={card.label} status={card.status} size="lg" fresh={fresh}
                holder={card.holder ? { name: card.holder.studentName, className: card.holder.className } : null} />
              <div className="rfid-detail-stats">
                <div><span className="stat-label">Total taps</span><strong>{card.taps}</strong></div>
                <div><span className="stat-label">Today</span><strong>{card.tapsToday}</strong></div>
                <div><span className="stat-label">Last scanned</span><strong>{card.lastSeenAt ? relativeTime(card.lastSeenAt) : '—'}</strong></div>
              </div>
            </div>

            <section className="card card-body rfid-holder-panel" aria-label="Who holds this card">
              <h2 className="section-title mb-3"><Users size={15} /> Held by</h2>
              {card.holder ? (
                <div className="rfid-holder rfid-holder--lg">
                  <StudentAvatar name={card.holder.studentName} />
                  <div>
                    <div className="rfid-holder-name">{card.holder.studentName}</div>
                    <div className="text-sm text-secondary">{card.holder.className ?? 'No class'}</div>
                    <div className="text-xs text-tertiary mt-1">
                      Since {fmtSchoolWhen(card.holder.assignedAt)}{card.holder.assignedByName ? ` · assigned by ${card.holder.assignedByName}` : ''}
                    </div>
                  </div>
                </div>
              ) : isBlocked(card.status) ? (
                <p className="text-sm text-secondary">
                  This card is {card.status}{card.statusReason ? `: ${card.statusReason}` : ''}. It doesn’t identify anyone until it’s re-enabled.
                </p>
              ) : (
                <p className="text-sm text-secondary">Nobody holds this card yet. Assign it to the student who will carry it.</p>
              )}

              {canManage && (
                <div className="rfid-holder-actions">
                  {card.status === 'unassigned' && (
                    <button className="btn btn-primary" onClick={() => setDialog({ kind: 'assign' })}><UserPlus size={15} /> Assign to a student</button>
                  )}
                  {card.status === 'active' && (
                    <>
                      <button className="btn btn-outline" onClick={() => setDialog({ kind: 'assign' })}><UserPlus size={15} /> Give to someone else</button>
                      <button className="btn btn-outline" onClick={() => setDialog({ kind: 'unassign' })}><Undo2 size={15} /> Take back</button>
                      <button className="btn btn-ghost" onClick={() => setDialog({ kind: 'lost' })}>Mark lost</button>
                    </>
                  )}
                  {(card.status === 'active' || card.status === 'unassigned') && (
                    <button className="btn btn-ghost" onClick={() => setDialog({ kind: 'disabled' })}><Ban size={15} /> Disable</button>
                  )}
                  {isBlocked(card.status) && (
                    <button className="btn btn-primary" onClick={reEnable}><RotateCcw size={15} /> Re-enable card</button>
                  )}
                  <button className="btn btn-ghost" onClick={() => setDialog({ kind: 'label' })}>
                    <Hash size={15} /> {card.label ? 'Change printed number' : 'Add printed number'}
                  </button>
                </div>
              )}
            </section>
          </div>

          <div className="rfid-detail-lower">
            <section className="card">
              <div className="card-header"><span className="section-title"><History size={15} /> Holders over time</span></div>
              <div className="card-body">
                {card.assignments.length === 0 ? (
                  <p className="text-sm text-secondary">Never assigned.</p>
                ) : (
                  <ol className="rfid-timeline">
                    {card.assignments.map((a) => (
                      <li key={a.id} className={a.endedAt ? '' : 'is-current'}>
                        <div className="flex items-center gap-2">
                          <StudentAvatar name={a.studentName} size="sm" />
                          <span className="font-medium">{a.studentName}</span>
                          {!a.endedAt && <span className="badge badge-present">Now</span>}
                        </div>
                        <span className="text-xs text-secondary">
                          {fmtSchoolWhen(a.assignedAt)} → {a.endedAt ? fmtSchoolWhen(a.endedAt) : 'today'}
                          {a.assignedByName ? ` · by ${a.assignedByName}` : ''}
                        </span>
                        {a.endReason && <span className="text-xs text-tertiary">{END_REASON[a.endReason] ?? a.endReason}</span>}
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            </section>

            <section className="card">
              <div className="card-header">
                <span className="section-title"><Radio size={15} /> Tap history</span>
                <span className="text-xs text-secondary">Latest {card.recentScans.length}</span>
              </div>
              {card.recentScans.length === 0 ? (
                <div className="empty-state" style={{ padding: '32px 0' }}><CalendarClock size={24} /><span className="text-sm">No taps yet.</span></div>
              ) : (
                <div className="table-wrap">
                  <table className="table">
                    <tbody>
                      {card.recentScans.map((s, i) => (
                        <tr key={s.id} className={fresh && i === 0 ? 'rfid-fresh' : undefined}>
                          <td className="text-sm">
                            <div className="mono">{fmtSchoolClock(s.at, true)}</div>
                            <div className="text-xs text-tertiary">{fmtSchoolWhen(s.at)}</div>
                          </td>
                          <td><OutcomeBadge outcome={s.outcome} />{s.detail && <div className="text-xs text-tertiary mt-1">{s.detail}</div>}</td>
                          <td className="text-sm text-secondary">{s.studentName ?? '—'}</td>
                          <td className="text-xs text-tertiary">{s.deviceName ?? (s.source === 'manual_entry' ? 'Entered by hand' : '')}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </div>

          {dialog?.kind === 'assign' && <AssignCardModal card={target} onClose={() => setDialog(null)} onDone={done} />}
          {dialog?.kind === 'label' && <CardLabelModal card={target} onClose={() => setDialog(null)} onDone={done} />}
          {(dialog?.kind === 'unassign' || dialog?.kind === 'lost' || dialog?.kind === 'disabled') && (
            <CardActionModal card={{ ...target, holderName: card.holder?.studentName ?? null }} kind={dialog.kind}
              onClose={() => setDialog(null)} onDone={done} />
          )}
        </>
      )}
    </DashboardLayout>
  );
};

export default RfidCardDetail;
