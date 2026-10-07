import type { Database } from 'sqlite';
import { config } from '../../config.js';
import { getDb } from '../../database.js';
import { basicAuthHeader } from '../../access/misService.js';
import { fetchWithTimeout } from '../../access/snapshot.js';
import { addDays, schoolDateString, schoolMinutesOfDay } from '../../shared/schoolTime.js';

/**
 * Early-warning signals -> NGA MIS.
 *
 * Once a day Tendo sends MIS a few per-student counts, and MIS combines them
 * with other sources into its early-warning view:
 *
 *   PUT {NGA_MIS_BASE_URL}/early-warning/signals
 *   Authorization: Basic base64(SSO_CLIENT_ID:SSO_CLIENT_SECRET)
 *   { as_of, students: [{ student_id, metrics: { ... } }] }   (<= 1000 per call)
 *
 * Windows are school-calendar (Africa/Kigali) days counting back from
 * *yesterday* inclusive, so a register still being taken today never shows
 * up half-done:
 *   - 14d       = [as_of - 14, as_of - 1]
 *   - prev 14d  = [as_of - 28, as_of - 15]
 *   - 30d       = [as_of - 30, as_of - 1]
 *
 * Metrics:
 *   - absences_14d / absences_prev_14d: subject (lesson) registers with
 *     status 'absent', plus homeroom 'absent' rows on days the student has
 *     no subject 'absent' (no double count for a day missed entirely). An
 *     approved excuse flips the row to 'excused' (routes/attendance.ts
 *     reconcile), so 'absent' is already "unexcused".
 *   - lates_14d: homeroom and subject registers with status 'late'.
 *   - incidents_30d: demerit discipline_records by incident_date, not
 *     dismissed, not soft-deleted (same filter as the conduct ledger).
 *   - discipline_points_30d: SUM(points) of those demerits (points is a
 *     positive magnitude; merits are not counted).
 *
 * Every student Tendo knows about is sent, zeros included, so MIS can tell
 * "no concerns" from "no data".
 */

export const EARLY_WARNING_BATCH_SIZE = 1000;
/** School-local minutes-of-day of the daily send (18:30). */
export const DAILY_SEND_MINUTES = 18 * 60 + 30;
const STARTUP_DELAY_MS = 2 * 60 * 1000;
const STARTUP_STALE_MS = 20 * 60 * 60 * 1000;
const TICK_MS = 5 * 60 * 1000;
const RETRY_BACKOFF_MS = 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 30_000;

const STATE_LAST_SUCCESS = 'early_warning.last_success_at';
const STATE_LAST_RESULT = 'early_warning.last_result';

export interface EarlyWarningMetrics {
  absences_14d: number;
  absences_prev_14d: number;
  lates_14d: number;
  incidents_30d: number;
  discipline_points_30d: number | null;
}

export interface EarlyWarningStudent {
  student_id: number;
  metrics: EarlyWarningMetrics;
}

export interface EarlyWarningWindows {
  asOf: string;
  yesterday: string;
  cur14From: string;
  prev14From: string;
  prev14To: string;
  d30From: string;
}

export function windowsFor(asOf: string): EarlyWarningWindows {
  return {
    asOf,
    yesterday: addDays(asOf, -1),
    cur14From: addDays(asOf, -14),
    prev14From: addDays(asOf, -28),
    prev14To: addDays(asOf, -15),
    d30From: addDays(asOf, -30),
  };
}

