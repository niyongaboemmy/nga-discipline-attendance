import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { Database } from 'sqlite';
import { setupTestDb, createTestUser, authHeader } from './testUtils.js';
import { app } from '../app.js';
import { config } from '../config.js';
import { drain } from '../modules/rfid/workQueue.js';
import { resolveEnrolment, syncRosterFromMis } from '../modules/rfid/roster.service.js';
import { syncMisUsers } from '../routes/admin.js';
import {
  _setStatusTransportForTests,
  activeStudentIds,
  checkStudentsActive,
  filterActive,
  inactiveIdSet,
  localActiveStates,
  misStatusIsActive,
} from '../services/activeStudents.js';

/**
 * Active users only (ACTIVE_USERS_CONTRACTS.md, "Tendo"): lists of people and
 * new records are for active students; a student whose MIS status is unknown
 * is never blocked; history stays.
 */
describe('active users only', () => {
  let db: Database;
  let adminToken: string;
  let teacherToken: string;
  /** Admin token carrying a MIS token, for the /api/mis proxy. */
  let misAdminToken: string;

  const roster = (id: string, name: string, status: string | null) =>
    db.run(
      `INSERT INTO roster_students (student_id, name, mis_status, synced_at) VALUES (?, ?, ?, '2026-01-01T00:00:00Z')
       ON CONFLICT(student_id) DO UPDATE SET mis_status = excluded.mis_status`,
      id, name, status
    );

  beforeAll(async () => {
    db = await setupTestDb();
    adminToken = (await createTestUser(db, { id: '9001', name: 'Ada Admin', email: 'a@s.test', roleLevel: 'ADMIN' })).token;
    teacherToken = (await createTestUser(db, { id: '9002', name: 'Tia Teacher', email: 't@s.test', roleLevel: 'TEACHER' })).token;
    misAdminToken = jwt.sign(
      { id: '9001', name: 'Ada Admin', email: 'a@s.test', role: 'admin', misToken: 'mis-tok' },
      config.jwtSecret, { expiresIn: '1h' }
    );
  });

  beforeEach(async () => {
    for (const t of ['rfid_card_assignments', 'rfid_cards', 'roster_enrolments', 'roster_students', 'roster_class_groups',
      'attendance_records', 'discipline_records', 'audit_log']) {
      await db.run(`DELETE FROM ${t}`);
    }
    await db.run(`DELETE FROM users WHERE id NOT IN ('9001', '9002')`);
    _setStatusTransportForTests(null);
  });

  afterEach(async () => {
    await drain();
    _setStatusTransportForTests(null);
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  // ---------------------------------------------------------------- helper
  describe('services/activeStudents', () => {
    it('reads MIS statuses: only ACTIVE is active, nothing is unknown', () => {
      expect(misStatusIsActive('ACTIVE')).toBe(true);
      expect(misStatusIsActive('active')).toBe(true);
      for (const s of ['INACTIVE', 'SUSPENDED', 'REMOVED']) expect(misStatusIsActive(s)).toBe(false);
      expect(misStatusIsActive(null)).toBeNull();
      expect(misStatusIsActive('')).toBeNull();
    });

    it('combines users.status and the roster MIS status; inactive wins, no data is unknown', async () => {
      await roster('101', 'Active A', 'ACTIVE');
      await roster('102', 'Suspended S', 'SUSPENDED');
      await roster('103', 'Removed R', 'REMOVED');
      await roster('104', 'Stale ACTIVE', 'ACTIVE');
      await roster('105', 'No status', null);
      await db.run(`INSERT INTO users (id, name, role, status) VALUES ('104', 'Stale ACTIVE', 'student', 'inactive')`);

      const states = await localActiveStates(db, ['101', '102', '103', '104', '105', '106']);
      expect(Object.fromEntries(states)).toEqual({
        101: 'active', 102: 'inactive', 103: 'inactive', 104: 'inactive', 105: 'unknown', 106: 'unknown',
      });
      expect([...(await inactiveIdSet(db))].sort()).toEqual(['102', '103', '104']);
      expect([...(await activeStudentIds(db))]).toEqual(['101']);
      const rows = [{ id: '101' }, { id: '102' }, { id: '105' }, { id: '106' }];
      expect(await filterActive(db, rows, (r) => r.id)).toEqual([{ id: '101' }, { id: '105' }, { id: '106' }]);
    });

    it('asks MIS about unknown ids: a status-aware answer decides (absent = REMOVED) and is stored', async () => {
      await db.run(`INSERT INTO users (id, name, role) VALUES ('201', 'Was Active', 'student')`);
      const asked: number[][] = [];
      _setStatusTransportForTests(async (ids) => {
        asked.push(ids);
        return [{ user_id: 200, status: 'ACTIVE' }, { user_id: 201, status: 'INACTIVE' }];
      });
      const res = await checkStudentsActive(db, ['200', '201', '202']);
      expect(asked).toEqual([[200, 201, 202]]);
      expect(res).toEqual({ inactive: ['201', '202'], unknown: [] });
      expect((await db.get(`SELECT status FROM users WHERE id = '201'`)).status).toBe('inactive');

      // Cached: the second check doesn't ask again.
      await checkStudentsActive(db, ['200']);
      expect(asked).toHaveLength(1);
    });

    it('today\'s MIS (no status in the lookup) or an unreachable MIS leaves ids unknown', async () => {
      _setStatusTransportForTests(async () => [{ user_id: 300 }]);
      expect(await checkStudentsActive(db, ['300', '301'])).toEqual({ inactive: [], unknown: ['300', '301'] });

      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      _setStatusTransportForTests(async () => { throw new Error('ECONNREFUSED'); });
      expect(await checkStudentsActive(db, ['302'])).toEqual({ inactive: [], unknown: ['302'] });
      expect(warn).toHaveBeenCalled();
    });
  });

  // ------------------------------------------------------------ /api/mis
  describe('/api/mis roster proxy', () => {
    const calls: string[] = [];
    const stubMis = (routes: Record<string, any>) => {
      calls.length = 0;
      vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
        const u = new URL(String(url));
        calls.push(u.pathname + u.search);
        const hit = Object.entries(routes).find(([p]) => u.pathname.endsWith(p));
        if (!hit) return new Response(JSON.stringify({ success: true, data: [] }), { status: 200 });
        const [, body] = hit;
        if (typeof body === 'number') return new Response('{}', { status: body });
        return new Response(JSON.stringify({ success: true, data: body }), { status: 200 });
      }));
    };
    const get = (p: string) => request(app).get(p).set(authHeader(misAdminToken));

    it('/students?class_id leaves out students Tendo knows are inactive, and any row MIS marks non-ACTIVE', async () => {
      await roster('2', 'Bea', 'INACTIVE');
      await db.run(`INSERT INTO users (id, name, role, status) VALUES ('4', 'Dee', 'student', 'inactive')`);
      stubMis({
        '/academics/class-groups/7/students': [
          { user_id: 1, first_name: 'Al', last_name: 'One' },
          { user_id: 2, first_name: 'Bea', last_name: 'Two' },
          { user_id: 3, first_name: 'Cy', last_name: 'Three', status: 'SUSPENDED' },
          { user_id: 4, first_name: 'Dee', last_name: 'Four' },
          { user_id: 5, first_name: 'Eve', last_name: 'Five', status: 'ACTIVE' },
        ],
      });
      const res = await get('/api/mis/students?class_id=7');
      expect(res.status).toBe(200);
      expect(res.body.data.map((s: any) => s.id)).toEqual(['1', '5']);
    });

    it('/students (school-wide) filters the class rosters; the /users fallback asks for ACTIVE', async () => {
      await roster('2', 'Bea', 'REMOVED');
      stubMis({
        '/academics/class-groups': [{ class_group_id: 7 }],
        '/academics/class-groups/7/students': [{ user_id: 1, first_name: 'Al' }, { user_id: 2, first_name: 'Bea' }],
      });
      expect((await get('/api/mis/students')).body.data.map((s: any) => s.id)).toEqual(['1']);

      stubMis({
        '/academics/class-groups': 403,
        '/users': [
          { user: { user_id: 1, username: 'al', status: 'ACTIVE' } },
          { user: { user_id: 6, username: 'fi', status: 'INACTIVE' } },
          { user: { user_id: 2, username: 'bea' } },
        ],
      });
      const res = await get('/api/mis/students');
      expect(res.body.data.map((s: any) => s.id)).toEqual(['1']);
      expect(calls.find((c) => c.startsWith('/users'))).toMatch(/status=ACTIVE/);
    });

    it('/staff drops inactive accounts from /users and from the teacher-assignment fallback', async () => {
      stubMis({
        '/users': [
          { user: { user_id: 50, username: 'tom', status: 'ACTIVE' }, roles: [{ name: 'TEACHER' }] },
          { user: { user_id: 51, username: 'ann', status: 'INACTIVE' }, roles: [{ name: 'TEACHER' }] },
          { user: { user_id: 52, username: 'kid', status: 'ACTIVE' }, roles: [{ name: 'STUDENT' }] },
        ],
      });
      const res = await get('/api/mis/staff');
      expect(res.body.data.map((s: any) => s.id)).toEqual(['50']);
      expect(calls.find((c) => c.startsWith('/users'))).toMatch(/status=ACTIVE/);

      await db.run(`INSERT INTO users (id, name, role, status) VALUES ('61', 'Old Teacher', 'teacher', 'inactive')`);
      stubMis({
        '/users': 403,
        '/academics/teacher-assignments': [
          { user_id: 60, teacher_name: 'New Teacher', status: 'ACTIVE' },
          { user_id: 61, teacher_name: 'Old Teacher', status: 'ACTIVE' },
        ],
      });
      expect((await get('/api/mis/staff')).body.data.map((s: any) => s.id)).toEqual(['60']);
    });
  });

  // ------------------------------------------------------- student writes
  describe('writes for students', () => {
    const register = (records: Array<{ studentId: string; studentName: string; status: string }>) =>
      request(app).post('/api/attendance/mark').set(authHeader(teacherToken)).send({
        classId: 'class-9', className: 'Grade 9A', date: '2026-05-11', period: 'Morning', records,
      });

    it('/attendance/mark answers 422 STUDENT_INACTIVE and writes nothing when a student is inactive', async () => {
      await roster('701', 'Active Ann', 'ACTIVE');
      await roster('702', 'Gone Gus', 'INACTIVE');
      const res = await register([
        { studentId: '701', studentName: 'Active Ann', status: 'present' },
        { studentId: '702', studentName: 'Gone Gus', status: 'absent' },
      ]);
      expect(res.status).toBe(422);
      expect(res.body).toMatchObject({ success: false, code: 'STUDENT_INACTIVE', ids: ['702'] });
      expect((await db.get(`SELECT COUNT(*) AS n FROM attendance_records`)).n).toBe(0);
    });

    it('/attendance/mark accepts students whose status is unknown, even with MIS down', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      _setStatusTransportForTests(async () => { throw new Error('MIS down'); });
      await roster('701', 'Active Ann', 'ACTIVE');
      const res = await register([
        { studentId: '701', studentName: 'Active Ann', status: 'present' },
        { studentId: '799', studentName: 'Never Synced', status: 'present' },
      ]);
      expect(res.status).toBe(200);
      expect((await db.get(`SELECT COUNT(*) AS n FROM attendance_records`)).n).toBe(2);
    });

    it('/discipline (single and bulk) answers 422 STUDENT_INACTIVE for an inactive student', async () => {
      await db.run(`INSERT INTO users (id, name, role, status) VALUES ('702', 'Gone Gus', 'student', 'inactive')`);
      const incident = {
        type: 'demerit', category: 'Tardiness', severity: 'minor', title: 'Late', incidentDate: '2026-05-04',
      };
      const one = await request(app).post('/api/discipline').set(authHeader(teacherToken))
        .send({ ...incident, studentId: '702', studentName: 'Gone Gus' });
      expect(one.status).toBe(422);
      expect(one.body).toMatchObject({ code: 'STUDENT_INACTIVE', ids: ['702'] });

      const bulk = await request(app).post('/api/discipline/bulk').set(authHeader(teacherToken)).send({
        ...incident, students: [{ studentId: 'stu-a', studentName: 'A' }, { studentId: '702', studentName: 'Gone Gus' }],
      });
      expect(bulk.status).toBe(422);
      expect(bulk.body.ids).toEqual(['702']);
      expect((await db.get(`SELECT COUNT(*) AS n FROM discipline_records`)).n).toBe(0);

      const ok = await request(app).post('/api/discipline').set(authHeader(teacherToken))
        .send({ ...incident, studentId: 'stu-a', studentName: 'A' });
      expect(ok.status).toBe(200);
    });
  });

  // ------------------------------------------------------------------ RFID
  describe('RFID', () => {
    const as = (p: string) => request(app).get(p).set(authHeader(adminToken));

    it('/students lists active students; include_inactive=1 adds the rest, tagged', async () => {
      await roster('s1', 'John Active', 'ACTIVE');
      await roster('s2', 'Jane Suspended', 'SUSPENDED');
      await roster('s3', 'Jim Unsynced', null);
      const list = await as('/api/rfid/students');
      expect(list.body.data.map((r: any) => r.id).sort()).toEqual(['s1', 's3']);
      const all = await as('/api/rfid/students?include_inactive=1');
      expect(all.body.data.map((r: any) => r.id).sort()).toEqual(['s1', 's2', 's3']);
      expect(all.body.data.find((r: any) => r.id === 's2')).toMatchObject({ inactive: true, status: 'SUSPENDED' });
    });

    it('assigning a card to an inactive student is refused (422 STUDENT_INACTIVE)', async () => {
      await roster('s2', 'Jane Suspended', 'SUSPENDED');
      const card = (await request(app).post('/api/rfid/cards').set(authHeader(adminToken)).send({ uid: '04A1B2C3' })).body.data.id;
      const res = await request(app).post(`/api/rfid/cards/${card}/assign`).set(authHeader(adminToken)).send({ studentId: 's2' });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('STUDENT_INACTIVE');
      expect((await db.get(`SELECT COUNT(*) AS n FROM rfid_card_assignments`)).n).toBe(0);
    });

    it('resolveEnrolment ignores an inactive student, so a tap records nothing', async () => {
      await roster('s1', 'John', 'ACTIVE');
      await db.run(`INSERT INTO roster_class_groups (class_id, name, synced_at) VALUES ('7', 'G7', 'x')`);
      await db.run(`INSERT INTO roster_enrolments (student_id, class_id, academic_year_id, status, synced_at) VALUES ('s1', '7', 5, 'ACTIVE', 'x')`);
      expect(await resolveEnrolment(db, 's1', 5)).toMatchObject({ kind: 'ok', classId: '7' });
      await roster('s1', 'John', 'INACTIVE');
      expect(await resolveEnrolment(db, 's1', 5)).toEqual({ kind: 'none' });
    });
  });

  // ------------------------------------------------------------ status sync
  describe('status sync', () => {
    it('syncMisUsers stores the MIS status (asking MIS for every status) and keeps it when MIS sends none', async () => {
      let asked = '';
      const mis = (rows: any[]) => vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
        asked = String(url);
        return new Response(JSON.stringify({ success: true, data: rows }), { status: 200 });
      }));
      mis([
        { user: { user_id: 801, username: 'on', status: 'ACTIVE' } },
        { user: { user_id: 802, username: 'off', status: 'INACTIVE' } },
        { user: { user_id: 803, username: 'sus', status: 'SUSPENDED' } },
      ]);
      await syncMisUsers('mis-tok');
      expect(new URL(asked).searchParams.get('status')).toBe('all');
      const rows = await db.all(`SELECT id, status FROM users WHERE id IN ('801','802','803') ORDER BY id`);
      expect(rows).toEqual([
        { id: '801', status: 'active' }, { id: '802', status: 'inactive' }, { id: '803', status: 'inactive' },
      ]);

      mis([{ user: { user_id: 802, username: 'off' } }]);
      await syncMisUsers('mis-tok');
      expect((await db.get(`SELECT status FROM users WHERE id = '802'`)).status).toBe('inactive');

      mis([{ user: { user_id: 802, username: 'off', status: 'ACTIVE' } }]);
      await syncMisUsers('mis-tok');
      expect((await db.get(`SELECT status FROM users WHERE id = '802'`)).status).toBe('active');
    });

    it('the roster sync writes users.status for everyone it sees, and REMOVED students become inactive', async () => {
      vi.stubEnv('MIS_INTEGRATION_TOKEN', 'svc');
      await db.run(`INSERT INTO users (id, name, role) VALUES ('901', 'Kid', 'student'), ('902', 'Staffer', 'teacher'), ('903', 'Leaver', 'student')`);
      await roster('903', 'Leaver', 'ACTIVE');
      const fetchImpl = async (url: string) => {
        const path = new URL(url).pathname;
        const data =
          path.endsWith('/reference') ? { classGroups: [] }
          : path.endsWith('/people') ? {
            users: [
              { id: 901, status: 'SUSPENDED', roles: [{ name: 'STUDENT' }], classGroups: [] },
              { id: 902, status: 'INACTIVE', roles: [{ name: 'TEACHER' }] },
            ],
            pagination: { hasMore: false },
          }
          : { calendarSlots: [] };
        return { ok: true, status: 200, json: async () => ({ data }) };
      };
      await syncRosterFromMis(db, { fetchImpl });
      const rows = await db.all(`SELECT id, status FROM users WHERE id IN ('901','902','903') ORDER BY id`);
      expect(rows).toEqual([
        { id: '901', status: 'inactive' }, { id: '902', status: 'inactive' }, { id: '903', status: 'inactive' },
      ]);
    });
  });

  // ----------------------------------------------------------------- admin
  describe('admin user management', () => {
    beforeEach(async () => {
      await db.run(`INSERT INTO users (id, name, role, status) VALUES
        ('a1', 'Active Student', 'student', 'active'),
        ('a2', 'Gone Student', 'student', 'inactive'),
        ('a3', 'Gone Teacher', 'teacher', 'inactive')`);
    });
    const get = (p: string) => request(app).get(p).set(authHeader(adminToken));

    it('lists active users by default, with ?status=inactive|all', async () => {
      const ids = async (q: string) => (await get(`/api/admin/users${q}`)).body.data.map((u: any) => u.id).sort();
      expect(await ids('')).toEqual(['9001', '9002', 'a1']);
      expect(await ids('?status=inactive')).toEqual(['a2', 'a3']);
      expect(await ids('?status=all')).toEqual(['9001', '9002', 'a1', 'a2', 'a3']);
      expect((await get('/api/admin/users?status=bogus')).status).toBe(400);
    });

    it('overview counts active roles and inactive accounts separately', async () => {
      const o = (await get('/api/admin/overview')).body.data;
      expect(o).toMatchObject({
        total: 3, students: 1, teachers: 1, admins: 1, inactive: 2,
        inactiveByRole: { students: 1, teachers: 1, admins: 0, unassigned: 0 },
      });
    });
  });
});
