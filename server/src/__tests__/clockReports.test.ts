import { describe, expect, it } from 'vitest';
import { buildPeriod, presetRange, previousRange, type PeriodDayRule, type PeriodRecord } from '../modules/clock/clockReports.js';

/** The Reports page's counting rules (Staff check-in -> Reports). Invented people only. */

const school: PeriodDayRule = { works: true, lateAfter: 510, earlyBefore: 960, start: '08:30', end: '16:00', own: false };
const weekend: PeriodDayRule = { ...school, works: false };
// 2026-11-23 is a Monday.
const dow = (d: string) => new Date(`${d}T12:00:00Z`).getUTCDay();
const ruleFor = (id: string, date: string): PeriodDayRule => {
  if (id === 'p3') return { works: dow(date) === 2, lateAfter: 600, earlyBefore: 840, start: '10:00', end: '14:00', own: true }; // Tuesdays only
  return dow(date) === 0 || dow(date) === 6 ? weekend : school;
};
const rec = (id: number, staffId: string, date: string, inM: number | null, outM: number | null, o: Partial<PeriodRecord> = {}): PeriodRecord => ({
  id, staffId, name: `Person ${staffId}`, date, inMinutes: inM, outMinutes: outM, minutes: inM != null && outM != null ? outM - inM : null,
  late: false, earlyOut: false, invalid: false, source: 'device', flags: [], needsReview: false, distance: 12, ...o,
});
const roster = [
  { id: 'p1', name: 'Person One Alpha', role: 'Teacher' },
  { id: 'p2', name: 'Person Two Beta', role: 'Teacher' },
  { id: 'p3', name: 'Person Three Gamma', role: 'Staff' },
];
const base = { today: '2026-11-26', trackingFrom: '2026-11-01', offDays: new Set<string>(), roster, ruleFor };

