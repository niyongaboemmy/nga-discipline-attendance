import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Database } from 'sqlite';
import { setupTestDb } from './testUtils.js';
import {
  computeEarlyWarningMetrics,
  dailyRunDue,
  disabledReason,
  lastSuccessAt,
  runEarlyWarningPush,
  sendEarlyWarningSignals,
  startupRunDue,
  windowsFor,
  __resetEarlyWarningState,
} from '../modules/integration/earlyWarning.service.js';

const AS_OF = '2026-10-07'; // yesterday = 10-06; 14d = 09-23..10-06; prev = 09-09..09-22; 30d = 09-07..10-06
const ENV = { misBaseUrl: 'http://mis.test/', clientId: 'discipline_attendance', clientSecret: 's3cret' };

let periodSeq = 0;
async function mark(db: Database, studentId: string, date: string, status: string, sessionType: 'subject' | 'homeroom' = 'subject') {
  periodSeq += 1;
  await db.run(
    `INSERT INTO attendance_records (student_id, student_name, class_id, class_name, session_date, period, session_type, subject_id, status, marked_by)
     VALUES (?, 'Student', '7', 'S4A', ?, ?, ?, ?, ?, 't1')`,
    studentId, date, `P${periodSeq}`, sessionType, sessionType === 'subject' ? 1 : null, status
  );
}

async function demerit(db: Database, studentId: string, date: string, points: number, extra: { type?: string; status?: string; deleted?: boolean } = {}) {
  await db.run(
    `INSERT INTO discipline_records (student_id, student_name, type, category, severity, points, title, incident_date, status, logged_by, deleted_at)
     VALUES (?, 'Student', ?, 'conduct', 'minor', ?, 'Incident', ?, ?, 't1', ?)`,
    studentId, extra.type ?? 'demerit', points, date, extra.status ?? 'open', extra.deleted ? '2026-10-01 10:00:00' : null
  );
}

async function user(db: Database, id: string, role: string, status = 'active') {
  await db.run(`INSERT INTO users (id, name, role, status) VALUES (?, 'U', ?, ?)`, id, role, status);
}

describe('early-warning metrics', () => {
  let db: Database;

  beforeAll(async () => {
    db = await setupTestDb();
    await db.run(`INSERT INTO subjects (id, name) VALUES (1, 'Maths')`);

    await user(db, '101', 'student');
    await user(db, '102', 'student'); // no records at all -> zeros
    await user(db, '103', 'student', 'inactive'); // has records but inactive -> left out
    await user(db, '900', 'teacher'); // not a student

    // 101: absences across the boundaries
    await mark(db, '101', '2026-10-07', 'absent'); // today: not counted
    await mark(db, '101', '2026-10-06', 'absent'); // 14d (yesterday)
    await mark(db, '101', '2026-09-23', 'absent'); // 14d (first day)
    await mark(db, '101', '2026-09-22', 'absent'); // prev (last day)
    await mark(db, '101', '2026-09-09', 'absent'); // prev (first day)
    await mark(db, '101', '2026-09-08', 'absent'); // outside both
    await mark(db, '101', '2026-10-01', 'excused'); // excused: not counted
    await mark(db, '101', '2026-10-02', 'absent', 'homeroom'); // homeroom roll call: not a lesson
    await mark(db, '101', '2026-10-03', 'present');
    await mark(db, '101', '2026-10-03', 'late'); // 14d late
    await mark(db, '101', '2026-09-20', 'late'); // prev window: not in lates_14d
    await mark(db, '101', '2026-10-07', 'late'); // today: not counted

    // 101: discipline
    await demerit(db, '101', '2026-09-07', 5); // 30d first day
    await demerit(db, '101', '2026-10-05', 3); // in
    await demerit(db, '101', '2026-09-06', 10); // outside
    await demerit(db, '101', '2026-10-07', 10); // today
    await demerit(db, '101', '2026-10-01', 4, { type: 'merit' }); // merit: not an incident
    await demerit(db, '101', '2026-10-01', 7, { status: 'dismissed' });
    await demerit(db, '101', '2026-10-01', 7, { deleted: true });

    // 103 inactive, 104 never signed in (only registers), 'abc' not an MIS id
    await mark(db, '103', '2026-10-06', 'absent');
    await mark(db, '104', '2026-10-06', 'absent');
    await mark(db, '104', '2026-10-05', 'late');
    await demerit(db, '104', '2026-10-04', 2, { status: 'resolved' });
    await mark(db, 'abc', '2026-10-06', 'absent');
  });

  it('computes the windows from yesterday back', () => {
    expect(windowsFor(AS_OF)).toEqual({
      asOf: AS_OF,
      yesterday: '2026-10-06',
      cur14From: '2026-09-23',
      prev14From: '2026-09-09',
      prev14To: '2026-09-22',
      d30From: '2026-09-07',
    });
  });

  it('counts unexcused lesson absences, lates and demerits inside the windows', async () => {
    const rows = await computeEarlyWarningMetrics(db, AS_OF);
    expect(rows.map((r) => r.student_id)).toEqual([101, 102, 104]);
    const by = Object.fromEntries(rows.map((r) => [r.student_id, r.metrics]));
    expect(by[101]).toEqual({
      absences_14d: 2,
      absences_prev_14d: 2,
      lates_14d: 1,
      incidents_30d: 2,
      discipline_points_30d: 8,
    });
    expect(by[102]).toEqual({ absences_14d: 0, absences_prev_14d: 0, lates_14d: 0, incidents_30d: 0, discipline_points_30d: 0 });
    expect(by[104]).toEqual({ absences_14d: 1, absences_prev_14d: 0, lates_14d: 1, incidents_30d: 1, discipline_points_30d: 2 });
  });
});

