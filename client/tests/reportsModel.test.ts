// Run with `npm test`. The Reports page's documents: what each report lists, the headline
// numbers and their change against the period before. Invented people only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAllReports, buildReportTable, duration, fileStem, flagWords, kpiList, percent, periodLabel, searchRows, REPORT_ORDER } from '../src/pages/staffClock/reports/reportsModel.ts';
import type { ReportsData, ReportsEntry, ReportsKpis, ReportsPerson } from '../src/api/staffClock.ts';

const entry = (date: string, userId: string, o: Partial<ReportsEntry> = {}): ReportsEntry => ({
  date, userId, status: 'on_time', in: '07:20', out: '16:05', start: '07:30', end: '16:00', own: false, lateBy: 0, earlyBy: 0, outState: 'on_time',
  minutes: 525, expectedMinutes: 510, source: 'device', flags: [], needsReview: false, invalid: false, extra: false, distance: 20, ...o,
});
const person = (userId: string, name: string, o: Partial<ReportsPerson> = {}): ReportsPerson => ({
  userId, name, role: 'Teacher', own: false, expectedDays: 2, present: 2, onTime: 2, late: 0, absent: 0, earlyLeave: 0, noCheckout: 0, extraDays: 0, lateMinutes: 0,
  minutesWorked: 1050, daysWithHours: 2, expectedMinutes: 1020, avgIn: '07:20', avgOut: '16:05', rate: 100, punctuality: 100, longestAbsence: 0, ...o,
});
const kpis = (o: Partial<ReportsKpis> = {}): ReportsKpis => ({
  staff: 3, schoolDays: 2, expected: 6, present: 5, onTime: 4, late: 1, absent: 1, notInToday: 0, rate: 83.3, punctuality: 80, earlyLeave: 1, noCheckout: 1,
  avgIn: '07:28', avgLateMinutes: 25, minutesWorked: 2000, avgMinutesPerDay: 500, needsReview: 1, invalid: 0, cardCheckIns: 1, perfect: 1, ...o,
});
const data = (o: Partial<ReportsData> = {}): ReportsData => ({
  from: '2026-11-24', to: '2026-11-25', today: '2026-11-27', trackingFrom: '2026-11-02', preset: 'custom', kpis: kpis(),
  days: [
    { date: '2026-11-24', kind: 'school', today: false, expected: 3, present: 3, onTime: 2, late: 1, absent: 0, notIn: 0, earlyLeave: 1, noCheckout: 0, rate: 100 },
    { date: '2026-11-25', kind: 'school', today: false, expected: 3, present: 2, onTime: 2, late: 0, absent: 1, notIn: 0, earlyLeave: 0, noCheckout: 1, rate: 66.7 },
  ],
  persons: [
    person('1', 'Person One Alpha'),
    person('2', 'Person Two Bravo', { late: 1, onTime: 1, earlyLeave: 1, lateMinutes: 25, punctuality: 50, minutesWorked: 900 }),
    person('3', 'Person Three Charlie', { present: 1, onTime: 1, absent: 1, noCheckout: 1, rate: 50, daysWithHours: 0, minutesWorked: 0, expectedMinutes: 0, longestAbsence: 1 }),
  ],
  entries: [
    entry('2026-11-24', '1'),
    entry('2026-11-24', '2', { status: 'late', in: '07:55', lateBy: 25, out: '15:10', outState: 'early', earlyBy: 50, minutes: 435 }),
    entry('2026-11-24', '3', { out: null, outState: 'missing', minutes: null, source: 'card' }),
    entry('2026-11-25', '1', { flags: ['weak_location'], needsReview: true }),
    entry('2026-11-25', '2'),
    entry('2026-11-25', '3', { status: 'absent', in: null, out: null, outState: null, minutes: null, source: null }),
  ],
  previous: { from: '2026-11-22', to: '2026-11-23', kpis: kpis({ rate: 90, punctuality: 70, late: 3, absent: 0, earlyLeave: 1, noCheckout: 0, avgMinutesPerDay: 480, perfect: 1 }) },
  term: { name: 'Term 1', start: '2026-09-07', end: '2026-12-11' }, rosterSource: 'mis', rules: { lateAfter: '07:30', earlyLeaveBefore: '16:00', enabled: true }, serverNow: '2026-11-27T06:00:00.000Z', ...o,
});

