import { ApiError } from '../api/client';
import type { CardStatus } from '../api/rfid';

/** Card helpers shared by the Attendance Cards pages. */

/** Name printed on the student cards; the MIS's reports use the same one. */
export const SCHOOL_NAME = 'NGA Coding Academy';

export type AssignTarget = { id: number; uid: string; label: string | null };

/** "79430104" -> "79:43:01:04", the way the scanner and Supabase show it. */
export const showUid = (uid: string | null | undefined): string =>
  uid ? (uid.match(/.{1,2}/g) ?? [uid]).join(':') : '';

export const errMsg = (err: unknown, fallback: string): string =>
  err instanceof ApiError ? err.message : fallback;

/** True when `iso` is more than `ms` in the past. Kept outside components so render stays pure. */
export const olderThan = (iso: string, ms: number): boolean => Date.now() - Date.parse(iso) > ms;

/** Run a loader after the current render: effects must not set state synchronously. */
export const defer = (fn: () => void, ms = 0): (() => void) => {
  const t = setTimeout(fn, ms);
  return () => clearTimeout(t);
};

export const initials = (name: string): string =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]).join('').toUpperCase();

export const CARD_STATUS_META: Record<CardStatus, { label: string; badge: string }> = {
  active: { label: 'Assigned', badge: 'badge-present' },
  unassigned: { label: 'Not assigned', badge: 'badge-late' },
  disabled: { label: 'Disabled', badge: 'badge-absent' },
  lost: { label: 'Lost', badge: 'badge-absent' },
  retired: { label: 'Retired', badge: 'badge-neutral' },
};

export const isBlocked = (status: CardStatus): boolean => status === 'disabled' || status === 'lost' || status === 'retired';

export type CardsView = 'grid' | 'list';
const VIEW_KEY = 'tendo.cards.view';

/** The admin's grid/list choice, remembered per browser (falls back to grid). */
export function readCardsView(): CardsView {
  try {
    return localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'grid';
  } catch {
    return 'grid';
  }
}

export function writeCardsView(view: CardsView): void {
  try {
    localStorage.setItem(VIEW_KEY, view);
  } catch {
    // Private mode or blocked storage: the choice just isn't remembered.
  }
}
