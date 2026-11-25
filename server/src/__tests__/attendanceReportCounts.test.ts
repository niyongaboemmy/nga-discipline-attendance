import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { Database } from 'sqlite';
import { setupTestDb, createTestUser, authHeader } from './testUtils.js';
import { app } from '../app.js';
import { getClassSectionReport, getOwnSectionReport } from '../modules/reporting/attendanceReport.service.js';
import { getAttendanceSummary, getAnnualReport } from '../modules/reporting/reporting.service.js';

/**
 * Attendance reports count only the rows that should count
 * (shared/attendanceScope.ts):
 *  - inactive / removed students and students taken out of the class are left out;
 *  - a row with no term id belongs to the term its date falls in, not to every term;
 *  - two registers on one day are two columns, so cells match the totals;
 *  - attended = present + late + excused on the dashboard too.
 */
describe('attendance report counting', () => {
  let db: Database;
  let adminToken: string;

  const mark = (
    student: string, name: string, classId: string, date: string, status: string,
    opts: { period?: string; term?: number | null; year?: number | null; type?: 'homeroom' | 'subject'; subject?: number | null } = {}
  ) => db.run(
    `INSERT INTO attendance_records
       (student_id, student_name, class_id, class_name, session_date, period, session_type, subject_id, status, marked_by,
        academic_year_id, academic_term_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'x', ?, ?)`,
    student, name, classId, `Class ${classId}`, date, opts.period ?? 'Morning', opts.type ?? 'homeroom',
    opts.subject ?? null, status, opts.year === undefined ? 9 : opts.year, opts.term === undefined ? 91 : opts.term
  );

  beforeAll(async () => {
    db = await setupTestDb();
    adminToken = (await createTestUser(db, { id: 'adm-cnt', name: 'Admin', email: 'adm-cnt@school.test', roleLevel: 'ADMIN' })).token;

    await db.run(`INSERT INTO academic_years (id, name, start_date, end_date, is_current) VALUES (9, '2026', '2026-01-01', '2026-12-31', 1)`);
    await db.run(`INSERT INTO academic_terms (id, academic_year_id, name, start_date, end_date) VALUES
      (91, 9, 'Term 1', '2026-01-05', '2026-03-31'),
      (92, 9, 'Term 2', '2026-04-20T00:00:00.000Z', '2026-07-10T00:00:00.000Z')`);
    await db.run(`INSERT INTO subjects (id, name) VALUES (7, 'Mathematics')`);

    // Roster for class 50, year 9: a1 active, a2 taken out of the class, a3 in
    // the class but their account is disabled on the MIS, a4 removed from the MIS.
    const now = new Date().toISOString();
    for (const [id, name, status] of [['a1', 'Amina', 'ACTIVE'], ['a2', 'Bosco', 'ACTIVE'], ['a3', 'Claire', 'INACTIVE'], ['a4', 'Didier', 'REMOVED']]) {
      await db.run(`INSERT INTO roster_students (student_id, name, mis_status, synced_at) VALUES (?, ?, ?, ?)`, id, name, status, now);
    }
    for (const [id, status] of [['a1', 'ACTIVE'], ['a2', 'DISABLED'], ['a3', 'ACTIVE'], ['a4', 'ACTIVE']]) {
      await db.run(
        `INSERT INTO roster_enrolments (student_id, class_id, academic_year_id, status, synced_at) VALUES (?, '50', 9, ?, ?)`,
        id, status, now
      );
    }
    // A local account disabled in Tendo itself (no roster row).
    await createTestUser(db, { id: 'a5', name: 'Eric', email: 'a5@school.test', roleLevel: 'STUDENT' });
    await db.run(`UPDATE users SET status = 'inactive' WHERE id = 'a5'`);

    for (const s of [['a1', 'Amina'], ['a2', 'Bosco'], ['a3', 'Claire'], ['a4', 'Didier'], ['a5', 'Eric']]) {
      await mark(s[0], s[1], '50', '2026-02-02', 'absent');
      await mark(s[0], s[1], '50', '2026-02-03', 'absent');
    }
    await mark('a1', 'Amina', '50', '2026-02-04', 'excused');

    // Class 60 is not on the roster at all: its students are kept (unknown).
    await mark('u1', 'Uwase', '60', '2026-02-02', 'present', { year: null });

    // Untermed rows: one in Term 1's dates, one in Term 2's.
    await mark('a1', 'Amina', '50', '2026-02-05', 'present', { term: null });
    await mark('a1', 'Amina', '50', '2026-05-04', 'absent', { term: null });

    // Two lessons of one subject on the same day.
    await mark('a1', 'Amina', '50', '2026-02-10', 'present', { type: 'subject', subject: 7, period: 'Morning' });
    await mark('a1', 'Amina', '50', '2026-02-10', 'absent', { type: 'subject', subject: 7, period: 'Afternoon' });
    await mark('a1', 'Amina', '50', '2026-02-11', 'present', { type: 'subject', subject: 7, period: 'Morning' });
  });

  it('the class register leaves out inactive, removed and moved-out students', async () => {
    const r = await getClassSectionReport(db, { classId: '50', academicTermId: 91, sessionType: 'homeroom' });
    expect(r.students.map((s) => s.studentId)).toEqual(['a1']);
    const a1 = r.students[0];
    // 2 absent + 1 excused + the untermed Term-1 row (present); not the Term-2 one.
    expect(a1).toMatchObject({ absent: 2, excused: 1, present: 1, total: 4, rate: 50 });
  });

  it('keeps students of a class the roster has never seen', async () => {
    const r = await getClassSectionReport(db, { classId: '60', academicTermId: 91, sessionType: 'homeroom' });
    expect(r.students.map((s) => s.studentId)).toEqual(['u1']);
  });

  it('a student still sees their own history after leaving the class', async () => {
    const own = await getOwnSectionReport(db, 'a2', { academicTermId: 91, sessionType: 'homeroom' });
    expect(own.students).toHaveLength(1);
    expect(own.students[0]).toMatchObject({ studentId: 'a2', absent: 2, total: 2 });
  });

  it('an untermed row counts in the term its date falls in, once', async () => {
    const t1 = await getAttendanceSummary(db, 91);
    const t2 = await getAttendanceSummary(db, 92);
    // Term 1: a1 (4 rows) + u1 (1 row). Term 2: only the 4 May row.
    expect(t1.totalRecords).toBe(5);
    expect(t1.attendedRecords).toBe(3);
    expect(t2.totalRecords).toBe(1);
    expect(t2.attendedRecords).toBe(0);

    // The year rate is weighted by records: 3 of 6, not the mean of 60% and 0%.
    const year = await getAnnualReport(db, 9);
    expect(year.yearAttendanceRate).toBe(50);
  });

  it('two registers on one day are two columns, and cells add up to the total', async () => {
    const r = await getClassSectionReport(db, { classId: '50', academicTermId: 91, sessionType: 'subject', subjectId: 7 });
    expect(r.dateColumns).toEqual(['2026-02-10 Morning', '2026-02-10 Afternoon', '2026-02-11']);
    const a1 = r.students[0];
    expect(Object.keys(a1.marks)).toHaveLength(a1.total);
    expect(a1.marks).toEqual({ '2026-02-10 Morning': 'present', '2026-02-10 Afternoon': 'absent', '2026-02-11': 'present' });
  });

  it('the dashboard overview counts excused as attended and leaves out inactive students', async () => {
    const res = await request(app).get('/api/reports/overview?academic_term_id=91').set(authHeader(adminToken));
    expect(res.status).toBe(200);
    // a1: present, excused, 2 absent -> 2/4; u1: 1/1. Overall 3/5 = 60%.
    expect(res.body.data.overallRate).toBe(60);
    expect(res.body.data.totalStudentsTracked).toBe(2);
    const cls50 = res.body.data.classes.find((c: any) => c.classId === '50');
    expect(cls50).toMatchObject({ rate: 50, totalCount: 4, studentCount: 1 });
  });

  it('the per-class report lists only students who still count', async () => {
    const res = await request(app).get('/api/reports/class/50?academic_term_id=91').set(authHeader(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.data.map((r: any) => r.student_id)).toEqual(['a1']);
  });
});
