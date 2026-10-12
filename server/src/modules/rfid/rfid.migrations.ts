import { Database } from 'sqlite';

/**
 * RFID check-in schema. Additive only — new tables plus nullable columns on
 * attendance_records / attendance_record_history — so it is safe on every boot.
 *
 * Instants written by this module are UTC ISO-8601 strings with a `Z`
 * (`new Date().toISOString()`), not SQLite's `CURRENT_TIMESTAMP`, because scan
 * ordering and the late cut-off are compared to the second.
 *
 * Layering, from raw to meaningful:
 *   rfid_scan_events      every tap the hardware reported, never deleted
 *   timetable_slots       each class's weekly timetable, cached from the MIS
 *   attendance_records    one result per student per register (existing table),
 *                         written for the morning register and every lesson
 */
export async function migrateRfidAttendance(db: Database) {
  await db.exec(`
    /* Local, read-only cache of the MIS roster. The server resolves a scan with
       no signed-in user, so it cannot use the per-user MIS proxy that the rest of
       the app relies on. Filled by modules/rfid/roster.service.ts. */
    CREATE TABLE IF NOT EXISTS roster_students (
      student_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      mis_status TEXT,
      synced_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS roster_class_groups (
      class_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      grade_id INTEGER,
      synced_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS roster_enrolments (
      student_id TEXT NOT NULL,
      class_id TEXT NOT NULL,
      academic_year_id INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('ACTIVE','DISABLED')),
      assigned_at TEXT,
      synced_at TEXT NOT NULL,
      PRIMARY KEY (student_id, class_id, academic_year_id)
    );
    CREATE INDEX IF NOT EXISTS idx_roster_enrol_class ON roster_enrolments(class_id, academic_year_id, status);

    CREATE TABLE IF NOT EXISTS roster_sync_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      students INTEGER NOT NULL DEFAULT 0,
      enrolments INTEGER NOT NULL DEFAULT 0,
      slots INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      triggered_by TEXT
    );

    /* A physical reader. Registered automatically the first time its code is
       seen so the existing firmware keeps working; an admin names/disables it. */
    CREATE TABLE IF NOT EXISTS rfid_devices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE NOT NULL,
      name TEXT,
      location TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),
      last_seen_at TEXT,
      last_clock_skew_ms INTEGER,
      created_at TEXT NOT NULL
    );

    /* A card is identified only by its UID (normalised uppercase hex). Cards are
       never deleted: scan history points at them. 'active' <=> an open
       assignment exists (maintained by cards.service.ts). */
    CREATE TABLE IF NOT EXISTS rfid_cards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      uid TEXT UNIQUE NOT NULL,
      label TEXT,
      status TEXT NOT NULL DEFAULT 'unassigned'
        CHECK(status IN ('unassigned','active','disabled','lost','retired')),
      status_reason TEXT,
      first_seen_at TEXT,
      last_seen_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    /* Who held a card, and when. Closing an assignment sets ended_at; rows are
       never deleted, so any past scan can still be traced to its holder. */
    CREATE TABLE IF NOT EXISTS rfid_card_assignments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      card_id INTEGER NOT NULL REFERENCES rfid_cards(id),
      student_id TEXT NOT NULL,
      student_name TEXT NOT NULL,
      assigned_at TEXT NOT NULL,
      assigned_by TEXT NOT NULL,
      assigned_by_name TEXT,
      ended_at TEXT,
      ended_by TEXT,
      end_reason TEXT
    );
    -- One holder per card, and one active card per student.
    CREATE UNIQUE INDEX IF NOT EXISTS uq_rfid_assignment_card_open
      ON rfid_card_assignments(card_id) WHERE ended_at IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS uq_rfid_assignment_student_open
      ON rfid_card_assignments(student_id) WHERE ended_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_rfid_assignment_student ON rfid_card_assignments(student_id);

    /* Each class's weekly timetable, cached from the MIS calendar
       (/integrations/sync/academics calendarSlots). Card taps are judged against
       the taps' student's own class timetable for that day. */
    CREATE TABLE IF NOT EXISTS timetable_slots (
      slot_id INTEGER PRIMARY KEY,
      class_id TEXT NOT NULL,
      subject_id INTEGER NOT NULL,
      day_of_week INTEGER NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      academic_term_id INTEGER,
      is_active INTEGER NOT NULL DEFAULT 1,
      synced_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_timetable_class_day ON timetable_slots(class_id, day_of_week, is_active);

    /* Days the school is closed (public holidays, closures). No lesson is closed
       as absent on these days, whatever the timetable says. */
    CREATE TABLE IF NOT EXISTS rfid_days_off (
      session_date TEXT PRIMARY KEY,
      reason TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    /* Registers already closed (absences filled in) per class and day, so the
       30-second tick never re-scans a lesson it has finished with. */
    CREATE TABLE IF NOT EXISTS rfid_closed_registers (
      class_id TEXT NOT NULL,
      session_date TEXT NOT NULL,
      register_key TEXT NOT NULL,
      closed_at TEXT NOT NULL,
      absent INTEGER NOT NULL DEFAULT 0,
      excused INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (class_id, session_date, register_key)
    );

    /* Where each upstream scan source has read up to, so a restart or an
       outage resumes from the last row instead of skipping or re-reading. */
    CREATE TABLE IF NOT EXISTS rfid_bridge_state (
      source TEXT PRIMARY KEY,
      last_ref INTEGER NOT NULL,
      last_polled_at TEXT,
      last_row_at TEXT,
      last_error TEXT,
      last_error_at TEXT
    );

    /* Every tap, append-only. 'outcome' records what the engine decided, which
       is what the live feed, the unknown-card queue and hardware feedback read. */
    CREATE TABLE IF NOT EXISTS rfid_scan_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      source_ref TEXT,
      device_id INTEGER REFERENCES rfid_devices(id),
      uid_raw TEXT NOT NULL,
      uid TEXT,
      card_id INTEGER REFERENCES rfid_cards(id),
      device_ts TEXT,
      received_at TEXT NOT NULL,
      effective_at TEXT NOT NULL,
      time_source TEXT NOT NULL DEFAULT 'received',
      student_id TEXT,
      student_name TEXT,
      class_id TEXT,
      class_name TEXT,
      outcome TEXT NOT NULL DEFAULT 'pending',
      detail TEXT,
      attendance_record_id INTEGER,
      processed_at TEXT,
      recorded_by TEXT
    );
    -- Replaying the same upstream row (Supabase retry, catch-up poll) is a no-op.
    CREATE UNIQUE INDEX IF NOT EXISTS uq_rfid_scan_source
      ON rfid_scan_events(source, source_ref) WHERE source_ref IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_rfid_scan_card_time ON rfid_scan_events(card_id, effective_at);
    CREATE INDEX IF NOT EXISTS idx_rfid_scan_uid_time ON rfid_scan_events(uid, effective_at);
    CREATE INDEX IF NOT EXISTS idx_rfid_scan_outcome_time ON rfid_scan_events(outcome, effective_at);
    CREATE INDEX IF NOT EXISTS idx_rfid_scan_time ON rfid_scan_events(effective_at);
  `);

  // Provenance on the existing register rows. 'manual' is what every existing
  // row is. auto_status keeps the engine's verdict after a teacher override.
  const recCols = await db.all(`PRAGMA table_info(attendance_records)`);
  const hasRec = (n: string) => recCols.some((c: any) => c.name === n);
  if (!hasRec('source')) {
    await db.run(`ALTER TABLE attendance_records ADD COLUMN source TEXT NOT NULL DEFAULT 'manual' CHECK(source IN ('manual','rfid','system'))`);
  }
  if (!hasRec('first_scan_at')) await db.run(`ALTER TABLE attendance_records ADD COLUMN first_scan_at TEXT`);
  if (!hasRec('scan_event_id')) await db.run(`ALTER TABLE attendance_records ADD COLUMN scan_event_id INTEGER`);
  if (!hasRec('auto_status')) await db.run(`ALTER TABLE attendance_records ADD COLUMN auto_status TEXT`);

  const histCols = await db.all(`PRAGMA table_info(attendance_record_history)`);
  const hasHist = (n: string) => histCols.some((c: any) => c.name === n);
  if (!hasHist('reason')) await db.run(`ALTER TABLE attendance_record_history ADD COLUMN reason TEXT`);
  if (!hasHist('change_source')) await db.run(`ALTER TABLE attendance_record_history ADD COLUMN change_source TEXT`);
}
