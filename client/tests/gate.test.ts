// Run with `npm test` (node --test; Node >= 23 strips TypeScript natively).
// The Gate view's rules: who is still expected (late first), who arrived, the countdown, who a reminder reaches.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agoText, gateHeadline, gateModel, span } from '../src/pages/staffClock/gate.ts';
import type { Overview, OverviewRow } from '../src/api/staffClock.ts';

const row = (userId: string, name: string, o: Partial<OverviewRow> = {}): OverviewRow => ({
  recordId: o.checkIn ? Number(userId) : null, userId, name, role: 'Teacher', checkIn: null, checkOut: null, status: 'not_in', expected: true,
  plan: { own: false, works: true, start: '07:30', end: '16:00' }, moment: 'due_later', reminders: true,
  outStatus: null, distance: null, source: null, device: null, flags: [], needsReview: false, reviewState: null, ...o,
});
const overview = (rows: OverviewRow[], review: Overview['review'] = []): Overview => ({
  date: '2026-11-26', isToday: true, serverNow: '', rosterSource: 'mis', rules: { lateAfter: '07:30', earlyLeaveBefore: '16:00', opens: '05:00', enabled: true },
  kpis: { staff: rows.length, checkedIn: 0, onTime: 0, late: 0, notIn: 0, checkedOut: 0, earlyLeave: 0, needsReview: 0, medianLateMinutes: null },
  arrivals: [], rows, review, phones: { registered: 0, staff: rows.length, pending: [], unregistered: [] },
});
const NOW = 7 * 60 + 24; // 07:24

const morning = () => overview([
  row('1', 'Bruno', { plan: { own: true, works: true, start: '07:00', end: '15:00' }, moment: 'due_now' }),
  row('2', 'Chantal', { plan: { own: true, works: true, start: '07:15', end: '16:00' }, moment: 'due_now' }),
  row('3', 'David'),
  row('4', 'Esther'),
  row('5', 'Felix', { reminders: false }),
  row('6', 'Irene', { plan: { own: true, works: true, start: '09:00', end: '13:00' } }),
  row('7', 'Grace', { checkIn: '07:23', status: 'present', moment: 'here', source: 'device' }),
  row('8', 'Aline', { checkIn: '07:19', status: 'present', moment: 'here', source: 'card' }),
  row('9', 'Liliane', { checkIn: '07:08', status: 'late', moment: 'here', source: 'device', plan: { own: true, works: true, start: '07:00', end: '16:00' } }),
  row('10', 'Agnes', { expected: false, status: 'day_off', moment: 'day_off', plan: { own: true, works: false, start: null, end: null } }),
  row('11', 'Refused', { checkIn: '07:01', status: 'invalid', moment: 'due_later' }),
]);

test('arriving: late people first (longest late on top), then the nearest start', () => {
  const m = gateModel(morning(), NOW, 'in');
  assert.deepEqual(m.waiting.map((w) => [w.name, w.kind, w.status]), [
    ['Bruno', 'late', '24 min late'],
    ['Chantal', 'late', '9 min late'],
    ['David', 'soon', 'in 6 min'],
    ['Esther', 'soon', 'in 6 min'],
    ['Felix', 'soon', 'in 6 min'],
    ['Irene', 'later', 'at 09:00'],
  ]);
  assert.deepEqual(m.counts, { late: 2, soon: 3, later: 1 });
});

test('arriving: the ring counts expected people who are in; a day off and an invalid check-in do not count', () => {
  const m = gateModel(morning(), NOW, 'in');
  assert.equal(m.total, 10); // everyone but the day off
  assert.equal(m.done, 3);
  assert.equal(m.dayOff, 1);
  assert.equal(m.onTime, 2);
  assert.equal(m.lateArrived, 1);
});

test('arriving: the feed is newest first, with minutes late against the person\'s own start', () => {
  const m = gateModel(morning(), NOW, 'in');
  assert.deepEqual(m.events.map((e) => [e.name, e.at, e.tag, e.card, e.ago]), [
    ['Grace', '07:23', 'On time', false, 1],
    ['Aline', '07:19', 'On time', true, 5],
    ['Liliane', '07:08', '8 min late', false, 16],
  ]);
});

test('a reminder reaches the late and the about-to-be-late with reminders on, not someone who starts hours later', () => {
  const m = gateModel(morning(), NOW, 'in');
  assert.deepEqual(m.remindIds, ['1', '2', '3', '4']);
  assert.equal(m.noReminders, 1);
  assert.equal(m.waiting.find((w) => w.name === 'Irene')!.canRemind, false);
});

test('the headline counts down to the next start, then names who is late', () => {
  assert.deepEqual(gateHeadline(gateModel(morning(), NOW, 'in')), { kicker: 'Start 07:30 · 3 people', line: 'Late in 6 min', tone: 'warn' });
  const later = gateModel(morning(), 7 * 60 + 40, 'in'); // 07:40: the 07:30 people are late now, next start 09:00
  assert.equal(later.counts.late, 5);
  assert.deepEqual(gateHeadline(later), { kicker: 'Next start 09:00', line: '5 late now', tone: 'warn' });
  const done = gateModel(overview([row('7', 'Grace', { checkIn: '07:23', status: 'present', moment: 'here' })]), NOW, 'in');
  assert.deepEqual(gateHeadline(done), { kicker: 'Nobody left to wait for', line: 'Everyone is in', tone: 'calm' });
});

