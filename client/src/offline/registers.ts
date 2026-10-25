import { ApiError, OfflineError, apiPost } from '../api/client';
import { enqueue, flush, list, type RegisterPayload, type SendOutcome } from './outbox';

/** Tells the banner (useOutbox) that the queue changed. */
export const OUTBOX_EVENT = 'tendo:outbox';
const changed = () => window.dispatchEvent(new Event(OUTBOX_EVENT));

/**
 * Saves a register. Online: as before. Offline: kept on this device and sent
 * later; resolves `{ queued: true }` so the page can say so. Server refusals
 * (validation, permission) still throw, as before.
 */
type MarkResult = { inserted: number; updated: number; skipped_inactive?: string[] };

/** "N students are no longer active and were skipped" -- the server drops
 *  students disabled on the MIS from a register instead of refusing it. */
export function skippedInactiveNotice(n: number): string | null {
  if (!n) return null;
  return `${n} student${n === 1 ? ' is' : 's are'} no longer active and ${n === 1 ? 'was' : 'were'} skipped.`;
}

export async function saveRegister(
  payload: RegisterPayload
): Promise<{ queued: boolean; inserted?: number; updated?: number; skippedInactive?: string[] }> {
  try {
    const res = await apiPost<MarkResult>('/api/attendance/mark', payload);
    const { skipped_inactive, ...counts } = res.data ?? ({} as MarkResult);
    return { queued: false, ...counts, skippedInactive: skipped_inactive ?? [] };
  } catch (err) {
    if (err instanceof OfflineError || (err instanceof ApiError && err.status >= 502 && err.status <= 504)) {
      if (enqueue(localStorage, payload)) {
        changed();
        return { queued: true };
      }
    }
    throw err;
  }
}

let replaySkipped = 0;
const sendOne = async (p: RegisterPayload): Promise<SendOutcome> => {
  try {
    const res = await apiPost<MarkResult>('/api/attendance/mark', p);
    replaySkipped += res.data?.skipped_inactive?.length ?? 0;
    return { ok: true };
  } catch (err) {
    if (err instanceof OfflineError) return { ok: false, refused: false };
    if (err instanceof ApiError && (err.status === 401 || err.status >= 500)) return { ok: false, refused: false };
    return { ok: false, refused: true, message: err instanceof Error ? err.message : 'Refused by the server' };
  }
};

let flushing = false;
/** Sends what's waiting (one run at a time). */
export async function sendWaiting() {
  if (flushing || !list(localStorage).length) return null;
  flushing = true;
  replaySkipped = 0;
  try {
    const r = await flush(localStorage, sendOne);
    changed();
    return { ...r, skippedInactive: replaySkipped };
  } finally {
    flushing = false;
  }
}
