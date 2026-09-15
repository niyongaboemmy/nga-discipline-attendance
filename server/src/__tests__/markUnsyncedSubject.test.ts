import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { Database } from 'sqlite';
import { setupTestDb, createTestUser, authHeader } from './testUtils.js';
import { config } from '../config.js';
import { app } from '../app.js';

/**
 * attendance_records.subject_id is a foreign key to the local `subjects`
 * cache, which only the admin roster sync fills. Saving a subject register
 * for a subject that hadn't been synced failed with
 * "SQLITE_CONSTRAINT: FOREIGN KEY constraint failed" — the teacher's save
 * must instead seed the cache row itself.
 */
describe('POST /mark for a subject that is not in the local cache', () => {
  let db: Database;
  let teacher: string;
  let teacherWithMis: string;

  beforeAll(async () => {
    db = await setupTestDb();
    teacher = (await createTestUser(db, { id: 'us-tch', name: 'Tia', email: 't@s.test', roleLevel: 'TEACHER' })).token;
    teacherWithMis = jwt.sign(
      { id: 'us-tch', name: 'Tia', email: 't@s.test', role: 'teacher', misToken: 'mis-x' },
      config.jwtSecret, { expiresIn: '1h' }
    );
  });
  beforeEach(async () => {
    await db.run('DELETE FROM attendance_records');
    await db.run('DELETE FROM subjects');
  });
  afterEach(() => vi.unstubAllGlobals());

  const mark = (token: string, subjectId: number, subjectName?: string) =>
    request(app).post('/api/attendance/mark').set(authHeader(token)).send({
      classId: 'cg-9', className: 'Grade 9A', date: '2026-09-14', period: 'Morning', sessionType: 'subject', subjectId, subjectName,
      records: [{ studentId: 's1', studentName: 'Ada', status: 'present' }],
    });

  it('saves, seeding the subject from the name the client sent', async () => {
    const res = await mark(teacher, 42, 'JavaScript');
    expect(res.status).toBe(200);
    expect(await db.get('SELECT name FROM subjects WHERE id = 42')).toEqual({ name: 'JavaScript' });
    expect(await db.get(`SELECT COUNT(*) AS n FROM attendance_records WHERE subject_id = 42`)).toEqual({ n: 1 });
  });

  it('prefers the MIS record when it can reach it', async () => {
    // With a MIS token the route also checks the subject is on the class's
    // curriculum, so the stub has to answer that lookup as well.
    const reply = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 });
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes('/academics/class-groups')) return reply([{ class_group_id: 'cg-9', grade_id: 3 }]);
      if (u.includes('/academics/grades/3/subjects')) return reply([{ subject_id: 7 }]);
      if (u.includes('/academics/subjects')) return reply([{ subject_id: 7, name: 'Physics', code: 'PHY' }]);
      return reply([]);
    }));
    const res = await mark(teacherWithMis, 7, 'physics (typed)');
    expect(res.status).toBe(200);
    expect(await db.get('SELECT name, code FROM subjects WHERE id = 7')).toEqual({ name: 'Physics', code: 'PHY' });
  });

  it('still saves with a placeholder when neither a name nor the MIS is available', async () => {
    // No MIS token → no curriculum check, no MIS lookup: the placeholder path.
    const res = await mark(teacher, 99);
    expect(res.status).toBe(200);
    expect(await db.get('SELECT name FROM subjects WHERE id = 99')).toEqual({ name: 'Subject 99' });
  });

  it('leaves an already-synced subject untouched', async () => {
    await db.run(`INSERT INTO subjects (id, name, code) VALUES (5, 'Mathematics', 'MAT')`);
    const res = await mark(teacher, 5, 'Maths (client name)');
    expect(res.status).toBe(200);
    expect(await db.get('SELECT name, code FROM subjects WHERE id = 5')).toEqual({ name: 'Mathematics', code: 'MAT' });
  });
});
