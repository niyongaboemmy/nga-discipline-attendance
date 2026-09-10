import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { Database } from 'sqlite';
import { setupTestDb, createTestUser, authHeader } from './testUtils.js';
import { config } from '../config.js';
import { app } from '../app.js';
import { schoolDateString, dayOfWeekFor } from '../shared/schoolTime.js';

const today = schoolDateString();
const todayDow = dayOfWeekFor(today);

function mockMis(slots: unknown[]) {
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
    if (String(url).includes('/calendar/my-calendar')) {
      return new Response(JSON.stringify({ data: { slots, upcoming: [], term_id: 1 } }), { status: 200 });
    }
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  }));
}

describe('notification engine (via GET /api/notifications)', () => {
  let db: Database;
  let token: string;

  beforeAll(async () => {
    db = await setupTestDb();
    await createTestUser(db, { id: 'ntf-teacher', name: 'Nia', email: 'nia@s.test', roleLevel: 'TEACHER' });
    token = jwt.sign(
      { id: 'ntf-teacher', name: 'Nia', email: 'nia@s.test', role: 'teacher', misToken: 'x', academicTermId: 1 },
      config.jwtSecret, { expiresIn: '1h' }
    );
    await db.run(`INSERT INTO subjects (id, name) VALUES (5, 'Mathematics')`);
  });
  afterEach(() => vi.unstubAllGlobals());

  const pastSlot = {
    slot_id: 1, subject_id: 5, subject_name: 'Mathematics', class_group_id: 'cg-9',
    class_group_name: 'Grade 9A', day_of_week: todayDow, start_time: '00:01:00', end_time: '00:45:00',
    location: 'R1',
  };

  it('raises a register_missing nudge for an un-recorded past lesson, and does not duplicate it', async () => {
    mockMis([pastSlot]);
    const first = await request(app).get('/api/notifications').set(authHeader(token));
    expect(first.status).toBe(200);
    const nudges = first.body.data.filter((n: any) => n.type === 'register_missing');
    expect(nudges).toHaveLength(1);
    expect(nudges[0].link).toContain('/attendance/mark');
    expect(nudges[0].severity).toBe('warning');

    mockMis([pastSlot]);
    const second = await request(app).get('/api/notifications').set(authHeader(token));
    expect(second.body.data.filter((n: any) => n.type === 'register_missing')).toHaveLength(1);
  });

  it('clears the nudge once the register is recorded', async () => {
    await db.run(
      `INSERT INTO attendance_records (student_id, student_name, class_id, class_name, session_date, period, session_type, subject_id, status, marked_by, academic_term_id)
       VALUES ('s1','S','cg-9','Grade 9A',?, '00:01','subject',5,'present','ntf-teacher',1)`,
      today
    );
    mockMis([pastSlot]);
    const res = await request(app).get('/api/notifications').set(authHeader(token));
    expect(res.body.data.filter((n: any) => n.type === 'register_missing')).toHaveLength(0);
  });
});

describe('excuse decision notification', () => {
  let db: Database;
  let studentToken: string;
  let reviewerToken: string;

  beforeAll(async () => {
    db = await setupTestDb();
    studentToken = (await createTestUser(db, { id: 'exc-stu', name: 'Stu', email: 'stu@s.test', roleLevel: 'STUDENT' })).token;
    reviewerToken = (await createTestUser(db, { id: 'exc-rev', name: 'Rev', email: 'rev@s.test', roleLevel: 'ADMIN' })).token;
    await db.run(
      `INSERT INTO excuse_requests (id, student_id, student_name, class_id, class_name, session_date, period, reason, status)
       VALUES (77, 'exc-stu', 'Stu', 'cg-9', 'Grade 9A', '2026-09-01', 'Morning', 'Sick', 'pending')`
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it('notifies the student when their excuse is decided', async () => {
    const res = await request(app)
      .put('/api/attendance/excuse/77/status')
      .set(authHeader(reviewerToken))
      .send({ status: 'approved' });
    expect(res.status).toBe(200);

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })));
    const notifs = await request(app).get('/api/notifications').set(authHeader(studentToken));
    const decided = notifs.body.data.filter((n: any) => n.type === 'excuse_decided');
    expect(decided).toHaveLength(1);
    expect(decided[0].title).toBe('Excuse approved');
  });
});
