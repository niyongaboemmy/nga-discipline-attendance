import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import { Database } from 'sqlite';
import { setupTestDb, createTestUser, authHeader } from './testUtils.js';
import { app } from '../app.js';

/**
 * The student-facing excuse flow: see which absences still need an excuse,
 * file one against a specific lesson (not only the morning check), open it,
 * withdraw it while pending, and have approval flip that lesson's mark.
 */
describe('student excuse flow', () => {
  let db: Database;
  let student: string;
  let other: string;
  let teacher: string;

  beforeAll(async () => {
    db = await setupTestDb();
    student = (await createTestUser(db, { id: 'sf-stu', name: 'Ada', email: 'ada@s.test', roleLevel: 'STUDENT' })).token;
    other = (await createTestUser(db, { id: 'sf-other', name: 'Ben', email: 'ben@s.test', roleLevel: 'STUDENT' })).token;
    teacher = (await createTestUser(db, { id: 'sf-tch', name: 'Tia', email: 'tia@s.test', roleLevel: 'TEACHER' })).token;
    await db.run(`INSERT INTO subjects (id, name) VALUES (9, 'JavaScript')`);
  });

  beforeEach(async () => {
    await db.run('DELETE FROM attendance_records');
    await db.run('DELETE FROM excuse_requests');
    await db.run('DELETE FROM notifications');
  });

  const mark = (sessionType: 'homeroom' | 'subject', status: string, extra: Record<string, unknown> = {}) =>
    request(app).post('/api/attendance/mark').set(authHeader(teacher)).send({
      classId: 'cg-9', className: 'Grade 9A', date: '2026-09-14', period: 'Morning', sessionType,
      ...(sessionType === 'subject' ? { subjectId: 9 } : {}),
      records: [{ studentId: 'sf-stu', studentName: 'Ada', status }],
      ...extra,
    });

  const subjectExcuse = (overrides: Record<string, unknown> = {}) =>
    request(app).post('/api/attendance/excuse').set(authHeader(student)).send({
      classId: 'cg-9', className: 'Grade 9A', sessionDate: '2026-09-14', period: 'Morning',
      sessionType: 'subject', subjectId: 9, subjectName: 'JavaScript',
      reason: 'Medical', description: 'Dentist appointment, note attached.', ...overrides,
    });

  it('lists absences with whether an excuse already covers each', async () => {
    await mark('homeroom', 'present');
    await mark('subject', 'absent');

    const before = await request(app).get('/api/attendance/excuses/me/absences').set(authHeader(student));
    expect(before.status).toBe(200);
    expect(before.body.data).toHaveLength(1);
    expect(before.body.data[0]).toMatchObject({
      sessionType: 'subject', subjectId: 9, subjectName: 'JavaScript', className: 'Grade 9A', date: '2026-09-14', excuse: null,
    });

    const ex = await subjectExcuse();
    expect(ex.status).toBe(200);

    const after = await request(app).get('/api/attendance/excuses/me/absences').set(authHeader(student));
    expect(after.body.data[0].excuse).toMatchObject({ id: ex.body.data.id, status: 'pending' });
  });

  it('keeps a subject excuse distinct from the morning-check excuse on the same day', async () => {
    const hr = await request(app).post('/api/attendance/excuse').set(authHeader(student)).send({
      classId: 'cg-9', className: 'Grade 9A', sessionDate: '2026-09-14', reason: 'Family',
    });
    expect(hr.status).toBe(200);
    const sub = await subjectExcuse();
    expect(sub.status).toBe(200);
    const dup = await subjectExcuse();
    expect(dup.status).toBe(409);
  });

  it('rejects a subject excuse without a subject', async () => {
    const res = await subjectExcuse({ subjectId: undefined });
    expect(res.status).toBe(400);
  });

  it('shows one excuse in full — to its owner only', async () => {
    await mark('subject', 'absent');
    const ex = await subjectExcuse();
    const id = ex.body.data.id;

    const mine = await request(app).get(`/api/attendance/excuses/me/${id}`).set(authHeader(student));
    expect(mine.status).toBe(200);
    expect(mine.body.data).toMatchObject({ id, status: 'pending', subject_name: 'JavaScript', attendanceStatus: 'absent', supersedes: null, supersededBy: null });

    const theirs = await request(app).get(`/api/attendance/excuses/me/${id}`).set(authHeader(other));
    expect(theirs.status).toBe(404);
  });

  it('approving a subject excuse flips that lesson (and only that lesson) to excused', async () => {
    await mark('homeroom', 'absent');
    await mark('subject', 'absent');
    const ex = await subjectExcuse();

    const res = await request(app).put(`/api/attendance/excuse/${ex.body.data.id}/status`)
      .set(authHeader(teacher)).send({ status: 'approved' });
    expect(res.status).toBe(200);

    const rows = await db.all(`SELECT session_type, status FROM attendance_records WHERE student_id = 'sf-stu' ORDER BY session_type`);
    expect(rows).toEqual([{ session_type: 'homeroom', status: 'absent' }, { session_type: 'subject', status: 'excused' }]);

    const detail = await request(app).get(`/api/attendance/excuses/me/${ex.body.data.id}`).set(authHeader(student));
    expect(detail.body.data.attendanceStatus).toBe('excused');
    expect(detail.body.data.reviewed_by_name).toBe('Tia');
  });

  it('lets a student withdraw a pending request, but not a decided one', async () => {
    const ex = await subjectExcuse();
    const id = ex.body.data.id;

    const notMine = await request(app).delete(`/api/attendance/excuse/${id}`).set(authHeader(other));
    expect(notMine.status).toBe(404);

    const gone = await request(app).delete(`/api/attendance/excuse/${id}`).set(authHeader(student));
    expect(gone.status).toBe(200);
    expect(await db.get('SELECT 1 FROM excuse_requests WHERE id = ?', id)).toBeUndefined();

    const again = await subjectExcuse();
    await request(app).put(`/api/attendance/excuse/${again.body.data.id}/status`).set(authHeader(teacher)).send({ status: 'rejected' });
    const locked = await request(app).delete(`/api/attendance/excuse/${again.body.data.id}`).set(authHeader(student));
    expect(locked.status).toBe(409);
  });

  it('links an appeal to the request it follows up', async () => {
    const first = await subjectExcuse();
    await request(app).put(`/api/attendance/excuse/${first.body.data.id}/status`).set(authHeader(teacher)).send({ status: 'rejected', reviewerNote: 'No note' });
    const appeal = await subjectExcuse({ supersedesId: first.body.data.id, description: 'Attaching the doctor note now.' });
    expect(appeal.status).toBe(200);

    const detail = await request(app).get(`/api/attendance/excuses/me/${appeal.body.data.id}`).set(authHeader(student));
    expect(detail.body.data.supersedes).toMatchObject({ id: first.body.data.id, status: 'rejected', reviewer_note: 'No note' });
    const original = await request(app).get(`/api/attendance/excuses/me/${first.body.data.id}`).set(authHeader(student));
    expect(original.body.data.supersededBy).toMatchObject({ id: appeal.body.data.id });
  });
});
