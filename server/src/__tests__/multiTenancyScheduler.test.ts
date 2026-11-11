import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Database } from 'sqlite';
import { closeTenantDb, getDbFor, initDatabase, tenantDbExists } from '../database.js';
import { primaryTenantCtx } from '../tenancy/index.js';
import { runRfidTick } from '../modules/rfid/rfid.scheduler.js';
import { checkEarlyWarningForTenants, setState } from '../modules/integration/earlyWarning.service.js';
import { tick } from '../modules/rfid/closing.service.js';

// Record which tenant context and which file each scheduler body ran with.
const seen: Array<{ tid: number; db: Database }> = [];
vi.mock('../modules/rfid/closing.service.js', async (orig) => {
  const real: any = await orig();
  const { currentTid } = await import('../tenancy/index.js');
  return { ...real, tick: vi.fn(async (db: Database) => { seen.push({ tid: currentTid(), db }); return 0; }) };
});


const t = (tid: number, status: any = 'ACTIVE') => ({
  tid, slug: `s${tid}`, name: `S${tid}`, status, isPrimary: tid === 1, timezone: 'Africa/Kigali', pkg: 'starter',
});

let dataDir: string;
const prev = process.env.TENDO_DATA_DIR;

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tendo-mt-sched-'));
  process.env.TENDO_DATA_DIR = dataDir;
  await initDatabase(':memory:');
  await initDatabase(2);
  await initDatabase(3);
});

afterAll(async () => {
  await closeTenantDb(2);
  await closeTenantDb(3);
  if (prev === undefined) delete process.env.TENDO_DATA_DIR;
  else process.env.TENDO_DATA_DIR = prev;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('schedulers loop over tenants (TD-7)', () => {
  it('the RFID tick runs once per active school with storage, each in its own context and file', async () => {
    seen.length = 0;
    const registry = { list: async () => [primaryTenantCtx(), t(2), t(3, 'SUSPENDED'), t(6)] };
    const failed = await runRfidTick(registry);
    expect(failed).toEqual([]);
    // 3 is suspended; 6 has no file (a background loop never creates one).
    expect(seen.map((s) => s.tid)).toEqual([1, 2]);
    expect(seen[0].db).toBe(getDbFor(1));
    expect(seen[1].db).toBe(getDbFor(2));
    expect(tenantDbExists(6)).toBe(false);
  });

  it('one school failing does not stop the next', async () => {
    seen.length = 0;
    (tick as any).mockImplementationOnce(async () => { throw new Error('boom'); });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const failed = await runRfidTick({ list: async () => [primaryTenantCtx(), t(2)] });
    errors.mockRestore();
    expect(failed.map((f) => f.tid)).toEqual([1]);
    expect(seen.map((s) => s.tid)).toEqual([2]);
  });

  it('the early-warning check reads each school’s own last-success state', async () => {
    // School 2 succeeded just now; school 1 never did. With MIS not configured
    // the push itself is refused, so only "was it due" is observable: the
    // per-tenant app_state is what decides.
    await setState(getDbFor(2), 'early_warning.last_success_at', new Date().toISOString());
    const errors: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...a: any[]) => { errors.push(a.join(' ')); });
    await checkEarlyWarningForTenants(true, { list: async () => [primaryTenantCtx(), t(2)] });
    spy.mockRestore();
    expect(errors.some((e) => e.includes('tenant 1 startup failed'))).toBe(true);
    expect(errors.some((e) => e.includes('tenant 2'))).toBe(false);
  });
});
