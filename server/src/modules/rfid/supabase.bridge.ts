import { Database } from 'sqlite';
import { ingestScan } from './ingest.service.js';

/**
 * Bridge from the existing hardware path (ESP32 → Supabase `public.rfid_scans`)
 * into Tendo's check-in engine. The firmware does not change.
 *
 * Upstream table, as found on 2026-09-25:
 *   rfid_scans(id bigint, uid text "79:43:01:04", device text "ESP32",
 *              scanned_at timestamptz, set by Supabase on insert)
 *
 * Polls by ascending id rather than subscribing to Realtime. A missed Realtime
 * message would lose a scan, but a cursor can't skip rows, and an outage on
 * either side is caught up on the next poll. `scanned_at` is Supabase's own
 * insert time, so it is used as the receive time; Tendo's poll delay never
 * shifts a student from present to late.
 *
 * Credentials (server env only, never VITE_):
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_KEY   preferred: keeps working once anon is made insert-only
 *   SUPABASE_ANON_KEY      fallback: works only while anon may SELECT rfid_scans
 */

const SOURCE = 'supabase';
const TABLE = process.env.SUPABASE_SCANS_TABLE || 'rfid_scans';
const PAGE = 500;

type FetchLike = (url: string, init: { headers: Record<string, string> }) => Promise<{
  ok: boolean; status: number; json(): Promise<any>; text(): Promise<string>;
}>;

export interface BridgeConfig {
  url: string;
  key: string;
  keyKind: 'service' | 'anon';
}

export function bridgeConfig(): BridgeConfig | null {
  const url = process.env.SUPABASE_URL?.trim().replace(/\/+$/, '');
  const service = process.env.SUPABASE_SERVICE_KEY?.trim();
  const anon = process.env.SUPABASE_ANON_KEY?.trim();
  if (!url || !(service || anon)) return null;
  return service ? { url, key: service, keyKind: 'service' } : { url, key: anon!, keyKind: 'anon' };
}

interface UpstreamRow { id: number; uid: string; device: string | null; scanned_at: string }