/** Per-student metrics as of `asOf` (YYYY-MM-DD, school-local "today"). */
export async function computeEarlyWarningMetrics(db: Database, asOf: string): Promise<EarlyWarningStudent[]> {
  const w = windowsFor(asOf);
  const earliest = w.prev14From < w.d30From ? w.prev14From : w.d30From;

  // Population: active student accounts, plus anyone with a register or a
  // conduct record in the windows (students who have never signed in to
  // Tendo still have registers). Inactive accounts are left out.
  const population = await db.all<{ student_id: string }[]>(
    `SELECT CAST(id AS TEXT) AS student_id FROM users
      WHERE status = 'active'
        AND (role = 'student' OR role_id IN (SELECT id FROM roles WHERE level = 'STUDENT'))
     UNION
     SELECT CAST(student_id AS TEXT) FROM attendance_records
      WHERE date(session_date) BETWEEN ? AND ?
     UNION
     SELECT CAST(student_id AS TEXT) FROM discipline_records
      WHERE deleted_at IS NULL AND date(incident_date) BETWEEN ? AND ?`,
    earliest, w.yesterday, earliest, w.yesterday
  );
  const inactive = new Set(
    (await db.all<{ id: string }[]>(`SELECT CAST(id AS TEXT) AS id FROM users WHERE status = 'inactive'`)).map((r) => r.id)
  );

  // A row counts as an absence when it is a lesson (subject) 'absent', or a
  // homeroom 'absent' on a day the student has no lesson 'absent' -- so a day
  // missed entirely isn't counted twice, but a day only recorded at homeroom
  // still counts. Lates count from both register types (most lateness is
  // recorded at homeroom).
  const attendance = await db.all<any[]>(
    `SELECT CAST(student_id AS TEXT) AS student_id,
            SUM(CASE WHEN counted_absent = 1 AND d BETWEEN ? AND ? THEN 1 ELSE 0 END) AS absences_14d,
            SUM(CASE WHEN counted_absent = 1 AND d BETWEEN ? AND ? THEN 1 ELSE 0 END) AS absences_prev_14d,
            SUM(CASE WHEN status = 'late'    AND d BETWEEN ? AND ? THEN 1 ELSE 0 END) AS lates_14d
       FROM (SELECT a.student_id, a.status, date(a.session_date) AS d,
                    CASE
                      WHEN a.status != 'absent' THEN 0
                      WHEN a.session_type = 'subject' THEN 1
                      WHEN NOT EXISTS (
                        SELECT 1 FROM attendance_records s
                         WHERE s.student_id = a.student_id AND s.session_type = 'subject'
                           AND s.status = 'absent' AND date(s.session_date) = date(a.session_date)
                      ) THEN 1
                      ELSE 0
                    END AS counted_absent
               FROM attendance_records a
              WHERE date(a.session_date) BETWEEN ? AND ?)
      GROUP BY student_id`,
    w.cur14From, w.yesterday, w.prev14From, w.prev14To, w.cur14From, w.yesterday, w.prev14From, w.yesterday
  );
  const discipline = await db.all<any[]>(
    `SELECT CAST(student_id AS TEXT) AS student_id, COUNT(*) AS incidents_30d, COALESCE(SUM(points), 0) AS points_30d
       FROM discipline_records
      WHERE type = 'demerit' AND status != 'dismissed' AND deleted_at IS NULL
        AND date(incident_date) BETWEEN ? AND ?
      GROUP BY student_id`,
    w.d30From, w.yesterday
  );

  const att = new Map(attendance.map((r) => [r.student_id, r]));
  const disc = new Map(discipline.map((r) => [r.student_id, r]));
  const out: EarlyWarningStudent[] = [];
  const seen = new Set<number>();
  for (const { student_id } of population) {
    const id = Number(student_id);
    // Student ids are MIS user ids; anything else can't be matched by MIS.
    if (!/^\d+$/.test(student_id) || !Number.isSafeInteger(id) || id <= 0) continue;
    if (inactive.has(student_id) || seen.has(id)) continue;
    seen.add(id);
    const a = att.get(student_id);
    const d = disc.get(student_id);
    out.push({
      student_id: id,
      metrics: {
        absences_14d: Number(a?.absences_14d ?? 0),
        absences_prev_14d: Number(a?.absences_prev_14d ?? 0),
        lates_14d: Number(a?.lates_14d ?? 0),
        incidents_30d: Number(d?.incidents_30d ?? 0),
        discipline_points_30d: Number(d?.points_30d ?? 0),
      },
    });
  }
  out.sort((x, y) => x.student_id - y.student_id);
  return out;
}

export interface EarlyWarningEnv {
  misBaseUrl?: string;
  clientId?: string;
  clientSecret?: string;
  /** EARLY_WARNING_PUSH; '0' disables. */
  pushFlag?: string;
}

const PLACEHOLDERS = new Set(['', 'placeholder_client_id', 'placeholder_client_secret']);

function currentEnv(): EarlyWarningEnv {
  return {
    misBaseUrl: config.ngaMisBaseUrl,
    clientId: config.ssoClientId,
    clientSecret: config.ssoClientSecret,
    pushFlag: process.env.EARLY_WARNING_PUSH,
  };
}

