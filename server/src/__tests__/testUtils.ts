import jwt from 'jsonwebtoken';
import { Database } from 'sqlite';
import { config } from '../config.js';
import { initDatabase, getDb } from '../database.js';

/** Fresh in-memory SQLite DB with the full schema + RBAC seed applied — one
 *  per test file (call from `beforeAll`), never touching the real on-disk DB. */
export async function setupTestDb(): Promise<Database> {
  await initDatabase(':memory:');
  return getDb();
}

export interface TestUser {
  id: string;
  name: string;
  email: string;
  roleLevel: 'STUDENT' | 'TEACHER' | 'ADMIN';
}

/** Insert a user with a system role (Student/Teacher/Admin) and return a
 *  bearer token good against `authMiddleware`, mirroring what a real SSO
 *  exchange would mint — without needing the external MIS. */
export async function createTestUser(
  db: Database,
  { id, name, email, roleLevel }: TestUser
): Promise<{ token: string; roleId: number }> {
  const role = await db.get(`SELECT id FROM roles WHERE level = ? AND is_system = 1`, roleLevel);
  if (!role) throw new Error(`No seeded system role for level ${roleLevel}`);

  const legacyRole = roleLevel.toLowerCase();
  await db.run(
    `INSERT INTO users (id, name, email, role, role_id) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET role_id = excluded.role_id, role = excluded.role`,
    id, name, email, legacyRole, role.id
  );

  const token = jwt.sign({ id, name, email, role: legacyRole }, config.jwtSecret, { expiresIn: '1h' });
  return { token, roleId: role.id };
}

export function authHeader(token: string) {
  return { Authorization: `Bearer ${token}` };
}
