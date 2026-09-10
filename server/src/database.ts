import sqlite3 from 'sqlite3';
import { open, Database } from 'sqlite';
import { config } from './config.js';
import { PERMISSIONS, DEFAULT_ROLE_PERMISSIONS, SYSTEM_ROLES } from './constants/permissions.js';

let db: Database;

/** `filenameOverride` lets tests point at `:memory:` without touching the
 *  process-wide config/env (config.databasePath stays the on-disk default
 *  for the real server). */
export async function initDatabase(filenameOverride?: string) {
  const filename = filenameOverride ?? config.databasePath;
  db = await open({
    filename,
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

    /* RBAC: roles carry a coarse 'level' (mirrors the legacy student/teacher/admin
       split so existing routing/nav logic keeps working) plus an arbitrary set of
       granular permissions via role_permissions. 'is_system' protects the 3
       seeded roles (one per level) from deletion; their permission sets remain
       admin-editable. Custom roles can be created at any level. */
    CREATE TABLE IF NOT EXISTS roles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      level TEXT NOT NULL CHECK(level IN ('STUDENT','TEACHER','ADMIN')),
      description TEXT,
      is_system INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS permissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT UNIQUE NOT NULL,
      category TEXT NOT NULL,
      description TEXT
    );

    CREATE TABLE IF NOT EXISTS role_permissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
      permission_id INTEGER NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
      UNIQUE(role_id, permission_id)
    );

    /* Tracks which (system role, permission key) pairs have ever been
       auto-granted by seedRbac(), independent of the current contents of
       role_permissions. This is what lets a newly-added permission key get
       granted to the right system roles on a later boot, while never
       re-granting a key an admin has since revoked — that decision is driven
       by "was this pairing ever seeded", not by diffing the permissions
       catalog against DB state (which is fragile: the catalog upsert and the
       grant step aren't atomic across incremental deploys/reloads). */
    CREATE TABLE IF NOT EXISTS role_permission_seed_log (
      role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
      permission_key TEXT NOT NULL,
      seeded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(role_id, permission_key)
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
    CREATE INDEX IF NOT EXISTS idx_role_permissions_role ON role_permissions(role_id);
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

  // Additive column migration: link a user to a granular role (RBAC). The legacy
  // 'role' column stays authoritative for level-based routing/nav; 'role_id' adds
  // a finer-grained permission set on top (see constants/permissions.ts).
  const userColsForRbac = await db.all(`PRAGMA table_info(users)`);
  if (!userColsForRbac.some((c: any) => c.name === 'role_id')) {
    await db.run(`ALTER TABLE users ADD COLUMN role_id INTEGER`);
  }
  await db.run(`CREATE INDEX IF NOT EXISTS idx_users_role_id ON users(role_id)`);

  await seedRbac();
  await backfillUserRoleIds();

  await migrateAcademicPeriodCache(db);
  await migrateRosterCache(db);
  await migrateDisciplineRules(db);
  await migrateAttendanceSessionType(db);
  await migrateAttendanceUniqueness(db);
  await migrateAttendanceHistory(db);
  await migrateExcuseRequestLinkage(db);
  await migrateDisciplineResolvedBy(db);
  await migrateNotificationDedupe(db);
  await migrateStaffType(db);

  // No demo/seed data. Identities are created from real SSO logins (routes/sso.ts)
  // and the admin MIS sync (routes/admin.ts); all operational records start empty.

  console.log('Database initialized successfully at:', filename);
}

/**
 * Keep the `permissions` catalog table in sync with constants/permissions.ts
 * (safe to run every boot — just an upsert), ensure the 3 system roles exist,
 * and grant each system role every DEFAULT_ROLE_PERMISSIONS key it has never
 * been granted before — tracked via `role_permission_seed_log`, not by
 * diffing the permissions catalog (that diff is fragile: the catalog upsert
 * and the grant step aren't atomic across incremental deploys/hot-reloads,
 * so a key can land in `permissions` before this function ever sees it as
 * "new"). Once a (role, key) pair is logged, it is never auto-granted again —
 * so an admin who later revokes a default permission from a system role has
 * that decision respected on every subsequent boot.
 */
async function seedRbac() {
  for (const p of PERMISSIONS) {
    await db.run(
      `INSERT INTO permissions (key, category, description) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET category = excluded.category, description = excluded.description`,
      p.key, p.category, p.description
    );
  }

  for (const role of SYSTEM_ROLES) {
    let systemRole = await db.get(`SELECT id FROM roles WHERE name = ? AND is_system = 1`, role.name);
    if (!systemRole) {
      const result = await db.run(
        `INSERT INTO roles (name, level, description, is_system) VALUES (?, ?, ?, 1)`,
        role.name, role.level, role.description
      );
      systemRole = { id: result.lastID };
    }

    const defaultKeys = DEFAULT_ROLE_PERMISSIONS[role.name as keyof typeof DEFAULT_ROLE_PERMISSIONS] || [];
    for (const key of defaultKeys) {
      const alreadySeeded = await db.get(
        `SELECT 1 FROM role_permission_seed_log WHERE role_id = ? AND permission_key = ?`,
        systemRole.id, key
      );
      if (alreadySeeded) continue;

      await grantPermissionToRole(systemRole.id, key);
      await db.run(
        `INSERT OR IGNORE INTO role_permission_seed_log (role_id, permission_key) VALUES (?, ?)`,
        systemRole.id, key
      );
    }
  }
}

async function grantPermissionToRole(roleId: number, permissionKey: string) {
  const perm = await db.get(`SELECT id FROM permissions WHERE key = ?`, permissionKey);
  if (perm) {
    await db.run(`INSERT OR IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)`, roleId, perm.id);
  }
}

/** Backfill role_id for users created before RBAC existed, matching their
 *  legacy 'role' string to the corresponding system role's level. Leaves
 *  'unassigned' users (and anyone already assigned a role_id) untouched. */
async function backfillUserRoleIds() {
  const levelByRole: Record<string, string> = { student: 'STUDENT', teacher: 'TEACHER', admin: 'ADMIN' };
  for (const [roleValue, level] of Object.entries(levelByRole)) {
    const systemRole = await db.get(`SELECT id FROM roles WHERE level = ? AND is_system = 1`, level);
    if (!systemRole) continue;
    await db.run(
      `UPDATE users SET role_id = ? WHERE role = ? AND role_id IS NULL`,
      systemRole.id, roleValue
    );
  }
}

/**
 * Phase 1: local cache of the MIS's Academic Year/Term entities. This app
 * never creates years/terms — the MIS remains the source of truth — but
 * caching them locally turns `academic_year_id`/`academic_term_id` (bare
 * nullable ints since the original migration) into values that can be
 * joined against a real row, and lets reporting group by term name instead
 * of a raw id. Populated by modules/academics/academicsSync.service.ts.
 */
async function migrateAcademicPeriodCache(db: Database) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS academic_years (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      start_date DATE,
      end_date DATE,
      is_current INTEGER NOT NULL DEFAULT 0,
      synced_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS academic_terms (
      id INTEGER PRIMARY KEY,
      academic_year_id INTEGER NOT NULL REFERENCES academic_years(id),
      name TEXT NOT NULL,
      start_date DATE,
      end_date DATE,
      is_current INTEGER NOT NULL DEFAULT 0,
      synced_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_academic_terms_year ON academic_terms(academic_year_id);
  `);
}

/**
 * Phase 3 (roster cache half): local cache of Subjects and the
 * class-group/subject/teacher timetable assignment, sourced from the MIS
 * schedule proxy (routes/mis.ts `/schedule`, write-through cached by
 * modules/academics/academicsSync.service.ts). This is what lets attendance
 * distinguish "homeroom" from "subject" sessions (A.1.1 vs A.1.2) and lets
 * teacher attendance be derived from their assigned-subject calendar (A.2).
 */
async function migrateRosterCache(db: Database) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS subjects (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      code TEXT,
      synced_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS class_subject_assignments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      class_id TEXT NOT NULL,
      class_name TEXT,
      subject_id INTEGER NOT NULL REFERENCES subjects(id),
      subject_name TEXT,
      teacher_id TEXT NOT NULL,
      teacher_name TEXT,
      academic_term_id INTEGER,
      day_of_week INTEGER,
      period TEXT,
      synced_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(class_id, subject_id, academic_term_id, day_of_week, period)
    );

    CREATE INDEX IF NOT EXISTS idx_csa_class ON class_subject_assignments(class_id, academic_term_id);
    CREATE INDEX IF NOT EXISTS idx_csa_teacher ON class_subject_assignments(teacher_id, academic_term_id);
  `);
}

/**
 * Phase 2: discipline rules catalog + per-term point/fine versioning, plus
 * the `rule_id` link on `discipline_records`. `category`/`severity`/`points`
 * stay on `discipline_records` as a snapshot at time of recording (so a
 * later rule-value edit never rewrites history) — see
 * modules/discipline/rules.repository.ts.
 */
async function migrateDisciplineRules(db: Database) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS discipline_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL CHECK(type IN ('demerit','merit')),
      category TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      default_points INTEGER NOT NULL CHECK(default_points > 0),
      fine_amount DECIMAL(10,2) NOT NULL DEFAULT 0,
      severity TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_by TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS discipline_rule_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rule_id INTEGER NOT NULL REFERENCES discipline_rules(id) ON DELETE CASCADE,
      academic_term_id INTEGER,
      points INTEGER NOT NULL,
      fine_amount DECIMAL(10,2),
      effective_from DATE NOT NULL DEFAULT (date('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_discipline_rules_type ON discipline_rules(type, is_active);
    CREATE INDEX IF NOT EXISTS idx_rule_versions_rule ON discipline_rule_versions(rule_id);
  `);

  const cols = await db.all(`PRAGMA table_info(discipline_records)`);
  if (!cols.some((c: any) => c.name === 'rule_id')) {
    await db.run(`ALTER TABLE discipline_records ADD COLUMN rule_id INTEGER REFERENCES discipline_rules(id)`);
  }
  await db.run(`CREATE INDEX IF NOT EXISTS idx_discipline_records_rule ON discipline_records(rule_id)`);
  // Backs modules/discipline/ledger.service.ts's per-student and roster-wide
  // term-balance aggregation (WHERE student_id = ? AND academic_term_id = ?
  // OR IS NULL ... GROUP BY student_id) — hit on every student's conduct
  // page load and every admin discipline-stats view.
  await db.run(`CREATE INDEX IF NOT EXISTS idx_discipline_records_student_term ON discipline_records(student_id, academic_term_id)`);

  // Term balance ledger (B.0/B.3) used to be backed by a `discipline_term_balance`
  // VIEW here, grouped by (student_id, academic_year_id, academic_term_id).
  // That grouping made the codebase-wide "legacy NULL-term rows stay visible
  // under any period filter" convention impossible to apply correctly — a
  // plain WHERE on the view matched the current-term group and the legacy
  // NULL group as two *separate* rows instead of merging them. It also
  // silently excluded dismissed records while utils/conduct.ts's
  // computeConductScore (still used by /api/discipline/me) does not,
  // so the two "conduct score" numbers shown together on MyConduct could
  // visibly disagree. modules/discipline/ledger.service.ts now aggregates
  // discipline_records directly instead, so this view has no consumers —
  // dropped rather than carried forward as a second, differently-scoped
  // definition of the same thing.
  await db.exec(`DROP VIEW IF EXISTS discipline_term_balance`);
}

/**
 * Phase 3 (attendance half): distinguish homeroom (A.1.1) from subject/course
 * (A.1.2) attendance. This requires replacing the original
 * UNIQUE(student_id, class_id, session_date, period) constraint — a subject
 * session and a homeroom session can otherwise collide on the same
 * student/class/date/period. SQLite can't ALTER a UNIQUE constraint in place,
 * so this is a one-time guarded table rebuild (detected via the absence of
 * the `session_type` column), not a plain ADD COLUMN.
 */
async function migrateAttendanceSessionType(db: Database) {
  const cols = await db.all(`PRAGMA table_info(attendance_records)`);
  if (cols.some((c: any) => c.name === 'session_type')) return; // already migrated

  await db.run('BEGIN TRANSACTION');
  try {
    await db.exec(`
      CREATE TABLE attendance_records_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        student_id TEXT NOT NULL,
        student_name TEXT NOT NULL,
        class_id TEXT NOT NULL,
        class_name TEXT NOT NULL,
        session_date DATE NOT NULL,
        period TEXT,
        session_type TEXT NOT NULL CHECK(session_type IN ('homeroom','subject')) DEFAULT 'homeroom',
        subject_id INTEGER REFERENCES subjects(id),
        status TEXT NOT NULL CHECK(status IN ('present','absent','late','excused')),
        notes TEXT,
        marked_by TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        academic_year_id INTEGER,
        academic_term_id INTEGER,
        UNIQUE(student_id, class_id, session_date, session_type, subject_id, period)
      );

      INSERT INTO attendance_records_new
        (id, student_id, student_name, class_id, class_name, session_date, period,
         session_type, subject_id, status, notes, marked_by, created_at, updated_at,
         academic_year_id, academic_term_id)
      SELECT
        id, student_id, student_name, class_id, class_name, session_date, period,
        'homeroom', NULL, status, notes, marked_by, created_at, updated_at,
        academic_year_id, academic_term_id
      FROM attendance_records;

      DROP TABLE attendance_records;
      ALTER TABLE attendance_records_new RENAME TO attendance_records;

      CREATE INDEX IF NOT EXISTS idx_attendance_student ON attendance_records(student_id);
      CREATE INDEX IF NOT EXISTS idx_attendance_class_date ON attendance_records(class_id, session_date);
      CREATE INDEX IF NOT EXISTS idx_attendance_records_academic_term ON attendance_records(academic_term_id);
      CREATE INDEX IF NOT EXISTS idx_attendance_subject ON attendance_records(subject_id, class_id, session_date);
    `);
    await db.run('COMMIT');
    console.log('Migrated attendance_records to session_type/subject_id schema.');
  } catch (err) {
    await db.run('ROLLBACK');
    throw err;
  }
}

/**
 * Remediation A1 — homeroom attendance could be duplicated.
 *
 * The table-level `UNIQUE(student_id, class_id, session_date, session_type,
 * subject_id, period)` from `migrateAttendanceSessionType` never fires for a
 * homeroom row because `subject_id` is NULL and SQLite treats NULL as distinct
 * from NULL in a UNIQUE index — so `POST /mark`'s `ON CONFLICT ... DO UPDATE`
 * upsert silently became a plain INSERT and every re-mark of a homeroom
 * register stacked a fresh set of rows.
 *
 * Fix: collapse any existing duplicates (keeping the most recently updated row
 * per logical session), then add two *partial* unique indexes that don't
 * depend on a nullable column — one for homeroom sessions, one for subject
 * sessions. `POST /mark` targets these explicitly via
 * `ON CONFLICT(...) WHERE session_type = ...`.
 */
async function migrateAttendanceUniqueness(db: Database) {
  const already = await db.get(
    `SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'uq_attendance_homeroom'`
  );
  if (already) return;

  await db.run('BEGIN TRANSACTION');
  try {
    // Collapse duplicate homeroom rows: keep the row with the newest
    // updated_at (tie-break on the highest id).
    await db.exec(`
      DELETE FROM attendance_records
      WHERE session_type = 'homeroom' AND id NOT IN (
        SELECT id FROM (
          SELECT id, ROW_NUMBER() OVER (
            PARTITION BY student_id, class_id, session_date, period
            ORDER BY updated_at DESC, id DESC
          ) AS rn
          FROM attendance_records WHERE session_type = 'homeroom'
        ) WHERE rn = 1
      );

      DELETE FROM attendance_records
      WHERE session_type = 'subject' AND id NOT IN (
        SELECT id FROM (
          SELECT id, ROW_NUMBER() OVER (
            PARTITION BY student_id, class_id, session_date, subject_id, period
            ORDER BY updated_at DESC, id DESC
          ) AS rn
          FROM attendance_records WHERE session_type = 'subject'
        ) WHERE rn = 1
      );

      CREATE UNIQUE INDEX uq_attendance_homeroom
        ON attendance_records(student_id, class_id, session_date, period)
        WHERE session_type = 'homeroom';

      CREATE UNIQUE INDEX uq_attendance_subject
        ON attendance_records(student_id, class_id, session_date, subject_id, period)
        WHERE session_type = 'subject';
    `);
    await db.run('COMMIT');
    console.log('Migrated attendance_records: partial unique indexes for homeroom/subject registers.');
  } catch (err) {
    await db.run('ROLLBACK');
    throw err;
  }
}

/**
 * Remediation A13 — attendance writes left no audit trail. This table keeps
 * the prior value of every attendance row that `POST /mark` overwrites, so a
 * correction (or a mistaken overwrite of someone else's register) is
 * recoverable and attributable. Written inside the same transaction as the
 * upsert in routes/attendance.ts.
 */
async function migrateAttendanceHistory(db: Database) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS attendance_record_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      attendance_record_id INTEGER,
      student_id TEXT NOT NULL,
      class_id TEXT NOT NULL,
      session_date DATE NOT NULL,
      period TEXT,
      session_type TEXT,
      subject_id INTEGER,
      previous_status TEXT,
      new_status TEXT,
      previous_notes TEXT,
      new_notes TEXT,
      changed_by TEXT NOT NULL,
      changed_by_name TEXT,
      changed_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_att_history_lookup
      ON attendance_record_history(class_id, session_date, period, session_type);
    CREATE INDEX IF NOT EXISTS idx_att_history_student
      ON attendance_record_history(student_id, session_date);
  `);
}

