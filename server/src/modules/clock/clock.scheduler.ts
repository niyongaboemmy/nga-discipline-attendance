import { ensureTenantDb, tenantDbExists } from '../../database.js';
import { forEachActiveTenant, tenantRegistry } from '../../tenancy/index.js';
import { autoCloseOpenDays, blankOldCoordinates } from './clock.service.js';
import { runReminders } from './reminders.js';

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

/** Every minute: the check-in / check-out reminders that are due, school by school. */
export async function runReminderTick(registry: Pick<ReturnType<typeof tenantRegistry>, 'list'> = tenantRegistry()): Promise<number> {
  let sent = 0;
  await forEachActiveTenant(registry, async (t) => {
    if (!tenantDbExists(t.tid)) return;
    sent += await runReminders(await ensureTenantDb(t.tid), t.slug);
  });
  return sent;
}

export function startClockScheduler(): () => void {
  const run = () => void runClockTick().catch((err) => console.error('[clock] background tick failed:', (err as Error).message));
  const remind = () => void runReminderTick().catch((err) => console.error('[clock] reminder tick failed:', (err as Error).message));
  const first = setTimeout(run, 30_000);
  const timer = setInterval(run, TICK_MS);
  const reminders = setInterval(remind, 60_000);
  return () => {
    clearTimeout(first);
    clearInterval(timer);
    clearInterval(reminders);
  };
}
