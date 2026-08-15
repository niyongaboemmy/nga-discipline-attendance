import sqlite3 from 'sqlite3';
import { open, Database } from 'sqlite';
import { config } from './config.js';
import { PERMISSIONS, DEFAULT_ROLE_PERMISSIONS, SYSTEM_ROLES } from './constants/permissions.js';

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

  // No demo/seed data. Identities are created from real SSO logins (routes/sso.ts)
  // and the admin MIS sync (routes/admin.ts); all operational records start empty.

  console.log('Database initialized successfully at:', config.databasePath);
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

export function getDb() {
  if (!db) {
    throw new Error('Database not initialized. Call initDatabase first.');
  }
  return db;
}
