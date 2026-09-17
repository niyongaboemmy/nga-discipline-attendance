import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { Database } from 'sqlite';
import { config } from '../config.js';
import { setupTestDb, createTestUser, authHeader } from './testUtils.js';
import { app } from '../app.js';

/** GET /api/reports/overview backs both the personal Dashboard (which asks
 *  for ?scope=me) and the explicitly whole-school /reports page (which
 *  doesn't) -- the two must never see each other's numbers by accident. */
describe('GET /api/reports/overview', () => {
  let db: Database;
  let adminToken: string;
  let teacherToken: string;

  beforeAll(async () => {
    db = await setupTestDb();
    adminToken = (await createTestUser(db, { id: 'admin-ov', name: 'Ada Admin', email: 'ada-ov@school.test', roleLevel: 'ADMIN' })).token;
    // createTestUser's own token has no `misToken` claim (there's no live
    // MIS in tests to ask), so this one is signed by hand to add it -- the
    // rest mirrors exactly what createTestUser does.
    await createTestUser(db, { id: 'teacher-ov', name: 'Tomas Teacher', email: 'tomas-ov@school.test', roleLevel: 'TEACHER' });
    teacherToken = jwt.sign(
      { id: 'teacher-ov', name: 'Tomas Teacher', email: 'tomas-ov@school.test', role: 'teacher', misToken: 'mis-tkn' },
      config.jwtSecret, { expiresIn: '1h' }
    );

    // Two classes, so an unscoped view and a class-teacher-scoped view give
    // visibly different numbers -- cls-a all present (100%), cls-b half
    // present (50%).
    const rows: Array<[string, string, string, string, string, string]> = [
      ['s1', 'Amina', 'cls-a', 'Class A', '2026-03-02', 'present'],
      ['s1', 'Amina', 'cls-a', 'Class A', '2026-03-03', 'present'],
      ['s2', 'Ben', 'cls-b', 'Class B', '2026-03-02', 'present'],
      ['s2', 'Ben', 'cls-b', 'Class B', '2026-03-03', 'absent'],
    ];
    for (const [studentId, studentName, classId, className, date, status] of rows) {
      await db.run(
        `INSERT INTO attendance_records
           (student_id, student_name, class_id, class_name, session_date, period, session_type, status, marked_by)
         VALUES (?, ?, ?, ?, ?, 'Morning', 'homeroom', ?, 'admin-ov')`,
        studentId, studentName, classId, className, date, status
      );
    }
  });

  it('rejects unauthenticated requests', async () => {
    const res = await request(app).get('/api/reports/overview');
    expect(res.status).toBe(401);
  });

  it('is whole-school by default, even for a user with a live MIS class-teacher assignment', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      data: [{ class_group_id: 'cls-a', class_group_name: 'Class A', academic_year_is_current: 1 }],
    }), { status: 200 })));

    // No ?scope=me -- must not narrow to cls-a even though this teacher IS
    // its class teacher, matching /reports.tsx's plain call.
    const res = await request(app).get('/api/reports/overview').set(authHeader(teacherToken));
    expect(res.status).toBe(200);
    expect(res.body.data.scope).toEqual({ isClassTeacher: false });
    expect(res.body.data.classes.map((c: { classId: string }) => c.classId).sort()).toEqual(['cls-a', 'cls-b']);
    expect(res.body.data.overallRate).toBe(75); // 3 of 4 present, school-wide
    vi.unstubAllGlobals();
  });

  it('?scope=me narrows a class teacher to their own class, and leaves everyone else unscoped', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      data: [{ class_group_id: 'cls-a', class_group_name: 'Class A', academic_year_is_current: 1 }],
    }), { status: 200 })));

    const scoped = await request(app).get('/api/reports/overview?scope=me').set(authHeader(teacherToken));
    expect(scoped.status).toBe(200);
    expect(scoped.body.data.scope).toEqual({ isClassTeacher: true, classIds: ['cls-a'], classNames: ['Class A'] });
    expect(scoped.body.data.classes.map((c: { classId: string }) => c.classId)).toEqual(['cls-a']);
    expect(scoped.body.data.overallRate).toBe(100); // cls-a only
    expect(scoped.body.data.atRiskCount).toBe(0);
    vi.unstubAllGlobals();

    // An admin asking for ?scope=me has no personal class assignment to
    // narrow to -- stays whole-school regardless of the flag.
    const adminScoped = await request(app).get('/api/reports/overview?scope=me').set(authHeader(adminToken));
    expect(adminScoped.body.data.scope).toEqual({ isClassTeacher: false });
    expect(adminScoped.body.data.atRiskCount).toBeNull();
  });

  it('?scope=me scopes to ALL of a teacher\'s assigned classes, not just the first', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      data: [
        { class_group_id: 'cls-a', class_group_name: 'Class A', academic_year_is_current: 1 },
        { class_group_id: 'cls-b', class_group_name: 'Class B', academic_year_is_current: 1 },
      ],
    }), { status: 200 })));

    const res = await request(app).get('/api/reports/overview?scope=me').set(authHeader(teacherToken));
    expect(res.status).toBe(200);
    expect(res.body.data.scope).toEqual({ isClassTeacher: true, classIds: ['cls-a', 'cls-b'], classNames: ['Class A', 'Class B'] });
    expect(res.body.data.classes.map((c: { classId: string }) => c.classId).sort()).toEqual(['cls-a', 'cls-b']);
    expect(res.body.data.overallRate).toBe(75); // both classes, same as the whole-school number here
    vi.unstubAllGlobals();
  });

  it('projects a trend when there is enough daily data, and null when there is not', async () => {
    // Only 2 distinct session dates exist in the base seed data (2026-03-02,
    // 2026-03-03) -- below the 3-day floor computeProjection requires.
    const thin = await request(app).get('/api/reports/overview').set(authHeader(adminToken));
    expect(thin.body.data.projection).toBeNull();

    // Add a clear downward trend: 100% -> 50% -> 33% present (never actually
    // hits the 0% floor, so the projection going lower still is a
    // meaningful assertion rather than both sides clamping to 0).
    const trendRows: Array<[string, string, string]> = [
      ['s-trend-1', '2026-04-01', 'present'], ['s-trend-2', '2026-04-01', 'present'], ['s-trend-3', '2026-04-01', 'present'],
      ['s-trend-1', '2026-04-02', 'present'], ['s-trend-2', '2026-04-02', 'absent'], ['s-trend-3', '2026-04-02', 'present'],
      ['s-trend-1', '2026-04-03', 'present'], ['s-trend-2', '2026-04-03', 'absent'], ['s-trend-3', '2026-04-03', 'absent'],
    ];
    for (const [studentId, date, status] of trendRows) {
      await db.run(
        `INSERT INTO attendance_records
           (student_id, student_name, class_id, class_name, session_date, period, session_type, status, marked_by)
         VALUES (?, 'Trend Student', 'cls-trend', 'Trend Class', ?, 'Morning', 'homeroom', ?, 'admin-ov')`,
        studentId, date, status
      );
    }

    const res = await request(app).get('/api/reports/overview').set(authHeader(adminToken));
    expect(res.body.data.projection).not.toBeNull();
    expect(res.body.data.projection.direction).toBe('down');
    expect(res.body.data.projection.projectedRate).toBeLessThan(res.body.data.trends.at(-1).rate);
  });

  afterEach(() => vi.unstubAllGlobals());
});