describe('early-warning sending', () => {
  let db: Database;

  beforeAll(async () => {
    db = await setupTestDb();
    await db.run('BEGIN');
    for (let i = 1; i <= 2500; i++) await user(db, String(10000 + i), 'student');
    await db.run('COMMIT');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    __resetEarlyWarningState();
  });

  function stubMis(status = 200) {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const body = JSON.parse(String(init.body));
      return new Response(
        JSON.stringify(status === 200
          ? { success: true, data: { saved: body.students.length, skipped: 0, as_of: body.as_of } }
          : { success: false, message: 'nope' }),
        { status, headers: { 'Content-Type': 'application/json' } }
      );
    }));
    return calls;
  }

  it('PUTs batches of at most 1000 with Basic auth', async () => {
    const calls = stubMis();
    const result = await sendEarlyWarningSignals(db, { asOf: AS_OF, env: ENV });

    expect(result).toEqual({ asOf: AS_OF, students: 2500, batches: 3, saved: 2500, skipped: 0 });
    expect(calls).toHaveLength(3);
    const expectedAuth = `Basic ${Buffer.from('discipline_attendance:s3cret').toString('base64')}`;
    const sizes: number[] = [];
    const ids = new Set<number>();
    for (const c of calls) {
      expect(c.url).toBe('http://mis.test/early-warning/signals');
      expect(c.init.method).toBe('PUT');
      expect((c.init.headers as Record<string, string>).Authorization).toBe(expectedAuth);
      const body = JSON.parse(String(c.init.body));
      expect(Object.keys(body).sort()).toEqual(['as_of', 'students']);
      expect(body.as_of).toBe(AS_OF);
      sizes.push(body.students.length);
      for (const s of body.students) {
        ids.add(s.student_id);
        expect(typeof s.student_id).toBe('number');
        expect(s.metrics).toEqual({ absences_14d: 0, absences_prev_14d: 0, lates_14d: 0, incidents_30d: 0, discipline_points_30d: 0 });
      }
    }
    expect(sizes).toEqual([1000, 1000, 500]);
    expect(ids.size).toBe(2500);
  });

  it('throws on a non-2xx answer and stops sending', async () => {
    const calls = stubMis(500);
    await expect(sendEarlyWarningSignals(db, { asOf: AS_OF, env: ENV })).rejects.toThrow(/500/);
    expect(calls).toHaveLength(1);
  });

  it('runEarlyWarningPush never throws and records the last success', async () => {
    const prev = { ...process.env };
    process.env.EARLY_WARNING_PUSH = '1';
    const { config } = await import('../config.js');
    const saved = { base: config.ngaMisBaseUrl, id: config.ssoClientId, secret: config.ssoClientSecret };
    Object.assign(config, { ngaMisBaseUrl: 'http://mis.test', ssoClientId: 'discipline_attendance', ssoClientSecret: 's3cret' });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      stubMis(500);
      expect(await runEarlyWarningPush('test', db)).toBeNull();
      expect(await lastSuccessAt(db)).toBeNull();

      stubMis(200);
      const r = await runEarlyWarningPush('test', db);
      expect(r?.students).toBe(2500);
      expect(await lastSuccessAt(db)).toBeInstanceOf(Date);
      // Summary line carries counts only.
      expect(log.mock.calls.some(([m]) => /2500 student\(s\) in 3 batch/.test(String(m)))).toBe(true);
    } finally {
      Object.assign(config, { ngaMisBaseUrl: saved.base, ssoClientId: saved.id, ssoClientSecret: saved.secret });
      process.env = prev;
      err.mockRestore();
      log.mockRestore();
    }
  });

  it('is disabled without credentials or with EARLY_WARNING_PUSH=0', () => {
    expect(disabledReason(ENV)).toBeNull();
    expect(disabledReason({ ...ENV, pushFlag: '0' })).toMatch(/EARLY_WARNING_PUSH/);
    expect(disabledReason({ ...ENV, clientId: 'placeholder_client_id' })).toMatch(/SSO_CLIENT_ID/);
    expect(disabledReason({ ...ENV, clientSecret: '' })).toMatch(/SSO_CLIENT_SECRET/);
    expect(disabledReason({ ...ENV, misBaseUrl: '' })).toMatch(/NGA_MIS_BASE_URL/);
  });
});

describe('early-warning schedule', () => {
  // Kigali is UTC+2: 16:30Z = 18:30 local.
  it('runs daily after 18:30 Kigali unless already sent since', () => {
    const at = (iso: string) => new Date(iso);
    expect(dailyRunDue(at('2026-10-07T16:29:00Z'), null)).toBe(false);
    expect(dailyRunDue(at('2026-10-07T16:30:00Z'), null)).toBe(true);
    expect(dailyRunDue(at('2026-10-07T17:00:00Z'), at('2026-10-06T16:31:00Z'))).toBe(true);
    expect(dailyRunDue(at('2026-10-07T17:00:00Z'), at('2026-10-07T08:00:00Z'))).toBe(true); // morning startup run doesn't count
    expect(dailyRunDue(at('2026-10-07T17:00:00Z'), at('2026-10-07T16:31:00Z'))).toBe(false);
  });

  it('runs at startup only when the last success is over 20h old', () => {
    const now = new Date('2026-10-07T10:00:00Z');
    expect(startupRunDue(now, null)).toBe(true);
    expect(startupRunDue(now, new Date('2026-10-06T13:00:00Z'))).toBe(true);
    expect(startupRunDue(now, new Date('2026-10-06T15:00:00Z'))).toBe(false);
  });
});