async function fetchRows(cfg: BridgeConfig, fetchImpl: FetchLike, query: string): Promise<UpstreamRow[]> {
  const resp = await fetchImpl(`${cfg.url}/rest/v1/${TABLE}?${query}`, {
    headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}`, Accept: 'application/json' },
  });
  if (!resp.ok) {
    const body = (await resp.text()).slice(0, 200);
    throw new Error(
      resp.status === 401 || resp.status === 403
        ? `Supabase refused to read ${TABLE} (${resp.status}). ${cfg.keyKind === 'anon' ? 'The anon key can no longer read scans; set SUPABASE_SERVICE_KEY.' : 'Check SUPABASE_SERVICE_KEY.'}`
        : `Supabase returned ${resp.status} for ${TABLE}: ${body}`
    );
  }
  const rows = await resp.json();
  return Array.isArray(rows) ? rows : [];
}

async function recordError(db: Database, message: string | null) {
  const now = new Date().toISOString();
  await db.run(
    `UPDATE rfid_bridge_state SET last_polled_at = ?, last_error = ?, last_error_at = CASE WHEN ? IS NULL THEN last_error_at ELSE ? END
      WHERE source = ?`,
    now, message, message, now, SOURCE
  );
}

/**
 * One poll: pull every row after the cursor (in pages) and ingest them in id
 * order. On the very first run the cursor starts at the newest existing row,
 * so the test scans already in the table are not replayed as attendance.
 * Set SUPABASE_BRIDGE_START=all to import history instead.
 *
 * Runs outside the work queue itself; each ingestScan call is queued.
 */
export async function pollSupabaseOnce(
  db: Database, opts: { fetchImpl?: FetchLike; config?: BridgeConfig | null } = {}
): Promise<{ ingested: number; cursor: number } | null> {
  const cfg = opts.config === undefined ? bridgeConfig() : opts.config;
  if (!cfg) return null;
  const fetchImpl = opts.fetchImpl ?? (fetch as unknown as FetchLike);

  try {
    let state = await db.get(`SELECT last_ref FROM rfid_bridge_state WHERE source = ?`, SOURCE);
    if (!state) {
      let start = 0;
      if (process.env.SUPABASE_BRIDGE_START !== 'all') {
        const newest = await fetchRows(cfg, fetchImpl, 'select=id&order=id.desc&limit=1');
        start = newest[0]?.id ?? 0;
      }
      await db.run(`INSERT OR IGNORE INTO rfid_bridge_state (source, last_ref) VALUES (?, ?)`, SOURCE, start);
      state = { last_ref: start };
      console.log(`RFID bridge: starting after Supabase ${TABLE} id ${start}.`);
    }

    let cursor = Number(state.last_ref);
    let ingested = 0;
    for (let guard = 0; guard < 100; guard++) {
      const rows = await fetchRows(cfg, fetchImpl, `select=id,uid,device,scanned_at&id=gt.${cursor}&order=id.asc&limit=${PAGE}`);
      for (const row of rows) {
        await ingestScan(db, {
          source: 'supabase',
          sourceRef: String(row.id),
          deviceCode: row.device || null,
          uid: String(row.uid ?? ''),
          receivedAt: row.scanned_at,
        });
        cursor = Number(row.id);
        await db.run(
          `UPDATE rfid_bridge_state SET last_ref = ?, last_row_at = ? WHERE source = ?`,
          cursor, row.scanned_at, SOURCE
        );
        ingested++;
      }
      if (rows.length < PAGE) break;
    }
    await recordError(db, null);
    return { ingested, cursor };
  } catch (err) {
    const message = (err as Error).message;
    await db.run(`INSERT OR IGNORE INTO rfid_bridge_state (source, last_ref) VALUES (?, 0)`, SOURCE).catch(() => {});
    await recordError(db, message.slice(0, 300)).catch(() => {});
    throw err;
  }
}

/** A poll this recent means the feed is running (polls are 1 s apart, retries at most 5 s). */
const LIVE_WITHIN_MS = 15_000;

/**
 * Is the ESP → Supabase → Tendo feed live right now, and why not if it isn't.
 * Decided on the server so a wrong browser clock can't make it look live.
 */
export async function bridgeStatus(db: Database) {
  const cfg = bridgeConfig();
  const state = await db.get(`SELECT * FROM rfid_bridge_state WHERE source = ?`, SOURCE);
  const lastScan = await db.get(
    `SELECT e.uid, e.card_id, e.outcome, e.student_name, e.class_name, e.effective_at, d.name AS device_name,
            c.status AS card_status,
            (SELECT a.student_name FROM rfid_card_assignments a WHERE a.card_id = e.card_id AND a.ended_at IS NULL) AS holder_name
       FROM rfid_scan_events e LEFT JOIN rfid_devices d ON d.id = e.device_id LEFT JOIN rfid_cards c ON c.id = e.card_id
      WHERE e.source = ? ORDER BY e.id DESC LIMIT 1`,
    SOURCE
  );
  const polledAgoMs = state?.last_polled_at ? Date.now() - Date.parse(state.last_polled_at) : null;
  let live = false;
  let reason: string | null = null;
  if (!cfg) reason = 'Supabase is not connected: SUPABASE_URL and a key are missing on the Tendo server.';
  else if (!state?.last_polled_at) reason = 'Tendo has not reached Supabase yet. It is still starting, or can’t connect.';
  else if (state.last_error) reason = `Tendo can’t read the scans from Supabase: ${state.last_error}`;
  else if (polledAgoMs! > LIVE_WITHIN_MS) reason = `Tendo last checked Supabase ${Math.round(polledAgoMs! / 1000)} s ago. The server may have stopped polling.`;
  else live = true;
  return {
    live,
    reason,
    secondsSinceCheck: polledAgoMs == null ? null : Math.round(polledAgoMs / 1000),
    lastScan: lastScan ? {
      uid: lastScan.uid, cardId: lastScan.card_id, outcome: lastScan.outcome,
      // The card as it is *now*: it may have been assigned since it was tapped.
      cardStatus: lastScan.card_status ?? null, holderName: lastScan.holder_name ?? null, studentName: lastScan.student_name,
      className: lastScan.class_name, at: lastScan.effective_at, deviceName: lastScan.device_name,
    } : null,
    configured: !!cfg,
    keyKind: cfg?.keyKind ?? null,
    table: TABLE,
    lastRef: state?.last_ref ?? null,
    lastPolledAt: state?.last_polled_at ?? null,
    lastRowAt: state?.last_row_at ?? null,
    lastError: state?.last_error ?? null,
    lastErrorAt: state?.last_error_at ?? null,
  };
}

/**
 * Poll once a second so a tap shows in Tendo within a second or two of the
 * card touching the reader. A poll is one small indexed query (about 0.25 s
 * round trip); an idle one returns `[]`. After a network blip it retries
 * quickly (at most 5 s apart) instead of backing off for minutes. Every row is
 * still caught after an outage, because the cursor never skips.
 */
const POLL_MS = Number(process.env.SUPABASE_POLL_MS || 1000);
const MAX_RETRY_MS = 5_000;

export function startSupabaseBridge(db: Database): () => void {
  const cfg = bridgeConfig();
  if (!cfg) {
    console.log('RFID bridge: SUPABASE_URL / key not set; not polling Supabase.');
    return () => {};
  }
  if (cfg.keyKind === 'anon') {
    console.warn('RFID bridge: using the anon key. This only works while anon can read scans, which also means anyone can. Set SUPABASE_SERVICE_KEY and lock anon to INSERT.');
  }
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let failures = 0;

  const loop = async () => {
    if (stopped) return;
    let delay = POLL_MS;
    try {
      const r = await pollSupabaseOnce(db, { config: cfg });
      if (r?.ingested) console.log(`RFID bridge: ingested ${r.ingested} scan(s), cursor ${r.cursor}.`);
      if (failures > 0) console.log('RFID bridge: reading Supabase again.');
      failures = 0;
    } catch (err) {
      failures++;
      if (failures === 1 || failures % 60 === 0) console.error('RFID bridge poll failed:', (err as Error).message);
      delay = Math.min(MAX_RETRY_MS, POLL_MS * 2 ** Math.min(failures, 3));
    }
    if (!stopped) timer = setTimeout(loop, delay);
  };
  void loop();
  return () => { stopped = true; if (timer) clearTimeout(timer); };
}
