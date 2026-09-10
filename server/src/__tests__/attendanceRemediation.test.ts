import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import { Database } from 'sqlite';
import { setupTestDb, createTestUser, authHeader } from './testUtils.js';
import { app } from '../app.js';

/**
 * Remediation coverage: A1 (no duplicate registers), A2 (read a register back),
 * A5 (input validation), A13 (audit + history), X3 (term from the record's date).
 */
describe('Attendance remediation — recording, editing, validation', () => {
  let db: Database;
  let teacherToken: string;
  let teacherId = 'teacher-rem';

  const mark = (body: Record<string, unknown>) =>
    request(app).post('/api/attendance/mark').set(authHeader(teacherToken)).send(body);

  const base = {
    classId: 'class-9', className: 'Grade 9A', date: '2026-05-11', period: 'Morning',
  };

  beforeAll(async () => {
    db = await setupTestDb();
    teacherToken = (await createTestUser(db, {
      id: teacherId, name: 'Tess Teacher', email: 'tess@school.test', roleLevel: 'TEACHER',
    })).token;
    await db.run(`INSERT INTO subjects (id, name) VALUES (7, 'History')`);
  });

  beforeEach(async () => {
    await db.run(`DELETE FROM attendance_records`);
    await db.run(`DELETE FROM attendance_record_history`);
    await db.run(`DELETE FROM audit_log`);
    await db.run(`DELETE FROM academic_terms`);
    await db.run(`DELETE FROM academic_years`);
  });

  it('A1: re-marking a homeroom register updates in place — one row per student', async () => {
    await mark({ ...base, records: [{ studentId: 's1', studentName: 'Sam One', status: 'absent' }] });
    await mark({ ...base, records: [{ studentId: 's1', studentName: 'Sam One', status: 'present' }] });
    await mark({ ...base, records: [{ studentId: 's1', studentName: 'Sam One', status: 'late' }] });

    const rows = await db.all(
      `SELECT * FROM attendance_records WHERE student_id = 's1' AND session_type = 'homeroom'`
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('late');
  });

  it('A1: a homeroom re-mark never touches the subject register for the same slot', async () => {
    await mark({ ...base, records: [{ studentId: 's1', studentName: 'Sam One', status: 'present' }] });
    await mark({ ...base, sessionType: 'subject', subjectId: 7, records: [{ studentId: 's1', studentName: 'Sam One', status: 'absent' }] });
    await mark({ ...base, records: [{ studentId: 's1', studentName: 'Sam One', status: 'late' }] });

    const rows = await db.all(`SELECT session_type, status FROM attendance_records WHERE student_id = 's1' ORDER BY session_type`);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.session_type === 'homeroom')!.status).toBe('late');
    expect(rows.find((r) => r.session_type === 'subject')!.status).toBe('absent');
  });

  it('A5: rejects a future date, an unknown period, an empty roster and an over-cap roster', async () => {
    const future = new Date(Date.now() + 3 * 864e5).toISOString().split('T')[0];
    expect((await mark({ ...base, date: future, records: [{ studentId: 's1', studentName: 'S', status: 'present' }] })).status).toBe(400);
    expect((await mark({ ...base, period: 'morning', records: [{ studentId: 's1', studentName: 'S', status: 'present' }] })).status).toBe(400);
    expect((await mark({ ...base, records: [] })).status).toBe(400);
    const many = Array.from({ length: 301 }, (_, i) => ({ studentId: `s${i}`, studentName: 'S', status: 'present' }));
    expect((await mark({ ...base, records: many })).status).toBe(400);
  });

  it('A5: rejects an invalid status inside a record', async () => {
    const res = await mark({ ...base, records: [{ studentId: 's1', studentName: 'S', status: 'here' }] });
    expect(res.status).toBe(400);
  });

  it('A2: GET /session returns the stored per-student statuses, not "all present"', async () => {
    await mark({ ...base, records: [
      { studentId: 's1', studentName: 'Sam One', status: 'absent', notes: 'sick' },
      { studentId: 's2', studentName: 'Sue Two', status: 'late' },
    ] });

    const res = await request(app)
      .get('/api/attendance/session')
      .query({ classId: base.classId, date: base.date, period: 'Morning', sessionType: 'homeroom' })
      .set(authHeader(teacherToken));

    expect(res.status).toBe(200);
    expect(res.body.data.exists).toBe(true);
    expect(res.body.data.markedByMe).toBe(true);
    const byId = Object.fromEntries(res.body.data.records.map((r: any) => [r.studentId, r]));
    expect(byId.s1.status).toBe('absent');
    expect(byId.s1.notes).toBe('sick');
    expect(byId.s2.status).toBe('late');
  });

  it('A13: overwriting a register writes a history row with the previous value and an audit row', async () => {
    await mark({ ...base, records: [{ studentId: 's1', studentName: 'Sam One', status: 'absent' }] });
    await mark({ ...base, records: [{ studentId: 's1', studentName: 'Sam One', status: 'present' }] });

    const history = await db.all(`SELECT * FROM attendance_record_history WHERE student_id = 's1'`);
    expect(history).toHaveLength(1);
    expect(history[0].previous_status).toBe('absent');
    expect(history[0].new_status).toBe('present');
    expect(history[0].changed_by).toBe(teacherId);

    const audits = await db.all(`SELECT * FROM audit_log WHERE entity_type = 'attendance_session'`);
    expect(audits.length).toBeGreaterThanOrEqual(2);
    expect(audits.some((a) => a.action === 'attendance.update')).toBe(true);
  });

  it('A13: confirming a register unchanged writes no history row', async () => {
    await mark({ ...base, records: [{ studentId: 's1', studentName: 'Sam One', status: 'present' }] });
    await mark({ ...base, records: [{ studentId: 's1', studentName: 'Sam One', status: 'present' }] });
    const history = await db.all(`SELECT * FROM attendance_record_history WHERE student_id = 's1'`);
    expect(history).toHaveLength(0);
  });

  it('A17: /records returns session_type + subject_name and can filter by session type', async () => {
    await mark({ ...base, records: [{ studentId: 's1', studentName: 'Sam One', status: 'present' }] });
    await mark({ ...base, sessionType: 'subject', subjectId: 7, records: [{ studentId: 's1', studentName: 'Sam One', status: 'late' }] });

    const all = await request(app).get('/api/attendance/records').query({ classId: base.classId }).set(authHeader(teacherToken));
    expect(all.body.data.length).toBe(2);
    const subjRow = all.body.data.find((r: any) => r.session_type === 'subject');
    expect(subjRow.subject_name).toBe('History');

    const subjectOnly = await request(app).get('/api/attendance/records')
      .query({ classId: base.classId, sessionType: 'subject' }).set(authHeader(teacherToken));
    expect(subjectOnly.body.data.length).toBe(1);
  });

  it('X3: a back-dated register is filed under the term its date falls in', async () => {
    await db.run(`INSERT INTO academic_years (id, name) VALUES (1, '2025-2026')`);
    await db.run(
      `INSERT INTO academic_terms (id, academic_year_id, name, start_date, end_date)
       VALUES (2, 1, 'Term 1', '2025-09-01', '2025-12-15'), (3, 1, 'Term 2', '2026-01-10', '2026-04-30')`
    );

    await mark({ ...base, date: '2025-10-02', records: [{ studentId: 's1', studentName: 'Sam One', status: 'present' }] });

    const row = await db.get(`SELECT academic_term_id, academic_year_id FROM attendance_records WHERE student_id = 's1'`);
    expect(row.academic_term_id).toBe(2);
    expect(row.academic_year_id).toBe(1);
  });
});
