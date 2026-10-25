import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { Database } from 'sqlite';
import { setupTestDb } from './testUtils.js';
import { schoolLocalToUtc } from '../shared/schoolTime.js';
import { ingestScan, reprocessPending } from '../modules/rfid/ingest.service.js';
import { assignCard, registerCard, setCardStatus } from '../modules/rfid/cards.service.js';
import { tick } from '../modules/rfid/closing.service.js';
import { drain } from '../modules/rfid/workQueue.js';

/**
 * End-to-end card attendance against an in-memory DB, following each class's
 * own timetable. Monday 2026-09-28. Year 1 (class y1):
 *   07:30 Maths · 08:10 English · 08:50 Physics · BREAK 09:30–09:50 · 09:50 Chemistry · 10:30 Biology (ends 11:10)
 * Year 2 (class y2) starts later: 08:00 History · 08:40 Geography.
 */
const DAY = '2026-09-28';
const TUE = '2026-09-29';
const iso = (hhmm: string, sec = 0, day = DAY) =>
  new Date(schoolLocalToUtc(day, hhmm).getTime() + sec * 1000).toISOString();
const admin = { id: 'adm-1', name: 'Admin' };

describe('card attendance follows the class timetable', () => {
  let db: Database;

  const tap = (uid: string, clock: string, sec = 0, day = DAY, extra: Record<string, unknown> = {}) =>
    ingestScan(db, { source: 'direct', deviceCode: 'NGA-GATE-01', uid, receivedAt: iso(clock, sec, day), ...extra });

  /** "Morning" or a subject name -> status, for one student and day. */
  async function registers(studentId: string, day = DAY): Promise<Record<string, string>> {
    const rows = await db.all(
      `SELECT a.session_type, COALESCE(s.name, '') AS subject, a.status FROM attendance_records a
         LEFT JOIN subjects s ON s.id = a.subject_id
        WHERE a.student_id = ? AND a.session_date = ?`,
      studentId, day
    );
    return Object.fromEntries(rows.map((r: any) => [r.session_type === 'homeroom' ? 'Morning' : r.subject, r.status]));
  }

  async function seedStudent(id: string, name: string, classId: string) {
    const now = new Date().toISOString();
    await db.run(`INSERT OR REPLACE INTO roster_students (student_id, name, mis_status, synced_at) VALUES (?, ?, 'ACTIVE', ?)`, id, name, now);
    await db.run(`DELETE FROM roster_enrolments WHERE student_id = ?`, id);
    await db.run(
      `INSERT INTO roster_enrolments (student_id, class_id, academic_year_id, status, synced_at) VALUES (?, ?, 7, 'ACTIVE', ?)`,
      id, classId, now
    );
  }
  async function giveCard(uid: string, studentId: string) {
    const cardId = await registerCard(db, admin, uid, null);
    await assignCard(db, admin, cardId, studentId, null);
    return cardId;
  }
  async function slot(id: number, classId: string, subjectId: number, from: string, to: string, day = 1) {
    await db.run(
      `INSERT INTO timetable_slots (slot_id, class_id, subject_id, day_of_week, start_time, end_time, is_active, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, 'x')`,
      id, classId, subjectId, day, from, to
    );
  }

  beforeAll(async () => {
    db = await setupTestDb();
  });

  beforeEach(async () => {
    // Cards are handed out the week before, so every tap is after assignment.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-21T08:00:00Z'));
    for (const t of ['rfid_scan_events', 'rfid_card_assignments', 'rfid_cards', 'rfid_devices', 'rfid_closed_registers',
      'rfid_days_off', 'timetable_slots', 'attendance_record_history', 'attendance_records', 'excuse_requests',
      'roster_enrolments', 'roster_students', 'roster_class_groups', 'notifications', 'audit_log']) {
      await db.run(`DELETE FROM ${t}`);
    }
    await db.run(`INSERT OR REPLACE INTO subjects (id, name) VALUES (1,'Maths'),(2,'English'),(3,'Physics'),(4,'Chemistry'),(5,'Biology'),(6,'History'),(7,'Geography')`);
    await db.run(`INSERT INTO roster_class_groups (class_id, name, synced_at) VALUES ('y1', 'Year 1', 'x'), ('y2', 'Year 2', 'x')`);
    await slot(1, 'y1', 1, '07:30', '08:10');
    await slot(2, 'y1', 2, '08:10', '08:50');
    await slot(3, 'y1', 3, '08:50', '09:30');
    await slot(4, 'y1', 4, '09:50', '10:30');
    await slot(5, 'y1', 5, '10:30', '11:10');
    await slot(6, 'y2', 6, '08:00', '08:40');
    await slot(7, 'y2', 7, '08:40', '09:20');
    await seedStudent('levi', 'Levi Ishimwe', 'y1');
    await seedStudent('jane', 'Jane Doe', 'y1');
    await seedStudent('alex', 'Alex Doe', 'y1');
    await seedStudent('nocard', 'No Card', 'y1');
    await seedStudent('mia', 'Mia Year2', 'y2');
    await giveCard('79:43:01:04', 'levi');
    await giveCard('57:33:01:04', 'jane');
    await giveCard('11:22:33:44', 'alex');
    await giveCard('AA:BB:CC:DD', 'mia');
  });

  afterEach(async () => {
    await drain();
    vi.useRealTimers();
  });

  it('Levi taps at 07:25: morning register and every lesson until the break are present', async () => {
    const r = await tap('79:43:01:04', '07:25');
    expect(r).toMatchObject({ outcome: 'recorded_present', studentName: 'Levi Ishimwe', className: 'Year 1', status: 'present' });
    expect(await registers('levi')).toEqual({ Morning: 'present', Maths: 'present', English: 'present', Physics: 'present' });
    const row = await db.get(`SELECT * FROM attendance_records WHERE student_id = 'levi' AND subject_id = 1`);
    expect(row).toMatchObject({ session_type: 'subject', period: 'Morning', class_id: 'y1', source: 'rfid', marked_by: 'system:rfid', first_scan_at: iso('07:25') });
  });

  it('back 5 minutes late from break: late for Chemistry, present for Biology', async () => {
    await tap('79:43:01:04', '07:25');
    const r = await tap('79:43:01:04', '09:55');
    expect(r.outcome).toBe('recorded_late');
    expect(await registers('levi')).toMatchObject({ Chemistry: 'late', Biology: 'present' });
  });

  it('grace is 3 minutes: 07:33 is on time, 07:34 is late', async () => {
    await tap('79:43:01:04', '07:33', 50);
    await tap('57:33:01:04', '07:34', 0);
    expect(await registers('levi')).toMatchObject({ Morning: 'present', Maths: 'present' });
    expect(await registers('jane')).toMatchObject({ Morning: 'late', Maths: 'late', English: 'present' });
  });

  it('each student is judged by their own class timetable', async () => {
    await tap('AA:BB:CC:DD', '07:58'); // Mia, Year 2: first lesson 08:00
    await tap('79:43:01:04', '07:58'); // Levi, Year 1: first lesson 07:30
    expect(await registers('mia')).toEqual({ Morning: 'present', History: 'present', Geography: 'present' });
    expect(await registers('levi')).toMatchObject({ Morning: 'late', Maths: 'late', English: 'present' });
  });

  it('repeated taps: one set of registers, every tap kept in the log', async () => {
    const outcomes = [];
    for (const [c, s] of [['07:25', 0], ['07:25', 3], ['07:25', 6], ['07:26', 0], ['07:40', 0]] as const) {
      outcomes.push((await tap('79:43:01:04', c, s)).outcome);
    }
    expect(outcomes).toEqual(['recorded_present', 'debounced', 'debounced', 'already_recorded', 'already_recorded']);
    expect((await db.get(`SELECT COUNT(*) AS n FROM attendance_records WHERE student_id = 'levi'`)).n).toBe(4);
    expect((await db.get(`SELECT COUNT(*) AS n FROM rfid_scan_events`)).n).toBe(5);
  });

  it('a tap after the last lesson records nothing', async () => {
    const r = await tap('79:43:01:04', '11:30');
    expect(r).toMatchObject({ outcome: 'no_active_session' });
    expect(await registers('levi')).toEqual({});
  });

  it('closing a lesson marks card holders with no tap absent; students without cards are left to the teacher', async () => {
    await tap('79:43:01:04', '07:25');
    await tick(db, new Date(iso('08:11')));
    expect((await registers('alex')).Maths).toBe('absent');
    expect((await registers('alex')).Morning).toBeUndefined(); // morning register closes at the break
    expect(await registers('nocard')).toEqual({});
    await tick(db, new Date(iso('09:31')));
    expect(await registers('alex')).toEqual({ Maths: 'absent', Morning: 'absent', English: 'absent', Physics: 'absent' });
    expect(await registers('levi')).toEqual({ Morning: 'present', Maths: 'present', English: 'present', Physics: 'present' });
    expect(await registers('nocard')).toEqual({});
    const absentRow = await db.get(`SELECT * FROM attendance_records WHERE student_id = 'alex' AND subject_id = 1`);
    expect(absentRow).toMatchObject({ source: 'system', auto_status: 'absent', notes: 'No card tap' });
    // Idempotent.
    await tick(db, new Date(iso('09:32')));
    expect((await db.get(`SELECT COUNT(*) AS n FROM attendance_records WHERE student_id = 'alex'`)).n).toBe(4);
  });

  it('arriving after the first lesson closed: that lesson stays absent, the rest are recorded', async () => {
    await tick(db, new Date(iso('08:11')));
    const r = await tap('57:33:01:04', '08:15');
    expect(r.outcome).toBe('recorded_late');
    expect(await registers('jane')).toEqual({ Maths: 'absent', Morning: 'late', English: 'late', Physics: 'present' });
  });

  it('an approved excuse turns the closing absent into excused', async () => {
    await db.run(
      `INSERT INTO excuse_requests (student_id, student_name, class_name, class_id, session_date, reason, status, session_type, subject_id)
       VALUES ('alex', 'Alex Doe', 'Year 1', 'y1', ?, 'Clinic', 'approved', 'subject', 1)`,
      DAY
    );
    await tick(db, new Date(iso('08:11')));
    expect((await registers('alex')).Maths).toBe('excused');
  });

  it('a day off: no absences and taps record nothing', async () => {
    await db.run(`INSERT INTO rfid_days_off (session_date, reason, created_by, created_at) VALUES (?, 'Public holiday', 'adm', 'x')`, DAY);
    const r = await tap('79:43:01:04', '07:25');
    expect(r.outcome).toBe('no_active_session');
    await tick(db, new Date(iso('12:00')));
    expect((await db.get(`SELECT COUNT(*) AS n FROM attendance_records`)).n).toBe(0);
  });

  it('a teacher’s mark is never overwritten by a card', async () => {
    await db.run(
      `INSERT INTO attendance_records (student_id, student_name, class_id, class_name, session_date, period, session_type, subject_id, status, marked_by)
       VALUES ('levi', 'Levi', 'y1', 'Year 1', ?, 'Morning', 'subject', 1, 'absent', 'tch-1')`,
      DAY
    );
    await tap('79:43:01:04', '07:25');
    const maths = await db.get(`SELECT status, source FROM attendance_records WHERE student_id = 'levi' AND subject_id = 1`);
    expect(maths).toEqual({ status: 'absent', source: 'manual' });
    expect((await registers('levi')).English).toBe('present');
  });

  it('getting a card mid-morning does not make a student absent from lessons before it', async () => {
    await db.run(`UPDATE rfid_card_assignments SET assigned_at = ? WHERE student_id = 'alex'`, iso('08:30'));
    await tick(db, new Date(iso('09:31')));
    expect(await registers('alex')).toEqual({ Physics: 'absent' });
  });

  it('promotion: the next day follows the new class, earlier rows keep the old class', async () => {
    await slot(20, 'y2', 6, '08:00', '08:40', 2);
    await tap('79:43:01:04', '07:25');
    await seedStudent('levi', 'Levi Ishimwe', 'y2');
    await tap('79:43:01:04', '07:55', 0, TUE);
    expect((await db.get(`SELECT DISTINCT class_id FROM attendance_records WHERE student_id = 'levi' AND session_date = ?`, DAY)).class_id).toBe('y1');
    expect(await registers('levi', TUE)).toEqual({ Morning: 'present', History: 'present' });
  });

  it('a lost card stops working; its replacement works; history stays', async () => {
    await tap('79:43:01:04', '07:25');
    const old = await db.get(`SELECT id FROM rfid_cards WHERE uid = '79430104'`);
    vi.setSystemTime(new Date(iso('09:35')));
    await setCardStatus(db, admin, old.id, 'lost', 'Lost at break');
    const newId = await registerCard(db, admin, 'DE:AD:BE:EF', null);
    await assignCard(db, admin, newId, 'levi', null);
    expect((await tap('79:43:01:04', '09:45')).outcome).toBe('disabled_card');
    expect((await tap('DE:AD:BE:EF', '09:46')).outcome).toBe('recorded_present');
    expect(await registers('levi')).toMatchObject({ Morning: 'present', Chemistry: 'present' });
  });

  it('unknown and malformed cards never create attendance', async () => {
    expect((await tap('DE:AD:00:01', '07:25')).outcome).toBe('unknown_card');
    expect((await tap('dh:dwad:!31', '07:26')).outcome).toBe('malformed_uid');
    expect((await db.get(`SELECT COUNT(*) AS n FROM attendance_records`)).n).toBe(0);
  });

  it('two scanners reporting the same card at once: one set of registers', async () => {
    const [a, b] = await Promise.all([
      ingestScan(db, { source: 'direct', deviceCode: 'NGA-GATE-01', uid: '79:43:01:04', receivedAt: iso('07:20') }),
      ingestScan(db, { source: 'direct', deviceCode: 'NGA-GATE-02', uid: '79:43:01:04', receivedAt: iso('07:20', 1) }),
    ]);
    expect([a.outcome, b.outcome]).toEqual(['recorded_present', 'debounced']);
    expect((await db.get(`SELECT COUNT(*) AS n FROM attendance_records`)).n).toBe(4);
  });

  it('a tap left pending by a crash is finished on restart', async () => {
    await db.run(
      `INSERT INTO rfid_scan_events (source, uid_raw, uid, received_at, effective_at, outcome) VALUES ('direct', '79:43:01:04', '79430104', ?, ?, 'pending')`,
      iso('07:15'), iso('07:15')
    );
    expect(await reprocessPending(db)).toBe(1);
    expect((await registers('levi')).Morning).toBe('present');
  });

  it('a late student gets the same late notice a teacher’s mark would send', async () => {
    await tap('57:33:01:04', '07:40');
    await new Promise((r) => setTimeout(r, 100)); // notices are sent in the background, as after a teacher's save
    const notes = await db.all(`SELECT dedupe_key FROM notifications WHERE user_id = 'jane'`);
    expect(notes.length).toBeGreaterThan(0);
  });
});