describe('buildPeriod', () => {
  const records = [
    rec(1, 'p1', '2026-11-23', 500, 965),
    rec(2, 'p2', '2026-11-23', 530, 900, { late: true, earlyOut: true }),
    rec(3, 'p1', '2026-11-24', 505, null),
    rec(4, 'p3', '2026-11-24', 590, 845),
    rec(5, 'p1', '2026-11-25', 500, 970, { source: 'card', flags: ['weak_location'], needsReview: true }),
    rec(6, 'p2', '2026-11-25', 495, 965, { invalid: true }),
    rec(7, 'p1', '2026-11-26', 502, null),
  ];
  const r = buildPeriod({ ...base, from: '2026-11-23', to: '2026-11-26', records });

  it('counts each person on the days they are expected, and never calls today an absence', () => {
    expect(r.kpis.staff).toBe(3);
    expect(r.kpis.schoolDays).toBe(4);
    // Mon: p1 on time, p2 late. Tue: p1, p3 in; p2 absent. Wed: p1 in; p2 invalid = absent. Thu (today): p1 in; p2 not in yet.
    expect(r.kpis.present).toBe(6);
    expect(r.kpis.late).toBe(1);
    expect(r.kpis.absent).toBe(2);
    expect(r.kpis.notInToday).toBe(1);
    expect(r.kpis.expected).toBe(8);
    expect(r.kpis.rate).toBe(75);
    const today = r.days.find((d) => d.date === '2026-11-26')!;
    expect(today).toMatchObject({ today: true, present: 1, absent: 0, notIn: 1, expected: 1 });
  });

  it('judges lateness and early leaving against each person\'s own hours', () => {
    const late = r.entries.find((e) => e.userId === 'p2' && e.date === '2026-11-23')!;
    expect(late).toMatchObject({ status: 'late', lateBy: 20, outState: 'early', earlyBy: 60, in: '08:50', out: '15:00', minutes: 370 });
    const own = r.entries.find((e) => e.userId === 'p3')!;
    expect(own).toMatchObject({ date: '2026-11-24', status: 'on_time', start: '10:00', end: '14:00', own: true, expectedMinutes: 240 });
    // p3 has no line on the days they do not work.
    expect(r.entries.filter((e) => e.userId === 'p3')).toHaveLength(1);
  });

  it('a past day without a check-out is "missing"; today it is still open', () => {
    expect(r.entries.find((e) => e.userId === 'p1' && e.date === '2026-11-24')!.outState).toBe('missing');
    expect(r.entries.find((e) => e.userId === 'p1' && e.date === '2026-11-26')!.outState).toBe('open');
    expect(r.kpis.noCheckout).toBe(1);
    expect(r.kpis.earlyLeave).toBe(1);
  });

  it('an invalid check-in is an absence that says so', () => {
    const e = r.entries.find((x) => x.userId === 'p2' && x.date === '2026-11-25')!;
    expect(e).toMatchObject({ status: 'absent', invalid: true, in: null });
    expect(r.kpis.invalid).toBe(1);
  });

  it('adds up each person: days, hours on days with both times, longest run absent', () => {
    const p1 = r.persons.find((p) => p.userId === 'p1')!;
    expect(p1).toMatchObject({ expectedDays: 4, present: 4, late: 0, absent: 0, noCheckout: 1, daysWithHours: 2, minutesWorked: 465 + 470, expectedMinutes: 900, rate: 100, punctuality: 100 });
    const p2 = r.persons.find((p) => p.userId === 'p2')!;
    expect(p2).toMatchObject({ expectedDays: 3, present: 1, late: 1, absent: 2, longestAbsence: 2, lateMinutes: 20, rate: 33.3, punctuality: 0 });
    expect(r.kpis.perfect).toBe(2); // p1 and p3
    expect(r.kpis.needsReview).toBe(1);
    expect(r.kpis.cardCheckIns).toBe(1);
    expect(r.kpis.avgLateMinutes).toBe(20);
  });

  it('a school day off, a weekend and days before tracking are not absences', () => {
    const off = buildPeriod({ ...base, offDays: new Set(['2026-11-24']), from: '2026-11-21', to: '2026-11-25', records });
    expect(off.days.find((d) => d.date === '2026-11-22')!.kind).toBe('off');
    // The school is closed on the 24th, but p1 and p3 came anyway: credit, no absences.
    expect(off.days.find((d) => d.date === '2026-11-24')).toMatchObject({ kind: 'school', present: 2, absent: 0 });
    expect(off.entries.find((e) => e.userId === 'p1' && e.date === '2026-11-24')!.extra).toBe(true);
    const early = buildPeriod({ ...base, trackingFrom: '2026-11-25', from: '2026-11-23', to: '2026-11-25', records });
    expect(early.days.find((d) => d.date === '2026-11-23')!.kind).toBe('untracked');
    expect(early.kpis.absent).toBe(1);
    expect(early.kpis.schoolDays).toBe(1);
  });

  it('someone who checked in but left the staff list still appears', () => {
    const gone = buildPeriod({ ...base, from: '2026-11-23', to: '2026-11-23', records: [...records, rec(9, 'p9', '2026-11-23', 480, 960)] });
    expect(gone.persons.map((p) => p.userId)).toContain('p9');
    expect(gone.kpis.present).toBe(3);
  });

  it('never reports past today', () => {
    const f = buildPeriod({ ...base, from: '2026-11-25', to: '2026-12-05', records });
    expect(f.to).toBe('2026-11-26');
    expect(f.days).toHaveLength(2);
  });
});

describe('periods', () => {
  it('named periods on the school calendar', () => {
    const term = { start: '2026-09-07', end: '2026-12-11' };
    expect(presetRange('today', '2026-11-26', '2026-11-23', term)).toEqual({ from: '2026-11-26', to: '2026-11-26' });
    expect(presetRange('yesterday', '2026-11-26', '2026-11-23', term)).toEqual({ from: '2026-11-25', to: '2026-11-25' });
    expect(presetRange('week', '2026-11-26', '2026-11-23', term)).toEqual({ from: '2026-11-23', to: '2026-11-26' });
    expect(presetRange('month', '2026-11-26', '2026-11-23', term)).toEqual({ from: '2026-11-01', to: '2026-11-26' });
    expect(presetRange('term', '2026-11-26', '2026-11-23', term)).toEqual({ from: '2026-09-07', to: '2026-11-26' });
    expect(presetRange('term', '2026-12-20', '2026-12-14', term)).toEqual({ from: '2026-09-07', to: '2026-12-11' });
    expect(presetRange('term', '2026-11-26', '2026-11-23', null)).toBeNull();
  });
  it('the period before is the same length', () => {
    expect(previousRange('2026-11-23', '2026-11-26')).toEqual({ from: '2026-11-19', to: '2026-11-22' });
    expect(previousRange('2026-11-26', '2026-11-26')).toEqual({ from: '2026-11-25', to: '2026-11-25' });
  });
});
