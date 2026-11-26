import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type { Database } from 'sqlite';
import { app } from '../app.js';
import { setupTestDb, createTestUser, authHeader } from './testUtils.js';
import { __setClockNow } from '../modules/clock/clock.service.js';
import { buildReport, dayKind, groupRules, reportStaff, type ReportInput, type ReportRecord } from '../modules/clock/clockReport.js';

/**
 * Staff attendance report (the dashboard's term calendar, weekly trend, patterns
 * and staff groups). 2026-11-02 is a Monday; Kigali is UTC+2.
 */

const WEEKDAYS = new Set([1, 2, 3, 4, 5]);
const rec = (staffId: string, date: string, inMinutes = 7 * 60 + 30, late = false): ReportRecord => ({ staffId, name: `Person ${staffId}`, date, inMinutes, late });
const base = (over: Partial<ReportInput> = {}): ReportInput => ({
  from: '2026-11-02', to: '2026-11-13', calFrom: '2026-11-01', calTo: '2026-11-30', today: '2026-11-13', trackingFrom: '2026-10-01',
  weekdays: WEEKDAYS, offDays: new Set(), roster: ['1', '2', '3', '4'].map((id) => ({ id, name: `Person ${id}` })), records: [], lateAfter: 8 * 60 + 30, opens: 6 * 60, ...over,
});

