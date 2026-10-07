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
export async function saveRegister(payload: RegisterPayload): Promise<{ queued: boolean; inserted?: number; updated?: number }> {
  try {
    const res = await apiPost<{ inserted: number; updated: number }>('/api/attendance/mark', payload);
    return { queued: false, ...(res.data ?? {}) };
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

const sendOne = async (p: RegisterPayload): Promise<SendOutcome> => {
  try {
    await apiPost('/api/attendance/mark', p);
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
  try {
    const r = await flush(localStorage, sendOne);
    changed();
    return r;
  } finally {
    flushing = false;
  }
}
