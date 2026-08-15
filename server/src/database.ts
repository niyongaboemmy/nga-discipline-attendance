import sqlite3 from 'sqlite3';
import { open, Database } from 'sqlite';
import { config } from './config.js';

let db: Database;

export async function initDatabase() {
  db = await open({
    filename: config.databasePath,
    driver: sqlite3.Database,
  });

  // Enable foreign keys
  await db.run('PRAGMA foreign_keys = ON');

  // Migrate Tables
  await db.exec(`
    CREATE TABLE IF NOT EXISTS attendance_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id TEXT NOT NULL,
      student_name TEXT NOT NULL,
      class_id TEXT NOT NULL,
      class_name TEXT NOT NULL,
      session_date DATE NOT NULL,
      period TEXT,
      status TEXT NOT NULL CHECK(status IN ('present','absent','late','excused')),
      notes TEXT,
      marked_by TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(student_id, class_id, session_date, period)
    );

    CREATE TABLE IF NOT EXISTS staff_attendance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      staff_id TEXT NOT NULL,
      staff_name TEXT NOT NULL,
      date DATE NOT NULL,
      clock_in DATETIME,
      clock_out DATETIME,
      status TEXT NOT NULL CHECK(status IN ('present','absent','late')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(staff_id, date)
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('low_attendance','reminder','system')),
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      read INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS excuse_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id TEXT NOT NULL,
      student_name TEXT NOT NULL,
      class_name TEXT NOT NULL,
      session_date DATE NOT NULL,
      reason TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    /* Canonical identity + role store. Roles are owned by this backend so that
       administrators can (re)assign them; 'unassigned' is a first-class state. */
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT,
      role TEXT NOT NULL DEFAULT 'unassigned' CHECK(role IN ('student','teacher','admin','unassigned')),
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','inactive')),
      source TEXT NOT NULL DEFAULT 'mis',
      last_login DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    /* Discipline & conduct records. A single table holds both negative incidents
       ('demerit') and positive recognition ('merit'). 'points' is always a positive
       magnitude derived server-side from type+severity (never trusted from clients);
       the sign is applied when computing a student's conduct score. Demerits carry a
       review workflow (status) and an optional sanction. The 'severity' tier values
       differ by type (minor|moderate|major for demerits, small|notable|outstanding
       for merits) so they are validated in application code rather than via CHECK. */
    CREATE TABLE IF NOT EXISTS discipline_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id TEXT NOT NULL,
      student_name TEXT NOT NULL,
      class_name TEXT,
      type TEXT NOT NULL CHECK(type IN ('demerit','merit')),
      category TEXT NOT NULL,
      severity TEXT,
      points INTEGER NOT NULL DEFAULT 0,
      title TEXT NOT NULL,
      description TEXT,
      incident_date DATE NOT NULL,
      location TEXT,
      sanction TEXT NOT NULL DEFAULT 'none',
      status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','under_review','resolved','dismissed')),
      logged_by TEXT NOT NULL,
      logged_by_name TEXT,
      resolution_note TEXT,
      resolved_by TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    /* Append-only audit trail for sensitive actions (role assignment, conduct
       decisions, excuse reviews). 'details' is a JSON snapshot of the change. */
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor_id TEXT NOT NULL,
      actor_name TEXT,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT,
      details TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    /* Outbound message queue for the notification dispatcher. In-app notifications
       live in the 'notifications' table; this records external channels (email/SMS)
       so delivery is testable without real provider keys. 'status' is 'queued' until
       a transport sends it. */
    CREATE TABLE IF NOT EXISTS notification_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel TEXT NOT NULL,
      recipient TEXT,
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      error TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      sent_at DATETIME
    );

    /* Indexes on the columns we filter/join on most. SQLite stores entity ids as
       TEXT (students/classes are external MIS entities, so foreign keys to the local
       users table are intentionally avoided); these indexes keep lookups fast. */
    CREATE INDEX IF NOT EXISTS idx_attendance_student ON attendance_records(student_id);
    CREATE INDEX IF NOT EXISTS idx_attendance_class_date ON attendance_records(class_id, session_date);
    CREATE INDEX IF NOT EXISTS idx_discipline_student ON discipline_records(student_id);
    CREATE INDEX IF NOT EXISTS idx_discipline_type_status ON discipline_records(type, status);
    CREATE INDEX IF NOT EXISTS idx_excuse_status ON excuse_requests(status);
    CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id);
    CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);
  `);

  // Additive column migration: per-user preferences (notifications, appearance).
  // ALTER TABLE ADD COLUMN is safe and idempotent once guarded by a column check.
  const userCols = await db.all(`PRAGMA table_info(users)`);
  if (!userCols.some((c: any) => c.name === 'preferences')) {
    await db.run(`ALTER TABLE users ADD COLUMN preferences TEXT`);
  }

  // Additive column migration: scope every record to the academic year/term it
  // belongs to (nullable — existing rows stay NULL and are treated as
  // "belongs to any period" for backward compatibility). The academic year/term
  // themselves are never stored locally; they're owned by the NGA Central MIS
  // and only referenced here by numeric id (see routes/academics.ts).
  const academicPeriodTables = ['attendance_records', 'discipline_records', 'staff_attendance', 'excuse_requests'];
  for (const table of academicPeriodTables) {
    const cols = await db.all(`PRAGMA table_info(${table})`);
    if (!cols.some((c: any) => c.name === 'academic_year_id')) {
      await db.run(`ALTER TABLE ${table} ADD COLUMN academic_year_id INTEGER`);
    }
    if (!cols.some((c: any) => c.name === 'academic_term_id')) {
      await db.run(`ALTER TABLE ${table} ADD COLUMN academic_term_id INTEGER`);
    }
    await db.run(`CREATE INDEX IF NOT EXISTS idx_${table}_academic_term ON ${table}(academic_term_id)`);
  }

  // No demo/seed data. Identities are created from real SSO logins (routes/sso.ts)
  // and the admin MIS sync (routes/admin.ts); all operational records start empty.

  console.log('Database initialized successfully at:', config.databasePath);
}

export function getDb() {
  if (!db) {
    throw new Error('Database not initialized. Call initDatabase first.');
  }
  return db;
}
