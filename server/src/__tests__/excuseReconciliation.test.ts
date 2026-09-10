import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import { Database } from 'sqlite';
import { setupTestDb, createTestUser, authHeader } from './testUtils.js';
import { app } from '../app.js';

/** Remediation A8/A10: an excuse decision moves the underlying absence, and
 *  the review list carries the context the reviewer needs. */
describe('Excuse ↔ attendance reconciliation', () => {
  let db: Database;
  let studentToken: string;
  let teacherToken: string;

  beforeAll(async () => {
    db = await setupTestDb();
    studentToken = (await createTestUser(db, { id: 'ex-stu', name: 'Ravi Roy', email: 'r@s.test', roleLevel: 'STUDENT' })).token;
    teacherToken = (await createTestUser(db, { id: 'ex-tch', name: 'Tia Teacher', email: 't@s.test', roleLevel: 'TEACHER' })).token;
  });

  beforeEach(async () => {
    await db.run('DELETE FROM attendance_records');
    await db.run('DELETE FROM excuse_requests');
    await db.run('DELETE FROM audit_log');
    await db.run('DELETE FROM notifications');
  });

  const markAbsent = () =>
    request(app).post('/api/attendance/mark').set(authHeader(teacherToken)).send({
      classId: 'c-7', className: 'Year 7 A', date: '2026-06-02', period: 'Morning',
      records: [{ studentId: 'ex-stu', studentName: 'Ravi Roy', status: 'absent' }],
    });

  const submitExcuse = () =>
    request(app).post('/api/attendance/excuse').set(authHeader(studentToken)).send({
      classId: 'c-7', className: 'Year 7 A', sessionDate: '2026-06-02', reason: 'Medical',
    });

  it('A8: approving an excuse flips the matching absent row to excused', async () => {
    await markAbsent();
    const ex = await submitExcuse();
    const id = ex.body.data.id;

    const res = await request(app).put(`/api/attendance/excuse/${id}/status`)
      .set(authHeader(teacherToken)).send({ status: 'approved', reviewerNote: 'Note verified' });
    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/1 attendance record/i);

    const row = await db.get(`SELECT status FROM attendance_records WHERE student_id = 'ex-stu'`);
    expect(row.status).toBe('excused');

    const updated = await db.get(`SELECT * FROM excuse_requests WHERE id = ?`, id);
    expect(updated.reviewer_note).toBe('Note verified');
    expect(updated.reviewed_by).toBe('ex-tch');
  });

  it('A8: rejecting a previously-approved excuse restores the absence', async () => {
    await markAbsent();
    const id = (await submitExcuse()).body.data.id;
    await request(app).put(`/api/attendance/excuse/${id}/status`).set(authHeader(teacherToken)).send({ status: 'approved' });

    await request(app).put(`/api/attendance/excuse/${id}/status`).set(authHeader(teacherToken)).send({ status: 'rejected' });
    const row = await db.get(`SELECT status FROM attendance_records WHERE student_id = 'ex-stu'`);
    expect(row.status).toBe('absent');
  });

  it('A8: an approved excuse with no matching absence is still recorded (0 rows changed)', async () => {
    const id = (await submitExcuse()).body.data.id;
    const res = await request(app).put(`/api/attendance/excuse/${id}/status`)
      .set(authHeader(teacherToken)).send({ status: 'approved' });
    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Excuse approved.');
  });

  it('A10: the review list reports whether the student is marked absent + prior excuse count', async () => {
    await markAbsent();
    await submitExcuse();

    const list = await request(app).get('/api/attendance/excuses?status=pending').set(authHeader(teacherToken));
    expect(list.status).toBe(200);
    expect(list.body.data[0].isMarkedAbsent).toBe(true);
    expect(list.body.data[0].attendanceStatus).toBe('absent');
    expect(list.body.data[0].priorExcuseCount).toBe(0);
  });

  it('A10: bulk approve processes several requests and reconciles each', async () => {
    await markAbsent();
    const id1 = (await submitExcuse()).body.data.id;
    await request(app).post('/api/attendance/mark').set(authHeader(teacherToken)).send({
      classId: 'c-7', className: 'Year 7 A', date: '2026-06-03', period: 'Morning',
      records: [{ studentId: 'ex-stu', studentName: 'Ravi Roy', status: 'absent' }],
    });
    const id2 = (await request(app).post('/api/attendance/excuse').set(authHeader(studentToken)).send({
      classId: 'c-7', className: 'Year 7 A', sessionDate: '2026-06-03', reason: 'Family',
    })).body.data.id;

    const res = await request(app).put('/api/attendance/excuses/bulk')
      .set(authHeader(teacherToken)).send({ ids: [id1, id2], status: 'approved' });
    expect(res.status).toBe(200);
    expect(res.body.data.processed).toBe(2);
    expect(res.body.data.attendanceRowsChanged).toBe(2);

    const excused = await db.all(`SELECT status FROM attendance_records WHERE student_id = 'ex-stu'`);
    expect(excused.every((r) => r.status === 'excused')).toBe(true);
  });

  it('A6: an approved excuse no longer counts against the student’s rate', async () => {
    // 4 absences, 1 present -> 20%. Excuse one absence -> excused counts as
    // attended -> 40%.
    for (const d of ['01', '02', '03', '04']) {
      await request(app).post('/api/attendance/mark').set(authHeader(teacherToken)).send({
        classId: 'c-7', className: 'Year 7 A', date: `2026-06-${d}`, period: 'Morning',
        records: [{ studentId: 'ex-stu', studentName: 'Ravi Roy', status: 'absent' }],
      });
    }
    await request(app).post('/api/attendance/mark').set(authHeader(teacherToken)).send({
      classId: 'c-7', className: 'Year 7 A', date: '2026-06-05', period: 'Morning',
      records: [{ studentId: 'ex-stu', studentName: 'Ravi Roy', status: 'present' }],
    });

    const before = await request(app).get('/api/attendance/me').set(authHeader(studentToken));
    expect(before.body.data.summary.rate).toBe(20);

    const exId = (await request(app).post('/api/attendance/excuse').set(authHeader(studentToken)).send({
      classId: 'c-7', className: 'Year 7 A', sessionDate: '2026-06-02', reason: 'Medical',
    })).body.data.id;
    await request(app).put(`/api/attendance/excuse/${exId}/status`).set(authHeader(teacherToken)).send({ status: 'approved' });

    const after = await request(app).get('/api/attendance/me').set(authHeader(studentToken));
    expect(after.body.data.summary.rate).toBe(40);
    expect(after.body.data.summary.excused).toBe(1);
  });
});