test('exactly at the start minute a person is due now, not "0 min late"', () => {
  const m = gateModel(overview([row('3', 'David', { moment: 'due_now' })]), 7 * 60 + 30, 'in');
  assert.equal(m.waiting[0].status, 'due now');
});

test('someone whose day ended without a check-in stays listed, but is not reminded', () => {
  const m = gateModel(overview([row('1', 'Bruno', { moment: 'missed', plan: { own: true, works: true, start: '07:00', end: '09:00' } })]), 10 * 60, 'in');
  assert.equal(m.waiting[0].status, '3 h 00 late');
  assert.deepEqual(m.remindIds, []);
});

test('leaving: still inside (past their end first), who left, and only the overdue are reminded', () => {
  const ov = overview([
    row('1', 'Paul', { checkIn: '07:00', status: 'present', moment: 'here', plan: { own: true, works: true, start: '07:00', end: '15:30' } }),
    row('2', 'Jean', { checkIn: '07:10', status: 'present', moment: 'here' }),
    row('3', 'Aline', { checkIn: '07:19', status: 'present', moment: 'here', plan: { own: true, works: true, start: '07:30', end: '17:00' } }),
    row('4', 'David', { checkIn: '07:20', checkOut: '16:09', status: 'present', moment: 'left', outStatus: 'on_time' }),
    row('5', 'Liliane', { checkIn: '07:08', checkOut: '14:40', status: 'late', moment: 'left_early', outStatus: 'early' }),
    row('6', 'Bruno', { moment: 'missed' }),
  ]);
  const m = gateModel(ov, 16 * 60 + 10, 'out');
  assert.deepEqual(m.waiting.map((w) => [w.name, w.kind, w.status]), [['Paul', 'late', '40 min over'], ['Jean', 'late', '10 min over'], ['Aline', 'later', 'ends 17:00']]);
  assert.deepEqual(m.events.map((e) => [e.name, e.tag, e.warn]), [['David', 'On time', false], ['Liliane', 'Left early', true]]);
  assert.equal(m.done, 2);
  assert.equal(m.total, 5);
  assert.deepEqual(m.remindIds, ['1', '2']);
  assert.deepEqual(gateHeadline(m), { kicker: 'Their day is over', line: '2 still inside', tone: 'warn' });
});

test('check-ins that wait for a yes come through with their reason', () => {
  const m = gateModel(overview([row('7', 'Samuel', { checkIn: '07:17', status: 'present', moment: 'here', needsReview: true })],
    [{ recordId: 7, userId: '7', name: 'Samuel', at: '07:17', flags: ['weak_location'], flagText: ['Imprecise location, off the school network'], distance: 80, accuracy: 240 }]), NOW, 'in');
  assert.deepEqual(m.checks, [{ recordId: 7, userId: '7', name: 'Samuel', at: '07:17', reason: 'Imprecise location, off the school network' }]);
  assert.equal(m.events[0].needsReview, true);
});

test('words for time', () => {
  assert.equal(span(6), '6 min');
  assert.equal(span(65), '1 h 05');
  assert.equal(agoText(0), 'just now');
  assert.equal(agoText(3), '3 min ago');
});

test('the day-off list names who is not expected today, and why', () => {
  const m = gateModel(morning(), NOW, 'in');
  assert.deepEqual(m.off, [{ userId: '10', name: 'Agnes', role: 'Teacher', note: 'Own hours: day off' }]);
  assert.equal(m.dayOff, 1);
  const closed = gateModel({ ...overview([row('1', 'Zed', { expected: false, status: 'day_off', moment: 'day_off' }), row('2', 'Abe', { expected: false, status: 'day_off', moment: 'day_off' })]), holiday: true }, NOW, 'out');
  assert.deepEqual(closed.off.map((p) => [p.name, p.note]), [['Abe', 'School closed today'], ['Zed', 'School closed today']]);
});

test('a start far off says who is due and when, not "N still to come"', () => {
  const m = gateModel(overview([row('6', 'Irene', { plan: { own: true, works: true, start: '09:00', end: '13:00' } }), row('7', 'Olivier', { plan: { own: true, works: true, start: '09:00', end: '16:00' } }), row('8', 'Diane', { plan: { own: true, works: true, start: '10:00', end: '16:00' } })]), NOW, 'in');
  assert.deepEqual(gateHeadline(m), { kicker: 'Next start 09:00 · in 1 h 36', line: '2 people due at 09:00', tone: 'calm' });
  const one = gateModel(overview([row('6', 'Irene', { plan: { own: true, works: true, start: '09:00', end: '13:00' } })]), NOW, 'in');
  assert.equal(gateHeadline(one).line, '1 person due at 09:00');
});
