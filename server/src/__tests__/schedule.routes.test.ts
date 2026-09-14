import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { Database } from 'sqlite';
import { setupTestDb, createTestUser, authHeader } from './testUtils.js';
import { config } from '../config.js';
import { app } from '../app.js';
import { buildDaySessions } from '../modules/attendance/schedule.routes.js';

/** A token that also carries a MIS access token, so fetchTimetable will try
 *  to call the (mocked) MIS instead of short-circuiting to "no timetable". */
async function misTeacher(db: Database, id: string) {
  await createTestUser(db, { id, name: 'Cal Teacher', email: `${id}@s.test`, roleLevel: 'TEACHER' });
  return jwt.sign(
    { id, name: 'Cal Teacher', email: `${id}@s.test`, role: 'teacher', misToken: 'mis-tkn', academicTermId: 1 },
    config.jwtSecret,
    { expiresIn: '1h' }
  );
}

const slot = (over: Partial<Record<string, unknown>> = {}) => ({
  slot_id: 10, subject_id: 5, subject_name: 'Mathematics', subject_code: 'MATH',
  color: '#2563eb', class_group_id: 'cg-1', class_group_name: 'Grade 9A',
  day_of_week: 1 /* Monday */, start_time: '08:00:00', end_time: '09:40:00',
  location: 'Room 3', ...over,
});

/** `classTeacherOf` defaults to `['cg-1']` — the class group every `slot()`
 *  fixture belongs to — so existing tests keep exercising a teacher who *is*
 *  the assigned Class Teacher without having to say so explicitly. Pass `[]`
 *  to simulate a teacher with no such assignment. */
function mockMis(slots: unknown[], classTeacherOf: string[] = ['cg-1']) {
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
    const u = String(url);
    if (u.includes('/calendar/my-calendar')) {
      return new Response(JSON.stringify({ data: { slots, upcoming: [], term_id: 1 } }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    if (u.includes('/grades')) {
      const rows = classTeacherOf.map((cg) => ({
        class_group_id: cg, academic_year_id: 1, academic_year_is_current: true,
      }));
      return new Response(JSON.stringify({ data: rows }), { status: 200 });
    }
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  }));
}

describe('buildDaySessions (pure)', () => {
  const slots = [
    { slotId: 1, subjectId: 5, subjectName: 'Math', subjectCode: null, color: null, classId: 'cg-1', className: '9A', dayOfWeek: 1, startTime: '08:00', endTime: '08:45', room: '', teacherId: null, teacherName: null },
    { slotId: 2, subjectId: 7, subjectName: 'English', subjectCode: null, color: null, classId: 'cg-1', className: '9A', dayOfWeek: 1, startTime: '09:00', endTime: '09:45', room: '', teacherId: null, teacherName: null },
  ];

  it('prepends exactly one homeroom entry per class, before the subject slots', () => {
    const out = buildDaySessions(slots, '2026-09-14', new Map(), 'u1');
    expect(out[0].kind).toBe('homeroom');
    expect(out.filter((s) => s.kind === 'homeroom')).toHaveLength(1);
    expect(out.slice(1).map((s) => s.subjectName)).toEqual(['Math', 'English']);
    expect(out.every((s) => s.status === 'missing')).toBe(true);
  });

  it('marks a slot recorded once local rows exist for it', () => {
    const agg = new Map([
      ['2026-09-14|subject|cg-1|5', { present: 12, absent: 2, late: 0, excused: 0, total: 14, lastMarkedAt: '2026-09-14T08:10:00Z', markedBy: 'u1', ownStatus: null }],
    ]);
    const out = buildDaySessions(slots, '2026-09-14', agg as never, 'u1');
    const math = out.find((s) => s.subjectName === 'Math')!;
    expect(math.status).toBe('recorded');
    expect(math.stats.present).toBe(12);
    expect(math.markedByMe).toBe(true);
    expect(out.find((s) => s.subjectName === 'English')!.status).toBe('missing');
  });
});

