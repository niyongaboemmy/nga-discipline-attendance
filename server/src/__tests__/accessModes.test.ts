import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { Database } from 'sqlite';
import { app } from '../app.js';
import { config } from '../config.js';
import { setupTestDb, createTestUser } from './testUtils.js';
import { accessIdle, __resetPolicyState } from '../access/policy.js';
import { __resetSnapshotCache } from '../access/snapshot.js';
import { __resetHoldersCache } from '../access/misService.js';
import { __resetStudentClassCache } from '../access/students.js';

/**
 * Access control v2 modes (ACCESS_V2_MODE) end to end. MIS is never started:
 * `fetch` is stubbed. Fixture school:
 *   - class group 7: student 501; class group 8: student 502
 *   - teacher 101 (local Teacher role): v2 grants only at class group 7,
 *     minor sanctions only, and NO REPORTS_VIEW
 *   - admin 100 (local Admin role): v2 grants everything school-wide
 * Class groups are resolved from the local registers (attendance rows).
 */

const TEACHER = { id: '101', name: 'Teacher T', email: 't@school.test' };
const ADMIN = { id: '100', name: 'Admin A', email: 'a@school.test' };
const S1 = { id: '501', name: 'Alice (G7)' };
const S2 = { id: '502', name: 'Bob (G8)' };

const cls7 = { class_groups: [7] };
const entry = (scope: any, depth: string | null = null) => [{ depth, scope, via: [1] }];

const TEACHER_CAPS: Record<string, any> = {
  ATTENDANCE_MARK: entry(cls7),
  ATTENDANCE_VIEW_ALL: entry(cls7, 'detail'),
  EXCUSES_REVIEW: entry(cls7),
  DISCIPLINE_LOG: entry(cls7),
  DISCIPLINE_VIEW_ALL: entry(cls7, 'detail'),
  DISCIPLINE_REVIEW: entry(cls7),
  DISCIPLINE_ADJUST: entry(cls7),
  DISCIPLINE_SANCTION_MINOR: entry(cls7),
  NOTIFICATIONS_MANAGE: entry({ self: 101 }),
};
const ADMIN_CAPS: Record<string, any> = Object.fromEntries(
  [
    'ATTENDANCE_MARK', 'ATTENDANCE_VIEW_ALL', 'EXCUSES_REVIEW', 'DISCIPLINE_LOG', 'DISCIPLINE_VIEW_ALL',
    'DISCIPLINE_REVIEW', 'DISCIPLINE_ADJUST', 'DISCIPLINE_SANCTION_MINOR', 'DISCIPLINE_SANCTION_MAJOR',
    'DISCIPLINE_SUSPEND_APPROVE', 'REPORTS_VIEW', 'NOTIFICATIONS_MANAGE',
  ].map((k) => [k, entry({ all: true }, ['ATTENDANCE_VIEW_ALL', 'DISCIPLINE_VIEW_ALL', 'REPORTS_VIEW'].includes(k) ? 'detail' : null)])
);

const snapshotFor = (userId: number, caps: Record<string, any>) => ({
  v: mis.version, app: 'da', core: '1.0.0', user: { id: userId, persona: 'TEACHER', school_id: 1 }, year: 5,
  caps, grants: {}, home: null, systems: ['da'], generated_at: '2026-09-27T00:00:00Z',
});

const mis = {
  version: 1,
  accessMe: 'ok' as 'ok' | '503',
  holders: [{ user_id: 300, depth: null, via: [9] }] as any[] | 'fail',
  calls: [] as string[],
};

function stubMis() {
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    mis.calls.push(u);
    const auth = String((init?.headers as any)?.Authorization ?? '');
    const json = (data: any, status = 200) => new Response(JSON.stringify({ success: status < 400, data }), { status });
    if (u.includes('/access/me')) {
      if (mis.accessMe === '503') return json(null, 503);
      if (auth === 'Bearer tok-101') return json(snapshotFor(101, TEACHER_CAPS));
      if (auth === 'Bearer tok-100') return json(snapshotFor(100, ADMIN_CAPS));
      return json(null, 401);
    }
    if (u.includes('/access/holders')) {
      expect(auth.startsWith('Basic ')).toBe(true);
      if (mis.holders === 'fail') return json(null, 500);
      return json(mis.holders);
    }
    if (u.includes('/auth/verify')) return json({ user_id: 101, access_version: mis.version });
    return json([]);
  }));
}

