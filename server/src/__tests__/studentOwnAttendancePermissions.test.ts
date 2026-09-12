import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { Database } from 'sqlite';
import { setupTestDb, authHeader } from './testUtils.js';
import { config } from '../config.js';
import { app } from '../app.js';

/**
 * ATTENDANCE_CALENDAR_VIEW_OWN and ATTENDANCE_DASHBOARD_VIEW_OWN (added
 * alongside the new read-only student calendar and dashboard pages) must
 * each independently unlock their route — a role holding only the new key,
 * with none of the older ATTENDANCE_* permissions, should still get in.
 */
async function makeCustomRole(db: Database, name: string, permissionKeys: string[]) {
  await db.run(`INSERT INTO roles (name, level, is_system) VALUES (?, 'STUDENT', 0)`, name);
  const role = await db.get(`SELECT id FROM roles WHERE name = ?`, name);
  for (const key of permissionKeys) {
    const perm = await db.get(`SELECT id FROM permissions WHERE key = ?`, key);
    if (!perm) throw new Error(`Permission ${key} was not seeded.`);
    await db.run(`INSERT INTO role_permissions (role_id, permission_id) VALUES (?, ?)`, role.id, perm.id);
  }
  return role.id as number;
}

async function userWithRole(db: Database, id: string, roleId: number) {
  await db.run(
    `INSERT INTO users (id, name, email, role, role_id) VALUES (?, ?, ?, 'student', ?)`,
    id, 'Test Student', `${id}@school.test`, roleId
  );
  return jwt.sign({ id, name: 'Test Student', email: `${id}@school.test`, role: 'student' }, config.jwtSecret, { expiresIn: '1h' });
}

describe('New own-attendance permissions (calendar + dashboard)', () => {
  let db: Database;

  beforeAll(async () => {
    db = await setupTestDb();
  });

  it('ATTENDANCE_CALENDAR_VIEW_OWN alone unlocks the schedule endpoints', async () => {
    const roleId = await makeCustomRole(db, 'calendar-only', ['ATTENDANCE_CALENDAR_VIEW_OWN']);
    const token = await userWithRole(db, 'cal-only-student', roleId);

    const res = await request(app).get('/api/attendance/schedule/day').set(authHeader(token));
    expect(res.status).toBe(200);
  });

  it('ATTENDANCE_DASHBOARD_VIEW_OWN alone unlocks /api/attendance/me', async () => {
    const roleId = await makeCustomRole(db, 'dashboard-only', ['ATTENDANCE_DASHBOARD_VIEW_OWN']);
    const token = await userWithRole(db, 'dash-only-student', roleId);

    const res = await request(app).get('/api/attendance/me').set(authHeader(token));
    expect(res.status).toBe(200);
  });

  it('neither new key alone unlocks the other route (they are not aliases of each other)', async () => {
    const roleId = await makeCustomRole(db, 'calendar-only-2', ['ATTENDANCE_CALENDAR_VIEW_OWN']);
    const token = await userWithRole(db, 'cal-only-student-2', roleId);

    const res = await request(app).get('/api/attendance/me').set(authHeader(token));
    expect(res.status).toBe(403);
  });

  it('a role with none of the attendance permissions is still denied both routes', async () => {
    const roleId = await makeCustomRole(db, 'no-attendance-perms', ['SETTINGS_MANAGE']);
    const token = await userWithRole(db, 'no-perms-student', roleId);

    expect((await request(app).get('/api/attendance/schedule/day').set(authHeader(token))).status).toBe(403);
    expect((await request(app).get('/api/attendance/me').set(authHeader(token))).status).toBe(403);
  });
});
