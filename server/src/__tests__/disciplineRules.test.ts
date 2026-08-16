import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { Database } from 'sqlite';
import { setupTestDb, createTestUser, authHeader } from './testUtils.js';
import { app } from '../app.js';

describe('Discipline rules catalog + permission-gated adjustment + term balance (B.0/B.1/B.2/B.3)', () => {
  let db: Database;
  let adminToken: string;
  let teacherToken: string;
  let studentToken: string;

  beforeAll(async () => {
    db = await setupTestDb();
    adminToken = (await createTestUser(db, { id: 'admin-1', name: 'Ada Admin', email: 'ada@school.test', roleLevel: 'ADMIN' })).token;
    teacherToken = (await createTestUser(db, { id: 'teacher-1', name: 'Tom Teacher', email: 'tom@school.test', roleLevel: 'TEACHER' })).token;
    studentToken = (await createTestUser(db, { id: 'student-1', name: 'Sam Student', email: 'sam@school.test', roleLevel: 'STUDENT' })).token;
  });

  it('rejects rule creation from a teacher (only DISCIPLINE_RULES_MANAGE, admin-only by default, may)', async () => {
    const res = await request(app)
      .post('/api/discipline/rules')
      .set(authHeader(teacherToken))
      .send({ type: 'demerit', category: 'Tardiness', title: 'Late to class', defaultPoints: 2 });
    expect(res.status).toBe(403);
  });

  it('lets an admin create a discipline rule', async () => {
    const res = await request(app)
      .post('/api/discipline/rules')
      .set(authHeader(adminToken))
      .send({ type: 'demerit', category: 'Tardiness', title: 'Late to class', defaultPoints: 5, fineAmount: 500 });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toMatchObject({ type: 'demerit', category: 'Tardiness', default_points: 5, fine_amount: 500 });
  });

  it('rejects an invalid rule payload (zod validation)', async () => {
    const res = await request(app)
      .post('/api/discipline/rules')
      .set(authHeader(adminToken))
      .send({ type: 'demerit', category: '', title: 'X', defaultPoints: -1 });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('lists active rules', async () => {
    const res = await request(app).get('/api/discipline/rules').set(authHeader(teacherToken));
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThanOrEqual(1);
  });

  it('a teacher without DISCIPLINE_ADJUST is denied; the default Teacher role has it, so this should succeed', async () => {
    const rule = await db.get(`SELECT * FROM discipline_rules WHERE title = 'Late to class'`);
    const res = await request(app)
      .post('/api/discipline/adjust')
      .set(authHeader(teacherToken))
      .send({
        studentId: 'student-1', studentName: 'Sam Student', ruleId: rule.id,
        incidentDate: '2026-02-10', description: 'Arrived 15 minutes late.',
      });
    expect(res.status).toBe(201);
    expect(res.body.data.points).toBe(5);
    expect(res.body.data.rule_id).toBe(rule.id);
  });

  it('rejects an adjustment against a retired rule', async () => {
    const rule = await db.get(`SELECT * FROM discipline_rules WHERE title = 'Late to class'`);
    await request(app).delete(`/api/discipline/rules/${rule.id}`).set(authHeader(adminToken));

    const res = await request(app)
      .post('/api/discipline/adjust')
      .set(authHeader(teacherToken))
      .send({ studentId: 'student-1', studentName: 'Sam Student', ruleId: rule.id, incidentDate: '2026-02-11' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/retired|does not exist/);
  });

  it("reflects the adjustment in the student's own term balance (B.3)", async () => {
    const res = await request(app).get('/api/discipline/term-balance/me').set(authHeader(studentToken));
    expect(res.status).toBe(200);
    expect(res.body.data.balance).toBe(95); // 100 - 5
    expect(res.body.data.demeritPoints).toBe(5);
  });

  it('denies a student from reading another student\'s term balance', async () => {
    const res = await request(app).get('/api/discipline/term-balance/someone-else').set(authHeader(studentToken));
    expect(res.status).toBe(403);
  });

  it('lets a teacher (DISCIPLINE_VIEW_ALL) read any student\'s term balance', async () => {
    const res = await request(app).get('/api/discipline/term-balance/student-1').set(authHeader(teacherToken));
    expect(res.status).toBe(200);
    expect(res.body.data.balance).toBe(95);
  });

  it('B.4: /stats surfaces the student in the roster-wide list with the correct balance', async () => {
    const res = await request(app).get('/api/discipline/stats').set(authHeader(adminToken));
    expect(res.status).toBe(200);
    const entry = res.body.data.students.find((s: any) => s.studentId === 'student-1');
    expect(entry).toBeTruthy();
    expect(entry.balance).toBe(95);
  });

  it('POST /discipline/bulk accepts a ruleId and applies it to every student in the batch', async () => {
    const ruleRes = await request(app)
      .post('/api/discipline/rules')
      .set(authHeader(adminToken))
      .send({ type: 'merit', category: 'Leadership', title: 'Class rep for the week', defaultPoints: 4 });
    const ruleId = ruleRes.body.data.id;

    const bulkRes = await request(app)
      .post('/api/discipline/bulk')
      .set(authHeader(teacherToken))
      .send({
        students: [
          { studentId: 'student-1', studentName: 'Sam Student' },
          { studentId: 'student-3', studentName: 'Jo Student' },
        ],
        type: 'merit', category: 'Leadership', severity: null, title: 'Class rep for the week',
        incidentDate: '2026-02-12', ruleId,
      });
    expect(bulkRes.status).toBe(200);
    expect(bulkRes.body.data.count).toBe(2);

    const rows = await db.all(`SELECT * FROM discipline_records WHERE title = 'Class rep for the week'`);
    expect(rows).toHaveLength(2);
    expect(rows.every((r: any) => r.rule_id === ruleId && r.points === 4)).toBe(true);
  });

  it('POST /discipline/bulk rejects a retired ruleId', async () => {
    const ruleRes = await request(app)
      .post('/api/discipline/rules')
      .set(authHeader(adminToken))
      .send({ type: 'demerit', category: 'Uniform', title: 'Out of uniform', defaultPoints: 2 });
    const ruleId = ruleRes.body.data.id;
    await request(app).delete(`/api/discipline/rules/${ruleId}`).set(authHeader(adminToken));

    const bulkRes = await request(app)
      .post('/api/discipline/bulk')
      .set(authHeader(teacherToken))
      .send({
        students: [{ studentId: 'student-1', studentName: 'Sam Student' }],
        type: 'demerit', category: 'Uniform', severity: 'minor', title: 'Out of uniform',
        incidentDate: '2026-02-12', ruleId,
      });
    expect(bulkRes.status).toBe(400);
  });
});
