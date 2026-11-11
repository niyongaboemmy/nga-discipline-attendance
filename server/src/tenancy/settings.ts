import type { Database } from 'sqlite';
import { PRIMARY_TENANT_ID, currentTenantOrNull, effectiveTid, type TenantCtx } from './index.js';

/**
 * Per-school settings (TD-6): what used to be process-wide env is a
 * `school_settings` key/value table inside each tenant's own file.
 *
 * Resolution for a key, for the tenant code is running for:
 *   1. the tenant's `school_settings` row;
 *   2. tenant 1 only: the env variable of the same name (so NGA's existing
 *      deploy keeps behaving exactly as before -- env stays its default);
 *   3. the built-in default.
 * The timezone is special: the tenant context's own `timezone` (from the MIS
 * control plane) comes first, then the rules above.
 *
 * Reads are synchronous (the values are cached per tenant when the file is
 * opened, see database.ts), so the many call sites that used module
 * constants stay synchronous.
 */

export const SCHOOL_SETTING_DEFAULTS = {
  SCHOOL_TIMEZONE: 'Africa/Kigali',
  /** 0=Sun .. 6=Sat, comma separated. */
  SCHOOL_DAYS: '1,2,3,4,5',
  HOMEROOM_PERIOD: 'Morning',
  HOMEROOM_START_TIME: '08:00',
  ATTENDANCE_WARN_THRESHOLD: '80',
  ATTENDANCE_MIN_SESSIONS: '3',
  STAFF_LATE_CUTOFF_MINUTES: String(8 * 60 + 30),
  RFID_GRACE_MINUTES: '3',
  RFID_BREAK_MIN_GAP_MINUTES: '10',
  RFID_DEBOUNCE_SECONDS: '10',
} as const;

export type SchoolSettingKey = keyof typeof SCHOOL_SETTING_DEFAULTS;
export const SCHOOL_SETTING_KEYS = Object.keys(SCHOOL_SETTING_DEFAULTS) as SchoolSettingKey[];

const cache = new Map<number, Map<string, string>>();

export async function migrateSchoolSettings(db: Database): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS school_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

/** (Re)load a tenant's settings into the cache. */
export async function loadSchoolSettings(tid: number, db: Database): Promise<void> {
  const rows = await db.all<{ key: string; value: string }[]>(`SELECT key, value FROM school_settings`);
  cache.set(tid, new Map(rows.map((r) => [r.key, r.value])));
}

/** Write one setting for a tenant (and refresh the cache). */
export async function setSchoolSetting(db: Database, tid: number, key: SchoolSettingKey, value: string): Promise<void> {
  await db.run(
    `INSERT INTO school_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
    key, value
  );
  if (!cache.has(tid)) cache.set(tid, new Map());
  cache.get(tid)!.set(key, value);
}

/**
 * Seed a new tenant's defaults (provisioning). Never overwrites a value the
 * school already has, so re-provisioning is harmless. The timezone comes from
 * the tenant profile.
 */
export async function seedSchoolSettings(db: Database, tenant: Pick<TenantCtx, 'tid' | 'timezone'>): Promise<void> {
  for (const key of SCHOOL_SETTING_KEYS) {
    const value = key === 'SCHOOL_TIMEZONE' && tenant.timezone ? tenant.timezone : SCHOOL_SETTING_DEFAULTS[key];
    await db.run(`INSERT OR IGNORE INTO school_settings (key, value) VALUES (?, ?)`, key, value);
  }
  await loadSchoolSettings(tenant.tid, db);
}

/** Raw string value of a setting for the effective tenant. */
export function schoolSetting(key: SchoolSettingKey, tid: number = effectiveTid('school setting')): string {
  const stored = cache.get(tid)?.get(key);
  if (stored !== undefined && stored !== '') return stored;
  if (tid === PRIMARY_TENANT_ID) {
    const env = process.env[key];
    if (env !== undefined && env !== '') return env;
  }
  return SCHOOL_SETTING_DEFAULTS[key];
}

function numberSetting(key: SchoolSettingKey): number {
  const n = Number(schoolSetting(key));
  return Number.isFinite(n) ? n : Number(SCHOOL_SETTING_DEFAULTS[key]);
}

/** IANA zone: tenant context timezone, then the setting, then env (tenant 1), then Africa/Kigali. */
export function schoolTimezone(): string {
  const ctx = currentTenantOrNull();
  if (ctx?.timezone) return ctx.timezone;
  return schoolSetting('SCHOOL_TIMEZONE');
}

export const schoolDays = (): Set<number> =>
  new Set(schoolSetting('SCHOOL_DAYS').split(',').map((d) => Number(d.trim())).filter(Number.isInteger));
export const homeroomPeriod = () => schoolSetting('HOMEROOM_PERIOD');
export const homeroomStartTime = () => schoolSetting('HOMEROOM_START_TIME');
export const attendanceWarnThreshold = () => numberSetting('ATTENDANCE_WARN_THRESHOLD');
export const attendanceMinSessions = () => numberSetting('ATTENDANCE_MIN_SESSIONS');
export const staffLateCutoffMinutes = () => numberSetting('STAFF_LATE_CUTOFF_MINUTES');
export const rfidGraceMinutes = () => numberSetting('RFID_GRACE_MINUTES');
export const rfidBreakMinGapMs = () => numberSetting('RFID_BREAK_MIN_GAP_MINUTES') * 60_000;
export const rfidDebounceSeconds = () => numberSetting('RFID_DEBOUNCE_SECONDS');

/** Test hook. */
export function __resetSchoolSettingsCache(): void {
  cache.clear();
}
