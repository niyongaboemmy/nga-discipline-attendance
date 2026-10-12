import { Database } from 'sqlite';
import { recordAudit } from '../../shared/audit.js';
import { normalizeUid } from './uid.js';

/**
 * Card lifecycle. Invariants, the first two enforced by partial unique indexes:
 *   - a card has at most one open assignment
 *   - a student has at most one open assignment (one active card each)
 *   - card.status = 'active' exactly when it has an open assignment
 * Assignments are closed, never deleted, so any past scan still names who held
 * the card at the time.
 */

export class CardError extends Error {
  constructor(public status: number, public code: string, message: string, public data?: unknown) {
    super(message);
  }
}

type Actor = { id: string; name?: string };

export const BLOCKED_STATUSES = ['disabled', 'lost', 'retired'] as const;
export type BlockedStatus = (typeof BLOCKED_STATUSES)[number];

async function tx<T>(db: Database, fn: () => Promise<T>): Promise<T> {
  await db.run('BEGIN TRANSACTION');
  try {
    const out = await fn();
    await db.run('COMMIT');
    return out;
  } catch (err) {
    await db.run('ROLLBACK');
    throw err;
  }
}

const cardLabel = (c: { label: string | null; uid: string }) => c.label || c.uid;

export async function registerCard(db: Database, actor: Actor, rawUid: string, label: string | null) {
  const uid = normalizeUid(rawUid);
  if (!uid) throw new CardError(400, 'MALFORMED_UID', 'That is not a valid card UID. Expected 4, 5, 7 or 10 bytes of hex, e.g. 04A1B2C3.');
  const existing = await db.get(`SELECT id FROM rfid_cards WHERE uid = ?`, uid);
  if (existing) {
    throw new CardError(409, 'CARD_EXISTS', 'This card is already registered.', { cardId: existing.id });
  }
  const now = new Date().toISOString();
  const r = await db.run(
    `INSERT INTO rfid_cards (uid, label, status, created_at, updated_at) VALUES (?, ?, 'unassigned', ?, ?)`,
    uid, label, now, now
  );
  await recordAudit(db, actor, 'rfid.card.register', 'rfid_card', Number(r.lastID), { uid, label });
  return Number(r.lastID);
}

export async function updateCardLabel(db: Database, actor: Actor, cardId: number, label: string | null) {
  const card = await loadCard(db, cardId);
  await db.run(`UPDATE rfid_cards SET label = ?, updated_at = ? WHERE id = ?`, label, new Date().toISOString(), cardId);
  await recordAudit(db, actor, 'rfid.card.label', 'rfid_card', cardId, { uid: card.uid }, { previousValue: card.label, newValue: label });
}

async function loadCard(db: Database, cardId: number) {
  const card = await db.get(`SELECT * FROM rfid_cards WHERE id = ?`, cardId);
  if (!card) throw new CardError(404, 'NOT_FOUND', 'Card not found.');
  return card;
}

async function openAssignment(db: Database, where: 'card_id' | 'student_id', value: unknown) {
  return db.get(
    `SELECT a.*, c.uid, c.label FROM rfid_card_assignments a JOIN rfid_cards c ON c.id = a.card_id
      WHERE a.${where} = ? AND a.ended_at IS NULL`,
    value
  );
}

export interface AssignOptions {
  /** The card currently belongs to someone else: move it. */
  reassign?: boolean;
  /** The student already holds another card: disable that one (lost/replaced). */
  replaceExisting?: boolean;
}

