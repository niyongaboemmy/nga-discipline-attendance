import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { Database } from 'sqlite';
import { app } from '../app.js';
import { setupTestDb, createTestUser, authHeader } from './testUtils.js';

/**
 * Nothing stopped a student re-submitting the same excuse, which fills the
 * reviewer's queue with duplicates of one absence. The guard is deliberately
 * narrow: it blocks a second *pending* request, not a resubmission after a
 * decision — a rejection often means "send better evidence", and blocking
 * that would leave the student no way back.
 */
describe('POST /api/attendance/excuse — duplicate guard', () => {
  let db: Database;
  let studentToken: string;
  let teacherToken: string;

  const body = {
    className: 'Year 2 A',
    sessionDate: '2026-08-10',
    reason: 'Medical',
    description: 'Doctor appointment, note attached.',
  };

  beforeAll(async () => {
    db = await setupTestDb();
    studentToken = (
      await createTestUser(db, { id: 'ex-student', name: 'Sam', email: 's@s.test', roleLevel: 'STUDENT' })
    ).token;
    teacherToken = (
      await createTestUser(db, { id: 'ex-teacher', name: 'Tom', email: 't@s.test', roleLevel: 'TEACHER' })
    ).token;
  });

  const submit = (overrides: Record<string, string> = {}, token = studentToken) =>
    request(app).post('/api/attendance/excuse').set(authHeader(token)).send({ ...body, ...overrides });

  it('accepts the first request', async () => {
    const res = await submit();
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('pending');
  });

  it('rejects an identical request while the first is still pending', async () => {
    const res = await submit();
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/already have a pending request/i);
  });

  it('still allows a different date or a different class', async () => {
    expect((await submit({ sessionDate: '2026-08-11' })).status).toBe(200);
    expect((await submit({ className: 'Year 1 B' })).status).toBe(200);
  });

  it('allows resubmission once the original has been decided', async () => {
    const pending = await db.get(
      `SELECT id FROM excuse_requests WHERE student_id = ? AND class_name = ? AND session_date = ? AND status = 'pending'`,
      'ex-student', body.className, body.sessionDate
    );
    const decided = await request(app)
      .put(`/api/attendance/excuse/${pending.id}/status`)
      .set(authHeader(teacherToken))
      .send({ status: 'rejected' });
    expect(decided.status).toBe(200);

    const res = await submit();
    expect(res.status).toBe(200);
  });

  it('still validates the date format', async () => {
    const res = await submit({ sessionDate: '10-08-2026' });
    expect(res.status).toBe(400);
  });
});
