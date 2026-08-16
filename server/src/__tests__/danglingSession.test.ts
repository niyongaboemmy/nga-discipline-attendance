import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { Database } from 'sqlite';
import { app } from '../app.js';
import { config } from '../config.js';
import { setupTestDb, createTestUser, authHeader } from './testUtils.js';

/**
 * A cryptographically valid token whose user row no longer exists is a dead
 * session, not an authorization failure. This used to fall through to an
 * empty permission set, so *every* route answered 403 "Forbidden. You do
 * not have permission to perform this action." forever, with no way for the
 * client to tell it should just sign in again.
 *
 * Production hit exactly this: the SQLite file was tracked in git, so the
 * deploy's `git reset --hard` replaced the live DB (and its user rows) with
 * the repo's dev copy, orphaning every signed-in session.
 */
describe('Dangling session handling', () => {
  let db: Database;
  let adminToken: string;

  beforeAll(async () => {
    db = await setupTestDb();
    const admin = await createTestUser(db, {
      id: 'admin-1',
      name: 'Admin',
      email: 'admin@school.test',
      roleLevel: 'ADMIN',
    });
    adminToken = admin.token;
  });

  it('401s (not 403s) when the token subject has no user row at all', async () => {
    const orphanToken = jwt.sign(
      { id: 'user-that-was-wiped', name: 'Ghost', email: 'ghost@school.test', role: 'admin' },
      config.jwtSecret,
      { expiresIn: '1h' }
    );

    const res = await request(app).get('/api/notifications').set(authHeader(orphanToken));

    expect(res.status).toBe(401);
    expect(res.body.message).toMatch(/sign in again/i);
  });

  it('still 403s a user who exists but holds no permissions (unassigned)', async () => {
    await db.run(
      `INSERT INTO users (id, name, email, role, role_id) VALUES (?, ?, ?, 'unassigned', NULL)`,
      'unassigned-1', 'Nobody', 'nobody@school.test'
    );
    const token = jwt.sign(
      { id: 'unassigned-1', name: 'Nobody', email: 'nobody@school.test', role: 'unassigned' },
      config.jwtSecret,
      { expiresIn: '1h' }
    );

    const res = await request(app).get('/api/notifications').set(authHeader(token));

    expect(res.status).toBe(403);
  });

  it('still lets a real user through', async () => {
    const res = await request(app).get('/api/notifications').set(authHeader(adminToken));
    expect(res.status).toBe(200);
  });
});