describe('staff attendance report (pure)', () => {
  it('tells school days from weekends, days off, untracked and future days', () => {
    const i = { today: '2026-11-13', trackingFrom: '2026-11-04', weekdays: WEEKDAYS, offDays: new Set(['2026-11-10']) };
    expect(dayKind('2026-11-07', i)).toBe('off'); // Saturday
    expect(dayKind('2026-11-10', i)).toBe('off'); // day off
    expect(dayKind('2026-11-03', i)).toBe('untracked');
    expect(dayKind('2026-11-05', i)).toBe('school');
    expect(dayKind('2026-11-16', i)).toBe('future');
  });

  it('counts each calendar day for the whole staff, and never counts "not in yet" today as an absence', () => {
    const records = [
      rec('1', '2026-11-02'), rec('2', '2026-11-02'), rec('3', '2026-11-02', 8 * 60 + 45, true),
      rec('1', '2026-11-03'), rec('2', '2026-11-03'), rec('3', '2026-11-03'), rec('4', '2026-11-03'),
      rec('1', '2026-11-13'), // today: only one person is in so far
    ];
    const r = buildReport(base({ records }));
    const day = (d: string) => r.days.find((x) => x.date === d)!;
    expect(day('2026-11-02')).toMatchObject({ kind: 'school', onTime: 2, late: 1, absent: 1, staff: 4, today: false });
    expect(day('2026-11-03')).toMatchObject({ onTime: 4, late: 0, absent: 0 });
    expect(day('2026-11-07')).toMatchObject({ kind: 'off', staff: 0 });
    expect(day('2026-11-13')).toMatchObject({ today: true, onTime: 1, absent: 3 });
    expect(day('2026-11-16')).toMatchObject({ kind: 'future' });
    expect(r.days[0].date).toBe('2026-11-01');
    expect(r.days[r.days.length - 1].date).toBe('2026-11-30');
    expect(r.staff).toBe(4);
    expect(r.totals.schoolDays).toBe(10);
    expect(r.countedDays).toBe(9); // today is left out of each person's absences
    const p1 = r.persons.find((p) => p.userId === '1')!;
    expect(p1).toMatchObject({ schoolDays: 10, attended: 3, absent: 7, late: 0 });
    const p4 = r.persons.find((p) => p.userId === '4')!;
    expect(p4).toMatchObject({ schoolDays: 9, attended: 1, absent: 8 });
  });

  it('builds weeks with the previous period, weekdays and the arrival buckets', () => {
    const records: ReportRecord[] = [];
    // Previous fortnight (19-30 Oct): two of four in every day. This fortnight: everyone, one late on Mondays.
    for (const d of ['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30']) records.push(rec('1', d), rec('2', d));
    for (const d of ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13']) {
      const monday = d === '2026-11-02' || d === '2026-11-09';
      records.push(rec('1', d), rec('2', d), rec('3', d), rec('4', d, monday ? 8 * 60 + 40 : 7 * 60 + 50, monday));
    }
    const r = buildReport(base({ records }));
    expect(r.weeks).toEqual([
      { start: '2026-11-02', rate: 100, late: 1, prevRate: 50 },
      { start: '2026-11-09', rate: 100, late: 1, prevRate: 50 },
    ]);
    expect(r.totals).toMatchObject({ rate: 100, prevRate: 50, late: 2 });
    expect(r.weekdays.map((w) => w.dow)).toEqual([1, 2, 3, 4, 5]);
    expect(r.weekdays.every((w) => w.rate === 100)).toBe(true);
    const lateBucket = r.arrivals.find((b) => b.from === '08:30')!;
    expect(lateBucket).toMatchObject({ onTime: 0, late: 2 });
    expect(r.arrivals.find((b) => b.from === '07:30')!.onTime).toBe(30);
  });

  it('puts staff in groups by rules that scale with the period, and lists a group on request', () => {
    expect(groupRules(62)).toEqual({ conversationAbsent: 7, conversationLate: 13, oftenLate: 10, rarelyAbsent: 2 });
    expect(groupRules(4)).toEqual({ conversationAbsent: 2, conversationLate: 3, oftenLate: 2, rarelyAbsent: 0 });
    const records: ReportRecord[] = [];
    for (const d of ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12']) {
      records.push(rec('1', d)); // always in, on time
      records.push(rec('2', d, 8 * 60 + 50, true)); // always late
      if (d < '2026-11-05') records.push(rec('3', d)); // absent 6 of 9
    }
    const r = buildReport(base({ records }));
    const count = (k: string) => r.groups.find((g) => g.key === k)!.count;
    expect(count('conversation')).toBe(3); // 2 (late), 3 and 4 (absent)
    expect(count('often_late')).toBe(1);
    expect(count('rarely_absent')).toBe(2); // 1 and 2
    expect(count('on_time')).toBe(2); // 1 and 3
    expect(reportStaff(r.persons, r.countedDays, 'often_late').map((p) => p.userId)).toEqual(['2']);
    expect(reportStaff(r.persons, r.countedDays).map((p) => p.userId)).toEqual(['4', '3', '2']); // worst first; person 1 is not listed
    expect(reportStaff(r.persons, 0, 'conversation')).toEqual([]);
  });

  it('reports nothing as absent before tracking started', () => {
    const r = buildReport(base({ trackingFrom: '2026-11-12', records: [rec('1', '2026-11-12'), rec('1', '2026-11-13')] }));
    expect(r.days.find((d) => d.date === '2026-11-05')).toMatchObject({ kind: 'untracked', absent: 0, staff: 0 });
    expect(r.totals.schoolDays).toBe(2);
    expect(r.persons.find((p) => p.userId === '2')).toMatchObject({ schoolDays: 1, absent: 1 });
  });
});

