import { EventEmitter } from 'events';

/**
 * Every RFID write (scan processing, roster sync, closing a session) runs
 * through this one FIFO. The app shares a single SQLite connection, so two
 * async flows that each BEGIN a transaction would interleave on it. Serialising
 * this module's own work rules that out among its own jobs, and it gives the
 * "first tap wins" rule a well-defined order when two scanners report at once.
 */
let tail: Promise<unknown> = Promise.resolve();

export function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const run = tail.then(job, job);
  // Keep the chain alive past a failed job; the caller still sees the rejection.
  tail = run.catch(() => undefined);
  return run;
}

/** Wait for everything queued so far. Tests use this, and so does shutdown. */
export function drain(): Promise<void> {
  return tail.then(() => undefined);
}

/**
 * In-process fan-out for live views (SSE). One process only: running several
 * server processes would need a shared broker (e.g. Redis pub/sub) here instead.
 */
export const rfidEvents = new EventEmitter();
rfidEvents.setMaxListeners(500);

export interface ScanProcessedEvent {
  type: 'scan';
  scanId: number;
  outcome: string;
  at: string;
  studentId: string | null;
  studentName: string | null;
  classId: string | null;
  className: string | null;
  status: string | null;
  /** e.g. "Chemistry late · Biology present". */
  detail: string | null;
  sessionDate: string | null;
  period: string | null;
  uid: string | null;
  deviceName: string | null;
}

export interface RegisterChangedEvent {
  type: 'register';
  sessionDate: string;
  period: string;
  classIds: string[];
}
