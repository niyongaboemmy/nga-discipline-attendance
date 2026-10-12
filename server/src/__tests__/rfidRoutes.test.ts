import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { Database } from 'sqlite';
import { setupTestDb, createTestUser, authHeader } from './testUtils.js';
import { app } from '../app.js';
import { drain } from '../modules/rfid/workQueue.js';

describe('/api/rfid', () => {
  let db: Database;
  let adminToken: string;
  let teacherToken: string;
  let studentToken: string;

  beforeAll(async () => {
    db = await setupTestDb();
    adminToken = (await createTestUser(db, { id: 'adm', name: 'Ada Admin', email: 'a@s.test', roleLevel: 'ADMIN' })).token;
    teacherToken = (await createTestUser(db, { id: 'tch', name: 'Tia', email: 't@s.test', roleLevel: 'TEACHER' })).token;
    studentToken = (await createTestUser(db, { id: 'stu', name: 'Sam', email: 's@s.test', roleLevel: 'STUDENT' })).token;
  });

  beforeEach(async () => {
    for (const t of ['rfid_scan_events', 'rfid_card_assignments', 'rfid_cards', 'rfid_devices', 'rfid_days_off',
      'timetable_slots', 'roster_enrolments', 'roster_students', 'roster_class_groups', 'roster_sync_runs']) {
      await db.run(`DELETE FROM ${t}`);
    }
    await db.run(`INSERT INTO roster_students (student_id, name, mis_status, synced_at) VALUES
      ('s1', 'John Doe', 'ACTIVE', '2020-01-01T00:00:00.000Z'), ('s2', 'Jane Doe', 'ACTIVE', '2020-01-01T00:00:00.000Z')`);
  });

  afterEach(async () => {
    await drain();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  const as = (token: string) => ({
    get: (p: string) => request(app).get(p).set(authHeader(token)),
    post: (p: string, body?: object) => request(app).post(p).set(authHeader(token)).send(body ?? {}),
    put: (p: string, body?: object) => request(app).put(p).set(authHeader(token)).send(body ?? {}),
  });

  describe('permissions', () => {
    it('students get 403 on every RFID route', async () => {
      for (const p of ['/api/rfid/cards', '/api/rfid/scans', '/api/rfid/devices', '/api/rfid/today', '/api/rfid/students']) {
        expect((await as(studentToken).get(p)).status).toBe(403);
      }
      expect((await as(studentToken).post('/api/rfid/cards', { uid: '04A1B2C3' })).status).toBe(403);
    });

    it('teachers cannot manage cards or sessions by default', async () => {
      expect((await as(teacherToken).get('/api/rfid/cards')).status).toBe(403);
      expect((await as(teacherToken).post('/api/rfid/cards', { uid: '04A1B2C3' })).status).toBe(403);
      expect((await as(teacherToken).get('/api/rfid/today')).status).toBe(403);
    });

    it('requires authentication', async () => {
      expect((await request(app).get('/api/rfid/cards')).status).toBe(401);
    });
  });

  describe('cards', () => {
    const register = async (uid: string, label?: string) =>
      (await as(adminToken).post('/api/rfid/cards', { uid, label })).body.data.id as number;

    it('registers a card with a normalised UID and rejects duplicates and garbage', async () => {
      const r = await as(adminToken).post('/api/rfid/cards', { uid: '04:a1:b2:c3', label: 'No. 17' });
      expect(r.status).toBe(201);
      const list = await as(adminToken).get('/api/rfid/cards');
      expect(list.body.data[0]).toMatchObject({ uid: '04A1B2C3', label: 'No. 17', status: 'unassigned', holder: null });

      const dup = await as(adminToken).post('/api/rfid/cards', { uid: '04 A1 B2 C3' });
      expect(dup.status).toBe(409);
      expect(dup.body.code).toBe('CARD_EXISTS');
      const bad = await as(adminToken).post('/api/rfid/cards', { uid: 'hello' });
      expect(bad.status).toBe(400);
      expect(bad.body.code).toBe('MALFORMED_UID');
    });

    it('one card cannot be active for two students without an explicit reassign', async () => {
      const card = await register('04A1B2C3');
      expect((await as(adminToken).post(`/api/rfid/cards/${card}/assign`, { studentId: 's1' })).status).toBe(200);

      const clash = await as(adminToken).post(`/api/rfid/cards/${card}/assign`, { studentId: 's2' });
      expect(clash.status).toBe(409);
      expect(clash.body).toMatchObject({ code: 'CARD_ASSIGNED', data: { holderId: 's1', holderName: 'John Doe' } });

      const moved = await as(adminToken).post(`/api/rfid/cards/${card}/assign`, { studentId: 's2', reassign: true });
      expect(moved.status).toBe(200);
      const detail = await as(adminToken).get(`/api/rfid/cards/${card}`);
      expect(detail.body.data.assignments.map((a: any) => [a.studentId, a.endReason])).toEqual([['s2', null], ['s1', 'reassigned']]);
      expect(detail.body.data.holder).toMatchObject({ studentId: 's2', studentName: 'Jane Doe' });
      expect(detail.body.data).toMatchObject({ taps: 0, tapsToday: 0 });
    });

    it('a student gets one active card; replacing disables the old one', async () => {
      const first = await register('04A1B2C3');
      const second = await register('04A1B2C4');
      await as(adminToken).post(`/api/rfid/cards/${first}/assign`, { studentId: 's1' });

      const clash = await as(adminToken).post(`/api/rfid/cards/${second}/assign`, { studentId: 's1' });
      expect(clash.status).toBe(409);
      expect(clash.body.code).toBe('STUDENT_HAS_CARD');

      expect((await as(adminToken).post(`/api/rfid/cards/${second}/assign`, { studentId: 's1', replaceExisting: true })).status).toBe(200);
      const old = await as(adminToken).get(`/api/rfid/cards/${first}`);
      expect(old.body.data).toMatchObject({ status: 'disabled', statusReason: 'Replaced by card 04A1B2C4' });
    });

    it('the database itself refuses a second open assignment', async () => {
      const card = await register('04A1B2C3');
      await as(adminToken).post(`/api/rfid/cards/${card}/assign`, { studentId: 's1' });
      await expect(db.run(
        `INSERT INTO rfid_card_assignments (card_id, student_id, student_name, assigned_at, assigned_by) VALUES (?, 's2', 'x', 'now', 'x')`,
        card
      )).rejects.toThrow(/UNIQUE/);
    });

    it('lost ends the assignment; a blocked card must be re-enabled before reuse', async () => {
      const card = await register('04A1B2C3');
      await as(adminToken).post(`/api/rfid/cards/${card}/assign`, { studentId: 's1' });
      expect((await as(adminToken).post(`/api/rfid/cards/${card}/status`, { status: 'lost', reason: 'Lost on trip' })).status).toBe(200);

      const blocked = await as(adminToken).post(`/api/rfid/cards/${card}/assign`, { studentId: 's2' });
      expect(blocked.status).toBe(409);
      expect(blocked.body.code).toBe('CARD_BLOCKED');

      expect((await as(adminToken).post(`/api/rfid/cards/${card}/status`, { status: 'unassigned' })).status).toBe(200);
      expect((await as(adminToken).post(`/api/rfid/cards/${card}/assign`, { studentId: 's2' })).status).toBe(200);
      const audit = await db.all(`SELECT action FROM audit_log WHERE entity_type = 'rfid_card' AND entity_id = ? ORDER BY id`, String(card));
      expect(audit.map((a: any) => a.action)).toEqual(['rfid.card.register', 'rfid.card.assign', 'rfid.card.lost', 'rfid.card.enable', 'rfid.card.assign']);
    });

    it('refuses to assign to a student missing from the roster', async () => {
      const card = await register('04A1B2C3');
      const r = await as(adminToken).post(`/api/rfid/cards/${card}/assign`, { studentId: 'ghost' });
      expect(r.status).toBe(400);
      expect(r.body.code).toBe('UNKNOWN_STUDENT');
    });

    it('scanned=1 lists only cards the reader picked up, unassigned first, with tap counts', async () => {
      await register('04A1B2C3'); // typed in, never tapped
      await as(adminToken).post('/api/rfid/scans', { uid: '1D:FC:FF:03' });
      await as(adminToken).post('/api/rfid/scans', { uid: '79:43:01:04' });
      const tapped = await db.get(`SELECT id FROM rfid_cards WHERE uid = '79430104'`);
      await as(adminToken).post(`/api/rfid/cards/${tapped.id}/assign`, { studentId: 's1' });
      const r = await as(adminToken).get('/api/rfid/cards?scanned=1');
      expect(r.body.data.map((c: any) => [c.uid, c.status, c.taps])).toEqual([['1DFCFF03', 'unassigned', 1], ['79430104', 'active', 1]]);
      expect(r.body.counts).toMatchObject({ total: 2, active: 1, unassigned: 1 });
    });

    it('filters by status and searches by holder', async () => {
      const a = await register('04A1B2C3');
      await register('04A1B2C4');
      await as(adminToken).post(`/api/rfid/cards/${a}/assign`, { studentId: 's1' });
      const assigned = await as(adminToken).get('/api/rfid/cards?status=active');
      expect(assigned.body.data.map((c: any) => c.uid)).toEqual(['04A1B2C3']);
      expect(assigned.body.counts).toMatchObject({ total: 2, active: 1, unassigned: 1, blocked: 0 });
      const found = await as(adminToken).get('/api/rfid/cards?search=john');
      expect(found.body.data).toHaveLength(1);
    });
  });

  describe('scans', () => {
    it('manual entry goes through the engine and shows in the unregistered queue', async () => {
      const r = await as(adminToken).post('/api/rfid/scans', { uid: 'DEADBEEF' });
      expect(r.status).toBe(200);
      expect(r.body.data.outcome).toBe('unknown_card');
      const queue = await as(adminToken).get('/api/rfid/scans/unresolved');
      expect(queue.body.data).toHaveLength(1);
      expect(queue.body.data[0]).toMatchObject({ uid: 'DEADBEEF', scans: 1 });
      const log = await as(adminToken).get('/api/rfid/scans?outcome=unresolved');
      expect(log.body.total).toBe(1);
    });
  });

  describe('today and days off', () => {
    const tomorrow = () => {
      const d = new Date(Date.now() + 36 * 3600_000);
      return d.toISOString().slice(0, 10);
    };

    it('lists classes with card holders and their timetable for the day', async () => {
      await db.run(`INSERT INTO roster_class_groups (class_id, name, synced_at) VALUES ('y1', 'Year 1', 'x')`);
      await db.run(`INSERT INTO roster_enrolments (student_id, class_id, academic_year_id, status, synced_at) VALUES ('s1', 'y1', 7, 'ACTIVE', 'x')`);
      await db.run(`INSERT OR REPLACE INTO subjects (id, name) VALUES (1, 'Maths')`);
      await db.run(`DELETE FROM timetable_slots`);
      for (let d = 0; d < 7; d++) {
        await db.run(`INSERT INTO timetable_slots (slot_id, class_id, subject_id, day_of_week, start_time, end_time, synced_at) VALUES (?, 'y1', 1, ?, '07:30', '08:10', 'x')`, 100 + d, d);
      }
      const card = (await as(adminToken).post('/api/rfid/cards', { uid: '79:43:01:04' })).body.data.id;
      await as(adminToken).post(`/api/rfid/cards/${card}/assign`, { studentId: 's1' });

      const r = await as(adminToken).get('/api/rfid/today');
      expect(r.status).toBe(200);
      expect(r.body.data).toMatchObject({ schoolOpen: true, graceMinutes: 3 });
      expect(r.body.data.classes).toEqual([expect.objectContaining({ classId: 'y1', className: 'Year 1', cardHolders: 1, lessonsToday: 1 })]);
    });

    it('marks and unmarks a day off, refusing past dates', async () => {
      const day = tomorrow();
      const add = await as(adminToken).post('/api/rfid/days-off', { date: day, reason: 'Public holiday' });
      expect(add.status).toBe(200);
      expect((await as(adminToken).get('/api/rfid/days-off')).body.data).toEqual([expect.objectContaining({ date: day, reason: 'Public holiday' })]);
      expect((await as(adminToken).get(`/api/rfid/today?date=${day}`)).body.data).toMatchObject({ schoolOpen: false, closedReason: 'Public holiday' });

      const past = await as(adminToken).post('/api/rfid/days-off', { date: '2020-01-01', reason: 'x' });
      expect(past.status).toBe(400);
      expect((await request(app).delete(`/api/rfid/days-off/${day}`).set(authHeader(adminToken))).status).toBe(200);
      expect((await as(adminToken).get('/api/rfid/days-off')).body.data).toEqual([]);
    });

    it('teachers cannot mark days off', async () => {
      expect((await as(teacherToken).post('/api/rfid/days-off', { date: tomorrow(), reason: 'x' })).status).toBe(403);
    });
  });

  describe('roster sync from the MIS integration API', () => {
    function mockMis(pages: any[][], opts: { status?: number } = {}) {
      const calls: { url: string; auth: string }[] = [];
      vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
        calls.push({ url: String(url), auth: init?.headers?.Authorization });
        if (opts.status) return { ok: false, status: opts.status, json: async () => ({}) };
        const u = new URL(String(url));
        if (u.pathname.endsWith('/sync/reference')) {
          return { ok: true, status: 200, json: async () => ({ success: true, data: {
            classGroups: [{ id: 31, gradeId: 3, name: 'Senior 3A' }],
            academicYears: [{ id: 7, name: '2026', startDate: '2026-01-04T22:00:00.000Z', endDate: '2026-11-29T22:00:00.000Z', isCurrent: 1 }],
            academicTerms: [{ id: 21, academicYearId: 7, name: 'Term 3', startDate: '2026-09-06T22:00:00.000Z', endDate: '2026-11-29T22:00:00.000Z', isCurrent: 1 }],
            subjects: [{ id: 1, name: 'Mathematics', code: 'MAT' }],
          } }) };
        }
        if (u.pathname.endsWith('/sync/academics')) {
          return { ok: true, status: 200, json: async () => ({ success: true, data: { calendarSlots: [
            { id: 501, classGroupId: 31, subjectId: 1, dayOfWeek: 1, startTime: '07:30:00', endTime: '08:10:00', academicTermId: 21, isActive: 1 },
            { id: 502, classGroupId: 31, subjectId: 1, dayOfWeek: 2, startTime: '07:30', endTime: '08:10', academicTermId: 21, isActive: 0 },
          ] } }) };
        }
        const i = Number(u.searchParams.get('cursor')) === 0 ? 0 : 1;
        const users = pages[i] ?? [];
        return {
          ok: true, status: 200,
          json: async () => ({ success: true, data: { users, pagination: { hasMore: i < pages.length - 1, nextCursor: i < pages.length - 1 ? 100 : null } } }),
        };
      }));
      return calls;
    }
    const student = (id: number, name: string, classGroups: any[]) => ({
      id, username: name.toLowerCase(), status: 'ACTIVE', roles: [{ id: 6, name: 'STUDENT' }],
      profile: { fullName: name }, classGroups,
    });

    it('pulls students and enrolments with the integration token, across pages', async () => {
      vi.stubEnv('MIS_INTEGRATION_TOKEN', 'int-token-1');
      const calls = mockMis([
        [student(1, 'John Doe', [{ classGroupId: 31, academicYearId: 7, status: 'ACTIVE' }]),
          { id: 2, roles: [{ id: 2, name: 'TEACHER' }], profile: { fullName: 'Tia' }, classGroups: [] }],
        [student(3, 'Jane Doe', [{ classGroupId: 31, academicYearId: 6, status: 'DISABLED' }, { classGroupId: 31, academicYearId: 7, status: 'ACTIVE' }])],
      ]);
      const r = await as(adminToken).post('/api/rfid/roster/sync');
      expect(r.status).toBe(200);
      expect(r.body.data).toMatchObject({ students: 2, enrolments: 3, classGroups: 1, slots: 2 });
      // The timetable, subjects and term dates the card attendance needs.
      expect(await db.get(`SELECT class_id, day_of_week, start_time, end_time, academic_term_id, is_active FROM timetable_slots WHERE slot_id = 501`))
        .toEqual({ class_id: '31', day_of_week: 1, start_time: '07:30', end_time: '08:10', academic_term_id: 21, is_active: 1 });
      expect((await db.get(`SELECT name FROM subjects WHERE id = 1`)).name).toBe('Mathematics');
      // MySQL DATEs arrive shifted by the MIS's timezone; the calendar day is recovered.
      expect(await db.get(`SELECT start_date, end_date FROM academic_terms WHERE id = 21`)).toEqual({ start_date: '2026-09-07', end_date: '2026-11-30' });
      expect(calls.every((c) => c.auth === 'Bearer int-token-1')).toBe(true);
      expect(calls.some((c) => c.url.includes('/integrations/sync/people'))).toBe(true);

      const enrol = await db.all(`SELECT student_id, academic_year_id, status FROM roster_enrolments ORDER BY student_id, academic_year_id`);
      expect(enrol).toEqual([
        { student_id: '1', academic_year_id: 7, status: 'ACTIVE' },
        { student_id: '3', academic_year_id: 6, status: 'DISABLED' },
        { student_id: '3', academic_year_id: 7, status: 'ACTIVE' },
      ]);
      // The pre-seeded students (s1, s2) are not on the MIS any more.
      expect((await db.get(`SELECT mis_status FROM roster_students WHERE student_id = 's1'`)).mis_status).toBe('REMOVED');
      const status = await as(adminToken).get('/api/rfid/roster/status');
      expect(status.body.data).toMatchObject({ students: 2, activeEnrolments: 2, classGroups: 1, credentialsConfigured: true, timetableSlots: 1, classesWithTimetable: 1 });
    });

    it('refuses to replace a populated roster with an empty MIS answer', async () => {
      vi.stubEnv('MIS_INTEGRATION_TOKEN', 'int-token-1');
      mockMis([[]]);
      const r = await as(adminToken).post('/api/rfid/roster/sync');
      expect(r.status).toBe(502);
      expect(r.body.message).toMatch(/kept the existing roster of 2/);
      expect((await db.get(`SELECT mis_status FROM roster_students WHERE student_id = 's1'`)).mis_status).toBe('ACTIVE');
    });

    it('reports a rejected credential clearly and records the failed run', async () => {
      vi.stubEnv('MIS_INTEGRATION_TOKEN', 'bad');
      mockMis([], { status: 401 });
      const r = await as(adminToken).post('/api/rfid/roster/sync');
      expect(r.status).toBe(502);
      expect(r.body.message).toMatch(/rejected Tendo’s service credentials/);
      const run = await db.get(`SELECT error FROM roster_sync_runs ORDER BY id DESC LIMIT 1`);
      expect(run.error).toMatch(/401/);
    });
  });

  describe('teacher register after RFID', () => {
    it('keeps scan provenance, records the override reason, and exposes it to the register', async () => {
      await db.run(`DELETE FROM attendance_records`);
      await db.run(`DELETE FROM attendance_record_history`);
      await db.run(
        `INSERT INTO attendance_records (student_id, student_name, class_id, class_name, session_date, period, session_type,
           status, marked_by, source, auto_status, first_scan_at)
         VALUES ('s1', 'John Doe', 'cg-3a', 'Senior 3A', '2026-09-21', 'Morning', 'homeroom', 'late', 'system:rfid', 'rfid', 'late', '2026-09-21T05:38:00.000Z')`
      );
      const save = await as(adminToken).post('/api/attendance/mark', {
        classId: 'cg-3a', className: 'Senior 3A', date: '2026-09-21', period: 'Morning',
        records: [{ studentId: 's1', studentName: 'John Doe', status: 'present', reason: 'Was on time; card reader queue' }],
      });
      expect(save.status).toBe(200);

      const row = await db.get(`SELECT * FROM attendance_records WHERE student_id = 's1'`);
      expect(row).toMatchObject({ status: 'present', source: 'rfid', auto_status: 'late', first_scan_at: '2026-09-21T05:38:00.000Z', marked_by: 'adm' });
      const hist = await db.get(`SELECT * FROM attendance_record_history WHERE student_id = 's1'`);
      expect(hist).toMatchObject({ previous_status: 'late', new_status: 'present', change_source: 'teacher', reason: 'Was on time; card reader queue' });

      const session = await as(adminToken).get('/api/attendance/session?classId=cg-3a&date=2026-09-21&period=Morning');
      expect(session.body.data.records[0]).toMatchObject({ status: 'present', source: 'rfid', autoStatus: 'late', firstScanAt: '2026-09-21T05:38:00.000Z' });
    });

    it('names the check-in system as the marker of an RFID-only register', async () => {
      await db.run(`DELETE FROM attendance_records`);
      await db.run(
        `INSERT INTO attendance_records (student_id, student_name, class_id, class_name, session_date, period, session_type, status, marked_by, source, auto_status)
         VALUES ('s2', 'Jane Doe', 'cg-3a', 'Senior 3A', '2026-09-22', 'Morning', 'homeroom', 'present', 'system:rfid', 'rfid', 'present')`
      );
      const session = await as(adminToken).get('/api/attendance/session?classId=cg-3a&date=2026-09-22&period=Morning');
      expect(session.body.data.markedByName).toBe('Check-in system');
    });
  });
});
