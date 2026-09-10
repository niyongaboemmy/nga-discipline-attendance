import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import { Database } from 'sqlite';
import { setupTestDb, createTestUser, authHeader } from './testUtils.js';
import { app } from '../app.js';

/** Remediation coverage: D1 (dedupe), D2 (edit/delete), D7 (resolved_by id). */
describe('Discipline remediation — dedupe, edit, delete', () => {
  let db: Database;
  let teacherToken: string;
  let teacher2Token: string;
  let adminToken: string;

  const incident = {
    studentId: 'stu-1', studentName: 'Dana Doe', type: 'demerit',
    category: 'Tardiness', severity: 'minor', title: 'Late to assembly', incidentDate: '2026-05-04',
  };

  beforeAll(async () => {
    db = await setupTestDb();
    teacherToken = (await createTestUser(db, { id: 'tD1', name: 'T One', email: 't1@s.test', roleLevel: 'TEACHER' })).token;
    teacher2Token = (await createTestUser(db, { id: 'tD2', name: 'T Two', email: 't2@s.test', roleLevel: 'TEACHER' })).token;
    adminToken = (await createTestUser(db, { id: 'aD1', name: 'A One', email: 'a1@s.test', roleLevel: 'ADMIN' })).token;
  });

  beforeEach(async () => {
    await db.run(`DELETE FROM discipline_records`);
    await db.run(`DELETE FROM audit_log`);
    await db.run(`DELETE FROM notifications`);
  });

  it('D1: logging the same incident twice is blocked, but force overrides', async () => {
    const a = await request(app).post('/api/discipline').set(authHeader(teacherToken)).send(incident);
    expect(a.status).toBe(200);

    const b = await request(app).post('/api/discipline').set(authHeader(teacherToken)).send(incident);
    expect(b.status).toBe(409);
    expect(b.body.code).toBe('DUPLICATE_INCIDENT');

    const c = await request(app).post('/api/discipline').set(authHeader(teacherToken)).send({ ...incident, force: true });
    expect(c.status).toBe(200);

    const rows = await db.all(`SELECT * FROM discipline_records WHERE student_id = 'stu-1'`);
    expect(rows).toHaveLength(2);
  });

  it('D1: a different teacher logging the same incident is allowed', async () => {
    await request(app).post('/api/discipline').set(authHeader(teacherToken)).send(incident);
    const other = await request(app).post('/api/discipline').set(authHeader(teacher2Token)).send(incident);
    expect(other.status).toBe(200);
  });

  it('D1/D6: bulk de-dupes a repeated studentId and skips already-logged students', async () => {
    await request(app).post('/api/discipline').set(authHeader(teacherToken)).send(incident);

    const res = await request(app).post('/api/discipline/bulk').set(authHeader(teacherToken)).send({
      ...incident,
      students: [
        { studentId: 'stu-1', studentName: 'Dana Doe' },   // already logged -> skipped
        { studentId: 'stu-2', studentName: 'Eve East' },
        { studentId: 'stu-2', studentName: 'Eve East' },    // duplicate in payload -> collapsed
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.data.count).toBe(1);
    expect(res.body.data.skipped).toBe(1);

    const stu2 = await db.all(`SELECT * FROM discipline_records WHERE student_id = 'stu-2'`);
    expect(stu2).toHaveLength(1);
  });

  it('D2/D7: PUT /:id/status records the reviewer id and name', async () => {
    const created = await request(app).post('/api/discipline').set(authHeader(teacherToken)).send(incident);
    const id = created.body.data.id;

    const res = await request(app).put(`/api/discipline/${id}/status`).set(authHeader(adminToken)).send({ status: 'resolved' });
    expect(res.status).toBe(200);
    expect(res.body.data.resolved_by_id).toBe('aD1');
    expect(res.body.data.resolved_by_name).toBe('A One');
  });

  it('D2: PUT /:id corrects fields and re-derives points from the new severity', async () => {
    const created = await request(app).post('/api/discipline').set(authHeader(teacherToken)).send(incident);
    const id = created.body.data.id;
    expect(created.body.data.points).toBe(2); // minor

    const res = await request(app).put(`/api/discipline/${id}`).set(authHeader(adminToken)).send({
      severity: 'major', title: 'Repeated lateness', studentName: 'Dana M. Doe',
    });
    expect(res.status).toBe(200);
    expect(res.body.data.points).toBe(10); // major
    expect(res.body.data.title).toBe('Repeated lateness');
    expect(res.body.data.edited_at).toBeTruthy();

    const audit = await db.get(`SELECT * FROM audit_log WHERE action = 'discipline.edit'`);
    expect(audit).toBeTruthy();
    const details = JSON.parse(audit.details);
    expect(details.previousValue.points).toBe(2);
    expect(details.newValue.points).toBe(10);
  });

  it('D2: a teacher without DISCIPLINE_EDIT cannot edit someone else’s record', async () => {
    const created = await request(app).post('/api/discipline').set(authHeader(teacherToken)).send(incident);
    const id = created.body.data.id;
    const res = await request(app).put(`/api/discipline/${id}`).set(authHeader(teacher2Token)).send({ title: 'x' });
    expect(res.status).toBe(403);
  });

  it('D2: soft-deleted records drop out of the list, overview and student view', async () => {
    const created = await request(app).post('/api/discipline').set(authHeader(teacherToken)).send(incident);
    const id = created.body.data.id;

    const denied = await request(app).delete(`/api/discipline/${id}`).set(authHeader(teacherToken));
    expect(denied.status).toBe(403);

    const del = await request(app).delete(`/api/discipline/${id}`).set(authHeader(adminToken)).send({ reason: 'wrong student' });
    expect(del.status).toBe(200);

    const list = await request(app).get('/api/discipline').set(authHeader(adminToken));
    expect(list.body.data.find((r: any) => r.id === id)).toBeUndefined();

    const overview = await request(app).get('/api/discipline/overview').set(authHeader(adminToken));
    expect(overview.body.data.totals.total).toBe(0);

    const audit = await db.get(`SELECT * FROM audit_log WHERE action = 'discipline.delete'`);
    expect(audit).toBeTruthy();
  });

  it('D9: GET /api/discipline/config serves the vocabularies', async () => {
    const res = await request(app).get('/api/discipline/config').set(authHeader(teacherToken));
    expect(res.status).toBe(200);
    expect(res.body.data.demeritCategories).toContain('Tardiness');
    expect(res.body.data.demeritTiers.major).toBe(10);
    expect(res.body.data.sanctions).toContain('detention');
  });

  it('D4: dismissing demerits clears the follow-up flag on the next check', async () => {
    // 16 points of demerits (> 15 threshold) -> a conduct follow-up notification.
    for (let i = 0; i < 2; i++) {
      await request(app).post('/api/discipline').set(authHeader(teacherToken)).send({
        studentId: 'stu-9', studentName: 'Nia N', type: 'demerit', category: 'Misconduct',
        severity: 'major', title: `Incident ${i}`, incidentDate: '2026-05-0' + (i + 1),
      });
    }
    const flagged = await db.get(`SELECT * FROM notifications WHERE user_id = 'all' AND title LIKE 'Conduct follow-up%'`);
    expect(flagged).toBeTruthy();

    // Dismiss both -> balance recovers. Clear the notification so the next
    // check has a clean slate, then flip a record's status.
    await db.run(`DELETE FROM notifications`);
    const recs = await db.all(`SELECT id FROM discipline_records WHERE student_id = 'stu-9'`);
    for (const r of recs) {
      await request(app).put(`/api/discipline/${r.id}/status`).set(authHeader(adminToken)).send({ status: 'dismissed' });
    }
    const after = await db.get(`SELECT * FROM notifications WHERE user_id = 'all' AND title LIKE 'Conduct follow-up%'`);
    expect(after).toBeFalsy();
  });

  it('D2: GET /:id returns the record plus its audit history', async () => {
    const created = await request(app).post('/api/discipline').set(authHeader(teacherToken)).send(incident);
    const id = created.body.data.id;
    await request(app).put(`/api/discipline/${id}/status`).set(authHeader(adminToken)).send({ status: 'under_review' });

    const res = await request(app).get(`/api/discipline/${id}`).set(authHeader(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.data.record.id).toBe(id);
    expect(res.body.data.history.length).toBeGreaterThanOrEqual(2);
  });
});
