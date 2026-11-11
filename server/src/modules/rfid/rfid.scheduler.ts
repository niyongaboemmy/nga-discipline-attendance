import { Database } from 'sqlite';
import { tick } from './closing.service.js';
import { reprocessPending } from './ingest.service.js';
import { misServiceAuthHeader, syncRosterFromMis } from './roster.service.js';
import { enqueue } from './workQueue.js';
import { startSupabaseBridge } from './supabase.bridge.js';
import { ensureTenantDb, tenantDbExists } from '../../database.js';
import {
  PRIMARY_TENANT_ID,
  forEachActiveTenant,
  primaryTenantCtx,
  runWithTenant,
  tenantRegistry,
  type TenantCtx,
} from '../../tenancy/index.js';

const TICK_MS = 30_000;
/** Re-sync the roster once the last good sync is older than this. */
const ROSTER_MAX_AGE_MS = 12 * 3600_000;
/** Don't hammer the MIS after a failed attempt. */
const ROSTER_RETRY_MS = 30 * 60_000;

/** Per school: one tenant's failed sync never holds back another's. */
const lastRosterAttempt = new Map<number, number>();

type Registry = Pick<ReturnType<typeof tenantRegistry>, 'list'>;

async function maybeSyncRoster(db: Database, tid: number) {
  if (!misServiceAuthHeader()) return;
  if (Date.now() - (lastRosterAttempt.get(tid) ?? 0) < ROSTER_RETRY_MS) return;
  const last = await db.get(
    `SELECT finished_at FROM roster_sync_runs WHERE error IS NULL AND finished_at IS NOT NULL ORDER BY id DESC LIMIT 1`
  );
  if (last && Date.now() - Date.parse(last.finished_at) < ROSTER_MAX_AGE_MS) return;
  lastRosterAttempt.set(tid, Date.now());
  try {
    const r = await enqueue(() => syncRosterFromMis(db, { triggeredBy: 'system:schedule' }));
    console.log(`RFID roster synced (tenant ${tid}): ${r.students} students, ${r.enrolments} enrolments.`);
  } catch (err) {
    console.error(`RFID roster sync failed (tenant ${tid}):`, (err as Error).message);
  }
}

/**
 * Only schools that already have a Tendo file (provisioned, or someone has
 * signed in): a background loop never creates storage.
 */
const hasStorage = (t: TenantCtx) => tenantDbExists(t.tid);

/**
 * One pass of the check-in background work for every active school, each in
 * its own tenant context and its own file. The roster sync is started, not
 * awaited (it can take a while and must not delay the next school's tick).
 */
export async function runRfidTick(registry: Registry = tenantRegistry()): Promise<TenantCtx[]> {
  return forEachActiveTenant(registry, async (t) => {
    if (!hasStorage(t)) return;
    const db = await ensureTenantDb(t.tid);
    await enqueue(() => tick(db));
    void maybeSyncRoster(db, t.tid);
  }, { onError: (t, err) => console.error(`Check-in tick failed (tenant ${t.tid}):`, err) });
}

/** Finish scans a restart left pending, per school. */
export async function recoverPendingScans(registry: Registry = tenantRegistry()): Promise<void> {
  await forEachActiveTenant(registry, async (t) => {
    if (!hasStorage(t)) return;
    const n = await reprocessPending(await ensureTenantDb(t.tid));
    if (n) console.log(`RFID (tenant ${t.tid}): finished ${n} scan(s) left pending by a restart.`);
  }, { onError: (t, err) => console.error(`RFID pending-scan recovery failed (tenant ${t.tid}):`, err) });
}

/** Background work for check-in. Started from index.ts only (never in tests). */
export function startRfidScheduler(registry: Registry = tenantRegistry()): () => void {
  void recoverPendingScans(registry);

  let busy = false;
  const run = () => {
    if (busy) return; // a slow pass is still going: skip rather than pile up
    busy = true;
    void runRfidTick(registry).finally(() => { busy = false; });
  };
  run();
  const timer = setInterval(run, TICK_MS);
  timer.unref();

  // The Supabase bridge is NGA's own scanner hardware (ESP32 -> Supabase), so
  // it feeds the primary tenant only. Its timers keep this context.
  let stopBridge: () => void = () => {};
  void (async () => {
    const primary = (await tenantRegistry().get(PRIMARY_TENANT_ID).catch(() => null)) ?? primaryTenantCtx();
    const db = await ensureTenantDb(PRIMARY_TENANT_ID);
    stopBridge = runWithTenant(primary, () => startSupabaseBridge(db));
  })().catch((err) => console.error('RFID bridge failed to start:', err));

  return () => { clearInterval(timer); stopBridge(); };
}
