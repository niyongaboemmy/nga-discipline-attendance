import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { Database } from 'sqlite';
import { setupTestDb } from './testUtils.js';
import { pollSupabaseOnce, bridgeStatus } from '../modules/rfid/supabase.bridge.js';
import { drain } from '../modules/rfid/workQueue.js';

/** A fake PostgREST over an in-memory `rfid_scans` table, shaped like the real one. */
function fakeSupabase(rows: { id: number; uid: string; device: string; scanned_at: string }[], status = 200) {
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (url: string) => {
    calls.push(url);
    const q = new URL(url).searchParams;
    let out = [...rows];
    const gt = q.get('id')?.match(/^gt\.(\d+)$/);
    if (gt) out = out.filter((r) => r.id > Number(gt[1]));
    out.sort((a, b) => (q.get('order') === 'id.desc' ? b.id - a.id : a.id - b.id));
    out = out.slice(0, Number(q.get('limit') ?? 1000));
    return {
      ok: status < 400, status,
      json: async () => out,
      text: async () => JSON.stringify({ message: 'Invalid API key' }),
    };
  });
  return { fetchImpl, calls };
}

const config = { url: 'https://example.supabase.co', key: 'k', keyKind: 'anon' as const };

describe('Supabase rfid_scans bridge', () => {
  let db: Database;
  beforeAll(async () => { db = await setupTestDb(); });
  beforeEach(async () => {
    for (const t of ['rfid_bridge_state', 'rfid_scan_events', 'rfid_cards', 'rfid_devices']) await db.run(`DELETE FROM ${t}`);
  });
  afterEach(async () => { await drain(); vi.unstubAllEnvs(); });

  const row = (id: number, uid = '79:43:01:04', at = `2026-09-25T05:${String(id).padStart(2, '0')}:00.123456+00:00`) =>
    ({ id, uid, device: 'ESP32', scanned_at: at });

  it('first run starts after the newest existing row, so old test scans are not replayed', async () => {
    const sb = fakeSupabase([row(1), row(2), row(94)]);
    const r = await pollSupabaseOnce(db, { fetchImpl: sb.fetchImpl, config });
    expect(r).toEqual({ ingested: 0, cursor: 94 });
    expect((await db.get(`SELECT COUNT(*) AS n FROM rfid_scan_events`)).n).toBe(0);
  });

  it('ingests new rows in id order, using Supabase’s insert time, and advances the cursor', async () => {
    const rows = [row(94)];
    const sb = fakeSupabase(rows);
    await pollSupabaseOnce(db, { fetchImpl: sb.fetchImpl, config });
    rows.push(row(96, '57:33:01:04', '2026-09-25T05:31:02.500000+00:00'), row(95, '79:43:01:04', '2026-09-25T05:24:07.123456+00:00'));
    const r = await pollSupabaseOnce(db, { fetchImpl: sb.fetchImpl, config });
    expect(r).toEqual({ ingested: 2, cursor: 96 });

    const events = await db.all(`SELECT source, source_ref, uid, received_at, effective_at, outcome FROM rfid_scan_events ORDER BY id`);
    expect(events.map((e: any) => e.source_ref)).toEqual(['95', '96']);
    // Microsecond timestamptz from Supabase, stored as a UTC ISO instant.
    expect(events[0]).toMatchObject({ source: 'supabase', uid: '79430104', received_at: '2026-09-25T05:24:07.123Z', effective_at: '2026-09-25T05:24:07.123Z' });
    expect(events[1].uid).toBe('57330104');
    const device = await db.get(`SELECT code FROM rfid_devices`);
    expect(device.code).toBe('ESP32');
    expect((await bridgeStatus(db)).lastRef).toBe(96);
  });

  it('catches up after an outage and never double-ingests a row', async () => {
    const rows = [row(10)];
    const sb = fakeSupabase(rows);
    await pollSupabaseOnce(db, { fetchImpl: sb.fetchImpl, config });
    for (let id = 11; id <= 20; id++) rows.push(row(id));
    await pollSupabaseOnce(db, { fetchImpl: sb.fetchImpl, config });
    // A cursor rewound by hand (or a crash between ingest and cursor update) is harmless.
    await db.run(`UPDATE rfid_bridge_state SET last_ref = 12`);
    const again = await pollSupabaseOnce(db, { fetchImpl: sb.fetchImpl, config });
    expect(again?.ingested).toBe(8);
    expect((await db.get(`SELECT COUNT(*) AS n FROM rfid_scan_events`)).n).toBe(10);
  });

  it('SUPABASE_BRIDGE_START=all imports history on the first run', async () => {
    vi.stubEnv('SUPABASE_BRIDGE_START', 'all');
    const sb = fakeSupabase([row(1), row(2)]);
    expect((await pollSupabaseOnce(db, { fetchImpl: sb.fetchImpl, config }))?.ingested).toBe(2);
  });

  it('records a refused key clearly instead of failing silently', async () => {
    const sb = fakeSupabase([], 401);
    await expect(pollSupabaseOnce(db, { fetchImpl: sb.fetchImpl, config })).rejects.toThrow(/anon key can no longer read scans/);
    expect((await bridgeStatus(db)).lastError).toMatch(/401/);
  });

  it('does nothing when Supabase is not configured', async () => {
    expect(await pollSupabaseOnce(db, { config: null })).toBeNull();
  });
});

