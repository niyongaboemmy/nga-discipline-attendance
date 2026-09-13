import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { Database } from 'sqlite';
import { setupTestDb, createTestUser, authHeader } from './testUtils.js';
import { app } from '../app.js';

describe('Unified reporting module (C: termly / combined)', () => {
  let db: Database;
  let adminToken: string;
  let studentToken: string;

  beforeAll(async () => {
    db = await setupTestDb();
    adminToken = (await createTestUser(db, { id: 'admin-2', name: 'Ada Admin', email: 'ada2@school.test', roleLevel: 'ADMIN' })).token;
    studentToken = (await createTestUser(db, { id: 'student-2', name: 'Riley Risky', email: 'riley@school.test', roleLevel: 'STUDENT' })).token;

    // Seed a student with both low attendance and low conduct balance, so
    // the combined-risk view has something to surface.
    for (let i = 0; i < 5; i++) {
      await db.run(
        `INSERT INTO attendance_records (student_id, student_name, class_id, class_name, session_date, status, marked_by)
         VALUES (?, ?, 'class-9', 'Grade 9A', ?, ?, 'admin-2')`,
        'student-2', 'Riley Risky', `2026-03-0${i + 1}`, i < 1 ? 'present' : 'absent'
      );
    }
    // 25 points pushes the term balance to 75 — under the combined report's
    // 80-point "at risk" threshold (see reporting.service.ts), same
    // threshold the low-attendance check uses for its own 80% cutoff.
    await db.run(
      `INSERT INTO discipline_records (student_id, student_name, type, category, severity, points, title, incident_date, logged_by, logged_by_name)
       VALUES ('student-2', 'Riley Risky', 'demerit', 'Misconduct', 'major', 25, 'Fight', '2026-03-02', 'admin-2', 'Ada Admin')`
    );
  });

  it('rejects unauthenticated reporting requests', async () => {
    const res = await request(app).get('/api/reporting/termly');
    expect(res.status).toBe(401);
  });

  it('a student without REPORTS_VIEW is denied', async () => {
    const res = await request(app).get('/api/reporting/termly').set(authHeader(studentToken));
    expect(res.status).toBe(403);
  });

  it('returns a termly report combining attendance and discipline summaries', async () => {
    const res = await request(app).get('/api/reporting/termly').set(authHeader(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.data.attendance.totalRecords).toBe(5);
    expect(res.body.data.discipline.totalRecords).toBe(1);
    expect(res.body.data.attendance.overallRate).toBe(20); // 1 present of 5
  });

  it('surfaces the combined-risk student (low attendance AND low conduct balance)', async () => {
    const res = await request(app).get('/api/reporting/combined').set(authHeader(adminToken));
    expect(res.status).toBe(200);
    const risky = res.body.data.studentsAtCombinedRisk.find((s: any) => s.studentId === 'student-2');
    expect(risky).toBeTruthy();
    expect(risky.attendanceRate).toBe(20);
    expect(risky.conductBalance).toBe(75); // 100 - 25
  });

  it('rejects /compare without both term ids', async () => {
    const res = await request(app).get('/api/reporting/compare').set(authHeader(adminToken));
    expect(res.status).toBe(400);
  });

  it('compares two distinct terms; legacy (NULL-term) rows count under both, so deltas are zero', async () => {
    const res = await request(app).get('/api/reporting/compare?term_a=101&term_b=102').set(authHeader(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.data.termA.academicTermId).toBe(101);
    expect(res.body.data.termB.academicTermId).toBe(102);
    expect(res.body.data.deltas).toEqual({ attendanceRate: 0, disciplineAverageBalance: 0, demerits: 0, merits: 0 });
  });

  // Class -> subject attendance report routes (attendanceReport.service.ts)
  // reuse the same router-level REPORTS_VIEW gate — smoke-test the wiring
  // here; the report-building logic itself is covered by
  // attendanceReport.service.test.ts.
  it('lists reportable classes for an authorized caller', async () => {
    const res = await request(app).get('/api/reporting/attendance/classes').set(authHeader(adminToken));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.some((c: any) => c.classId === 'class-9')).toBe(true);
  });

  it('denies a student without REPORTS_VIEW from the class register endpoint', async () => {
    const res = await request(app).get('/api/reporting/attendance/class/class-9').set(authHeader(studentToken));
    expect(res.status).toBe(403);
  });

  it('requires subject_id when session_type=subject', async () => {
    const res = await request(app)
      .get('/api/reporting/attendance/class/class-9?session_type=subject')
      .set(authHeader(adminToken));
    expect(res.status).toBe(400);
  });

  it('returns the homeroom register for a class by default', async () => {
    const res = await request(app).get('/api/reporting/attendance/class/class-9').set(authHeader(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.data.sessionType).toBe('homeroom');
    const risky = res.body.data.students.find((s: any) => s.studentId === 'student-2');
    expect(risky).toBeTruthy();
    expect(risky.rate).toBe(20);
  });

  // A student holds ATTENDANCE_REPORT_VIEW_OWN but not REPORTS_VIEW — the
  // /attendance/me/* routes must accept that on their own (registered before
  // the router-wide REPORTS_VIEW gate), while every other route in this
  // router stays off-limits to them.
  it("lets a student reach their own report but nothing else in this router", async () => {
    const sections = await request(app).get('/api/reporting/attendance/me/sections').set(authHeader(studentToken));
    expect(sections.status).toBe(200);

    const report = await request(app).get('/api/reporting/attendance/me/report').set(authHeader(studentToken));
    expect(report.status).toBe(200);
    expect(report.body.data.sessionType).toBe('homeroom');
    // student-2 has attendance seeded under class-9 earlier in this file.
    expect(report.body.data.students.every((s: any) => s.studentId === 'student-2')).toBe(true);

    expect((await request(app).get('/api/reporting/attendance/classes').set(authHeader(studentToken))).status).toBe(403);
    expect((await request(app).get('/api/reporting/termly').set(authHeader(studentToken))).status).toBe(403);
  });

  it("lets a student load their own all-subjects comparison view", async () => {
    const res = await request(app).get('/api/reporting/attendance/me/subjects').set(authHeader(studentToken));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data[0]).toHaveProperty('hasData');
  });
});
