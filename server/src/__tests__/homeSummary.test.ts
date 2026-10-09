import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';

// Read at module load by the home summary service: make the morning register
// due from midnight on every day, so C-01 does not depend on when this runs.
vi.hoisted(() => {
  process.env.HOMEROOM_START_TIME = '00:00';
  process.env.SCHOOL_DAYS = '0,1,2,3,4,5,6';
  // A small verification cache, so the eviction test stays fast.
  process.env.MIS_VERIFY_CACHE_MAX = '40';
});

import request from 'supertest';
import { Database } from 'sqlite';
import { app } from '../app.js';
import { setupTestDb, createTestUser } from './testUtils.js';
import { accessIdle, __resetPolicyState } from '../access/policy.js';
import { __resetSnapshotCache } from '../access/snapshot.js';
import { __resetStudentClassCache } from '../access/students.js';
import * as misBearer from '../middleware/misBearerAuth.js';
import * as integration from '../modules/integration/integration.routes.js';
import { lensForClass } from '../modules/integration/homeSummary.service.js';
import { schoolDateString, addDays } from '../shared/schoolTime.js';
import { config } from '../config.js';

const { __resetMisBearerCache } = misBearer;

/**
 * POST /api/integration/home-summary -- the MIS Home page's D&A slice.
 * MIS is never started: `fetch` is stubbed. Fixture school:
 *   - class group 7 (G7): student 501. Teacher 101 is its Class Teacher.
 *   - class group 8 (G8): students 502..506 -- not the teacher's class.
 *   - admin 100: local Admin role, Class Teacher of nothing.
 *   - 900: a valid MIS user who never signed in here.
 */

const TODAY = schoolDateString();
/** This app's public URL (from the environment), the prefix of every link. */
const APP = config.appPublicUrl;
const DAY = (n: number) => addDays(TODAY, -n);

const MIS_USERS: Record<string, number> = {
  'mis-teacher': 101,
  'mis-student': 501,
  'mis-admin': 100,
  'mis-viewer': 102,
  'mis-stranger': 900,
  'mis-notes': 103,
  'mis-pairs': 104,
  'mis-school': 105,
  'mis-learner2': 508,
  'mis-conduct': 106,
  'mis-conduct-summary': 107,
  'mis-registrar': 109,
};
/** MIS user for a token: the fixture map, plus `bulk-<n>` -> 100000 + n. */
const misUserFor = (token: string) =>
  MIS_USERS[token] ?? (/^bulk-\d+$/.test(token) ? 100000 + Number(token.slice(5)) : undefined);

const entry = (scope: any, depth: string | null = null) => [{ depth, scope, via: [1] }];
const SNAPSHOT_CAPS: Record<number, Record<string, any>> = {
  101: {
    ATTENDANCE_MARK: entry({ class_groups: [7] }),
    ATTENDANCE_VIEW_ALL: entry({ class_groups: [7] }, 'detail'),
    EXCUSES_REVIEW: entry({ class_groups: [7] }),
    NOTIFICATIONS_MANAGE: entry({ self: 101 }),
  },
  // An insights-style viewer: attendance of class 8 at summary depth only.
  102: {
    ATTENDANCE_VIEW_ALL: entry({ class_groups: [8] }, 'summary'),
  },
  // A subject teacher: Maths (30) in class 20 only -- a (subject, class) pair.
  104: {
    ATTENDANCE_MARK: entry({ pairs: [[30, 20]] }),
  },
  // Discipline master of class 7 (detail) who can review.
  106: {
    DISCIPLINE_VIEW_ALL: entry({ class_groups: [7] }, 'detail'),
    DISCIPLINE_REVIEW: entry({ class_groups: [7] }),
  },
  // Discipline insights at summary depth only: no names, so no D items.
  107: {
    DISCIPLINE_VIEW_ALL: entry({ class_groups: [7] }, 'summary'),
    DISCIPLINE_REVIEW: entry({ class_groups: [7] }),
  },
  // Assigns local roles.
  109: {
    USERS_MANAGE: entry({ all: true }),
  },
  // School-wide reviewer (DOS-style).
  105: {
    ATTENDANCE_VIEW_ALL: entry({ all: true }, 'detail'),
    EXCUSES_REVIEW: entry({ all: true }),
  },
};

const mis = {
  calls: [] as string[],
  down: false,
  /** Status MIS /auth/verify answers with instead of verifying (e.g. 500). */
  verifyStatus: null as number | null,
  /** Tokens MIS no longer accepts. */
  revoked: new Set<string>(),
};

function stubMis() {
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    mis.calls.push(u);
    const auth = String((init?.headers as any)?.Authorization ?? '');
    const token = auth.replace(/^Bearer /, '');
    const json = (data: any, status = 200) => new Response(JSON.stringify({ success: status < 400, data }), { status });
    if (u.includes('/auth/verify')) {
      if (mis.down) throw new TypeError('fetch failed: connect ECONNREFUSED 10.0.0.5:4000 /srv/secret/path');
      if (mis.verifyStatus) return json(null, mis.verifyStatus);
      const id = mis.revoked.has(token) ? undefined : misUserFor(token);
      return id ? json({ userId: id, access_version: 1 }) : json(null, 401);
    }
    if (u.includes('/access/me')) {
      const id = misUserFor(token)!;
      const caps = SNAPSHOT_CAPS[id];
      if (!caps) return json(null, 401);
      return json({
        v: 1, app: 'da', core: '1.0.0', user: { id, persona: 'TEACHER', school_id: 1 }, year: 5,
        caps, grants: {}, home: null, systems: ['da'], generated_at: '2026-09-27T00:00:00Z',
      });
    }
    // Class Teacher placement (MIS UserGrade).
    if (/\/users\/101\/grades/.test(u)) {
      return json([{ class_group_id: 7, class_group_name: 'G7', academic_year_is_current: true }]);
    }
    return json([]);
  }));
}

// ---------------------------------------------------------------------------
// Contract: the full HomeSummary shape (HOME_SUMMARY_SPEC.md), checked on
// every 200 this file receives.
// ---------------------------------------------------------------------------
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const TIERS = ['blocking', 'slipping', 'tidy'];
const DEPTHS = ['summary', 'detail', 'write'];
const SEVERITIES = ['info', 'success', 'warning', 'critical'];
const MARK_STATUSES = ['done', 'missing', 'upcoming', 'not_yours'];
const TILE_STATUSES = ['good', 'warning', 'critical'];

