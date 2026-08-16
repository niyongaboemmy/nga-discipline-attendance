import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { Database } from 'sqlite';
import { app } from '../app.js';
import { setupTestDb, createTestUser, authHeader } from './testUtils.js';

/**
 * The Missing Attendance dashboard is only useful if a class with no register
 * is impossible to miss. These tests pin the two things that could silently
 * break that: a marked class must never be reported as missing, and the page
 * must still render when the MIS class list is unavailable (the fallback then
 * degrades to "classes we know about because they were marked").
 */
describe('GET /api/attendance/coverage', () => {
  let db: Database;
  let teacherToken: string;
  let studentToken: string;
  const date = '2026-08-14';

  beforeAll(async () => {
    db = await setupTestDb();
    teacherToken = (
      await createTestUser(db, { id: 'cov-teacher', name: 'Tom', email: 't@cov.test', roleLevel: 'TEACHER' })
    ).token;
    studentToken = (
      await createTestUser(db, { id: 'cov-student', name: 'Sam', email: 's@cov.test', roleLevel: 'STUDENT' })
    ).token;

    // attendance_records.subject_id is a real FK — a subject register can't
    // exist for a subject the app has never synced.
    await db.run(`INSERT INTO subjects (id, name, code) VALUES (11, 'Mathematics', 'MTH'), (12, 'Biology', 'BIO')`);

    const mark = (body: Record<string, unknown>) =>
      request(app).post('/api/attendance/mark').set(authHeader(teacherToken)).send({
        className: 'Year 2 A',
        date,
        period: 'Morning',
        records: [{ studentId: 's1', studentName: 'One', status: 'present' }],
        ...body,
      });

    await mark({ classId: 'cov-a', sessionType: 'homeroom' });
    await mark({ classId: 'cov-a', sessionType: 'subject', subjectId: 11, period: 'Afternoon' });
    // A class touched only by a subject register — homeroom is still missing.
    await mark({ classId: 'cov-b', className: 'Year 3 B', sessionType: 'subject', subjectId: 12 });
  });

  const coverage = (query: Record<string, string> = {}, token = teacherToken) =>
    request(app).get('/api/attendance/coverage').query({ date, ...query }).set(authHeader(token));

  it('requires ATTENDANCE_VIEW_ALL', async () => {
    expect((await coverage({}, studentToken)).status).toBe(403);
  });

  it('validates the date format', async () => {
    const res = await coverage({ date: '14-08-2026' });
    expect(res.status).toBe(400);
  });

  it('reports per-class status and totals', async () => {
    const res = await coverage();
    expect(res.status).toBe(200);

    const rows: any[] = res.body.data.classes;
    const a = rows.find((r) => r.classId === 'cov-a');
    const b = rows.find((r) => r.classId === 'cov-b');

    expect(a.homeroomRecorded).toBe(true);
    expect(a.subjectsRecorded).toBe(1);
    expect(b.homeroomRecorded).toBe(false);
    expect(b.subjectsRecorded).toBe(1);

    expect(res.body.data.totals.homeroomTaken).toBe(1);
    expect(res.body.data.totals.classesWithAnySubject).toBe(2);
  });

  it('shows nothing recorded on a day with no registers', async () => {
    const res = await coverage({ date: '2026-08-15' });
    expect(res.status).toBe(200);
    expect(res.body.data.classes.every((c: any) => !c.homeroomRecorded)).toBe(true);
  });

  it('returns detail for one class, including subjects marked off-curriculum', async () => {
    const res = await coverage({ classId: 'cov-a' });
    expect(res.status).toBe(200);
    expect(res.body.data.homeroom.recorded).toBe(true);

    // No MIS curriculum available in tests, so the only subject listed is the
    // one actually marked — it must never be dropped just because the
    // curriculum lookup came back empty.
    const subject = res.body.data.subjects.find((s: any) => s.id === 11);
    expect(subject).toBeTruthy();
    expect(subject.recorded).toBe(true);
    expect(res.body.data.curriculumKnown).toBe(false);
  });

  it('reports a class with no registers at all as fully missing', async () => {
    const res = await coverage({ classId: 'cov-z' });
    expect(res.status).toBe(200);
    expect(res.body.data.homeroom.recorded).toBe(false);
    expect(res.body.data.subjects).toEqual([]);
  });
});
