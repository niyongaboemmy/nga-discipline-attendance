import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import { Database } from 'sqlite';
import { app } from '../app.js';
import { setupTestDb, createTestUser } from './testUtils.js';
import { __resetPolicyState, accessIdle } from '../access/policy.js';
import { __resetSnapshotCache } from '../access/snapshot.js';
import * as misBearer from '../middleware/misBearerAuth.js';

/**
 * GET /api/integration/attendance/class/:classId/term -- what Task Mentor's
 * report card workbench imports: each student's homeroom days this term.
 * MIS is never started: `fetch` is stubbed (MIS bearer verification).
 */

const USERS: Record<string, number> = { 'mis-admin': 100, 'mis-student': 501, 'mis-stranger': 900 };

function stubMis() {
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    const token = String((init?.headers as any)?.Authorization ?? '').replace(/^Bearer /, '');
    const json = (data: any, status = 200) => new Response(JSON.stringify({ success: status < 400, data }), { status });
    if (u.includes('/auth/verify')) {
      const id = USERS[token];
      return id ? json({ userId: id, access_version: 1 }) : json(null, 401);
    }
    if (u.includes('/access/me')) return json(null, 503);
    return json([]);
  }));
}

describe('GET /api/integration/attendance/class/:classId/term', () => {
  let db: Database;
  const get = (token: string, path = '/api/integration/attendance/class/7/term') =>
    request(app).get(path).set('Authorization', `Bearer ${token}`);

  beforeAll(async () => {
    db = await setupTestDb();
    await createTestUser(db, { id: '100', name: 'Admin A', email: 'a@school.test', roleLevel: 'ADMIN' });
    await createTestUser(db, { id: '501', name: 'Alice', email: 's@school.test', roleLevel: 'STUDENT' });
    const mark = (student: string, name: string, date: string, status: string, sessionType = 'homeroom') =>
      db.run(
        `INSERT INTO attendance_records (student_id, student_name, class_id, class_name, session_date, period, session_type, subject_id, status, marked_by)
         VALUES (?, ?, '7', 'G7', ?, 'Morning', ?, NULL, ?, 'x')`,
        student, name, date, sessionType, status,
      );
    await mark('501', 'Alice', '2026-09-01', 'present');
    await mark('501', 'Alice', '2026-09-02', 'present');
    await mark('501', 'Alice', '2026-09-03', 'late');
    await mark('501', 'Alice', '2026-09-04', 'absent');
    await mark('501', 'Alice', '2026-09-05', 'excused');
    await mark('502', 'Bob', '2026-09-01', 'absent');
    // A subject lesson is not a school day: left out.
    await mark('501', 'Alice', '2026-09-01', 'absent', 'subject');
  });

  beforeEach(() => {
    __resetSnapshotCache();
    __resetPolicyState();
    misBearer.__resetMisBearerCache();
    stubMis();
  });

  afterAll(async () => {
    await accessIdle();
    vi.unstubAllGlobals();
  });

  it('returns each student\'s homeroom days by status', async () => {
    const res = await get('mis-admin');
    expect(res.status).toBe(200);
    const alice = res.body.data.students.find((s: any) => s.studentId === '501');
    expect(alice).toMatchObject({ present: 2, late: 1, absent: 1, excused: 1, total: 5 });
    const bob = res.body.data.students.find((s: any) => s.studentId === '502');
    expect(bob).toMatchObject({ present: 0, absent: 1, total: 1 });
    expect(res.body.data.sessions).toBe(5);
    expect(alice.marks).toBeUndefined();
  });

  it('refuses a caller without attendance reporting rights', async () => {
    const res = await get('mis-student');
    expect(res.status).toBe(403);
  });

  it('refuses a MIS user who never signed in here', async () => {
    const res = await get('mis-stranger');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('NOT_PROVISIONED');
  });

  it('refuses an unknown token and a bad class id', async () => {
    expect((await get('nobody')).status).toBe(401);
    expect((await get('mis-admin', '/api/integration/attendance/class/abc/term')).status).toBe(400);
  });
});