test('words: durations, percentages, the period, a file name, flags', () => {
  assert.equal(duration(45), '45 min');
  assert.equal(duration(465), '7 h 45');
  assert.equal(duration(null), '');
  assert.equal(percent(92.5), '92.5%');
  assert.equal(percent(100), '100%');
  assert.equal(percent(null), '');
  assert.equal(periodLabel('2026-11-26', '2026-11-26'), 'Thursday, 26 November 2026');
  assert.equal(periodLabel('2026-11-23', '2026-11-26'), '23 Nov 2026 to 26 Nov 2026');
  assert.equal(fileStem('late', '2026-11-23', '2026-11-26'), 'staff-attendance-late-2026-11-23-to-2026-11-26');
  assert.equal(fileStem('all', '2026-11-26', '2026-11-26'), 'staff-attendance-all-2026-11-26');
  assert.equal(flagWords('weak_location'), 'Weak location');
  assert.equal(flagWords('out:manual'), 'Check-out entered by the office');
  assert.equal(flagWords('some_new_flag'), 'Some new flag');
});

test('headline numbers: value, the report behind each, and the change against the period before', () => {
  const list = kpiList(data());
  const by = Object.fromEntries(list.map((k) => [k.id, k]));
  assert.equal(by.rate.value, '83.3%');
  assert.deepEqual(by.rate.change, { text: 'Down 6.7 pts', good: false });
  assert.deepEqual(by.punctuality.change, { text: 'Up 10 pts', good: true });
  // Fewer late arrivals is good; more absences is not.
  assert.deepEqual(by.late.change, { text: 'Down 2', good: true });
  assert.deepEqual(by.absent.change, { text: 'Up 1', good: false });
  assert.deepEqual(by.early.change, { text: 'Same as before', good: null });
  assert.deepEqual(by.hours.change, { text: 'Up 20 min', good: true });
  assert.equal(by.late.report, 'late');
  assert.equal(by.absent.report, 'absent');
  assert.equal(by.noout.report, 'leaving');
  assert.equal(by.review.report, 'review');
  assert.equal(list.length, 10);
});

test('no earlier tracked day: no comparison is claimed', () => {
  const list = kpiList(data({ previous: { from: '2026-11-22', to: '2026-11-23', kpis: kpis({ schoolDays: 0, rate: null }) } }));
  assert.ok(list.every((k) => k.change === null));
});

test('nine reports, each from the same facts', () => {
  const all = buildAllReports(data());
  assert.deepEqual(all.map((t) => t.id), REPORT_ORDER);
  assert.equal(all.length, 9);
  const by = Object.fromEntries(all.map((t) => [t.id, t]));
  assert.equal(by.register.rows.length, 6);
  assert.equal(by.staff.rows.length, 3);
  assert.equal(by.daily.rows.length, 2);
  assert.equal(by.late.rows.length, 1);
  assert.equal(by.absent.rows.length, 1);
  assert.equal(by.leaving.rows.length, 2);
  assert.equal(by.hours.rows.length, 3);
  assert.equal(by.review.rows.length, 2); // a staff card + a weak location
  // Every cell a row carries has a column, and every column is filled or blank (never undefined).
  for (const t of all) for (const r of t.rows) for (const c of t.columns) assert.notEqual(r.cells[c.key], undefined, `${t.id}.${c.key}`);
});

test('late arrivals: by how much, against their own start, and how often', () => {
  const t = buildReportTable(data(), 'late');
  assert.deepEqual(t.rows[0].cells, { date: '24 Nov 2026', day: 'Tue', name: 'Person Two Bravo', role: 'Teacher', due: '07:30', in: '07:55', lateBy: '25 min', times: 1 });
  assert.equal(t.countText, '1 late arrival');
  assert.equal(t.facts.find((f) => f.label === 'Time lost')!.value, '25 min');
});

