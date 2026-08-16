import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { Database } from 'sqlite';
import { setupTestDb, createTestUser, authHeader } from './testUtils.js';
import { app } from '../app.js';

/**
 * Bulk rule import (spreadsheet upload). The contract that matters to the
 * user: one bad row must not discard the good ones, and re-uploading a
 * corrected sheet must not duplicate what already imported.
 */
describe('POST /api/discipline/rules/import', () => {
  let db: Database;
  let adminToken: string;
  let teacherToken: string;

  beforeAll(async () => {
    db = await setupTestDb();
    adminToken = (
      await createTestUser(db, { id: 'imp-admin', name: 'Ada', email: 'ada@s.test', roleLevel: 'ADMIN' })
    ).token;
    teacherToken = (
      await createTestUser(db, { id: 'imp-teacher', name: 'Tom', email: 'tom@s.test', roleLevel: 'TEACHER' })
    ).token;
  });

  it('requires DISCIPLINE_RULES_MANAGE', async () => {
    const res = await request(app)
      .post('/api/discipline/rules/import')
      .set(authHeader(teacherToken))
      .send({ rules: [{ type: 'demerit', category: 'C', title: 'T', defaultPoints: 1 }] });
    expect(res.status).toBe(403);
  });

  it('imports valid rows and reports per-row errors without discarding the good ones', async () => {
    const res = await request(app)
      .post('/api/discipline/rules/import')
      .set(authHeader(adminToken))
      .send({
        rules: [
          { type: 'demerit', category: 'Uniform', title: 'Untidy uniform', defaultPoints: 2, fineAmount: 500 },
          { type: 'merit', category: 'Service', title: 'Helped a peer', defaultPoints: 3 },
          // defaultPoints must be a positive int -> row 4 fails
          { type: 'demerit', category: 'Uniform', title: 'Bad row', defaultPoints: 0 },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.data.created).toHaveLength(2);
    expect(res.body.data.errors).toHaveLength(1);
    // Row numbers are spreadsheet rows (header is row 1), so the 3rd entry is row 4.
    expect(res.body.data.errors[0].row).toBe(4);

    const listed = await request(app)
      .get('/api/discipline/rules')
      .set(authHeader(adminToken));
    const titles = listed.body.data.map((r: any) => r.title);
    expect(titles).toContain('Untidy uniform');
    expect(titles).toContain('Helped a peer');
    expect(titles).not.toContain('Bad row');
  });

  it('skips rules that already exist instead of duplicating them', async () => {
    const res = await request(app)
      .post('/api/discipline/rules/import')
      .set(authHeader(adminToken))
      .send({
        rules: [
          // Same title as above, differing only by case/whitespace.
          { type: 'demerit', category: 'Uniform', title: '  untidy uniform ', defaultPoints: 2 },
          { type: 'demerit', category: 'Conduct', title: 'Brand new rule', defaultPoints: 4 },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.data.created).toHaveLength(1);
    expect(res.body.data.skipped).toHaveLength(1);

    const listed = await request(app)
      .get('/api/discipline/rules')
      .set(authHeader(adminToken));
    const untidy = listed.body.data.filter(
      (r: any) => r.title.trim().toLowerCase() === 'untidy uniform'
    );
    expect(untidy).toHaveLength(1);
  });

  it('rejects an empty or oversized batch', async () => {
    const empty = await request(app)
      .post('/api/discipline/rules/import')
      .set(authHeader(adminToken))
      .send({ rules: [] });
    expect(empty.status).toBe(400);

    const huge = await request(app)
      .post('/api/discipline/rules/import')
      .set(authHeader(adminToken))
      .send({
        rules: Array.from({ length: 501 }, (_, i) => ({
          type: 'demerit', category: 'C', title: `Rule ${i}`, defaultPoints: 1,
        })),
      });
    expect(huge.status).toBe(400);
  });
});
