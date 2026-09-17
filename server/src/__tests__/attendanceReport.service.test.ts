import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { Database } from 'sqlite';
import { setupTestDb } from './testUtils.js';
import {
  listReportableClasses, listClassSections, getClassSectionReport, attendanceComment,
  listAvailableSubjects, listSubjectClasses, listOwnSections, getOwnSectionReport, resolveOwnClassId,
  getOwnSubjectsOverview,
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

describe('Subject-first dashboard (listAvailableSubjects / listSubjectClasses)', () => {
  let db: Database;

  beforeAll(async () => {
    db = await setupTestDb();

    await db.run(`INSERT INTO subjects (id, name, code) VALUES (5, 'Applied Mathematics II', 'MATH2')`);
    // Same subject, two different classes, two different teachers — this is
    // exactly the "if admin, show all; if teacher, only your own" scoping case.
    await db.run(
      `INSERT INTO class_subject_assignments
         (class_id, class_name, subject_id, subject_name, teacher_id, teacher_name, academic_term_id, day_of_week, period)
       VALUES
         ('cls-y2c', 'Year 2C', 5, 'Applied Mathematics II', 't1', 'Jean Bosco Uwitonze', 10, 1, '08:00'),
         ('cls-y1a', 'Year 1A', 5, 'Applied Mathematics II', 't2', 'Grace Mukamana', 10, 2, '09:00')`
    );

    // marked_by matches each row's actual class-subject teacher (t1 for
    // cls-y2c, t2 for cls-y1a) — attendanceReport.service.ts's
    // classesForSubject() falls back to attendance_records.marked_by for
    // teacher-scoping when class_subject_assignments hasn't caught up yet,
    // so getting this wrong here would silently mask that scoping.
    const rows: Array<[string, string, string, string, string, number, string, string]> = [
      ['s1', 'Amina K.', 'cls-y2c', 'Year 2C', '2026-03-02', 5, 'present', 't1'],
      ['s1', 'Amina K.', 'cls-y2c', 'Year 2C', '2026-03-04', 5, 'absent', 't1'],
      ['s2', 'Ben T.', 'cls-y2c', 'Year 2C', '2026-03-02', 5, 'present', 't1'],
      ['s3', 'Cissy M.', 'cls-y1a', 'Year 1A', '2026-03-02', 5, 'absent', 't2'],
      ['s3', 'Cissy M.', 'cls-y1a', 'Year 1A', '2026-03-04', 5, 'absent', 't2'],
    ];
    for (const [studentId, studentName, classId, className, date, subjectId, status, markedBy] of rows) {
      await db.run(
        `INSERT INTO attendance_records
           (student_id, student_name, class_id, class_name, session_date, period, session_type, subject_id, status, marked_by, academic_term_id)
         VALUES (?, ?, ?, ?, ?, 'Morning', 'subject', ?, ?, ?, 10)`,
        studentId, studentName, classId, className, date, subjectId, status, markedBy
      );
    }
  });

  it('an admin sees every subject/class regardless of who teaches it', async () => {
    const subjects = await listAvailableSubjects(db, { role: 'admin', userId: 'someone-else', academicTermId: 10 });
    const math = subjects.find((s) => s.subjectId === 5)!;
    expect(math).toBeTruthy();
    expect(math.classCount).toBe(2);
    expect(math.studentsTracked).toBe(3);

    const classes = await listSubjectClasses(db, 5, { role: 'admin', userId: 'someone-else', academicTermId: 10 });
    expect(classes.map((c) => c.classId).sort()).toEqual(['cls-y1a', 'cls-y2c']);
  });

  it('a teacher only sees the classes they were actually assigned this subject in', async () => {
    const subjects = await listAvailableSubjects(db, { role: 'teacher', userId: 't1', academicTermId: 10 });
    const math = subjects.find((s) => s.subjectId === 5)!;
    expect(math.classCount).toBe(1);
    expect(math.studentsTracked).toBe(2); // Amina + Ben, not Cissy

    const classes = await listSubjectClasses(db, 5, { role: 'teacher', userId: 't1', academicTermId: 10 });
    expect(classes).toHaveLength(1);
    expect(classes[0].classId).toBe('cls-y2c');
    expect(classes[0].teacherName).toBe('Jean Bosco Uwitonze');
  });

  it('a teacher with no assignments at all sees an empty subject list', async () => {
    const subjects = await listAvailableSubjects(db, { role: 'teacher', userId: 't-nobody', academicTermId: 10 });
    expect(subjects).toEqual([]);
  });

  it('computes per-class average rate and at-risk count correctly', async () => {
    const classes = await listSubjectClasses(db, 5, { role: 'admin', userId: 'x', academicTermId: 10 });
    const y1a = classes.find((c) => c.classId === 'cls-y1a')!;
    // Cissy: 0 present of 2 -> 0% -> below the 80% at-risk bar.
    expect(y1a.averageRate).toBe(0);

    const subjects = await listAvailableSubjects(db, { role: 'admin', userId: 'x', academicTermId: 10 });
    const math = subjects.find((s) => s.subjectId === 5)!;
    expect(math.atRiskCount).toBeGreaterThanOrEqual(1);
  });

  // Reported bug: a teacher whose "By Class" report and the MIS's own
  // dashboard both showed a subject saw an empty "By Subject" dashboard.
  // Root cause: class_subject_assignments only refreshes on a manual
  // POST /academics/sync, so right after a term rollover it can lag the
  // real assignment for a while — and the subject dashboard, unlike
  // listReportableClasses, had no fallback to attendance_records.
  it('still surfaces a subject that has real attendance records but no synced roster-cache row for this term', async () => {
    await db.run(`INSERT INTO subjects (id, name, code) VALUES (9, 'Advanced Database', 'DB9')`);
    // Deliberately no class_subject_assignments row for subject 9 at all —
    // simulates a stale/never-synced roster cache.
    await db.run(
      `INSERT INTO attendance_records
         (student_id, student_name, class_id, class_name, session_date, period, session_type, subject_id, status, marked_by, academic_term_id)
       VALUES ('s4', 'Dax O.', 'cls-y2c', 'Year 2C', '2026-03-05', 'Morning', 'subject', 9, 'present', 't1', 10)`
    );

    const subjects = await listAvailableSubjects(db, { role: 'teacher', userId: 't1', academicTermId: 10 });
    const found = subjects.find((s) => s.subjectId === 9);
    expect(found).toBeTruthy();
    expect(found!.subjectName).toBe('Advanced Database');
    expect(found!.classCount).toBe(1);
    expect(found!.studentsTracked).toBe(1);

    const classes = await listSubjectClasses(db, 9, { role: 'teacher', userId: 't1', academicTermId: 10 });
    expect(classes).toHaveLength(1);
    expect(classes[0].classId).toBe('cls-y2c');
    // No roster-cache row exists, so there's genuinely no teacher name to show.
    expect(classes[0].teacherName).toBeNull();

    // A different teacher who never marked it must not see it.
    const otherTeacherSubjects = await listAvailableSubjects(db, { role: 'teacher', userId: 't-someone-else', academicTermId: 10 });
    expect(otherTeacherSubjects.find((s) => s.subjectId === 9)).toBeUndefined();
  });
});

describe('Subject dashboard with a live MIS link (misToken present)', () => {
  let db: Database;

  function mockMisTeacherSubjects(response: unknown[]) {
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes('/academics/teacher-assignments')) {
        // The real endpoint is school-wide (filtered by academic_year_id
        // only), not per-teacher -- mix in a row for a different teacher to
        // prove the service itself narrows to the requesting user.
        return new Response(JSON.stringify({
          data: [
            ...response,
            { subject_id: 7, subject_name: 'Someone Else\'s Subject', class_group_id: 'cls-other', class_group_name: 'Other Class', teacher_id: 't-someone-else', academic_year_id: 1, academic_year_is_current: 1 },
          ],
        }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }));
  }

  afterEach(() => vi.unstubAllGlobals());

  beforeAll(async () => {
    db = await setupTestDb();
    await db.run(`INSERT INTO subjects (id, name, code) VALUES (5, 'Applied Mathematics II', 'MATH2'), (9, 'Advanced Database', 'DB9')`);

    // A STALE local roster cache + a misleading marked_by row — exactly what
    // was reported: the teacher had never taught "Advanced Database", but it
    // was wrongly assigned to them in the local cache (or they'd once
    // recorded a session for it, e.g. covering for someone), so it leaked
    // into the old marked_by/teacher_id-based dashboard.
    await db.run(
      `INSERT INTO class_subject_assignments
         (class_id, class_name, subject_id, subject_name, teacher_id, teacher_name, academic_term_id, day_of_week, period)
       VALUES ('cls-y2c', 'Year 2C', 9, 'Advanced Database', 't1', 'Jean Bosco Uwitonze', 10, 1, '08:00')`
    );
    await db.run(
      `INSERT INTO attendance_records
         (student_id, student_name, class_id, class_name, session_date, period, session_type, subject_id, status, marked_by, academic_term_id)
       VALUES ('s1', 'Amina K.', 'cls-y2c', 'Year 2C', '2026-03-02', 'Morning', 'subject', 9, 'present', 't1', 10)`
    );
  });

  it('trusts the live MIS assignment over the stale local cache and marked_by history', async () => {
    // The MIS says this teacher currently only teaches subject 5, in cls-y2c
    // — nothing about subject 9, contradicting both the cache and the
    // attendance record seeded above.
    mockMisTeacherSubjects([
      { subject_id: 5, subject_name: 'Applied Mathematics II', class_group_id: 'cls-y2c', class_group_name: 'Year 2C', teacher_id: 't1', academic_year_id: 1, academic_year_is_current: 1 },
    ]);

    const subjects = await listAvailableSubjects(db, {
      role: 'teacher', userId: 't1', academicTermId: 10, academicYearId: 1, misToken: 'mis-tkn',
    });
    expect(subjects.map((s) => s.subjectId)).toEqual([5]);
    expect(subjects.find((s) => s.subjectId === 9)).toBeUndefined();

    const classes = await listSubjectClasses(db, 5, {
      role: 'teacher', userId: 't1', academicTermId: 10, academicYearId: 1, misToken: 'mis-tkn',
    });
    expect(classes).toHaveLength(1);
    expect(classes[0].classId).toBe('cls-y2c');

    // Asking about the subject the MIS no longer credits them with returns nothing.
    const staleClasses = await listSubjectClasses(db, 9, {
      role: 'teacher', userId: 't1', academicTermId: 10, academicYearId: 1, misToken: 'mis-tkn',
    });
    expect(staleClasses).toEqual([]);
  });

  it('filters the MIS response to the requested academic year', async () => {
    mockMisTeacherSubjects([
      { subject_id: 5, subject_name: 'Applied Mathematics II', class_group_id: 'cls-y2c', class_group_name: 'Year 2C', teacher_id: 't1', academic_year_id: 1, academic_year_is_current: 0 },
      { subject_id: 9, subject_name: 'Advanced Database', class_group_id: 'cls-y2c', class_group_name: 'Year 2C', teacher_id: 't1', academic_year_id: 2, academic_year_is_current: 1 },
    ]);

    const forYear1 = await listAvailableSubjects(db, {
      role: 'teacher', userId: 't1', academicTermId: 10, academicYearId: 1, misToken: 'mis-tkn',
    });
    expect(forYear1.map((s) => s.subjectId)).toEqual([5]);

    const forYear2 = await listAvailableSubjects(db, {
      role: 'teacher', userId: 't1', academicTermId: 10, academicYearId: 2, misToken: 'mis-tkn',
    });
    expect(forYear2.map((s) => s.subjectId)).toEqual([9]);
  });
});