const tokenFor = (u: { id: string; name: string; email: string }, role: string, misToken: string) =>
  jwt.sign({ ...u, role, misToken }, config.jwtSecret, { expiresIn: '1h' });

describe('access control v2 modes', () => {
  let db: Database;
  let teacher: string;
  let admin: string;
  let excuse1: number;
  let excuse2: number;

  beforeAll(async () => {
    db = await setupTestDb();
    await createTestUser(db, { ...TEACHER, roleLevel: 'TEACHER' });
    await createTestUser(db, { ...ADMIN, roleLevel: 'ADMIN' });
    teacher = tokenFor(TEACHER, 'teacher', 'tok-101');
    admin = tokenFor(ADMIN, 'admin', 'tok-100');

    // Local registers = the roster the class-group resolver reads.
    for (const [s, cls, status] of [[S1, '7', 'present'], [S2, '8', 'absent']] as const) {
      await db.run(
        `INSERT INTO attendance_records (student_id, student_name, class_id, class_name, session_date, period, session_type, status, marked_by)
         VALUES (?, ?, ?, ?, '2026-09-01', 'Morning', 'homeroom', ?, 'x')`,
        s.id, s.name, cls, `G${cls}`, status
      );
    }
    for (const s of [S1, S2]) {
      await db.run(
        `INSERT INTO discipline_records (student_id, student_name, type, category, severity, points, title, incident_date, logged_by)
         VALUES (?, ?, 'demerit', 'Misconduct', 'minor', 2, 'Seed', '2026-09-02', 'x')`,
        s.id, s.name
      );
    }
    excuse1 = (await db.run(
      `INSERT INTO excuse_requests (student_id, student_name, class_name, class_id, session_date, reason) VALUES (?, ?, 'G7', '7', '2026-09-01', 'ill')`,
      S1.id, S1.name
    )).lastID!;
    excuse2 = (await db.run(
      `INSERT INTO excuse_requests (student_id, student_name, class_name, class_id, session_date, reason) VALUES (?, ?, 'G8', '8', '2026-09-01', 'ill')`,
      S2.id, S2.name
    )).lastID!;
  });

  beforeEach(async () => {
    __resetSnapshotCache();
    __resetHoldersCache();
    __resetStudentClassCache();
    __resetPolicyState();
    mis.accessMe = 'ok';
    mis.version = 1;
    mis.holders = [{ user_id: 300, depth: null, via: [9] }];
    mis.calls = [];
    stubMis();
    await db.run('DELETE FROM access_shadow_diffs');
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(async () => {
    await accessIdle();
    delete process.env.ACCESS_V2_MODE;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const logDemerit = (t: string, studentId: string, sanction: string, extra: Record<string, unknown> = {}) =>
    request(app).post('/api/discipline').set(auth(t)).send({
      studentId, studentName: studentId, type: 'demerit', category: 'Misconduct', severity: 'minor',
      title: `T-${Math.random()}`, incidentDate: '2026-09-03', sanction, ...extra,
    });
  const diffs = () => db.all('SELECT * FROM access_shadow_diffs ORDER BY id');

  // -------------------------------------------------------------------------
  describe('off (the test default)', () => {
    it('is what NODE_ENV=test selects, and never talks to MIS access endpoints', async () => {
      const list = await request(app).get('/api/discipline').set(auth(teacher));
      expect(list.status).toBe(200);
      expect(list.body.data.map((r: any) => r.student_id).sort()).toEqual(expect.arrayContaining([S1.id, S2.id]));
      const res = await logDemerit(teacher, S2.id, 'suspension');
      expect(res.status).toBe(200);
      const rep = await request(app).get('/api/reports/class/8').set(auth(teacher));
      expect(rep.status).toBe(200);
      await accessIdle();
      expect(mis.calls.filter((u) => u.includes('/access/'))).toEqual([]);
      expect(await diffs()).toEqual([]);
    });

    it('keeps staff broadcasts addressed to all', async () => {
      const res = await logDemerit(teacher, S1.id, 'none', { severity: 'major' });
      expect(res.status).toBe(200);
      const row = await db.get(`SELECT user_id FROM notifications WHERE title = 'Major incident: ${S1.id}' ORDER BY id DESC`);
      expect(row.user_id).toBe('all');
    });
  });

  // -------------------------------------------------------------------------
  describe('shadow', () => {
    beforeEach(() => { process.env.ACCESS_V2_MODE = 'shadow'; });

    it('leaves responses unchanged and counts the rows v2 would hide', async () => {
      const list = await request(app).get('/api/discipline').set(auth(teacher));
      expect(list.status).toBe(200);
      expect(list.body.data.map((r: any) => r.student_id)).toEqual(expect.arrayContaining([S1.id, S2.id]));
      await accessIdle();
      const d = (await diffs()).find((r: any) => r.capability === 'DISCIPLINE_VIEW_ALL@detail:rows');
      expect(d).toBeTruthy();
      expect(d.route).toBe('GET /api/discipline/');
      expect(d.legacy_allowed).toBe(1);
      expect(d.v2_allowed).toBe(0);
      expect(JSON.parse(d.sample_target)).toMatchObject({ hidden: expect.any(Number) });
      expect(d.sample_target).not.toContain('Bob');
    });

    it('records legacy-allowed / v2-denied guards and sanctions, without changing the status', async () => {
      const rep = await request(app).get('/api/reports/class/7').set(auth(teacher));
      expect(rep.status).toBe(200);
      const sanction = await logDemerit(teacher, S1.id, 'suspension');
      expect(sanction.status).toBe(200);
      const mark = await request(app).post('/api/attendance/mark').set(auth(teacher)).send({
        classId: '8', className: 'G8', date: '2026-09-04', records: [{ studentId: S2.id, studentName: S2.name, status: 'present' }],
      });
      expect(mark.status).toBe(200);
      await accessIdle();
      const rows = await diffs();
      const caps = rows.map((r: any) => `${r.capability} ${r.route}`);
      expect(caps).toContain('REPORTS_VIEW GET /api/reports/class/:id');
      expect(caps).toContain('DISCIPLINE_SUSPEND_APPROVE SANCTION suspension');
      expect(caps).toContain('ATTENDANCE_MARK POST /api/attendance/mark');
      expect(rows.every((r: any) => r.legacy_allowed === 1 && r.v2_allowed === 0)).toBe(true);
    });

    it('counts repeat disagreements as hits, throttled per key', async () => {
      await request(app).get('/api/reports/class/7').set(auth(teacher));
      await accessIdle();
      __resetPolicyState(); // lift the 60s throttle
      await request(app).get('/api/reports/class/7').set(auth(teacher));
      await request(app).get('/api/reports/class/7').set(auth(teacher)); // throttled
      await accessIdle();
      const row = (await diffs()).find((r: any) => r.capability === 'REPORTS_VIEW');
      expect(row.hits).toBe(2);
    });

    it('agreeing decisions are not recorded', async () => {
      const res = await request(app).get('/api/discipline').set(auth(admin));
      expect(res.status).toBe(200);
      await accessIdle();
      expect(await diffs()).toEqual([]);
    });

    it('skips silently when MIS has no access v2 (503)', async () => {
      mis.accessMe = '503';
      const res = await request(app).get('/api/reports/class/7').set(auth(teacher));
      expect(res.status).toBe(200);
      await accessIdle();
      expect(await diffs()).toEqual([]);
    });

    it("keeps the 'all' broadcast and logs who v2 would notify", async () => {
      const res = await logDemerit(teacher, S1.id, 'none', { severity: 'major' });
      expect(res.status).toBe(200);
      await accessIdle();
      const row = await db.get(`SELECT user_id FROM notifications WHERE title = 'Major incident: ${S1.id}' ORDER BY id DESC`);
      expect(row.user_id).toBe('all');
      const holdersCall = mis.calls.find((u) => u.includes('/access/holders'))!;
      expect(holdersCall).toContain('cap=DISCIPLINE_REVIEW');
      expect(holdersCall).toContain('classGroupId=7');
      expect(holdersCall).toContain('studentId=501');
      const d = (await diffs()).find((r: any) => r.capability === 'notify:DISCIPLINE_REVIEW');
      expect(JSON.parse(d.sample_target)).toMatchObject({ count: 1, recipients: ['300'] });
    });
  });

  // -------------------------------------------------------------------------
  describe('enforce', () => {
    beforeEach(() => { process.env.ACCESS_V2_MODE = 'enforce'; });

    it('marks only registers in scope', async () => {
      const ok = await request(app).post('/api/attendance/mark').set(auth(teacher)).send({
        classId: '7', className: 'G7', date: '2026-09-05', records: [{ studentId: S1.id, studentName: S1.name, status: 'present' }],
      });
      expect(ok.status).toBe(200);
      const no = await request(app).post('/api/attendance/mark').set(auth(teacher)).send({
        classId: '8', className: 'G8', date: '2026-09-05', records: [{ studentId: S2.id, studentName: S2.name, status: 'present' }],
      });
      expect(no.status).toBe(403);
      const stored = await db.get(`SELECT COUNT(*) AS n FROM attendance_records WHERE class_id = '8' AND session_date = '2026-09-05'`);
      expect(stored.n).toBe(0);
      const session = await request(app).get('/api/attendance/session').query({ classId: '8', date: '2026-09-01' }).set(auth(teacher));
      expect(session.status).toBe(403);
    });

    it('filters attendance records to the scope', async () => {
      const res = await request(app).get('/api/attendance/records').set(auth(teacher));
      expect(res.status).toBe(200);
      expect(new Set(res.body.data.map((r: any) => r.class_id))).toEqual(new Set(['7']));
      const all = await request(app).get('/api/attendance/records').set(auth(admin));
      expect(new Set(all.body.data.map((r: any) => r.class_id))).toEqual(new Set(['7', '8']));
    });

    it('scopes excuse listing and review', async () => {
      const list = await request(app).get('/api/attendance/excuses').set(auth(teacher));
      expect(list.status).toBe(200);
      expect(list.body.data.map((e: any) => e.student_id)).toEqual([S1.id]);
      const denied = await request(app).put(`/api/attendance/excuse/${excuse2}/status`).set(auth(teacher)).send({ status: 'approved' });
      expect(denied.status).toBe(403);
      const bulk = await request(app).put('/api/attendance/excuses/bulk').set(auth(teacher)).send({ ids: [excuse1, excuse2], status: 'rejected' });
      expect(bulk.status).toBe(403);
      expect(bulk.body.data.denied).toEqual([excuse2]);
      const ok = await request(app).put(`/api/attendance/excuse/${excuse1}/status`).set(auth(teacher)).send({ status: 'rejected' });
      expect(ok.status).toBe(200);
    });

    it('filters discipline list, overview and stats to students in scope', async () => {
      const list = await request(app).get('/api/discipline').set(auth(teacher));
      expect(list.status).toBe(200);
      expect(new Set(list.body.data.map((r: any) => r.student_id))).toEqual(new Set([S1.id]));
      expect(list.body.total).toBe(list.body.data.length);

      const overview = await request(app).get('/api/discipline/overview').set(auth(teacher));
      expect(overview.status).toBe(200);
      expect(overview.body.data.topDemerits.map((t: any) => t.student_id)).toEqual([S1.id]);

      const stats = await request(app).get('/api/discipline/stats').set(auth(teacher));
      expect(stats.status).toBe(200);
      expect(stats.body.data.students.map((s: any) => s.studentId)).not.toContain(S2.id);

      const adminList = await request(app).get('/api/discipline').set(auth(admin));
      expect(new Set(adminList.body.data.map((r: any) => r.student_id))).toEqual(new Set([S1.id, S2.id]));
    });

    it('filters class reports', async () => {
      const own = await request(app).get('/api/reports/class/7').set(auth(admin));
      expect(own.body.data.map((r: any) => r.student_id)).toEqual([S1.id]);
      // The teacher's snapshot has no REPORTS_VIEW at all: the guard refuses.
      const t = await request(app).get('/api/reports/class/7').set(auth(teacher));
      expect(t.status).toBe(403);
    });

    it('applies the sanction ladder at the student\'s class group', async () => {
      expect((await logDemerit(teacher, S1.id, 'warning')).status).toBe(200);
      expect((await logDemerit(teacher, S1.id, 'none')).status).toBe(200);
      const major = await logDemerit(teacher, S1.id, 'detention');
      expect(major.status).toBe(403);
      expect(major.body.code).toBe('SANCTION_NOT_PERMITTED');
      expect((await logDemerit(teacher, S1.id, 'suspension')).status).toBe(403);
      expect((await logDemerit(teacher, S2.id, 'warning')).status).toBe(403);
      expect((await logDemerit(admin, S2.id, 'suspension')).status).toBe(200);

      const rec = await db.get(`SELECT id FROM discipline_records WHERE student_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1`, S1.id);
      const upgrade = await request(app).put(`/api/discipline/${rec.id}/status`).set(auth(teacher)).send({ status: 'resolved', sanction: 'community_service' });
      expect(upgrade.status).toBe(403);
      const minor = await request(app).put(`/api/discipline/${rec.id}/status`).set(auth(teacher)).send({ status: 'resolved', sanction: 'parent_contact' });
      expect(minor.status).toBe(200);

      const other = await db.get(`SELECT id FROM discipline_records WHERE student_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1`, S2.id);
      const review = await request(app).put(`/api/discipline/${other.id}/status`).set(auth(teacher)).send({ status: 'under_review' });
      expect(review.status).toBe(403);
    });

    it('sends staff notices to the capability holders only', async () => {
      const res = await logDemerit(teacher, S1.id, 'none', { severity: 'major', title: 'holders-case' });
      expect(res.status).toBe(200);
      const rows = await db.all(`SELECT user_id FROM notifications WHERE message LIKE '%holders-case%' AND title LIKE 'Major incident%'`);
      expect(rows.map((r: any) => r.user_id)).toEqual(['300']);
    });

    it('falls back to the local admins when the holders call fails', async () => {
      mis.holders = 'fail';
      const res = await logDemerit(teacher, S2.id, 'none', { severity: 'major', title: 'fallback-case' });
      expect(res.status).toBe(200);
      const rows = await db.all(`SELECT user_id FROM notifications WHERE message LIKE '%fallback-case%' AND title LIKE 'Major incident%'`);
      expect(rows.map((r: any) => r.user_id)).toEqual([ADMIN.id]);
    });

    it('fails closed (503) when there is no snapshot', async () => {
      mis.accessMe = '503';
      const res = await request(app).get('/api/discipline').set(auth(teacher));
      expect(res.status).toBe(503);
    });
  });

  // -------------------------------------------------------------------------
  describe('GET /api/access/me and verify-mis', () => {
    it('returns the snapshot, or 503 when there is none', async () => {
      const ok = await request(app).get('/api/access/me').set(auth(teacher));
      expect(ok.status).toBe(200);
      expect(ok.body.data.caps.ATTENDANCE_MARK).toBeTruthy();
      mis.accessMe = '503';
      __resetSnapshotCache();
      const none = await request(app).get('/api/access/me').set(auth(teacher));
      expect(none.status).toBe(503);
    });

    it('verify-mis response is unchanged and a new access_version drops the cached snapshot', async () => {
      const meCalls = () => mis.calls.filter((u) => u.includes('/access/me')).length;
      await request(app).get('/api/access/me').set(auth(teacher));
      let res = await request(app).get('/api/sso/verify-mis').set(auth(teacher));
      expect(res.body).toEqual({ success: true });
      await request(app).get('/api/access/me').set(auth(teacher));
      expect(meCalls()).toBe(1); // same version: served from cache

      mis.version = 2; // e.g. a grant was added in Access Studio
      res = await request(app).get('/api/sso/verify-mis').set(auth(teacher));
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true });
      const me = await request(app).get('/api/access/me').set(auth(teacher));
      expect(meCalls()).toBe(2);
      expect(me.body.data.v).toBe(2);
    });
  });
});
