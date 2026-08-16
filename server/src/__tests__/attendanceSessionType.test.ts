import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { Database } from 'sqlite';
import { setupTestDb, createTestUser, authHeader } from './testUtils.js';
import { app } from '../app.js';

describe('Homeroom vs. subject attendance (A.1.1 / A.1.2)', () => {
  let db: Database;
  let teacherToken: string;

  beforeAll(async () => {
    db = await setupTestDb();
    teacherToken = (await createTestUser(db, { id: 'teacher-2', name: 'Tara Teacher', email: 't2@school.test', roleLevel: 'TEACHER' })).token;
    await db.run(`INSERT INTO subjects (id, name) VALUES (1, 'Mathematics')`);
  });

  it('marks homeroom attendance (A.1.1) with session_type defaulting to homeroom', async () => {
    const res = await request(app)
      .post('/api/attendance/mark')
      .set(authHeader(teacherToken))
      .send({
        classId: 'class-1', className: 'Grade 9A', date: '2026-02-10', period: 'Morning',
        records: [{ studentId: 'student-1', studentName: 'Sam Student', status: 'present' }],
      });
    expect(res.status).toBe(200);

    const row = await db.get(
      `SELECT * FROM attendance_records WHERE student_id = 'student-1' AND class_id = 'class-1' AND session_date = '2026-02-10'`
    );
    expect(row.session_type).toBe('homeroom');
    expect(row.subject_id).toBeNull();
  });

  it('requires subjectId when sessionType is "subject" (A.1.2)', async () => {
    const res = await request(app)
      .post('/api/attendance/mark')
      .set(authHeader(teacherToken))
      .send({
        classId: 'class-1', className: 'Grade 9A', date: '2026-02-10', period: 'P1',
        sessionType: 'subject',
        records: [{ studentId: 'student-1', studentName: 'Sam Student', status: 'present' }],
      });
    expect(res.status).toBe(400);
  });

  it('marks subject attendance for the same student/class/date/period without colliding with the homeroom record', async () => {
    const res = await request(app)
      .post('/api/attendance/mark')
      .set(authHeader(teacherToken))
      .send({
        classId: 'class-1', className: 'Grade 9A', date: '2026-02-10', period: 'Morning',
        sessionType: 'subject', subjectId: 1,
        records: [{ studentId: 'student-1', studentName: 'Sam Student', status: 'late' }],
      });
    expect(res.status).toBe(200);

    const rows = await db.all(
      `SELECT * FROM attendance_records WHERE student_id = 'student-1' AND class_id = 'class-1' AND session_date = '2026-02-10' ORDER BY session_type`
    );
    expect(rows).toHaveLength(2);
    const homeroom = rows.find((r: any) => r.session_type === 'homeroom');
    const subject = rows.find((r: any) => r.session_type === 'subject');
    expect(homeroom.status).toBe('present');
    expect(subject.status).toBe('late');
    expect(subject.subject_id).toBe(1);
  });

  it('re-marking the same subject session updates the existing row instead of duplicating it', async () => {
    await request(app)
      .post('/api/attendance/mark')
      .set(authHeader(teacherToken))
      .send({
        classId: 'class-1', className: 'Grade 9A', date: '2026-02-10', period: 'Morning',
        sessionType: 'subject', subjectId: 1,
        records: [{ studentId: 'student-1', studentName: 'Sam Student', status: 'present' }],
      });

    const rows = await db.all(
      `SELECT * FROM attendance_records WHERE student_id = 'student-1' AND class_id = 'class-1' AND session_date = '2026-02-10' AND session_type = 'subject'`
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('present');
  });

  it('lists subject attendance via GET /attendance/subject/:subjectId', async () => {
    const res = await request(app).get('/api/attendance/subject/1').set(authHeader(teacherToken));
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(1);
    expect(res.body.data[0].subject_id).toBe(1);
  });
});
