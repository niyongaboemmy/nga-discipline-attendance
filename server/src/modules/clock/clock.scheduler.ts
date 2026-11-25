import { ensureTenantDb, tenantDbExists } from '../../database.js';
import { forEachActiveTenant, tenantRegistry } from '../../tenancy/index.js';
import { autoCloseOpenDays, blankOldCoordinates } from './clock.service.js';

/**
 * Every 10 minutes, for each school that has a Tendo file: close days left without a
 * check-out once the school's auto-close time passes, and blank coordinates older than
 * the retention period. Each school in its own tenant context.
 */
const TICK_MS = 10 * 60_000;

export async function runClockTick(registry: Pick<ReturnType<typeof tenantRegistry>, 'list'> = tenantRegistry()): Promise<void> {
  await forEachActiveTenant(registry, async (t) => {
    if (!tenantDbExists(t.tid)) return;
    const db = await ensureTenantDb(t.tid);
    await autoCloseOpenDays(db);
    await blankOldCoordinates(db);
  });
}

export function startClockScheduler(): () => void {
  const run = () => void runClockTick().catch((err) => console.error('[clock] background tick failed:', (err as Error).message));
  const first = setTimeout(run, 30_000);
  const timer = setInterval(run, TICK_MS);
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