describe('GET /api/attendance/schedule/day', () => {
  let db: Database;
  let token: string;

  beforeAll(async () => {
    db = await setupTestDb();
    token = await misTeacher(db, 'sched-teacher');
    await db.run(`INSERT INTO subjects (id, name) VALUES (5, 'Mathematics')`);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('returns the timetable slots for that weekday plus a homeroom card', async () => {
    mockMis([slot(), slot({ slot_id: 11, day_of_week: 2 })]); // Mon + Tue
    const res = await request(app)
      .get('/api/attendance/schedule/day?date=2026-09-14') // a Monday
      .set(authHeader(token));

    expect(res.status).toBe(200);
    expect(res.body.data.timetableAvailable).toBe(true);
    const kinds = res.body.data.sessions.map((s: any) => s.kind);
    expect(kinds).toEqual(['homeroom', 'subject']); // Tuesday slot filtered out
    const subj = res.body.data.sessions[1];
    expect(subj.subjectName).toBe('Mathematics');
    expect(subj.deepLink).toContain('sessionType=subject');
    expect(subj.deepLink).toContain('subjectId=5');
    expect(subj.status).toBe('missing');
    expect(res.body.data.progress).toEqual({ done: 0, total: 2 });
  });

  it('reflects a recorded register', async () => {
    mockMis([slot()]);
    await db.run(
      `INSERT INTO attendance_records (student_id, student_name, class_id, class_name, session_date, period, session_type, subject_id, status, marked_by, academic_term_id)
       VALUES ('stu-1','Sam','cg-1','Grade 9A','2026-09-14','08:00','subject',5,'present','sched-teacher',1)`
    );
    const res = await request(app)
      .get('/api/attendance/schedule/day?date=2026-09-14')
      .set(authHeader(token));
    const subj = res.body.data.sessions.find((s: any) => s.kind === 'subject');
    expect(subj.status).toBe('recorded');
    expect(subj.stats.present).toBe(1);
    expect(res.body.data.progress.done).toBe(1);
  });

  it('month view aggregates per-day register progress', async () => {
    mockMis([slot()]); // Mondays only
    const res = await request(app)
      .get('/api/attendance/schedule/month?month=2026-09')
      .set(authHeader(token));
    expect(res.status).toBe(200);
    expect(res.body.data.days).toHaveLength(30);
    const mon14 = res.body.data.days.find((d: any) => d.date === '2026-09-14');
    expect(mon14.lessonCount).toBe(1);
    expect(mon14.progress.total).toBe(2); // homeroom + 1 subject
    const tue15 = res.body.data.days.find((d: any) => d.date === '2026-09-15');
    expect(tue15.lessonCount).toBe(0);
    // No lesson that day, but the class still owes a morning register.
    expect(tue15.progress.total).toBe(1);
  });

  it('is graceful when the session has no MIS link', async () => {
    const plain = (await createTestUser(db, { id: 't-nomis', name: 'No Mis', email: 'n@s.test', roleLevel: 'TEACHER' })).token;
    const res = await request(app)
      .get('/api/attendance/schedule/day?date=2026-09-14')
      .set(authHeader(plain));
    expect(res.status).toBe(200);
    expect(res.body.data.timetableAvailable).toBe(false);
    expect(res.body.data.sessions).toEqual([]);
  });

  it('omits the homeroom card for a teacher who is not the class\'s assigned Class Teacher', async () => {
    mockMis([slot()], []); // teaches Maths in cg-1, but isn't its Class Teacher
    const res = await request(app)
      .get('/api/attendance/schedule/day?date=2026-09-14')
      .set(authHeader(token));
    expect(res.status).toBe(200);
    const kinds = res.body.data.sessions.map((s: any) => s.kind);
    expect(kinds).toEqual(['subject']); // no homeroom entry
    expect(res.body.data.progress.total).toBe(1);
  });
});

describe('GET /api/attendance/schedule/homeroom-classes', () => {
  let db: Database;
  let token: string;

  beforeAll(async () => {
    db = await setupTestDb();
    token = await misTeacher(db, 'hr-teacher');
  });
  afterEach(() => vi.unstubAllGlobals());

  it('lists only the classes this teacher is the assigned Class Teacher of', async () => {
    mockMis([slot()], ['cg-1', 'cg-9']);
    const res = await request(app)
      .get('/api/attendance/schedule/homeroom-classes')
      .set(authHeader(token));
    expect(res.status).toBe(200);
    expect(res.body.data.map((c: any) => c.id).sort()).toEqual(['cg-1', 'cg-9']);
  });

  it('is empty for a teacher with no Class Teacher assignment', async () => {
    mockMis([slot()], []);
    const res = await request(app)
      .get('/api/attendance/schedule/homeroom-classes')
      .set(authHeader(token));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });
});