/**
 * Remediation A8/A9 — an approved excuse never touched the absence it excused,
 * and `excuse_requests` only stored a free-text `class_name` with no reliable
 * key back to an attendance row. Add the identifying columns (all nullable so
 * existing rows are untouched) plus review metadata.
 */
async function migrateExcuseRequestLinkage(db: Database) {
  const cols = await db.all(`PRAGMA table_info(excuse_requests)`);
  const has = (n: string) => cols.some((c: any) => c.name === n);
  if (!has('class_id')) await db.run(`ALTER TABLE excuse_requests ADD COLUMN class_id TEXT`);
  if (!has('period')) await db.run(`ALTER TABLE excuse_requests ADD COLUMN period TEXT`);
  if (!has('reviewer_note')) await db.run(`ALTER TABLE excuse_requests ADD COLUMN reviewer_note TEXT`);
  if (!has('reviewed_by')) await db.run(`ALTER TABLE excuse_requests ADD COLUMN reviewed_by TEXT`);
  if (!has('reviewed_by_name')) await db.run(`ALTER TABLE excuse_requests ADD COLUMN reviewed_by_name TEXT`);
  if (!has('supersedes_id')) await db.run(`ALTER TABLE excuse_requests ADD COLUMN supersedes_id INTEGER`);
  await db.run(`CREATE INDEX IF NOT EXISTS idx_excuse_student_date ON excuse_requests(student_id, session_date)`);
}