describe('staff attendance report (routes)', () => {
  let db: Database;
  let adminToken: string;
  let teacherToken: string;
  const kigali = (hhmm: string, date: string) => Date.parse(`${date}T${hhmm}:00+02:00`);

  beforeAll(async () => {
    db = await setupTestDb();
    ({ token: adminToken } = await createTestUser(db, { id: '900', name: 'Admin Office', email: 'admin@school.rw', roleLevel: 'ADMIN' }));
    ({ token: teacherToken } = await createTestUser(db, { id: '901', name: 'Plain Teacher', email: 'teacher@school.rw', roleLevel: 'TEACHER' }));
    __setClockNow(() => kigali('10:00', '2026-11-13'));
    await db.run(`INSERT INTO academic_years (id, name, start_date, end_date, is_current) VALUES (1, '2026-2027', '2026-09-01', '2027-07-31', 1)`).catch(() => undefined);
    await db.run(`INSERT INTO academic_terms (id, academic_year_id, name, start_date, end_date, is_current) VALUES (1, 1, 'Term 1', '2026-11-02', '2026-12-18', 1)`);
    const add = (id: string, name: string, date: string, time: string, status: string, review?: string) =>
      db.run(`INSERT INTO staff_attendance (staff_id, staff_name, date, clock_in, status, source, review_state) VALUES (?, ?, ?, ?, ?, 'device', ?)`, id, name, date, new Date(kigali(time, date)).toISOString(), status, review ?? null);
    await add('900', 'Admin Office', '2026-11-02', '07:30', 'present');
    await add('901', 'Plain Teacher', '2026-11-02', '08:45', 'late');
    await add('900', 'Admin Office', '2026-11-03', '07:35', 'present');
    await add('901', 'Plain Teacher', '2026-11-03', '07:40', 'present', 'invalid'); // marked invalid: not counted
    await add('900', 'Admin Office', '2026-11-13', '07:20', 'present');
  });

  afterAll(() => { __setClockNow(null); });

  it('reports the current term by default, without any names', async () => {
    const res = await request(app).get('/api/staff/clock/report').set(authHeader(adminToken));
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d).toMatchObject({ from: '2026-11-02', to: '2026-11-13', today: '2026-11-13', term: { name: 'Term 1', start: '2026-11-02', end: '2026-12-18' } });
    expect(d.persons).toBeUndefined();
    expect(JSON.stringify(d)).not.toContain('Plain Teacher');
    const day = (date: string) => d.days.find((x: any) => x.date === date);
    expect(day('2026-11-02')).toMatchObject({ kind: 'school', onTime: 1, late: 1 });
    expect(day('2026-11-03')).toMatchObject({ onTime: 1, late: 0 });
    expect(day('2026-11-13')).toMatchObject({ today: true, onTime: 1 });
    expect(d.days[0].date).toBe('2026-11-01');
    expect(d.days[d.days.length - 1].date).toBe('2026-11-30');
    expect(d.groups.map((g: any) => g.key)).toEqual(['conversation', 'often_late', 'rarely_absent', 'on_time']);
    expect(d.lateAfter).toMatch(/^\d{2}:\d{2}$/);
  });

  it('takes a custom range, and lists staff only when asked', async () => {
    const res = await request(app).get('/api/staff/clock/report?from=2026-11-02&to=2026-11-03').set(authHeader(adminToken));
    expect(res.body.data).toMatchObject({ from: '2026-11-02', to: '2026-11-03' });
    expect(res.body.data.totals).toMatchObject({ schoolDays: 2, late: 1 });
    const staff = await request(app).get('/api/staff/clock/report/staff?from=2026-11-02&to=2026-11-03').set(authHeader(adminToken));
    expect(staff.status).toBe(200);
    const teacher = staff.body.data.people.find((p: any) => p.userId === '901');
    expect(teacher).toMatchObject({ name: 'Plain Teacher', late: 1, absent: 1, attended: 1 });
    expect(staff.body.data.people.some((p: any) => p.userId === '900')).toBe(false); // never late or absent
    // A future end date is cut back to today; a reversed range becomes one day.
    const clipped = await request(app).get('/api/staff/clock/report?from=2026-12-01&to=2026-12-31').set(authHeader(adminToken));
    expect(clipped.body.data).toMatchObject({ from: '2026-11-13', to: '2026-11-13' });
  });

  it('is for people who may see all staff attendance', async () => {
    expect((await request(app).get('/api/staff/clock/report').set(authHeader(teacherToken))).status).toBe(403);
    expect((await request(app).get('/api/staff/clock/report/staff').set(authHeader(teacherToken))).status).toBe(403);
    expect((await request(app).get('/api/staff/clock/report')).status).toBe(401);
  });
});