/** Null when sending is enabled, else the reason it is not. */
export function disabledReason(env: EarlyWarningEnv = currentEnv()): string | null {
  if ((env.pushFlag ?? '').trim() === '0') return 'EARLY_WARNING_PUSH=0';
  if (!/^https?:\/\//.test(env.misBaseUrl || '')) return 'NGA_MIS_BASE_URL not set';
  if (!env.clientId || PLACEHOLDERS.has(env.clientId)) return 'SSO_CLIENT_ID not set';
  if (!env.clientSecret || PLACEHOLDERS.has(env.clientSecret)) return 'SSO_CLIENT_SECRET not set';
  return null;
}

export interface SendResult {
  asOf: string;
  students: number;
  batches: number;
  saved: number;
  skipped: number;
}

/** Compute and PUT the signals in batches. Throws on the first failed batch. */
export async function sendEarlyWarningSignals(
  db: Database,
  opts: { asOf?: string; env?: EarlyWarningEnv } = {}
): Promise<SendResult> {
  const env = opts.env ?? currentEnv();
  const reason = disabledReason(env);
  if (reason) throw new Error(`early-warning push disabled: ${reason}`);

  const asOf = opts.asOf ?? schoolDateString();
  const students = await computeEarlyWarningMetrics(db, asOf);
  const url = `${(env.misBaseUrl as string).replace(/\/+$/, '')}/early-warning/signals`;
  const headers = {
    Authorization: basicAuthHeader(env.clientId, env.clientSecret),
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };

  const result: SendResult = { asOf, students: students.length, batches: 0, saved: 0, skipped: 0 };
  for (let i = 0; i < students.length; i += EARLY_WARNING_BATCH_SIZE) {
    const batch = students.slice(i, i + EARLY_WARNING_BATCH_SIZE);
    const resp = await fetchWithTimeout(
      url,
      { method: 'PUT', headers, body: JSON.stringify({ as_of: asOf, students: batch }) },
      REQUEST_TIMEOUT_MS
    );
    let body: any = null;
    try { body = await resp.json(); } catch { /* non-JSON */ }
    if (!resp.ok || body?.success === false) {
      // Status only: MIS error bodies could echo student data.
      throw new Error(`MIS PUT /early-warning/signals answered ${resp.status} (batch ${result.batches + 1})`);
    }
    result.batches += 1;
    result.saved += Number(body?.data?.saved ?? 0) || 0;
    result.skipped += Number(body?.data?.skipped ?? 0) || 0;
  }
  return result;
}

// ---------------------------------------------------------------- state ----

export async function getState(db: Database, key: string): Promise<string | null> {
  const row = await db.get<{ value: string }>(`SELECT value FROM app_state WHERE key = ?`, key);
  return row?.value ?? null;
}

export async function setState(db: Database, key: string, value: string): Promise<void> {
  await db.run(
    `INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
    key, value
  );
}

export async function lastSuccessAt(db: Database): Promise<Date | null> {
  const v = await getState(db, STATE_LAST_SUCCESS);
  const t = v ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? new Date(t) : null;
}

/** True once today's 18:30 (school time) has passed and no success since. */
export function dailyRunDue(now: Date, last: Date | null): boolean {
  if (schoolMinutesOfDay(now) < DAILY_SEND_MINUTES) return false;
  if (!last) return true;
  const today = schoolDateString(now);
  const lastDay = schoolDateString(last);
  if (lastDay < today) return true;
  return lastDay === today && schoolMinutesOfDay(last) < DAILY_SEND_MINUTES;
}

export function startupRunDue(now: Date, last: Date | null): boolean {
  return !last || now.getTime() - last.getTime() > STARTUP_STALE_MS;
}

let running = false;
let lastFailureAt = 0;

/** One guarded run: never throws, logs a one-line summary (counts only). */
export async function runEarlyWarningPush(trigger: string, db: Database = getDb()): Promise<SendResult | null> {
  if (running) return null;
  running = true;
  try {
    const result = await sendEarlyWarningSignals(db);
    await setState(db, STATE_LAST_SUCCESS, new Date().toISOString());
    await setState(db, STATE_LAST_RESULT, JSON.stringify(result));
    console.log(
      `[early-warning] ${trigger}: as_of ${result.asOf}, ${result.students} student(s) in ${result.batches} batch(es); ` +
      `MIS saved ${result.saved}, skipped ${result.skipped}`
    );
    return result;
  } catch (err: any) {
    lastFailureAt = Date.now();
    console.error(`[early-warning] ${trigger} failed (will retry): ${err?.message ?? err}`);
    return null;
  } finally {
    running = false;
  }
}

let timers: NodeJS.Timeout[] = [];

/**
 * Daily at 18:30 Africa/Kigali (checked every 5 minutes, so a restart or a
 * failure later in the evening still catches up; failures back off an hour),
 * plus once 2 minutes after boot when the last success is over 20 hours old.
 * No-op when not configured or EARLY_WARNING_PUSH=0.
 */
export function startEarlyWarningScheduler(): void {
  const reason = disabledReason();
  if (reason) {
    console.log(`[early-warning] daily push disabled (${reason})`);
    return;
  }
  stopEarlyWarningScheduler();

  const check = async (startup: boolean) => {
    try {
      const db = getDb();
      const last = await lastSuccessAt(db);
      const now = new Date();
      if (startup ? startupRunDue(now, last) : dailyRunDue(now, last)) {
        if (!startup && Date.now() - lastFailureAt < RETRY_BACKOFF_MS) return;
        await runEarlyWarningPush(startup ? 'startup' : 'daily', db);
      }
    } catch (err: any) {
      console.error(`[early-warning] scheduler check failed: ${err?.message ?? err}`);
    }
  };

  const startupTimer = setTimeout(() => void check(true), STARTUP_DELAY_MS);
  const tick = setInterval(() => void check(false), TICK_MS);
  startupTimer.unref?.();
  tick.unref?.();
  timers = [startupTimer, tick];
}

export function stopEarlyWarningScheduler(): void {
  for (const t of timers) clearTimeout(t);
  timers = [];
}

export function __resetEarlyWarningState(): void {
  running = false;
  lastFailureAt = 0;
}
