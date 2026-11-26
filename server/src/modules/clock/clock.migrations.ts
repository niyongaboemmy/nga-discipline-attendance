import type { Database } from 'sqlite';

/**
 * Staff attendance clock tables (STAFF_ATTENDANCE_CLOCK_PLAN.md §6.4). Additive and
 * idempotent: every school's own file runs this on open.
 *
 *  - attendance_devices: the phone or tablet a person checks in with. The device id
 *    is the SHA-256 thumbprint of a non-extractable P-256 key that never leaves it.
 *  - attendance_zones:   the school's areas (circles, or polygons later).
 *  - attendance_events:  every attempt, refusals included (immutable log).
 *  - staff_attendance:   gains the where/how columns of the check-in and check-out.
 */
export async function migrateStaffClock(db: Database): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS attendance_devices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      user_name TEXT NOT NULL,
      google_sub TEXT NOT NULL,
      google_email TEXT NOT NULL,
      key_thumbprint TEXT NOT NULL,
      public_key_jwk TEXT NOT NULL,
      token_hash TEXT NOT NULL,
      install_uuid TEXT NOT NULL,
      nga_did TEXT,
      form_factor TEXT NOT NULL DEFAULT 'phone' CHECK(form_factor IN ('phone','tablet','desktop')),
      label TEXT,
      browser TEXT,
      os TEXT,
      model TEXT,
      user_agent TEXT,
      ip_first TEXT,
      ip_last TEXT,
      status TEXT NOT NULL CHECK(status IN ('pending','active','revoked','replaced','declined')),
      registered_at TEXT NOT NULL,
      approved_at TEXT,
      approved_by TEXT,
      last_used_at TEXT,
      revoked_at TEXT,
      revoked_by TEXT,
      revoke_reason TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS ux_clock_device_user_active ON attendance_devices(user_id) WHERE status = 'active';
    CREATE UNIQUE INDEX IF NOT EXISTS ux_clock_device_key_active ON attendance_devices(key_thumbprint) WHERE status IN ('active','pending');
    CREATE UNIQUE INDEX IF NOT EXISTS ux_clock_device_token ON attendance_devices(token_hash);
    CREATE INDEX IF NOT EXISTS ix_clock_device_install ON attendance_devices(install_uuid);
    CREATE INDEX IF NOT EXISTS ix_clock_device_status ON attendance_devices(status, registered_at);

    CREATE TABLE IF NOT EXISTS attendance_zones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'circle' CHECK(kind IN ('circle','polygon')),
      center_lat REAL,
      center_lng REAL,
      radius_m INTEGER,
      polygon_geojson TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      updated_by TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS attendance_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      occurred_at TEXT NOT NULL,
      school_date TEXT NOT NULL,
      user_id TEXT,
      device_id INTEGER,
      kind TEXT NOT NULL,
      reason TEXT,
      lat REAL,
      lng REAL,
      accuracy_m REAL,
      distance_m REAL,
      ip TEXT,
      user_agent TEXT,
      client_time TEXT,
      flags TEXT
    );
    CREATE INDEX IF NOT EXISTS ix_clock_events_date ON attendance_events(school_date, kind);
    CREATE INDEX IF NOT EXISTS ix_clock_events_user ON attendance_events(user_id, occurred_at);

    /* Printed QR cards for staff without a smartphone (code hash only). */
    CREATE TABLE IF NOT EXISTS staff_clock_cards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      user_name TEXT NOT NULL,
      code_hash TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK(status IN ('active','revoked')),
      issued_by TEXT,
      issued_at TEXT NOT NULL,
      revoked_at TEXT,
      revoked_by TEXT,
      last_used_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS ux_clock_card_user_active ON staff_clock_cards(user_id) WHERE status = 'active';

    /* Reminders (reminders.ts): the phone's Web Push subscription, and what was already sent. */
    CREATE TABLE IF NOT EXISTS staff_clock_push (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      device_id INTEGER NOT NULL,
      endpoint TEXT NOT NULL UNIQUE,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      lang TEXT NOT NULL DEFAULT 'en',
      created_at TEXT NOT NULL,
      last_ok_at TEXT
    );
    CREATE INDEX IF NOT EXISTS ix_clock_push_device ON staff_clock_push(device_id);
    CREATE TABLE IF NOT EXISTS staff_clock_reminders (
      user_id TEXT NOT NULL,
      date TEXT NOT NULL,
      kind TEXT NOT NULL,
      sent_at TEXT NOT NULL,
      PRIMARY KEY (user_id, date, kind)
    );

    /* A person's own working week (workPlan.ts): dated versions, days NULL = the school's rules. */
    CREATE TABLE IF NOT EXISTS staff_work_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      effective_from TEXT NOT NULL,
      days TEXT,
      note TEXT,
      updated_by TEXT,
      updated_by_name TEXT,
      updated_at TEXT NOT NULL,
      UNIQUE(user_id, effective_from)
    );
  `);

  const cols = new Set((await db.all(`PRAGMA table_info(staff_attendance)`)).map((c: any) => c.name));
  const add: Array<[string, string]> = [
    ['source', `TEXT NOT NULL DEFAULT 'web'`],
    ['in_device_id', 'INTEGER'],
    ['in_lat', 'REAL'],
    ['in_lng', 'REAL'],
    ['in_accuracy_m', 'REAL'],
    ['in_distance_m', 'REAL'],
    ['in_zone_id', 'INTEGER'],
    ['in_ip', 'TEXT'],
    ['out_device_id', 'INTEGER'],
    ['out_lat', 'REAL'],
    ['out_lng', 'REAL'],
    ['out_accuracy_m', 'REAL'],
    ['out_distance_m', 'REAL'],
    ['out_zone_id', 'INTEGER'],
    ['out_ip', 'TEXT'],
    ['out_status', 'TEXT'],
    ['flags', 'TEXT'],
    ['review_state', 'TEXT'],
    ['review_note', 'TEXT'],
    ['reviewed_by', 'TEXT'],
    ['reviewed_at', 'TEXT'],
    ['client_skew_ms', 'INTEGER'],
    ['in_by', 'TEXT'],
    ['out_by', 'TEXT'],
    /* a forgotten check-out: the time the person says they left (HH:MM), for the office to confirm */
    ['out_claim', 'TEXT'],
    ['out_claim_at', 'TEXT'],
  ];
  for (const [name, type] of add) {
    if (!cols.has(name)) await db.run(`ALTER TABLE staff_attendance ADD COLUMN ${name} ${type}`);
  }
  await db.run(`CREATE INDEX IF NOT EXISTS idx_staff_attendance_date ON staff_attendance(date)`);
}
