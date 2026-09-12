import { describe, it, expect, beforeAll } from 'vitest';
import { Database } from 'sqlite';
import { setupTestDb } from './testUtils.js';
import {
  listReportableClasses, listClassSections, getClassSectionReport, attendanceComment,
} from '../modules/reporting/attendanceReport.service.js';

describe('attendanceComment', () => {
  it.each([
    [100, 'Excellent'], [95, 'Excellent'],
    [94, 'Good'], [92.9, 'Good'], [85.7, 'Good'], [85, 'Good'],
    [84, 'Fair'], [78.6, 'Fair'], [75, 'Fair'],
    [74, 'Poor'], [71.4, 'Poor'], [0, 'Poor'],
  ] as const)('rates %s%% as %s', (rate, expected) => {
    expect(attendanceComment(rate)).toBe(expected);
  });
});

describe('Class -> subject attendance report', () => {
  let db: Database;

  beforeAll(async () => {
    db = await setupTestDb();

    // A subject roster row so the class/subject grouping (and teacher name)
    // resolves, mirroring what academicsSync.service.ts would have written.
    await db.run(
      `INSERT INTO subjects (id, name, code) VALUES (5, 'Applied Mathematics II', 'MATH2')`
    );
    await db.run(
      `INSERT INTO class_subject_assignments
         (class_id, class_name, subject_id, subject_name, teacher_id, teacher_name, academic_term_id, day_of_week, period)
       VALUES ('cls-y2c', 'Year 2C', 5, 'Applied Mathematics II', 't1', 'Jean Bosco Uwitonze', 10, 1, '08:00')`
    );

    // Two subject sessions and one homeroom session per student, across two
    // students, so homeroom/subject scoping and per-student tallies both have
    // something real to check.
    const rows: Array<[string, string, string, 'homeroom' | 'subject', number | null, string]> = [
      ['s1', 'Amina K.', '2026-03-02', 'subject', 5, 'present'],
      ['s1', 'Amina K.', '2026-03-04', 'subject', 5, 'absent'],
      ['s1', 'Amina K.', '2026-03-02', 'homeroom', null, 'present'],
      ['s2', 'Ben T.', '2026-03-02', 'subject', 5, 'present'],
      ['s2', 'Ben T.', '2026-03-04', 'subject', 5, 'late'],
      ['s2', 'Ben T.', '2026-03-02', 'homeroom', null, 'absent'],
    ];
    for (const [studentId, studentName, date, sessionType, subjectId, status] of rows) {
      await db.run(
        `INSERT INTO attendance_records
           (student_id, student_name, class_id, class_name, session_date, period, session_type, subject_id, status, marked_by, academic_term_id)
         VALUES (?, ?, 'cls-y2c', 'Year 2C', ?, 'Morning', ?, ?, ?, 't1', 10)`,
        studentId, studentName, date, sessionType, subjectId, status
      );
    }
  });

  it('lists the class once even though it appears in both the roster cache and attendance_records', async () => {
    const classes = await listReportableClasses(db, 10);
    expect(classes.filter((c) => c.classId === 'cls-y2c')).toHaveLength(1);
    expect(classes.find((c) => c.classId === 'cls-y2c')?.className).toBe('Year 2C');
  });

  it('lists homeroom first, then every distinct subject taught in the class this term', async () => {
    const sections = await listClassSections(db, 'cls-y2c', 10);
    expect(sections[0]).toEqual({ kind: 'homeroom' });
    expect(sections).toHaveLength(2);
    expect(sections[1]).toEqual({
      kind: 'subject', subjectId: 5, subjectName: 'Applied Mathematics II', teacherName: 'Jean Bosco Uwitonze',
    });
  });

  it('builds the subject register: date columns, per-student marks/tallies/rate/comment, without homeroom bleeding in', async () => {
    const report = await getClassSectionReport(db, {
      classId: 'cls-y2c', academicTermId: 10, sessionType: 'subject', subjectId: 5,
    });
    expect(report.className).toBe('Year 2C');
    expect(report.subjectName).toBe('Applied Mathematics II');
    expect(report.teacherName).toBe('Jean Bosco Uwitonze');
    expect(report.dateColumns).toEqual(['2026-03-02', '2026-03-04']);
    expect(report.students).toHaveLength(2);

    const amina = report.students.find((s) => s.studentId === 's1')!;
    expect(amina.marks).toEqual({ '2026-03-02': 'present', '2026-03-04': 'absent' });
    expect(amina.present).toBe(1);
    expect(amina.absent).toBe(1);
    expect(amina.total).toBe(2);
    expect(amina.rate).toBe(50);
    expect(amina.comment).toBe('Poor');

    const ben = report.students.find((s) => s.studentId === 's2')!;
    // present + late both count as attended per shared/attendancePolicy.ts.
    expect(ben.rate).toBe(100);
    expect(ben.comment).toBe('Excellent');

    expect(report.classAverageRate).toBe(75); // (50 + 100) / 2
  });

  it('scopes the homeroom register separately from the subject register for the same dates', async () => {
    const report = await getClassSectionReport(db, {
      classId: 'cls-y2c', academicTermId: 10, sessionType: 'homeroom',
    });
    expect(report.subjectId).toBeNull();
    expect(report.subjectName).toBeNull();
    expect(report.dateColumns).toEqual(['2026-03-02']);
    const amina = report.students.find((s) => s.studentId === 's1')!;
    expect(amina.total).toBe(1);
    expect(amina.marks).toEqual({ '2026-03-02': 'present' });
    const ben = report.students.find((s) => s.studentId === 's2')!;
    expect(ben.marks).toEqual({ '2026-03-02': 'absent' });
  });

  it('narrows to a date range', async () => {
    const report = await getClassSectionReport(db, {
      classId: 'cls-y2c', academicTermId: 10, sessionType: 'subject', subjectId: 5,
      fromDate: '2026-03-03', toDate: '2026-03-04',
    });
    expect(report.dateColumns).toEqual(['2026-03-04']);
  });
});
