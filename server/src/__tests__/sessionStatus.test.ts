import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { Database } from 'sqlite';
import { app } from '../app.js';
import { setupTestDb, createTestUser, authHeader } from './testUtils.js';

/**
 * POST /mark upserts, so re-submitting a session silently replaces whatever
 * was there. This endpoint is what lets the client warn first — these tests
 * pin the behaviour that warning depends on.
 */
describe('GET /api/attendance/session-status', () => {
  let db: Database;
  let teacherToken: string;
  let studentToken: string;

  const session = {
    classId: 'c-1',
    className: 'Year 2 A',
    date: '2026-08-16',
    period: 'Morning',
    sessionType: 'homeroom' as const,
  };

  beforeAll(async () => {
    db = await setupTestDb();
    teacherToken = (
      await createTestUser(db, { id: 'ss-teacher', name: 'Tom', email: 't@s.test', roleLevel: 'TEACHER' })
    ).token;
    studentToken = (
      await createTestUser(db, { id: 'ss-student', name: 'Sam', email: 's@s.test', roleLevel: 'STUDENT' })
    ).token;
  });

  const statusFor = (overrides: Record<string, string> = {}) =>
    request(app)
      .get('/api/attendance/session-status')
      .query({
        classId: session.classId,
        date: session.date,
        period: session.period,
        sessionType: session.sessionType,
        ...overrides,
      })
      .set(authHeader(teacherToken));

  it('requires ATTENDANCE_MARK', async () => {
    const res = await request(app)
      .get('/api/attendance/session-status')
      .query({ classId: session.classId, date: session.date })
      .set(authHeader(studentToken));
    expect(res.status).toBe(403);
  });

  it('validates the date format', async () => {
    const res = await statusFor({ date: '16-08-2026' });
    expect(res.status).toBe(400);
  });

  it('reports no existing register before anything is marked', async () => {
    const res = await statusFor();
    expect(res.status).toBe(200);
    expect(res.body.data.exists).toBe(false);
    expect(res.body.data.count).toBe(0);
  });

  it('reports the register once the session has been marked', async () => {
    const marked = await request(app)
      .post('/api/attendance/mark')
      .set(authHeader(teacherToken))
      .send({
        ...session,
        records: [
          { studentId: 's1', studentName: 'One', status: 'present' },
          { studentId: 's2', studentName: 'Two', status: 'absent' },
        ],
      });
    expect(marked.status).toBe(200);

    const res = await statusFor();
    expect(res.status).toBe(200);
    expect(res.body.data.exists).toBe(true);
    expect(res.body.data.count).toBe(2);
    expect(res.body.data.markedByName).toBe('Tom');
  });

  it('scopes to the exact session — a different period is untouched', async () => {
    const res = await statusFor({ period: 'Afternoon' });
    expect(res.status).toBe(200);
    expect(res.body.data.exists).toBe(false);
  });

  it('treats a subject session as distinct from the homeroom one', async () => {
    const res = await statusFor({ sessionType: 'subject', subjectId: '7' });
    expect(res.status).toBe(200);
    expect(res.body.data.exists).toBe(false);
  });
});
