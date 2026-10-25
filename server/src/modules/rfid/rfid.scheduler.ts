import { Database } from 'sqlite';
import { tick } from './closing.service.js';
import { reprocessPending } from './ingest.service.js';
import { misServiceAuthHeader, syncRosterFromMis } from './roster.service.js';
import { enqueue } from './workQueue.js';
import { startSupabaseBridge } from './supabase.bridge.js';

const TICK_MS = 30_000;
/** Re-sync the roster once the last good sync is older than this. */
const ROSTER_MAX_AGE_MS = 12 * 3600_000;
/** Don't hammer the MIS after a failed attempt. */
const ROSTER_RETRY_MS = 30 * 60_000;

let lastRosterAttempt = 0;

async function maybeSyncRoster(db: Database) {
  if (!misServiceAuthHeader()) return;
  if (Date.now() - lastRosterAttempt < ROSTER_RETRY_MS) return;
  const last = await db.get(
    `SELECT finished_at FROM roster_sync_runs WHERE error IS NULL AND finished_at IS NOT NULL ORDER BY id DESC LIMIT 1`
  );
  if (last && Date.now() - Date.parse(last.finished_at) < ROSTER_MAX_AGE_MS) return;
  lastRosterAttempt = Date.now();
  try {
    const r = await enqueue(() => syncRosterFromMis(db, { triggeredBy: 'system:schedule' }));
    console.log(`RFID roster synced: ${r.students} students, ${r.enrolments} enrolments.`);
  } catch (err) {
    console.error('RFID roster sync failed:', (err as Error).message);
  }
}

/** Background work for check-in. Started from index.ts only (never in tests). */
export function startRfidScheduler(db: Database): () => void {
  void reprocessPending(db)
    .then((n) => { if (n) console.log(`RFID: finished ${n} scan(s) left pending by a restart.`); })
    .catch((err) => console.error('RFID pending-scan recovery failed:', err));

  const run = () => {
    void enqueue(() => tick(db)).catch((err) => console.error('Check-in tick failed:', err));
    void maybeSyncRoster(db);
  };
  run();
  const timer = setInterval(run, TICK_MS);
  timer.unref();
  const stopBridge = startSupabaseBridge(db);
  return () => { clearInterval(timer); stopBridge(); };
}
