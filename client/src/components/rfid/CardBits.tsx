import React from 'react';
import { Nfc } from 'lucide-react';
import { OUTCOME_META, type CardStatus, type ScanOutcome } from '../../api/rfid';
import { CARD_STATUS_META, SCHOOL_NAME, initials, isBlocked, showUid } from '../../utils/rfidCards';

/** Small presentational pieces shared by the Attendance Cards pages. */

export const OutcomeBadge: React.FC<{ outcome: ScanOutcome }> = ({ outcome }) => {
  const m = OUTCOME_META[outcome] ?? { label: outcome, tone: 'neutral' };
  return <span className={`badge ${m.tone === 'neutral' ? 'badge-neutral' : `badge-${m.tone}`}`}>{m.label}</span>;
};

export const CardStatusBadge: React.FC<{ status: CardStatus }> = ({ status }) => (
  <span className={`badge ${CARD_STATUS_META[status].badge}`}>{CARD_STATUS_META[status].label}</span>
);

export const StudentAvatar: React.FC<{ name: string; size?: 'sm' | 'md' }> = ({ name, size = 'md' }) => (
  <span className={`avatar rfid-avatar${size === 'sm' ? ' avatar-sm' : ''}`} aria-hidden="true">{initials(name)}</span>
);

/**
 * The card drawn as the NGA student ID it is: school band with the NGA
 * shield, photo slot (initials), name, class, printed number and the RFID UID.
 * An unassigned card shows an empty slot; a card that no longer works is stamped.
 */
export const CardFace: React.FC<{
  uid: string;
  label: string | null;
  status: CardStatus;
  holder?: { name: string; className: string | null } | null;
  size?: 'sm' | 'lg';
  fresh?: boolean;
}> = ({ uid, label, status, holder = null, size = 'sm', fresh = false }) => (
  <div
    className={`rfid-id rfid-id--${size}${isBlocked(status) ? ' is-blocked' : ''}${fresh ? ' is-fresh' : ''}`}
    role="img"
    aria-label={`${SCHOOL_NAME} student card ${showUid(uid)}${holder ? `, ${holder.name}` : ', not assigned'}${label ? `, number ${label}` : ''}`}
  >
    <div className="rfid-id-band">
      <img src="/nga-logo.png" alt="" className="rfid-id-logo" />
      <div className="rfid-id-school">
        <strong>{SCHOOL_NAME}</strong>
        <span>Student Identity Card</span>
      </div>
    </div>

    <div className="rfid-id-body">
      <div className={`rfid-id-photo${holder ? '' : ' is-empty'}`} aria-hidden="true">
        {holder ? initials(holder.name) : '?'}
      </div>
      <div className="rfid-id-fields">
        <div className="rfid-id-name">{holder ? holder.name : 'Not assigned yet'}</div>
        <div className="rfid-id-class">{holder ? holder.className ?? 'No class' : 'Unassigned card'}</div>
        <dl className="rfid-id-meta">
          <div className={label ? undefined : 'is-empty'}><dt>Card No.</dt><dd>{label ?? '—'}</dd></div>
          <div><dt>UID</dt><dd className="mono">{showUid(uid)}</dd></div>
        </dl>
      </div>
    </div>

    <div className="rfid-id-foot">
      <span className="rfid-id-barcode" aria-hidden="true" />
      <span className="rfid-id-tap"><Nfc size={size === 'lg' ? 16 : 12} aria-hidden="true" /> Tap to scan</span>
    </div>

    {isBlocked(status) && <span className="rfid-id-stamp">{CARD_STATUS_META[status].label}</span>}
  </div>
);