/**
 * Remediation D7 — `resolved_by` stored a display name (`actor.name || actor.id`)
 * where `logged_by` stores an id + `logged_by_name`. Add the id column and the
 * name column so review attribution can be joined like everything else.
 */
async function migrateDisciplineResolvedBy(db: Database) {
  const cols = await db.all(`PRAGMA table_info(discipline_records)`);
  const has = (n: string) => cols.some((c: any) => c.name === n);
  if (!has('resolved_by_id')) await db.run(`ALTER TABLE discipline_records ADD COLUMN resolved_by_id TEXT`);
  if (!has('resolved_by_name')) await db.run(`ALTER TABLE discipline_records ADD COLUMN resolved_by_name TEXT`);
  if (!has('deleted_at')) await db.run(`ALTER TABLE discipline_records ADD COLUMN deleted_at DATETIME`);
  if (!has('edited_at')) await db.run(`ALTER TABLE discipline_records ADD COLUMN edited_at DATETIME`);
}

/**
 * Remediation X4 — the "one alert per day" guards were `title LIKE '%...%'`
 * string matches. A `dedupe_key` column plus a unique index makes the guard a
 * real constraint. Additive; existing rows get NULL keys (never matched).
 */
async function migrateNotificationDedupe(db: Database) {
  const cols = await db.all(`PRAGMA table_info(notifications)`);
  if (!cols.some((c: any) => c.name === 'dedupe_key')) {
    await db.run(`ALTER TABLE notifications ADD COLUMN dedupe_key TEXT`);
  }
  await db.run(
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_notifications_dedupe
     ON notifications(dedupe_key) WHERE dedupe_key IS NOT NULL`
  );
}

/** Phase 3 (staff half): distinguish teachers (whose "attendance" is really
 *  calendar-derived — see A.2) from other staff (A.3, simple daily clock).
 *  Additive — no rebuild needed since there's no constraint to widen. */
async function migrateStaffType(db: Database) {
  const cols = await db.all(`PRAGMA table_info(staff_attendance)`);
  if (!cols.some((c: any) => c.name === 'staff_type')) {
    await db.run(
      `ALTER TABLE staff_attendance ADD COLUMN staff_type TEXT NOT NULL DEFAULT 'other' CHECK(staff_type IN ('teacher','other'))`
    );
  }
  await db.run(`CREATE INDEX IF NOT EXISTS idx_staff_attendance_type ON staff_attendance(staff_type, date)`);
}

export function getDb() {
  if (!db) {
    throw new Error('Database not initialized. Call initDatabase first.');
  }
  return db;
}
