import React, { useEffect, useState } from 'react';
import { AlertTriangle, Check, Search } from 'lucide-react';
import { Modal } from '../common/Modal';
import { apiGet, apiPost, apiPut, ApiError } from '../../api/client';
import { useToast } from '../../context/ToastContext';
import type { RosterStudent } from '../../api/rfid';
import { errMsg, showUid, type AssignTarget } from '../../utils/rfidCards';
import { StudentAvatar } from './CardBits';

type Conflict = { code: 'CARD_ASSIGNED' | 'STUDENT_HAS_CARD'; message: string };

/** Pick a student for a card. Handles "card already held" and "student
 *  already has a card" by asking before reassigning or replacing. */
export const AssignCardModal: React.FC<{
  card: AssignTarget; onClose: () => void; onDone: () => void;
}> = ({ card, onClose, onDone }) => {
  const toast = useToast();
  const [query, setQuery] = useState('');
  const [students, setStudents] = useState<RosterStudent[]>([]);
  const [loading, setLoading] = useState(true);
  const [picked, setPicked] = useState<RosterStudent | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [confirmed, setConfirmed] = useState({ reassign: false, replaceExisting: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = card.label ? `No. ${card.label}` : showUid(card.uid);

  useEffect(() => {
    let live = true;
    const t = setTimeout(async () => {
      try {
        const r = await apiGet<RosterStudent[]>(`/api/rfid/students?search=${encodeURIComponent(query.trim())}`);
        if (live) setStudents(r.data ?? []);
      } catch (err) {
        if (live) setError(errMsg(err, 'Could not search students.'));
      } finally {
        if (live) setLoading(false);
      }
    }, 200);
    return () => { live = false; clearTimeout(t); };
  }, [query]);

  const submit = async (flags = confirmed) => {
    if (!picked) return;
    setBusy(true); setError(null);
    try {
      await apiPost(`/api/rfid/cards/${card.id}/assign`, { studentId: picked.id, ...flags });
      toast.success('Card assigned', `${name} → ${picked.name}`);
      onDone();
    } catch (err) {
      setBusy(false);
      if (err instanceof ApiError && err.status === 409 && (err.code === 'CARD_ASSIGNED' || err.code === 'STUDENT_HAS_CARD')) {
        setConflict({ code: err.code, message: err.message });
        return;
      }
      setError(errMsg(err, 'Could not assign the card.'));
    }
  };

  const confirmConflict = () => {
    if (!conflict) return;
    const flags = conflict.code === 'CARD_ASSIGNED' ? { ...confirmed, reassign: true } : { ...confirmed, replaceExisting: true };
    setConfirmed(flags);
    setConflict(null);
    void submit(flags);
  };

  return (
    <Modal open title={`Assign card ${name}`} subtitle={card.label ? <code className="mono">{showUid(card.uid)}</code> : 'Choose the student who will carry this card.'}
      onClose={busy ? () => {} : onClose} maxWidth={520}
      footer={<>
        <button className="btn btn-outline" onClick={onClose} disabled={busy}>Cancel</button>
        {conflict ? (
          <button className="btn btn-danger" onClick={confirmConflict} disabled={busy}>
            {conflict.code === 'CARD_ASSIGNED' ? 'Yes, reassign' : 'Yes, replace old card'}
          </button>
        ) : (
          <button className="btn btn-primary" onClick={() => submit()} disabled={busy || !picked}>
            {busy ? 'Assigning…' : picked ? `Assign to ${picked.name.split(' ')[0]}` : 'Assign'}
          </button>
        )}
      </>}>
      {conflict ? (
        <div className="alert alert-warning" role="alert"><AlertTriangle size={16} /><span>{conflict.message}</span></div>
      ) : (
        <>
          <div className="rp-search mb-3">
            <Search className="field-icon" size={15} />
            <input className="input" placeholder="Search students by name…" value={query} autoFocus
              aria-label="Search students" onChange={(e) => { setQuery(e.target.value); setPicked(null); setLoading(true); }} />
          </div>
          <ul className="rfid-pick-list" role="listbox" aria-label="Students">
            {loading && students.length === 0 && <li className="text-sm text-secondary p-3">Searching…</li>}
            {!loading && students.length === 0 && (
              <li className="text-sm text-secondary p-3">No students found. If someone is missing, press “Sync now” on the cards page.</li>
            )}
            {students.map((s) => (
              <li key={s.id}>
                <button type="button" role="option" aria-selected={picked?.id === s.id}
                  className={`rfid-pick${picked?.id === s.id ? ' is-picked' : ''}`} onClick={() => setPicked(s)}>
                  <StudentAvatar name={s.name} size="sm" />
                  <span className="flex-1">
                    <span className="font-medium">{s.name}</span>
                    <span className="text-xs text-secondary block">{s.className ?? 'No active class'}</span>
                  </span>
                  {s.card && <span className="badge badge-neutral" title="Already holds a card">Has {s.card.label ? `No. ${s.card.label}` : showUid(s.card.uid)}</span>}
                  {picked?.id === s.id && <Check size={16} className="rfid-pick-check" aria-hidden="true" />}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {error && <div className="field-error mt-2" role="alert">{error}</div>}
    </Modal>
  );
};

export type CardAction = 'unassign' | 'lost' | 'disabled';

/** Return a card, or mark it lost / disabled, with a reason for the audit log. */
export const CardActionModal: React.FC<{
  card: AssignTarget & { holderName: string | null }; kind: CardAction; onClose: () => void; onDone: () => void;
}> = ({ card, kind, onClose, onDone }) => {
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const name = card.label ? `No. ${card.label}` : showUid(card.uid);
  const copy = {
    unassign: {
      title: `Take card ${name} back`,
      body: `${card.holderName ?? 'The holder'} will no longer be identified by this card. You can give it to someone else afterwards.`,
      cta: 'Take back', required: true, placeholder: 'e.g. Student left the school', done: 'Card taken back',
    },
    lost: {
      title: `Mark card ${name} as lost`,
      body: `The card stops working straight away, and any tap of it is flagged.${card.holderName ? ` ${card.holderName} can then be given a new card.` : ''}`,
      cta: 'Mark lost', required: false, placeholder: 'Optional: where or when it was lost', done: 'Card marked lost',
    },
    disabled: {
      title: `Disable card ${name}`,
      body: 'The card stops working straight away. Its history stays as it is, and you can re-enable it later.',
      cta: 'Disable card', required: false, placeholder: 'Optional reason', done: 'Card disabled',
    },
  }[kind];

  const submit = async () => {
    setBusy(true);
    try {
      if (kind === 'unassign') await apiPost(`/api/rfid/cards/${card.id}/unassign`, { reason: reason.trim() });
      else await apiPost(`/api/rfid/cards/${card.id}/status`, { status: kind, reason: reason.trim() || undefined });
      toast.success(copy.done, name);
      onDone();
    } catch (err) {
      toast.error('That didn’t work', errMsg(err, ''));
      setBusy(false);
    }
  };

  return (
    <Modal open title={copy.title} onClose={busy ? () => {} : onClose} maxWidth={460}
      footer={<>
        <button className="btn btn-outline" onClick={onClose} disabled={busy}>Cancel</button>
        <button className={`btn ${kind === 'unassign' ? 'btn-primary' : 'btn-danger'}`} onClick={submit}
          disabled={busy || (copy.required && !reason.trim())}>{busy ? 'Saving…' : copy.cta}</button>
      </>}>
      <p className="text-sm text-secondary mb-3">{copy.body}</p>
      <div className="field">
        <label className="label" htmlFor="rfid-reason">Reason{copy.required ? '' : ' (optional)'}</label>
        <input id="rfid-reason" className="input" value={reason} maxLength={200} placeholder={copy.placeholder}
          onChange={(e) => setReason(e.target.value)} autoFocus />
      </div>
    </Modal>
  );
};

/** The number printed on the card, so staff can match the plastic to the record. */
export const CardLabelModal: React.FC<{ card: AssignTarget; onClose: () => void; onDone: () => void }> = ({ card, onClose, onDone }) => {
  const toast = useToast();
  const [label, setLabel] = useState(card.label ?? '');
  const [busy, setBusy] = useState(false);

  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setBusy(true);
    try {
      await apiPut(`/api/rfid/cards/${card.id}`, { label: label.trim() || null });
      toast.success('Card number saved', label.trim() ? `No. ${label.trim()}` : 'Number removed');
      onDone();
    } catch (err) {
      toast.error('Could not save', errMsg(err, ''));
      setBusy(false);
    }
  };

  return (
    <Modal open title="Number printed on the card" subtitle={<code className="mono">{showUid(card.uid)}</code>}
      onClose={busy ? () => {} : onClose} maxWidth={420}
      footer={<>
        <button className="btn btn-outline" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="btn btn-primary" onClick={() => submit()} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
      </>}>
      <form onSubmit={submit} className="field">
        <label className="label" htmlFor="card-label">Card number</label>
        <input id="card-label" className="input" value={label} maxLength={60} placeholder="e.g. 0172" autoFocus
          onChange={(e) => setLabel(e.target.value)} />
        <span className="text-xs text-tertiary">Optional. Leave empty if the card has no printed number.</span>
      </form>
    </Modal>
  );
};