export async function assignCard(
  db: Database, actor: Actor, cardId: number, studentId: string, fallbackName: string | null, opts: AssignOptions = {}
) {
  const card = await loadCard(db, cardId);
  if ((BLOCKED_STATUSES as readonly string[]).includes(card.status)) {
    throw new CardError(409, 'CARD_BLOCKED', `This card is ${card.status}. Re-enable it before assigning it.`);
  }
  const rosterStudent = await db.get(`SELECT name, mis_status FROM roster_students WHERE student_id = ?`, studentId);
  const studentName = rosterStudent?.name ?? fallbackName;
  if (!studentName) {
    throw new CardError(400, 'UNKNOWN_STUDENT', 'That student isn’t in Tendo’s student list yet. Press “Sync now” to pull students from the MIS, then try again.');
  }

  const cardHolder = await openAssignment(db, 'card_id', cardId);
  if (cardHolder?.student_id === studentId) {
    throw new CardError(409, 'ALREADY_ASSIGNED', `This card is already assigned to ${studentName}.`);
  }
  if (cardHolder && !opts.reassign) {
    throw new CardError(409, 'CARD_ASSIGNED', `This card is assigned to ${cardHolder.student_name}. Reassign it?`, {
      holderId: cardHolder.student_id, holderName: cardHolder.student_name,
    });
  }
  const studentCard = await openAssignment(db, 'student_id', studentId);
  if (studentCard && !opts.replaceExisting) {
    throw new CardError(409, 'STUDENT_HAS_CARD',
      `${studentName} already has card ${cardLabel(studentCard)}. Replace it? The old card will be disabled.`, {
        cardId: studentCard.card_id, cardLabel: cardLabel(studentCard),
      });
  }

  const now = new Date().toISOString();
  await tx(db, async () => {
    if (cardHolder) {
      await db.run(
        `UPDATE rfid_card_assignments SET ended_at = ?, ended_by = ?, end_reason = 'reassigned' WHERE id = ?`,
        now, actor.id, cardHolder.id
      );
    }
    if (studentCard) {
      await db.run(
        `UPDATE rfid_card_assignments SET ended_at = ?, ended_by = ?, end_reason = 'replaced' WHERE id = ?`,
        now, actor.id, studentCard.id
      );
      await db.run(
        `UPDATE rfid_cards SET status = 'disabled', status_reason = ?, updated_at = ? WHERE id = ?`,
        `Replaced by card ${cardLabel(card)}`, now, studentCard.card_id
      );
    }
    await db.run(
      `INSERT INTO rfid_card_assignments (card_id, student_id, student_name, assigned_at, assigned_by, assigned_by_name)
       VALUES (?, ?, ?, ?, ?, ?)`,
      cardId, studentId, studentName, now, actor.id, actor.name ?? null
    );
    await db.run(
      `UPDATE rfid_cards SET status = 'active', status_reason = NULL, updated_at = ? WHERE id = ?`,
      now, cardId
    );
    await recordAudit(db, actor, 'rfid.card.assign', 'rfid_card', cardId, {
      uid: card.uid, studentId, studentName,
      reassignedFrom: cardHolder ? { studentId: cardHolder.student_id, studentName: cardHolder.student_name } : undefined,
      replacedCard: studentCard ? { cardId: studentCard.card_id, uid: studentCard.uid } : undefined,
    }, { required: true });
  });
}

/** Take a card back from its holder. The card stays usable for someone else. */
export async function unassignCard(db: Database, actor: Actor, cardId: number, reason: string) {
  const card = await loadCard(db, cardId);
  const holder = await openAssignment(db, 'card_id', cardId);
  if (!holder) throw new CardError(409, 'NOT_ASSIGNED', 'This card is not assigned to anyone.');
  const now = new Date().toISOString();
  await tx(db, async () => {
    await db.run(
      `UPDATE rfid_card_assignments SET ended_at = ?, ended_by = ?, end_reason = ? WHERE id = ?`,
      now, actor.id, reason, holder.id
    );
    await db.run(`UPDATE rfid_cards SET status = 'unassigned', status_reason = NULL, updated_at = ? WHERE id = ?`, now, cardId);
    await recordAudit(db, actor, 'rfid.card.unassign', 'rfid_card', cardId,
      { uid: card.uid, studentId: holder.student_id, studentName: holder.student_name, reason }, { required: true });
  });
}

/**
 * Block a card (disabled / lost / retired), which also ends its assignment so
 * the student can be given a replacement. Or re-enable one ('unassigned').
 */
export async function setCardStatus(
  db: Database, actor: Actor, cardId: number, status: BlockedStatus | 'unassigned', reason: string | null
) {
  const card = await loadCard(db, cardId);
  const now = new Date().toISOString();
  if (status === 'unassigned') {
    if (!(BLOCKED_STATUSES as readonly string[]).includes(card.status)) {
      throw new CardError(409, 'NOT_BLOCKED', 'Only a disabled, lost or retired card can be re-enabled.');
    }
    await db.run(`UPDATE rfid_cards SET status = 'unassigned', status_reason = NULL, updated_at = ? WHERE id = ?`, now, cardId);
    await recordAudit(db, actor, 'rfid.card.enable', 'rfid_card', cardId, { uid: card.uid, from: card.status, reason });
    return;
  }
  if (card.status === status) throw new CardError(409, 'NO_CHANGE', `This card is already ${status}.`);
  const holder = await openAssignment(db, 'card_id', cardId);
  await tx(db, async () => {
    if (holder) {
      await db.run(
        `UPDATE rfid_card_assignments SET ended_at = ?, ended_by = ?, end_reason = ? WHERE id = ?`,
        now, actor.id, status, holder.id
      );
    }
    await db.run(`UPDATE rfid_cards SET status = ?, status_reason = ?, updated_at = ? WHERE id = ?`, status, reason, now, cardId);
    await recordAudit(db, actor, `rfid.card.${status}`, 'rfid_card', cardId, {
      uid: card.uid, from: card.status, reason,
      holder: holder ? { studentId: holder.student_id, studentName: holder.student_name } : undefined,
    }, { required: true });
  });
}