export function validateHomeSummary(b: any): string[] {
  const errs: string[] = [];
  const check = (ok: unknown, msg: string) => { if (!ok) errs.push(msg); };
  const isStr = (v: unknown) => typeof v === 'string';
  const absUrl = (v: unknown) => isStr(v) && /^https?:\/\/[^/\s]+/.test(v as string);
  const optIso = (v: unknown) => v === undefined || v === null || (isStr(v) && ISO_RE.test(v as string));

  check(b && typeof b === 'object', 'body is an object');
  if (!b || typeof b !== 'object') return errs;
  check(b.version === 1, 'version 1');
  check(b.source === 'attendance', 'source attendance');
  check(isStr(b.generated_at) && ISO_RE.test(b.generated_at), 'generated_at ISO');
  check(typeof b.provisioned === 'boolean', 'provisioned bool');
  check(absUrl(b.app_url), 'app_url absolute');
  for (const k of ['items', 'tiles', 'updates', 'today_marks']) check(Array.isArray(b[k]), `${k} array`);
  if (errs.length) return errs;

  const itemIds = new Set<string>();
  b.items.forEach((i: any, n: number) => {
    const at = `items[${n}]`;
    check(isStr(i.id) && i.id.startsWith(`attendance:${i.kind}:`), `${at}.id`);
    check(!itemIds.has(i.id), `${at}.id unique`); itemIds.add(i.id);
    check(i.source === 'attendance', `${at}.source`);
    check(isStr(i.kind) && /^[A-Z]-\d\d$/.test(i.kind), `${at}.kind`);
    check(TIERS.includes(i.tier), `${at}.tier`);
    check(isStr(i.lens) && i.lens.length > 0, `${at}.lens`);
    check(Array.isArray(i.via) && i.via.every((v: unknown) => typeof v === 'number'), `${at}.via`);
    check(DEPTHS.includes(i.depth), `${at}.depth`);
    check(Number.isInteger(i.count) && i.count >= 0, `${at}.count`);
    check(isStr(i.title) && i.title.length > 0, `${at}.title`);
    check(Array.isArray(i.entities) && i.entities.length <= 8 && i.entities.every(isStr), `${at}.entities`);
    check(i.depth !== 'summary' || i.entities.length === 0, `${at} summary depth => no entities`);
    check(isStr(i.why) && i.why.length > 0, `${at}.why`);
    check(i.cta && isStr(i.cta.label) && absUrl(i.cta.href) && i.cta.external === true, `${at}.cta`);
    check(i.cta && isStr(i.cta.href) && i.cta.href.startsWith(b.app_url), `${at}.cta into this app`);
    check(optIso(i.due_at), `${at}.due_at`);
    check(optIso(i.waiting_since), `${at}.waiting_since`);
  });

  check(b.tiles.length <= 3, 'tiles <= 3');
  const tileIds = new Set<string>();
  b.tiles.forEach((t: any, n: number) => {
    const at = `tiles[${n}]`;
    check(isStr(t.id) && !tileIds.has(t.id), `${at}.id unique`); tileIds.add(t.id);
    check(t.source === 'attendance', `${at}.source`);
    check(isStr(t.lens), `${at}.lens`);
    check(isStr(t.label), `${at}.label`);
    check(t.value === null || isStr(t.value), `${at}.value`);
    check(t.suppressed === undefined || typeof t.suppressed === 'boolean', `${at}.suppressed`);
    check(t.suppressed !== true || t.value === null, `${at} suppressed => value null`);
    check(t.status === undefined || TILE_STATUSES.includes(t.status), `${at}.status`);
    check(t.href === undefined || absUrl(t.href), `${at}.href`);
  });

  check(b.updates.length <= 10, 'updates <= 10');
  const updateIds = new Set<string>();
  let seenRead = false;
  b.updates.forEach((u: any, n: number) => {
    const at = `updates[${n}]`;
    check(isStr(u.id) && !updateIds.has(u.id), `${at}.id unique`); updateIds.add(u.id);
    check(u.source === 'attendance', `${at}.source`);
    check(isStr(u.kind) && !['register_missing', 'homeroom_missing', 'lesson_soon'].includes(u.kind), `${at}.kind`);
    check(isStr(u.title), `${at}.title`);
    check(SEVERITIES.includes(u.severity), `${at}.severity`);
    check(isStr(u.created_at) && ISO_RE.test(u.created_at), `${at}.created_at`);
    check(Date.now() - Date.parse(u.created_at) <= 7 * 86_400_000 + 60_000, `${at} within 7 days`);
    check(typeof u.read === 'boolean', `${at}.read`);
    check(!(seenRead && !u.read), `${at} unread first`); if (u.read) seenRead = true;
    check(u.href == null || absUrl(u.href), `${at}.href`);
  });

  const keys = new Set<string>();
  b.today_marks.forEach((m: any, n: number) => {
    const at = `today_marks[${n}]`;
    check(isStr(m.lesson_key) && !keys.has(m.lesson_key), `${at}.lesson_key unique`); keys.add(m.lesson_key);
    check(MARK_STATUSES.includes(m.status), `${at}.status`);
    check(m.href === undefined || absUrl(m.href), `${at}.href`);
    check(m.status !== 'not_yours' || m.href === undefined, `${at} not_yours has no link`);
  });
  if (!b.provisioned) {
    check(b.items.length + b.tiles.length + b.updates.length + b.today_marks.length === 0, 'unprovisioned is empty');
  }
  return errs;
}

/** Every 200 from the endpoint must satisfy the contract. */
function checked<T extends { status: number; body: any }>(res: T): T {
  if (res.status === 200) expect(validateHomeSummary(res.body)).toEqual([]);
  return res;
}