describe("A student's own attendance report (auto-detected class, own row only)", () => {
  let db: Database;

  beforeAll(async () => {
    db = await setupTestDb();
    await db.run(`INSERT INTO subjects (id, name, code) VALUES (5, 'Applied Mathematics II', 'MATH2')`);
    await db.run(
      `INSERT INTO class_subject_assignments
         (class_id, class_name, subject_id, subject_name, teacher_id, teacher_name, academic_term_id, day_of_week, period)
       VALUES ('cls-y2c', 'Year 2C', 5, 'Applied Mathematics II', 't1', 'Jean Bosco Uwitonze', 10, 1, '08:00')`
    );
    // s1 and s2 are classmates in cls-y2c; s1 is "me" throughout these tests.
    const rows: Array<[string, string, string, 'homeroom' | 'subject', number | null, string]> = [
      ['s1', 'Amina K.', '2026-03-02', 'subject', 5, 'present'],
      ['s1', 'Amina K.', '2026-03-04', 'subject', 5, 'absent'],
      ['s1', 'Amina K.', '2026-03-02', 'homeroom', null, 'present'],
      ['s2', 'Ben T.', '2026-03-02', 'subject', 5, 'present'],
      ['s2', 'Ben T.', '2026-03-02', 'homeroom', null, 'present'],
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

  it('auto-detects the class from the student\'s own most recent attendance row', async () => {
    expect(await resolveOwnClassId(db, 's1')).toBe('cls-y2c');
    expect(await resolveOwnClassId(db, 'never-attended-anything')).toBeNull();
  });

  it('lists homeroom + subjects for the auto-detected class, no class_id input needed', async () => {
    const sections = await listOwnSections(db, 's1', 10);
    expect(sections[0]).toEqual({ kind: 'homeroom' });
    expect(sections[1]).toMatchObject({ kind: 'subject', subjectId: 5, subjectName: 'Applied Mathematics II' });
  });

  it("returns only the student's own row, never a classmate's", async () => {
    const report = await getOwnSectionReport(db, 's1', { academicTermId: 10, sessionType: 'subject', subjectId: 5 });
    expect(report.students).toHaveLength(1);
    expect(report.students[0].studentId).toBe('s1');
    expect(report.students[0].rate).toBe(50);
    expect(report.classAverageRate).toBe(50); // their own rate, not the class's
    expect(report.className).toBe('Year 2C');
    expect(report.subjectName).toBe('Applied Mathematics II');

    // Confirm the classmate's row genuinely never leaves the function, not
    // just that it's filtered from what we asserted on.
    expect(JSON.stringify(report)).not.toContain('Ben T.');
    expect(JSON.stringify(report)).not.toContain('s2');
  });

  it('returns a friendly empty report for a student with no attendance history at all', async () => {
    const report = await getOwnSectionReport(db, 'brand-new-student', { academicTermId: 10, sessionType: 'homeroom' });
    expect(report.students).toEqual([]);
    expect(report.classId).toBe('');
    expect(report.dateColumns).toEqual([]);
  });

  // Reported bug: the letterhead showed "Class: 26" (a raw class id) and
  // "Subject: Homeroom" while viewing a real subject, because
  // class_subject_assignments had no row for it (the same roster-cache
  // staleness this file already routes around for scoping) and the name
  // resolution had no fallback.
  it('resolves the real class/subject name from attendance_records when the roster cache has no row for it', async () => {
    await db.run(`INSERT INTO subjects (id, name, code) VALUES (6, 'Web3 Applications', 'WEB3')`);
    // Deliberately no class_subject_assignments row for subject 6.
    await db.run(
      `INSERT INTO attendance_records
         (student_id, student_name, class_id, class_name, session_date, period, session_type, subject_id, status, marked_by, academic_term_id)
       VALUES ('s1', 'Amina K.', 'cls-y2c', 'Year 2C', '2026-03-05', 'Morning', 'subject', 6, 'late', 't1', 10)`
    );

    const report = await getOwnSectionReport(db, 's1', { academicTermId: 10, sessionType: 'subject', subjectId: 6 });
    expect(report.className).toBe('Year 2C');
    expect(report.className).not.toBe('cls-y2c');
    expect(report.subjectName).toBe('Web3 Applications');
    expect(report.subjectName).not.toBe('Homeroom');
  });
});

describe('getOwnSubjectsOverview — the "All Subjects" comparison view', () => {
  let db: Database;

  beforeAll(async () => {
    db = await setupTestDb();
    await db.run(`INSERT INTO subjects (id, name, code) VALUES (5, 'Applied Mathematics II', 'MATH2'), (6, 'Web3 Applications', 'WEB3')`);
    await db.run(
      `INSERT INTO class_subject_assignments
         (class_id, class_name, subject_id, subject_name, teacher_id, teacher_name, academic_term_id, day_of_week, period)
       VALUES
         ('cls-y2c', 'Year 2C', 5, 'Applied Mathematics II', 't1', 'Jean Bosco Uwitonze', 10, 1, '08:00'),
         ('cls-y2c', 'Year 2C', 6, 'Web3 Applications', 't1', 'Jean Bosco Uwitonze', 10, 2, '10:50')`
    );
    // Only Applied Mathematics II has any recorded attendance for this
    // student — Web3 Applications is assigned (per the cache row above) but
    // genuinely untouched, and homeroom has one present.
    const rows: Array<[string, 'homeroom' | 'subject', number | null, string]> = [
      ['2026-03-02', 'subject', 5, 'present'],
      ['2026-03-04', 'subject', 5, 'absent'],
      ['2026-03-02', 'homeroom', null, 'present'],
    ];
    for (const [date, sessionType, subjectId, status] of rows) {
      await db.run(
        `INSERT INTO attendance_records
           (student_id, student_name, class_id, class_name, session_date, period, session_type, subject_id, status, marked_by, academic_term_id)
         VALUES ('s1', 'Amina K.', 'cls-y2c', 'Year 2C', ?, 'Morning', ?, ?, ?, 't1', 10)`,
        date, sessionType, subjectId, status
      );
    }
  });

  it('includes every section — including one with zero recorded sessions — sorted homeroom first', async () => {
    const overview = await getOwnSubjectsOverview(db, 's1', { academicTermId: 10 });
    expect(overview.map((s) => s.kind === 'homeroom' ? 'homeroom' : s.subjectName)).toEqual([
      'homeroom', 'Applied Mathematics II', 'Web3 Applications',
    ]);
  });

  it('zero-fills a section with no attendance instead of defaulting it to 100%', async () => {
    const overview = await getOwnSubjectsOverview(db, 's1', { academicTermId: 10 });
    const web3 = overview.find((s) => s.subjectName === 'Web3 Applications')!;
    expect(web3.hasData).toBe(false);
    expect(web3).toMatchObject({ present: 0, absent: 0, late: 0, excused: 0, total: 0, rate: 0 });
  });

  it('reports real numbers for a section that does have attendance', async () => {
    const overview = await getOwnSubjectsOverview(db, 's1', { academicTermId: 10 });
    const math = overview.find((s) => s.subjectName === 'Applied Mathematics II')!;
    expect(math.hasData).toBe(true);
    expect(math).toMatchObject({ present: 1, absent: 1, total: 2, rate: 50 });
  });
});