test('register: status, notes and how they checked in', () => {
  const t = buildReportTable(data(), 'register');
  const two = t.rows.find((r) => r.cells.name === 'Person Two Bravo' && r.cells.date === '24 Nov 2026')!;
  assert.equal(two.cells.status, 'Late');
  assert.equal(two.tone, 'late');
  assert.equal(two.cells.notes, 'Left 50 min early');
  const three = t.rows.find((r) => r.cells.name === 'Person Three Charlie' && r.cells.date === '24 Nov 2026')!;
  assert.equal(three.cells.how, 'Staff card');
  assert.equal(three.cells.notes, 'No check-out');
  const gone = t.rows.find((r) => r.cells.name === 'Person Three Charlie' && r.cells.date === '25 Nov 2026')!;
  assert.equal(gone.cells.status, 'Absent');
  assert.equal(gone.cells.in, '');
});

test('staff summary lists the people who need attention first; time at school compares like with like', () => {
  const staff = buildReportTable(data(), 'staff');
  assert.equal(staff.rows[0].cells.name, 'Person Three Charlie');
  assert.equal(staff.rows[0].tone, 'abs');
  const hours = buildReportTable(data(), 'hours');
  const one = hours.rows.find((r) => r.cells.name === 'Person One Alpha')!;
  assert.equal(one.cells.time, '17 h 30');
  assert.equal(one.cells.diff, '+30 min');
  const three = hours.rows.find((r) => r.cells.name === 'Person Three Charlie')!;
  assert.equal(three.cells.diff, '');
  assert.equal(three.cells.noOut, 1);
});

test('today in the period: "not in yet" is shown, never as an absence', () => {
  const d = data({
    to: '2026-11-27', kpis: kpis({ notInToday: 2 }),
    days: [...data().days, { date: '2026-11-27', kind: 'school', today: true, expected: 1, present: 1, onTime: 1, late: 0, absent: 0, notIn: 2, earlyLeave: 0, noCheckout: 0, rate: 100 }],
    entries: [...data().entries, entry('2026-11-27', '1', { out: null, outState: 'open', minutes: null }), entry('2026-11-27', '2', { status: 'not_in', in: null, out: null, outState: null, minutes: null, source: null })],
  });
  const daily = buildReportTable(d, 'daily');
  assert.equal(daily.rows[2].cells.absent, '2 not in yet');
  assert.equal(daily.rows[2].cells.expected, 3);
  assert.equal(buildReportTable(d, 'absent').rows.length, 1);
  assert.equal(buildReportTable(d, 'leaving').rows.length, 2); // today's open day is not "no check-out"
  const reg = buildReportTable(d, 'register').rows.find((r) => r.cells.date === '27 Nov 2026' && r.cells.name === 'Person Two Bravo')!;
  assert.equal(reg.cells.status, 'Not in yet');
});

test('an empty period says so in plain words', () => {
  const d = data({ kpis: kpis({ schoolDays: 0, expected: 0, present: 0, onTime: 0, late: 0, absent: 0, rate: null, punctuality: null, earlyLeave: 0, noCheckout: 0, avgIn: null, avgLateMinutes: null, minutesWorked: 0, avgMinutesPerDay: null, needsReview: 0, cardCheckIns: 0, perfect: 0 }), days: [], persons: [], entries: [] });
  for (const t of buildAllReports(d).filter((x) => x.id !== 'summary')) { assert.equal(t.rows.length, 0); assert.ok(t.empty.length > 10); }
  assert.equal(kpiList(d).find((k) => k.id === 'rate')!.value, '–');
});

test('search: every typed word must be on the line', () => {
  const t = buildReportTable(data(), 'register');
  assert.equal(searchRows(t, 'bravo').length, 2);
  assert.equal(searchRows(t, 'bravo late').length, 1);
  assert.equal(searchRows(t, '  ').length, 6);
  assert.equal(searchRows(t, 'nobody').length, 0);
});