describe('bridge live status', () => {
  let db: Database;
  beforeAll(async () => { db = await setupTestDb(); });
  afterEach(() => vi.unstubAllEnvs());

  it('is not live when Supabase is not configured, and says why', async () => {
    vi.stubEnv('SUPABASE_URL', '');
    const s = await bridgeStatus(db);
    expect(s.live).toBe(false);
    expect(s.reason).toMatch(/not connected/);
  });

  it('is live right after a successful poll, not live once polls stop or fail', async () => {
    vi.stubEnv('SUPABASE_URL', 'https://x.supabase.co');
    vi.stubEnv('SUPABASE_SERVICE_KEY', 'k');
    await db.run(`DELETE FROM rfid_bridge_state`);
    await db.run(`INSERT INTO rfid_bridge_state (source, last_ref, last_polled_at) VALUES ('supabase', 5, ?)`, new Date().toISOString());
    expect((await bridgeStatus(db)).live).toBe(true);

    // The last tap reports the card's status now, not when it was tapped.
    await db.run(`DELETE FROM rfid_scan_events`);
    await db.run(`DELETE FROM rfid_cards`);
    await db.run(`INSERT INTO rfid_cards (id, uid, status, created_at, updated_at) VALUES (9, 'AABBCCDD', 'active', 'x', 'x')`);
    await db.run(`INSERT INTO rfid_card_assignments (card_id, student_id, student_name, assigned_at, assigned_by) VALUES (9, 's1', 'Levi Gatimu', 'x', 'adm')`);
    await db.run(`INSERT INTO rfid_scan_events (source, uid_raw, uid, card_id, received_at, effective_at, outcome) VALUES ('supabase', 'x', 'AABBCCDD', 9, 'x', 'x', 'unknown_card')`);
    expect((await bridgeStatus(db)).lastScan).toMatchObject({ outcome: 'unknown_card', cardStatus: 'active', holderName: 'Levi Gatimu' });

    await db.run(`UPDATE rfid_bridge_state SET last_polled_at = ?`, new Date(Date.now() - 120_000).toISOString());
    const stale = await bridgeStatus(db);
    expect(stale.live).toBe(false);
    expect(stale.reason).toMatch(/last checked Supabase 120 s ago/);

    await db.run(`UPDATE rfid_bridge_state SET last_polled_at = ?, last_error = 'Supabase returned 401'`, new Date().toISOString());
    expect((await bridgeStatus(db)).reason).toMatch(/can’t read the scans/);
  });
});