describe('POST /api/integration/home-summary', () => {
  let db: Database;

  const summary = async (token: string | null, body: any = {}) => {
    const req = request(app).post('/api/integration/home-summary');
    if (token) req.set('Authorization', `Bearer ${token}`);
    return checked(await req.send(body));
  };
  const item = (res: any, kind: string) => res.body.items.find((i: any) => i.kind === kind);
  const kinds = (res: any) => res.body.items.map((i: any) => i.kind).sort();

  beforeAll(async () => {
    db = await setupTestDb();
    await createTestUser(db, { id: '101', name: 'Teacher T', email: 't@school.test', roleLevel: 'TEACHER' });
    await createTestUser(db, { id: '100', name: 'Admin A', email: 'a@school.test', roleLevel: 'ADMIN' });
    await createTestUser(db, { id: '102', name: 'Viewer V', email: 'v@school.test', roleLevel: 'TEACHER' });
    await createTestUser(db, { id: '501', name: 'Alice', email: 's@school.test', roleLevel: 'STUDENT' });
    await createTestUser(db, { id: '103', name: 'Teacher N', email: 'n@school.test', roleLevel: 'TEACHER' });
    await createTestUser(db, { id: '104', name: 'Teacher P', email: 'p@school.test', roleLevel: 'TEACHER' });
    await createTestUser(db, { id: '105', name: 'Dos D', email: 'd@school.test', roleLevel: 'ADMIN' });
    await createTestUser(db, { id: '508', name: 'Ben', email: 'b@school.test', roleLevel: 'STUDENT' });
    await createTestUser(db, { id: '106', name: 'Conduct C', email: 'c@school.test', roleLevel: 'TEACHER' });
    await createTestUser(db, { id: '107', name: 'Insight I', email: 'i@school.test', roleLevel: 'TEACHER' });
    await createTestUser(db, { id: '109', name: 'Registrar R', email: 'r@school.test', roleLevel: 'TEACHER' });

    for (const [id, name] of [[30, 'Maths'], [31, 'Physics'], [32, 'Biology']] as const) {
      await db.run('INSERT INTO subjects (id, name) VALUES (?, ?)', id, name);
    }
    const mark = (student: string, name: string, cls: string, date: string, status: string, sessionType = 'homeroom', subjectId: number | null = null) =>
      db.run(
        `INSERT INTO attendance_records (student_id, student_name, class_id, class_name, session_date, period, session_type, subject_id, status, marked_by)
         VALUES (?, ?, ?, ?, ?, 'Morning', ?, ?, ?, 'x')`,
        student, name, cls, `G${cls}`, date, sessionType, subjectId, status
      );

    // Class 7: Alice is at 25% (3 of 4 mornings absent); today she missed Maths
    // (whose register therefore exists) and the morning register is not taken.
    await mark('501', 'Alice', '7', DAY(4), 'present');
    await mark('501', 'Alice', '7', DAY(3), 'absent');
    await mark('501', 'Alice', '7', DAY(2), 'absent');
    await mark('501', 'Alice', '7', DAY(1), 'absent');
    await mark('501', 'Alice', '7', TODAY, 'absent', 'subject', 30);

    // Class 8: five students, two of them below the bar; Bob absent today.
    for (const [id, name] of [['502', 'Bob'], ['503', 'Cara'], ['504', 'Dan'], ['505', 'Eve'], ['506', 'Fay']]) {
      const low = id === '502' || id === '503';
      for (let d = 1; d <= 4; d += 1) await mark(id, name, '8', DAY(d), low && d > 1 ? 'absent' : 'present');
    }
    await mark('502', 'Bob', '8', TODAY, 'absent');

    // Pending excuses: Alice's (3 days old, so blocking) and Bob's.
    await db.run(
      `INSERT INTO excuse_requests (student_id, student_name, class_name, class_id, session_date, reason, created_at)
       VALUES ('501', 'Alice', 'G7', '7', ?, 'ill', datetime('now', '-3 days'))`,
      DAY(3)
    );
    await db.run(
      `INSERT INTO excuse_requests (student_id, student_name, class_name, class_id, session_date, reason)
       VALUES ('502', 'Bob', 'G8', '8', ?, 'ill')`,
      DAY(2)
    );

    // Alice's conduct: four major demerits -> balance 60.
    for (let i = 0; i < 4; i += 1) {
      await db.run(
        `INSERT INTO discipline_records (student_id, student_name, type, category, severity, points, title, incident_date, logged_by)
         VALUES ('501', 'Alice', 'demerit', 'Misconduct', 'major', 10, 'Seed', ?, 'x')`,
        DAY(i + 1)
      );
    }

    // Late staff today.
    await db.run(`INSERT INTO staff_attendance (staff_id, staff_name, date, status) VALUES ('77', 'Late Larry', ?, 'late')`, TODAY);

    // Teacher 101's notifications.
    const note = (userId: string, type: string, title: string, read = 0, age = '-1 hour') =>
      db.run(
        `INSERT INTO notifications (user_id, type, title, message, link, severity, read, created_at)
         VALUES (?, ?, ?, 'm', '/excuses/review', 'warning', ?, datetime('now', ?))`,
        userId, type, title, read, age
      );
    await note('101', 'system', 'Visible update');
    await note('101', 'register_missing', 'Derived by Home');
    await note('101', 'lesson_soon', 'Also derived');
    await note('101', 'system', 'Already read', 1);
    await note('101', 'system', 'Too old', 0, '-8 days');
    await note('all', 'low_attendance', 'Broadcast about a student');
  });

  beforeEach(() => {
    __resetSnapshotCache();
    __resetStudentClassCache();
    __resetPolicyState();
    __resetMisBearerCache();
    (integration as any).__resetIntegrationRateLimit?.();
    mis.calls = [];
    mis.down = false;
    mis.verifyStatus = null;
    mis.revoked.clear();
    stubMis();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(async () => {
    vi.useRealTimers();
    await accessIdle();
    delete process.env.ACCESS_V2_MODE;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const LESSONS = [
    // Register exists (Alice was marked in Maths today).
    { lesson_key: `7:30:${TODAY}:00:00`, class_group_id: 7, subject_id: 30, date: TODAY, start_time: '00:00', end_time: '00:40' },
    // Started, nothing recorded.
    { lesson_key: `7:31:${TODAY}:00:00`, class_group_id: 7, subject_id: 31, date: TODAY, start_time: '00:00', end_time: '00:41', class_group_name: 'G7' },
    // Not started yet.
    { lesson_key: `7:32:${TODAY}:23:59`, class_group_id: 7, subject_id: 32, date: TODAY, start_time: '23:59', end_time: '23:59' },
    // Another teacher's class.
    { lesson_key: `8:31:${TODAY}:00:01`, class_group_id: 8, subject_id: 31, date: TODAY, start_time: '00:01', end_time: '00:41' },
  ];
  const LENSES = [
    { key: 'TEACHING', type: 'TEACHING', class_group_ids: [7] },
    { key: 'CLASS_GROUP:7', type: 'CLASS_GROUP', class_group_ids: [7] },
    { key: 'CLASS_GROUP:8', type: 'CLASS_GROUP', class_group_ids: [8] },
    { key: 'SCHOOL', type: 'SCHOOL', class_group_ids: null },
    { key: 'SELF', type: 'SELF', class_group_ids: [] },
  ];

  // -------------------------------------------------------------------------
  describe('authentication', () => {
    it('401 without a bearer token, without calling MIS', async () => {
      const res = await summary(null);
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('MIS_TOKEN_INVALID'); // the one 401 code of the shared contract
      expect(mis.calls).toEqual([]);
    });

    it('401 MIS_TOKEN_INVALID when MIS rejects the token', async () => {
      const res = await summary('not-a-real-token');
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('MIS_TOKEN_INVALID');
    });

    it('503 when MIS cannot be reached', async () => {
      mis.down = true;
      const res = await summary('mis-teacher');
      expect(res.status).toBe(503);
    });

    it('caches a verification instead of asking MIS on every call', async () => {
      await summary('mis-student');
      await summary('mis-student');
      expect(mis.calls.filter((u) => u.includes('/auth/verify'))).toHaveLength(1);
    });

    it('answers provisioned:false for a MIS user who never signed in here, and creates nobody', async () => {
      const res = await summary('mis-stranger', { lessons: LESSONS });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ version: 1, source: 'attendance', provisioned: false, items: [], tiles: [], updates: [], today_marks: [] });
      expect(await db.get(`SELECT id FROM users WHERE id = '900'`)).toBeUndefined();
    });

    it('also answers GET, and reads an unreadable date as today (lenient, like TM and Tupo)', async () => {
      const get = checked(await request(app).get('/api/integration/home-summary').set('Authorization', 'Bearer mis-student'));
      expect(get.status).toBe(200);
      expect(get.body.provisioned).toBe(true);
      const bad = await summary('mis-student', { date: '27/09/2026' });
      expect(bad.status).toBe(200);
    });
  });

  // -------------------------------------------------------------------------
  describe('teacher (legacy access, the test default)', () => {
    it('marks today\'s lessons done / missing / upcoming and raises T-01', async () => {
      const res = await summary('mis-teacher', { lessons: LESSONS, lenses: LENSES });
      expect(res.status).toBe(200);
      const marks = Object.fromEntries(res.body.today_marks.map((m: any) => [m.lesson_key, m.status]));
      expect(marks[LESSONS[0].lesson_key]).toBe('done');
      expect(marks[LESSONS[1].lesson_key]).toBe('missing');
      expect(marks[LESSONS[2].lesson_key]).toBe('upcoming');

      const t01 = item(res, 'T-01');
      expect(t01).toMatchObject({ tier: 'blocking', lens: 'TEACHING', source: 'attendance', id: 'attendance:T-01:TEACHING' });
      // The legacy guard lets any ATTENDANCE_MARK holder mark any register.
      expect(t01.count).toBe(2);
      expect(t01.entities).toContain('Physics · G7 (00:00)');
      expect(t01.cta.href).toMatch(/^http:\/\/localhost:3000\/attendance\/mark\?classId=7&/);

      const tile = res.body.tiles.find((t: any) => t.label === 'Registers today');
      expect(tile.value).toBe('1/4');
    });

    it('raises the class-teacher items for their own class only', async () => {
      const res = await summary('mis-teacher', { lenses: LENSES });
      const c01 = item(res, 'C-01');
      expect(c01).toMatchObject({ lens: 'CLASS_GROUP:7', tier: 'blocking', count: 1, entities: ['G7'] });

      const c02 = item(res, 'C-02');
      expect(c02).toMatchObject({ lens: 'CLASS_GROUP:7', tier: 'blocking', count: 1 });
      expect(c02.entities.join()).toContain('Alice');

      const c03 = item(res, 'C-03');
      expect(c03).toMatchObject({ lens: 'CLASS_GROUP:7', depth: 'detail', count: 1 });
      expect(c03.entities).toEqual(['Alice · 25%']);

      const c04 = item(res, 'C-04');
      expect(c04.entities).toEqual(['Alice · G7']);

      // Class 8 (Bob's) never appears anywhere.
      expect(JSON.stringify(res.body.items)).not.toMatch(/Bob|Cara|G8|CLASS_GROUP:8/);
      expect(res.body.tiles.find((t: any) => t.id === 'attendance:tile:present-today')).toMatchObject({ value: null });
      // Not school staff attendance: no O-06.
      expect(item(res, 'O-06')).toBeUndefined();
    });

    it('lists only the user\'s own unread, recent, non-derived notifications', async () => {
      const res = await summary('mis-teacher');
      expect(res.body.updates.map((u: any) => u.title)).toEqual(['Visible update']);
      expect(res.body.updates[0]).toMatchObject({ read: false, severity: 'warning', href: 'http://localhost:3000/excuses/review' });
    });

    it('is read-only (shadow mode included): no row written, no notification generated', async () => {
      process.env.ACCESS_V2_MODE = 'shadow';
      const before = await db.get('SELECT total_changes() AS n');
      const res = await summary('mis-teacher', { lessons: LESSONS, lenses: LENSES });
      expect(res.status).toBe(200);
      await accessIdle();
      const after = await db.get('SELECT total_changes() AS n');
      expect(after.n).toBe(before.n);
    });
  });

  // -------------------------------------------------------------------------
  describe('student', () => {
    it('gets S-06, S-07, S-08, S-09 and the attendance tile, all on SELF', async () => {
      const res = await summary('mis-student', { lenses: LENSES });
      expect(kinds(res)).toEqual(['S-06', 'S-07', 'S-08', 'S-09']);
      // Four absences, one covered by the pending excuse.
      expect(item(res, 'S-06')).toMatchObject({ lens: 'SELF', count: 3, tier: 'slipping' });
      expect(item(res, 'S-07').title).toContain('25%');
      expect(item(res, 'S-08').title).toContain('60');
      expect(res.body.tiles).toEqual([expect.objectContaining({ label: 'Attendance', value: '25%', lens: 'SELF' })]);
      // No teaching rights: every hinted lesson is someone else's.
      const marks = (await summary('mis-student', { lessons: LESSONS })).body.today_marks;
      expect(marks.every((m: any) => m.status === 'not_yours' && !m.href)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  describe('admin (legacy)', () => {
    it('gets O-06 but no class items (Class Teacher of nothing)', async () => {
      const res = await summary('mis-admin', { lenses: LENSES });
      expect(item(res, 'O-06')).toMatchObject({ tier: 'tidy', count: 1, lens: 'SCHOOL', entities: [] });
      expect(kinds(res).filter((k: string) => k.startsWith('C-'))).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  describe('enforce (access v2)', () => {
    beforeEach(() => { process.env.ACCESS_V2_MODE = 'enforce'; });

    it('decides today_marks per register with the snapshot', async () => {
      const res = await summary('mis-teacher', { lessons: LESSONS, lenses: LENSES });
      const marks = Object.fromEntries(res.body.today_marks.map((m: any) => [m.lesson_key, m.status]));
      expect(marks[LESSONS[3].lesson_key]).toBe('not_yours');
      expect(marks[LESSONS[1].lesson_key]).toBe('missing');
      expect(item(res, 'T-01').count).toBe(1);
      expect(item(res, 'C-02').count).toBe(1);
      expect(JSON.stringify(res.body.items)).not.toMatch(/Bob|G8/);
    });

    it('a summary-depth viewer gets counts, never names', async () => {
      const res = await summary('mis-viewer', { lenses: LENSES });
      const c03 = item(res, 'C-03');
      expect(c03).toMatchObject({ lens: 'CLASS_GROUP:8', depth: 'summary', count: 2, entities: [] });
      // Absent-without-notice names students: detail only.
      expect(item(res, 'C-04')).toBeUndefined();
      expect(item(res, 'C-02')).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Quick reminders: discipline (D-01..D-03), excuses (C-05, S-09), own
  // clock-in (O-07), accounts without a role (A-01). Fixture rows are added
  // per test and removed again, so the cases above keep their exact counts.
  // -------------------------------------------------------------------------
  describe('reminders: discipline', () => {
    const demerit = async (student: string, name: string, opts: { severity?: string; status?: string; date?: string; age?: string; title?: string } = {}) =>
      (await db.run(
        `INSERT INTO discipline_records (student_id, student_name, type, category, severity, points, title, incident_date, status, logged_by, created_at)
         VALUES (?, ?, 'demerit', 'Misconduct', ?, 3, ?, ?, ?, 'x', datetime('now', ?))`,
        student, name, opts.severity ?? 'minor', opts.title ?? 'Extra', opts.date ?? DAY(1), opts.status ?? 'open', opts.age ?? '-1 hour'
      )).lastID;
    const cleanup = () => db.run(`DELETE FROM discipline_records WHERE title != 'Seed'`);

    it('legacy: a DISCIPLINE_VIEW_ALL holder gets D-01, D-02 and D-03 school-wide, like /discipline/overview', async () => {
      try {
        await demerit('502', 'Bob', { title: 'Late' });
        await demerit('503', 'Cara', { status: 'resolved', title: 'Done' });
        await demerit('503', 'Cara', { status: 'dismissed', severity: 'major', title: 'Dismissed' });
        await demerit('504', 'Dan', { severity: 'major', status: 'resolved', date: DAY(10), title: 'Old major' });
        await db.run(
          `INSERT INTO discipline_records (student_id, student_name, type, category, severity, points, title, incident_date, logged_by)
           VALUES ('505', 'Eve', 'merit', 'Kindness', 'small', 2, 'Helped', ?, 'x')`, DAY(1)
        );
        const res = await summary('mis-admin', { lenses: LENSES });

        const d01 = item(res, 'D-01');
        // Alice's four open majors + Bob's open minor; never resolved, dismissed or merit rows.
        expect(d01).toMatchObject({ id: 'attendance:D-01:SCHOOL', lens: 'SCHOOL', tier: 'slipping', depth: 'detail', count: 5 });
        expect(d01.entities).toContain('Bob · Late');
        expect(d01.entities.join()).not.toMatch(/Done|Dismissed|Helped|Old major/);
        expect(d01.cta.href).toBe(`${APP}/discipline/records`);
        expect(d01.waiting_since).toMatch(/Z$/);

        const d02 = item(res, 'D-02');
        expect(d02).toMatchObject({ tier: 'slipping', depth: 'detail', count: 1, entities: ['Alice · 40 demerit pts'] });
        expect(d02.cta.href).toBe(`${APP}/reports/student/501`);

        const d03 = item(res, 'D-03');
        // Alice's four majors in the window; Dan's is 10 days old, Cara's dismissed.
        expect(d03).toMatchObject({ tier: 'slipping', count: 4 });
        expect(d03.entities.join()).not.toMatch(/Old major|Dismissed/);
      } finally {
        await cleanup();
      }
    });

    it('D-01 blocks after 72 h; D-03 is tidy once no major incident is fresh', async () => {
      try {
        await db.run(`UPDATE discipline_records SET created_at = datetime('now', '-4 days') WHERE title = 'Seed'`);
        const res = await summary('mis-teacher', { lenses: LENSES });
        expect(item(res, 'D-01')).toMatchObject({ tier: 'blocking', count: 4 });
        expect(Date.now() - Date.parse(item(res, 'D-01').waiting_since)).toBeGreaterThan(72 * 3600_000);
        expect(item(res, 'D-03')).toMatchObject({ tier: 'tidy', count: 4 });
      } finally {
        await db.run(`UPDATE discipline_records SET created_at = datetime('now') WHERE title = 'Seed'`);
      }
    });

    it('D-02 counts this term\'s demerit points against the threshold (15)', async () => {
      try {
        // Bob: 3 x 3 = 9 points, under the bar; then 5 x 3 = 15, at it.
        for (let i = 0; i < 3; i += 1) await demerit('502', 'Bob', { status: 'resolved' });
        expect(item(await summary('mis-admin'), 'D-02').count).toBe(1);
        for (let i = 0; i < 2; i += 1) await demerit('502', 'Bob', { status: 'resolved' });
        const d02 = item(await summary('mis-admin'), 'D-02');
        expect(d02.count).toBe(2);
        expect(d02.entities).toEqual(['Alice · 40 demerit pts', 'Bob · 15 demerit pts']);
        expect(d02.cta.href).toBe(`${APP}/discipline/records`);
      } finally {
        await cleanup();
      }
    });

    it('legacy: no DISCIPLINE_VIEW_ALL (a student) means no D items', async () => {
      const res = await summary('mis-student', { lenses: LENSES });
      expect(kinds(res).filter((k: string) => k.startsWith('D-'))).toEqual([]);
    });

    describe('enforce', () => {
      beforeEach(() => { process.env.ACCESS_V2_MODE = 'enforce'; });

      it('covers only students in the v2 scope, tagged with their class lens', async () => {
        try {
          await demerit('502', 'Bob', { severity: 'major', title: 'Out of scope' });
          const res = await summary('mis-conduct', { lenses: LENSES });
          expect(item(res, 'D-01')).toMatchObject({ lens: 'CLASS_GROUP:7', count: 4 });
          expect(item(res, 'D-02')).toMatchObject({ lens: 'CLASS_GROUP:7', entities: ['Alice · 40 demerit pts'] });
          expect(item(res, 'D-03')).toMatchObject({ lens: 'CLASS_GROUP:7', count: 4 });
          expect(JSON.stringify(res.body.items)).not.toMatch(/Bob|Out of scope/);
        } finally {
          await cleanup();
        }
      });

      it('summary depth (the overview\'s detail rule) or no grant: no D items', async () => {
        expect(kinds(await summary('mis-conduct-summary', { lenses: LENSES })).filter((k: string) => k.startsWith('D-'))).toEqual([]);
        // Teacher 101's snapshot carries no discipline capability at all.
        expect(kinds(await summary('mis-teacher', { lenses: LENSES })).filter((k: string) => k.startsWith('D-'))).toEqual([]);
      });
    });
  });

  describe('reminders: excuses', () => {
    const excuse = async (f: Record<string, any>) =>
      (await db.run(
        `INSERT INTO excuse_requests (student_id, student_name, class_name, class_id, session_date, reason, status,
                                      period, session_type, subject_id, supersedes_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'ill', ?, ?, ?, ?, ?, datetime('now', ?), datetime('now', ?))`,
        f.student ?? '501', f.name ?? 'Alice', f.className ?? 'G7', f.classId === undefined ? '7' : f.classId, f.date,
        f.status ?? 'approved', f.period ?? null, f.sessionType ?? 'homeroom', f.subjectId ?? null, f.supersedes ?? null,
        f.age ?? '-1 hour', f.updatedAge ?? f.age ?? '-1 hour'
      )).lastID!;
    const ids: number[] = [];
    const add = async (f: Record<string, any>) => { const id = await excuse(f); ids.push(id); return id; };
    afterEach(async () => {
      await db.run('DELETE FROM excuse_requests WHERE id IN (SELECT value FROM json_each(?))', JSON.stringify(ids.splice(0)));
    });

    const seedApproved = async () => {
      // Covers Alice's absent morning on DAY(2): still absent -> counted.
      await add({ date: DAY(2) });
      // Covers Alice's absent Maths lesson today (subject register) -> counted.
      await add({ date: TODAY, sessionType: 'subject', subjectId: 30, period: 'Morning' });
      // Physics today: no register row at all -> nothing to reconcile.
      await add({ date: TODAY, sessionType: 'subject', subjectId: 31 });
      // A different period than the absent row -> not covered.
      await add({ date: DAY(1), period: 'Afternoon' });
      // Alice's present morning -> nothing to fix.
      await add({ date: DAY(4) });
      // Bob, an older class-name-only excuse (case differs) -> class 8.
      await add({ student: '502', name: 'Bob', className: 'g8', classId: null, date: DAY(2) });
    };

    it('C-05 (legacy): approved excuses still marked absent, in the class teacher\'s own classes', async () => {
      await seedApproved();
      const res = await summary('mis-teacher', { lenses: LENSES });
      const c05 = item(res, 'C-05');
      expect(c05).toMatchObject({ id: 'attendance:C-05:CLASS_GROUP:7', tier: 'slipping', count: 2, depth: 'write' });
      expect(c05.entities.every((e: string) => e.startsWith('Alice · G7'))).toBe(true);
      expect(c05.cta.href).toBe(`${APP}/attendance/records?search=501`);
      expect(JSON.stringify(res.body.items)).not.toMatch(/Bob/);
    });

    it('C-05 (enforce): a school-wide reviewer sees every class; no EXCUSES_REVIEW sees none', async () => {
      process.env.ACCESS_V2_MODE = 'enforce';
      await seedApproved();
      const res = await summary('mis-school', { lenses: LENSES });
      const c05 = res.body.items.filter((i: any) => i.kind === 'C-05');
      // Bob's class-less excuse is not resolved for a school-wide reviewer (no
      // per-student lookups), so it lands on the SCHOOL lens -- as in C-02.
      expect(Object.fromEntries(c05.map((i: any) => [i.lens, i.count]))).toEqual({ 'CLASS_GROUP:7': 2, SCHOOL: 1 });
      expect(item(await summary('mis-viewer', { lenses: LENSES }), 'C-05')).toBeUndefined();
      // 101's v2 scope is class 7 only.
      expect(item(await summary('mis-teacher', { lenses: LENSES }), 'C-05')).toMatchObject({ count: 2 });
    });

    it('C-05 ignores pending and rejected excuses', async () => {
      await add({ date: DAY(1), status: 'rejected' });
      const res = await summary('mis-teacher', { lenses: LENSES });
      expect(item(res, 'C-05')).toBeUndefined();
    });

    it('S-09: a pending excuse alone is tidy', async () => {
      const res = await summary('mis-student');
      expect(item(res, 'S-09')).toMatchObject({
        id: 'attendance:S-09:SELF', tier: 'tidy', lens: 'SELF', count: 1,
        entities: [`Morning check · ${DAY(3).slice(5)} · waiting`],
      });
      expect(item(res, 'S-09').cta.href).toBe(`${APP}/excuses`);
    });

    it('S-09: a recent rejection that can be resubmitted makes it slipping and links to it', async () => {
      const rejected = await add({ date: DAY(1), status: 'rejected', age: '-2 days', updatedAge: '-1 day' });
      // Too old to remind about.
      await add({ date: DAY(4), status: 'rejected', age: '-20 days', updatedAge: '-15 days' });
      // Already appealed: the appeal (pending) counts, the rejection does not.
      const appealed = await add({ date: DAY(2), status: 'rejected', age: '-3 days', updatedAge: '-2 days' });
      await add({ date: DAY(2), status: 'pending', supersedes: appealed });
      // Another student's rejection.
      await add({ student: '502', name: 'Bob', className: 'G8', classId: '8', date: DAY(1), status: 'rejected' });

      const s09 = item(await summary('mis-student'), 'S-09');
      expect(s09).toMatchObject({ tier: 'slipping', count: 3 });
      expect(s09.title).toBe('1 excuse was rejected · 2 excuses are waiting for a decision');
      expect(s09.entities[0]).toBe(`Morning check · ${DAY(1).slice(5)} · rejected`);
      expect(s09.cta.href).toBe(`${APP}/excuses/${rejected}`);
    });

    it('S-09 is only for EXCUSES_VIEW_OWN holders', async () => {
      expect(item(await summary('mis-teacher'), 'S-09')).toBeUndefined();
      process.env.ACCESS_V2_MODE = 'enforce';
      // No v2 snapshot for this student: nothing is shown.
      expect(item(await summary('mis-student'), 'S-09')).toBeUndefined();
    });
  });

  describe('reminders: own clock-in and roles', () => {
    it('O-07: a staff member who has not clocked in today is reminded; clocking in clears it', async () => {
      const res = await summary('mis-teacher');
      expect(item(res, 'O-07')).toMatchObject({
        id: 'attendance:O-07:SELF', tier: 'slipping', lens: 'SELF', count: 1, entities: [],
        cta: { label: 'Clock in', href: `${APP}/staff/attendance`, external: true },
      });
      await db.run(`INSERT INTO staff_attendance (staff_id, staff_name, date, status) VALUES ('101', 'Teacher T', ?, 'present')`, TODAY);
      try {
        expect(item(await summary('mis-teacher'), 'O-07')).toBeUndefined();
      } finally {
        await db.run(`DELETE FROM staff_attendance WHERE staff_id = '101'`);
      }
    });

    it('O-07: not for students, not for another day, not without the v2 grant', async () => {
      expect(item(await summary('mis-student'), 'O-07')).toBeUndefined();
      expect(item(await summary('mis-teacher', { date: addDays(TODAY, -1) }), 'O-07')).toBeUndefined();
      process.env.ACCESS_V2_MODE = 'enforce';
      expect(item(await summary('mis-teacher'), 'O-07')).toBeUndefined();
    });

    it('A-01: role managers see accounts waiting for a role (legacy and enforce)', async () => {
      await db.run(`INSERT INTO users (id, name, role) VALUES ('950', 'Newbie N', 'unassigned')`);
      try {
        const admin = item(await summary('mis-admin', { lenses: LENSES }), 'A-01');
        expect(admin).toMatchObject({
          id: 'attendance:A-01:SCHOOL', tier: 'tidy', count: 1, entities: ['Newbie N'],
          cta: { label: 'Assign roles', href: `${APP}/admin`, external: true },
        });
        expect(item(await summary('mis-teacher'), 'A-01')).toBeUndefined();

        process.env.ACCESS_V2_MODE = 'enforce';
        expect(item(await summary('mis-registrar'), 'A-01')).toMatchObject({ count: 1 });
        expect(item(await summary('mis-school'), 'A-01')).toBeUndefined();
      } finally {
        await db.run(`DELETE FROM users WHERE id = '950'`);
      }
    });

    it('A-01: nothing when every account has a role', async () => {
      expect(item(await summary('mis-admin'), 'A-01')).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Hardening: every case below pins a defect found in review.
  // -------------------------------------------------------------------------
  describe('hardening: MIS token verification', () => {
    const verifyCalls = () => mis.calls.filter((u) => u.includes('/auth/verify')).length;
    const at = (iso: string) => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(iso));
    };

    it('keys the cache on the whole token: a token sharing a prefix with a cached one is verified on its own', async () => {
      expect((await summary('mis-teacher')).status).toBe(200);
      const res = await summary('mis-teacherX');
      expect(res.status).toBe(401);
      expect(verifyCalls()).toBe(2);
    });

    it('never caches a MIS 401, or a 200 without a user id', async () => {
      expect((await summary('nobody')).status).toBe(401);
      expect((await summary('nobody')).status).toBe(401);
      expect(verifyCalls()).toBe(2);
    });

    it('answers 503 for a MIS 5xx, does not cache it, and recovers on the next call', async () => {
      mis.verifyStatus = 500;
      expect((await summary('mis-student')).status).toBe(503);
      expect((await summary('mis-student')).status).toBe(503);
      mis.verifyStatus = null;
      expect((await summary('mis-student')).status).toBe(200);
      expect(verifyCalls()).toBe(3);
    });

    it('a revoked token stops working once the 60 s verification expires', async () => {
      at('2026-09-27T08:00:00Z');
      expect((await summary('mis-student')).status).toBe(200);
      mis.revoked.add('mis-student');
      vi.setSystemTime(new Date('2026-09-27T08:00:30Z'));
      expect((await summary('mis-student')).status).toBe(200);
      vi.setSystemTime(new Date('2026-09-27T08:01:01Z'));
      expect((await summary('mis-student')).status).toBe(401);
    });

    it('resolves the academic period once per verification, not on every request', async () => {
      await summary('mis-student');
      await summary('mis-student');
      expect(mis.calls.filter((u) => u.includes('/users/me'))).toHaveLength(1);
    });

    it('accepts a case-insensitive Bearer scheme and refuses an oversized token without calling MIS', async () => {
      const lower = await request(app).post('/api/integration/home-summary').set('Authorization', 'bearer mis-student').send({});
      expect(checked(lower).status).toBe(200);
      mis.calls = [];
      const huge = await summary('x'.repeat(5000));
      expect(huge.status).toBe(401);
      expect(mis.calls).toEqual([]);
    });

    it('keeps the cache bounded without dropping recent verifications', async () => {
      // MIS_VERIFY_CACHE_MAX is 40 in this file.
      for (let n = 0; n <= 40; n += 1) await summary(`bulk-${n}`);
      const size = (misBearer as any).__misBearerCacheSize?.();
      expect(size).toBeLessThanOrEqual(40);
      mis.calls = [];
      await summary('bulk-39');
      await summary('bulk-40');
      expect(verifyCalls()).toBe(0);
      // The oldest went first.
      await summary('bulk-0');
      expect(verifyCalls()).toBe(1);
    });
  });

  describe('hardening: errors and rate limit', () => {
    const leaky = /SQLITE|ECONNREFUSED|secret|node_modules|at \w+ \(|<pre>|SyntaxError/;

    it('a malformed JSON body gets a JSON 400 with no stack trace', async () => {
      const res = await request(app)
        .post('/api/integration/home-summary')
        .set('Authorization', 'Bearer mis-student')
        .set('Content-Type', 'application/json')
        .send('{"date": ');
      expect(res.status).toBe(400);
      expect(res.headers['content-type']).toMatch(/json/);
      expect(res.text).not.toMatch(leaky);
    });

    it('an internal failure during auth gets a generic JSON 500', async () => {
      const spy = vi.spyOn(db, 'get').mockRejectedValueOnce(new Error('SQLITE_ERROR: no such table: secret_users'));
      const res = await summary('mis-student');
      spy.mockRestore();
      expect(res.status).toBe(500);
      expect(res.headers['content-type']).toMatch(/json/);
      expect(res.text).not.toMatch(leaky);
    });

    it('MIS being unreachable does not leak the network error', async () => {
      mis.down = true;
      const res = await summary('mis-student');
      expect(res.status).toBe(503);
      expect(res.text).not.toMatch(leaky);
    });

    it('rate-limits per MIS user after authentication (30 a minute)', async () => {
      for (let i = 0; i < 30; i += 1) expect((await summary('mis-student')).status).toBe(200);
      const limited = await summary('mis-student');
      expect(limited.status).toBe(429);
      expect(limited.body.code).toBe('RATE_LIMITED');
      // Another user is unaffected; bad tokens are refused as 401, not counted.
      expect((await summary('mis-teacher')).status).toBe(200);
      expect((await summary('forged')).status).toBe(401);
    });
  });

  describe('hardening: request body', () => {
    const lessonsFor = (n: number, classId = 7, start = '00:00') =>
      Array.from({ length: n }, (_, i) => ({
        lesson_key: `bulk:${classId}:${i}`, class_group_id: classId, subject_id: 40 + i, date: TODAY, start_time: start,
      }));

    it('silently truncates oversized lessons / lenses / class_group_ids instead of refusing the summary', async () => {
      const res = await summary('mis-teacher', {
        lessons: lessonsFor(200),
        lenses: [
          { key: 'CLASS_GROUP:7', type: 'CLASS_GROUP', class_group_ids: [...Array.from({ length: 3000 }, (_, i) => i + 1000), 7] },
          ...Array.from({ length: 120 }, (_, i) => ({ key: `PROGRAM:${i}`, type: 'PROGRAM', class_group_ids: [i + 5000] })),
        ],
      });
      expect(res.status).toBe(200);
      expect(res.body.today_marks).toHaveLength(50);
    });

    it('tolerates garbage hint entries: drops what cannot be identified, normalises times', async () => {
      const res = await summary('mis-teacher', {
        date: TODAY,
        tz: 42,
        lenses: [null, 'x', { key: 5 }, { key: 'CG7', type: 'class_group', class_group_ids: ['7', 'abc', -1, 7.5] }],
        lessons: [
          null, 7, {},
          { lesson_key: 'no-class', subject_id: 30, start_time: '08:00' },
          { lesson_key: 'k1', class_group_id: 7, subject_id: 31, start_time: '0:00', date: TODAY },
          { lesson_key: 'k2', class_group_id: 7, subject_id: 32, start_time: '25:99', date: TODAY },
          { lesson_key: 'k3', class_group_id: 7, subject_id: 33, date: TODAY },
          { lesson_key: 'k4', class_group_id: 7, subject_id: 31, start_time: '08:00', date: 'not-a-date' },
          { lesson_key: 'k1', class_group_id: 8, subject_id: 31, start_time: '00:00', date: TODAY },
        ],
      });
      expect(res.status).toBe(200);
      const marks = Object.fromEntries(res.body.today_marks.map((m: any) => [m.lesson_key, m.status]));
      // A duplicate lesson_key answers once (the first entry wins).
      expect(res.body.today_marks.map((m: any) => m.lesson_key).sort()).toEqual(['k1', 'k2', 'k3']);
      expect(marks).toEqual({ k1: 'missing', k2: 'upcoming', k3: 'upcoming' });
      expect(item(res, 'T-01').count).toBe(1);
      expect(item(res, 'C-01').lens).toBe('CG7');

      for (const body of [[1, 2], { lessons: 'nope', lenses: { a: 1 } }]) {
        expect((await summary('mis-teacher', body)).status).toBe(200);
      }
    });

    it('a date that is not a real calendar day, or far from today, falls back to today', async () => {
      for (const date of ['2026-02-31', addDays(TODAY, -60), addDays(TODAY, 60), 20260927, null]) {
        const res = await summary('mis-teacher', { date, lenses: LENSES });
        expect(res.status).toBe(200);
        // C-01 is a today-only signal: its presence shows the date became today.
        expect(item(res, 'C-01')).toBeDefined();
      }
      const yesterday = await summary('mis-teacher', { date: addDays(TODAY, -1), lenses: LENSES });
      expect(yesterday.status).toBe(200);
      // The morning register is a today-only signal.
      expect(item(yesterday, 'C-01')).toBeUndefined();
    });
  });

  describe('hardening: scope', () => {
    beforeEach(() => { process.env.ACCESS_V2_MODE = 'enforce'; });

    it('hinted lessons never widen access: another subject or class is not_yours, with no T-01 and no echo', async () => {
      const res = await summary('mis-pairs', {
        lenses: LENSES,
        lessons: [
          { lesson_key: 'p-mine', class_group_id: 20, subject_id: 30, date: TODAY, start_time: '00:00', class_group_name: 'G20' },
          { lesson_key: 'p-subject', class_group_id: 20, subject_id: 31, date: TODAY, start_time: '00:00', class_group_name: 'SECRET-20', subject_name: 'SECRET' },
          { lesson_key: 'p-class', class_group_id: 8, subject_id: 30, date: TODAY, start_time: '00:00', class_group_name: 'SECRET-8' },
        ],
      });
      const marks = Object.fromEntries(res.body.today_marks.map((m: any) => [m.lesson_key, m]));
      expect(marks['p-mine'].status).toBe('missing');
      expect(marks['p-subject']).toEqual({ lesson_key: 'p-subject', status: 'not_yours' });
      expect(marks['p-class']).toEqual({ lesson_key: 'p-class', status: 'not_yours' });
      expect(item(res, 'T-01')).toMatchObject({ count: 1, entities: ['Maths · G20 (00:00)'] });
      expect(JSON.stringify({ items: res.body.items, tiles: res.body.tiles })).not.toMatch(/SECRET/);
      expect(res.body.tiles.find((t: any) => t.label === 'Registers today').value).toBe('0/1');
    });
  });

  describe('hardening: correctness', () => {
    it('decides "started" in school time (Africa/Kigali) even when the server runs in UTC', async () => {
      const tz = process.env.TZ;
      process.env.TZ = 'UTC';
      try {
        vi.useFakeTimers({ toFake: ['Date'] });
        // 22:30 UTC on the 27th is 00:30 on Monday the 28th in Kigali.
        vi.setSystemTime(new Date('2026-09-27T22:30:00Z'));
        const res = await summary('mis-teacher', {
          lenses: LENSES,
          lessons: [
            { lesson_key: 'a', class_group_id: 7, subject_id: 31, date: '2026-09-28', start_time: '00:15' },
            { lesson_key: 'b', class_group_id: 7, subject_id: 32, date: '2026-09-28', start_time: '01:00' },
            { lesson_key: 'c', class_group_id: 7, subject_id: 32, date: '2026-09-27', start_time: '23:30' },
          ],
        });
        const marks = Object.fromEntries(res.body.today_marks.map((m: any) => [m.lesson_key, m.status]));
        expect(marks).toEqual({ a: 'missing', b: 'upcoming', c: 'missing' });
        const t01 = item(res, 'T-01');
        expect(t01.count).toBe(1);
        expect(t01.waiting_since).toBe('2026-09-27T22:15:00.000Z');
        // Sunday the 27th is last week (Monday-based) in Kigali: no T-02.
        expect(item(res, 'T-02')).toBeUndefined();
        expect(res.body.tiles.find((t: any) => t.label === 'Registers today').value).toBe('0/2');
      } finally {
        if (tz === undefined) delete process.env.TZ;
        else process.env.TZ = tz;
      }
    });

    it('caps entities at 8, counts every one, and pluralises 1 vs many', async () => {
      const many = await summary('mis-teacher', {
        lessons: Array.from({ length: 12 }, (_, i) => ({
          lesson_key: `m${i}`, class_group_id: 7, subject_id: 40 + i, date: TODAY, start_time: '00:00',
        })),
      });
      const t01 = item(many, 'T-01');
      expect(t01).toMatchObject({ count: 12, lens: 'SELF' });
      expect(t01.entities).toHaveLength(8);
      expect(t01.title).toMatch(/^12 registers /);
      const one = await summary('mis-teacher', {
        lessons: [{ lesson_key: 'one', class_group_id: 7, subject_id: 31, date: TODAY, start_time: '00:00' }],
      });
      expect(item(one, 'T-01').title).toMatch(/^1 register not taken/);
    });

    it('item ids are stable across calls', async () => {
      const body = { lessons: LESSONS, lenses: LENSES };
      const a = await summary('mis-teacher', body);
      const b = await summary('mis-teacher', body);
      expect(a.body.items.map((i: any) => i.id)).toEqual(b.body.items.map((i: any) => i.id));
      expect(a.body.items.length).toBeGreaterThan(3);
    });

    it('lens tagging: most specific hint wins; an explicit list beats null at the same rank', async () => {
      const res = await summary('mis-teacher', {
        lenses: [
          { key: 'CG:unlisted', type: 'CLASS_GROUP' },
          { key: 'GRADE:all', type: 'GRADE', class_group_ids: null },
          { key: 'CLASS_GROUP:7', type: 'CLASS_GROUP', class_group_ids: [7] },
        ],
      });
      expect(item(res, 'C-01').lens).toBe('CLASS_GROUP:7');

      const G = (key: string, type: string, ids: number[] | null) => ({ key, type, class_group_ids: ids });
      expect(lensForClass([G('G-all', 'GRADE', null), G('G7', 'GRADE', [7])], 7)).toBe('G7');
      expect(lensForClass([G('P-big', 'PROGRAM', [7, 8, 9]), G('P-small', 'PROGRAM', [7])], 7)).toBe('P-small');
      expect(lensForClass([G('S', 'SCHOOL', null), G('D', 'DEPARTMENT', [7]), G('G', 'GRADE', [8])], 7)).toBe('D');
      expect(lensForClass([G('S', 'SCHOOL', null)], 99)).toBe('S');
      expect(lensForClass([G('T', 'TEACHING', [7]), G('ME', 'SELF', [])], 7)).toBe('SELF');
      // null means "every class" only on SCHOOL: a listless CLASS_GROUP/GRADE
      // hint never captures classes it does not name.
      expect(lensForClass([G('CG-null', 'CLASS_GROUP', null), G('S', 'SCHOOL', null)], 7)).toBe('S');
      expect(lensForClass([G('G-null', 'GRADE', null), G('P', 'PROGRAM', [7])], 7)).toBe('P');
      expect(lensForClass([G('CG-null', 'CLASS_GROUP', null)], 7)).toBe('SELF');
    });

    it('updates: at most 10, unread, newest first, last 7 days, derived kinds excluded', async () => {
      const note = (type: string, title: string, read: number, age: string) =>
        db.run(
          `INSERT INTO notifications (user_id, type, title, message, severity, read, created_at)
           VALUES ('103', ?, ?, 'm', 'bogus', ?, datetime('now', ?))`,
          type, title, read, age
        );
      try {
        for (let i = 0; i < 12; i += 1) await note('system', `Unread ${i}`, 0, `-${i + 1} hours`);
        await note('system', 'Read one', 1, '-5 minutes');
        await note('system', 'Too old', 0, '-8 days');
        for (const k of ['register_missing', 'homeroom_missing', 'lesson_soon']) await note(k, k, 0, '-1 minutes');
        const res = await summary('mis-notes');
        expect(res.body.updates.map((u: any) => u.title)).toEqual(Array.from({ length: 10 }, (_, i) => `Unread ${i}`));
        expect(res.body.updates.every((u: any) => u.severity === 'info' && u.read === false)).toBe(true);
      } finally {
        await db.run(`DELETE FROM notifications WHERE user_id = '103'`);
      }
    });

    it('with no current term from MIS, counts the term the local calendar puts today in', async () => {
      await db.run(`INSERT INTO academic_years (id, name, start_date, end_date) VALUES (9, 'Y', ?, ?)`, addDays(TODAY, -300), addDays(TODAY, 60));
      await db.run(
        `INSERT INTO academic_terms (id, academic_year_id, name, start_date, end_date) VALUES (77, 9, 'T', ?, ?)`,
        addDays(TODAY, -30), addDays(TODAY, 30)
      );
      const mark = (date: string, status: string, term: number) =>
        db.run(
          `INSERT INTO attendance_records (student_id, student_name, class_id, class_name, session_date, period, session_type, status, marked_by, academic_term_id)
           VALUES ('508', 'Ben', '21', 'G21', ?, 'Morning', 'homeroom', ?, 'x', ?)`,
          date, status, term
        );
      try {
        for (let d = 40; d < 45; d += 1) await mark(DAY(d), 'absent', 66); // an earlier term
        for (let d = 1; d <= 5; d += 1) await mark(DAY(d), 'present', 77);
        const res = await summary('mis-learner2');
        expect(res.status).toBe(200);
        expect(res.body.tiles).toEqual([expect.objectContaining({ label: 'Attendance', value: '100%' })]);
        expect(item(res, 'S-07')).toBeUndefined();
        expect(item(res, 'S-06')).toBeUndefined();
      } finally {
        await db.run(`DELETE FROM attendance_records WHERE student_id = '508'`);
        await db.run('DELETE FROM academic_terms WHERE id = 77');
        await db.run('DELETE FROM academic_years WHERE id = 9');
      }
    });
  });

  describe('hardening: performance', () => {
    const STUDENTS = 200;
    beforeAll(async () => {
      await db.exec('BEGIN');
      for (let s = 0; s < STUDENTS; s += 1) {
        const id = String(6000 + s);
        for (let d = 0; d < 5; d += 1) {
          await db.run(
            `INSERT INTO attendance_records (student_id, student_name, class_id, class_name, session_date, period, session_type, status, marked_by)
             VALUES (?, ?, '20', 'G20', ?, 'Morning', 'homeroom', ?, 'x')`,
            id, `Pupil ${s}`, DAY(d), s % 2 === 0 ? 'absent' : 'present'
          );
        }
      }
      // Older pending excuses without a class group (students with no local registers).
      for (let e = 0; e < 60; e += 1) {
        await db.run(
          `INSERT INTO excuse_requests (student_id, student_name, class_name, session_date, reason) VALUES (?, ?, 'Old', ?, 'ill')`,
          String(7000 + e), `Old ${e}`, DAY(1)
        );
      }
      await db.exec('COMMIT');
    });
    afterAll(async () => {
      await db.run(`DELETE FROM attendance_records WHERE class_id = '20'`);
      await db.run(`DELETE FROM excuse_requests WHERE CAST(student_id AS INTEGER) BETWEEN 7000 AND 7099`);
    });

    const counting = () => {
      const counts = { reads: 0, writes: 0 };
      for (const m of ['all', 'get', 'each'] as const) {
        const orig = (db as any)[m].bind(db);
        vi.spyOn(db as any, m).mockImplementation((...a: any[]) => { counts.reads += 1; return orig(...a); });
      }
      for (const m of ['run', 'exec'] as const) {
        const orig = (db as any)[m].bind(db);
        vi.spyOn(db as any, m).mockImplementation((...a: any[]) => { counts.writes += 1; return orig(...a); });
      }
      return counts;
    };

    it('a school-wide viewer over 200 students and 200 hinted lessons: bounded queries, no MIS fan-out, no writes', async () => {
      process.env.ACCESS_V2_MODE = 'enforce';
      await summary('mis-school'); // warm the verification + snapshot caches
      mis.calls = [];
      const counts = counting();
      const started = Date.now();
      const res = await summary('mis-school', { lenses: LENSES, lessons: lessonsOf(200) });
      const elapsed = Date.now() - started;
      expect(res.status).toBe(200);
      expect(res.body.today_marks).toHaveLength(50);
      // Class 20 is in no hinted class list, so it lands on SCHOOL.
      const school = (kind: string) => res.body.items.find((i: any) => i.kind === kind && i.lens === 'SCHOOL');
      expect(school('C-03')).toMatchObject({ count: STUDENTS / 2, depth: 'detail' });
      expect(school('C-03').entities).toHaveLength(8);
      expect(school('C-04').entities).toHaveLength(8);
      expect(school('C-02').count).toBe(60);
      expect(counts.writes).toBe(0);
      expect(counts.reads).toBeLessThanOrEqual(20);
      // A school-wide reviewer needs no per-student class lookups.
      expect(mis.calls.filter((u) => /\/users\/70\d\d\/grades/.test(u))).toEqual([]);
      expect(elapsed).toBeLessThan(2000);
    });

    it('a teacher with 200 hinted lessons: one register lookup, not one per lesson', async () => {
      await summary('mis-teacher');
      const counts = counting();
      const res = await summary('mis-teacher', { lenses: LENSES, lessons: lessonsOf(200) });
      expect(res.status).toBe(200);
      expect(item(res, 'T-01').entities).toHaveLength(8);
      expect(counts.writes).toBe(0);
      expect(counts.reads).toBeLessThanOrEqual(20);
    });

    const lessonsOf = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        lesson_key: `perf:${i}`, class_group_id: 20, subject_id: 30 + (i % 3), date: TODAY, start_time: '00:00',
      }));
  });
});
