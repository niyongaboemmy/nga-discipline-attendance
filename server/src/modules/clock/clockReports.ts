import { addDays } from '../../shared/schoolTime.js';

/**
 * Staff attendance reports (Tendo -> Staff check-in -> Reports): one period as a
 * set of facts every report on that page is cut from: one line per person per
 * school day, a line per person, a line per day, and the headline numbers.
 *
 * Pure: the route loads the rows, the roster and the working hours; this judges.
 *
 * The counting rules are the dashboard's (clockReport.ts), so the two always agree:
 *  - a person counts on a day they are expected (their own week or the school's
 *    rules, not a day off for the school), or on any day they came anyway;
 *  - days before the school's first device/card check-in are not tracked: no absences;
 *  - a check-in an administrator marked invalid does not count as coming;
 *  - today: someone not in yet is "not in yet", never absent, and is not counted
 *    as expected until the day is over (the rate must not look worse at 7 am).
 */

export type EntryStatus = 'on_time' | 'late' | 'absent' | 'not_in';
/** how the day ended for someone who came */
export type OutState = 'on_time' | 'early' | 'missing' | 'open' | null;

export interface PeriodRecord {
  id: number;
  staffId: string;
  name: string;
  date: string;
  /** minutes after midnight on the school clock */
  inMinutes: number | null;
  outMinutes: number | null;
  /** minutes between the stored check-in and check-out, when both exist */
  minutes: number | null;
  late: boolean;
  earlyOut: boolean;
  invalid: boolean;
  source: string | null;
  flags: string[];
  needsReview: boolean;
  distance: number | null;
}

export interface PeriodDayRule {
  works: boolean;
  lateAfter: number | null;
  earlyBefore: number | null;
  start: string | null;
  end: string | null;
  own: boolean;
}

export interface PeriodInput {
  from: string;
  to: string;
  today: string;
  trackingFrom: string;
  offDays: Set<string>;
  roster: Array<{ id: string; name: string; role: string | null }>;
  records: PeriodRecord[];
  ruleFor: (userId: string, date: string) => PeriodDayRule;
}

export interface PeriodEntry {
  date: string;
  userId: string;
  status: EntryStatus;
  /** "07:42" */
  in: string | null;
  out: string | null;
  /** the hours they were expected that day */
  start: string | null;
  end: string | null;
  own: boolean;
  lateBy: number;
  earlyBy: number;
  outState: OutState;
  /** minutes at school (check-in to check-out) */
  minutes: number | null;
  /** minutes they were expected to be at school that day */
  expectedMinutes: number | null;
  source: string | null;
  flags: string[];
  needsReview: boolean;
  /** an invalid check-in exists for this day (the day counts as absent) */
  invalid: boolean;
  /** came on a day they were not expected */
  extra: boolean;
  distance: number | null;
}

export interface PeriodDay {
  date: string;
  kind: 'school' | 'off' | 'untracked';
  today: boolean;
  expected: number;
  present: number;
  onTime: number;
  late: number;
  absent: number;
  notIn: number;
  earlyLeave: number;
  noCheckout: number;
  rate: number | null;
}

export interface PeriodPerson {
  userId: string;
  name: string;
  role: string | null;
  own: boolean;
  expectedDays: number;
  present: number;
  onTime: number;
  late: number;
  absent: number;
  earlyLeave: number;
  noCheckout: number;
  extraDays: number;
  lateMinutes: number;
  /** minutes at school on the days with both a check-in and a check-out */
  minutesWorked: number;
  daysWithHours: number;
  /** expected minutes on those same days (the fair comparison) */
  expectedMinutes: number;
  avgIn: string | null;
  avgOut: string | null;
  rate: number | null;
  punctuality: number | null;
  /** the longest run of school days absent in a row */
  longestAbsence: number;
}

export interface PeriodKpis {
  staff: number;
  schoolDays: number;
  /** person-days expected (closed days), plus the people in today */
  expected: number;
  present: number;
  onTime: number;
  late: number;
  absent: number;
  notInToday: number;
  rate: number | null;
  punctuality: number | null;
  earlyLeave: number;
  noCheckout: number;
  avgIn: string | null;
  avgLateMinutes: number | null;
  minutesWorked: number;
  avgMinutesPerDay: number | null;
  needsReview: number;
  invalid: number;
  cardCheckIns: number;
  /** expected at least once, never absent, never late */
  perfect: number;
}

const hhmm = (m: number | null): string | null => (m == null ? null : `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(Math.round(m) % 60).padStart(2, '0')}`);
const mins = (t: string | null): number | null => (t && /^\d\d:\d\d/.test(t) ? Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5)) : null);
const pct = (part: number, whole: number): number | null => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);
const avg = (list: number[]): number | null => (list.length ? Math.round(list.reduce((a, b) => a + b, 0) / list.length) : null);

export function buildPeriod(input: PeriodInput) {
  const { from, to, today, trackingFrom } = input;
  const people = new Map<string, { name: string; role: string | null }>();
  for (const p of input.roster) people.set(p.id, { name: p.name, role: p.role });
  // Someone who checked in but is no longer on the list still belongs to the period.
  for (const r of input.records) if (r.date >= from && r.date <= to && !r.invalid && !people.has(r.staffId)) people.set(r.staffId, { name: r.name, role: null });

  const recordOf = new Map<string, PeriodRecord>();
  const invalidOf = new Set<string>();
  for (const r of input.records) {
    const key = `${r.date}|${r.staffId}`;
    if (r.invalid) invalidOf.add(key);
    else recordOf.set(key, r);
  }

  const entries: PeriodEntry[] = [];
  const days: PeriodDay[] = [];
  const ids = [...people.keys()];

  for (let date = from; date <= to && date <= today; date = addDays(date, 1)) {
    const isToday = date === today;
    const off = input.offDays.has(date);
    const day: PeriodDay = { date, kind: 'off', today: isToday, expected: 0, present: 0, onTime: 0, late: 0, absent: 0, notIn: 0, earlyLeave: 0, noCheckout: 0, rate: null };
    let anyoneExpected = false;
    const dayEntries: PeriodEntry[] = [];
    for (const id of ids) {
      const rule = input.ruleFor(id, date);
      const expected = rule.works && !off;
      if (expected) anyoneExpected = true;
      const key = `${date}|${id}`;
      const r = recordOf.get(key);
      const came = !!r && r.inMinutes != null;
      if (!expected && !came) continue;
      const expectedMinutes = expected && mins(rule.start) != null && mins(rule.end) != null ? Math.max(0, (mins(rule.end) as number) - (mins(rule.start) as number)) : null;
      const base = { date, userId: id, start: expected ? rule.start : null, end: expected ? rule.end : null, own: rule.own, expectedMinutes, invalid: invalidOf.has(key), extra: !expected && came };
      if (came && r) {
        const lateBy = r.late && rule.lateAfter != null && r.inMinutes != null ? Math.max(0, r.inMinutes - rule.lateAfter) : 0;
        const outState: OutState = r.outMinutes != null ? (r.earlyOut ? 'early' : 'on_time') : isToday ? 'open' : 'missing';
        const earlyBy = r.earlyOut && rule.earlyBefore != null && r.outMinutes != null ? Math.max(0, rule.earlyBefore - r.outMinutes) : 0;
        dayEntries.push({ ...base, status: r.late ? 'late' : 'on_time', in: hhmm(r.inMinutes), out: hhmm(r.outMinutes), lateBy, earlyBy, outState, minutes: r.outMinutes != null ? r.minutes : null, source: r.source, flags: r.flags, needsReview: r.needsReview, distance: r.distance });
      } else {
        dayEntries.push({ ...base, status: isToday ? 'not_in' : 'absent', in: null, out: null, lateBy: 0, earlyBy: 0, outState: null, minutes: null, source: null, flags: [], needsReview: false, distance: null });
      }
    }
    const tracked = date >= trackingFrom;
    if (!anyoneExpected && dayEntries.length === 0) { days.push(day); continue; }
    if (!tracked) {
      // Before tracking started nothing is absent; a stray check-in is still a fact of the day.
      const cameOnly = dayEntries.filter((e) => e.in);
      day.kind = 'untracked';
      entries.push(...cameOnly);
      days.push(day);
      continue;
    }
    day.kind = anyoneExpected || dayEntries.some((e) => e.in) ? 'school' : 'off';
    for (const e of dayEntries) {
      if (e.status === 'on_time') day.onTime += 1;
      else if (e.status === 'late') day.late += 1;
      else if (e.status === 'absent') day.absent += 1;
      else day.notIn += 1;
      if (e.outState === 'early') day.earlyLeave += 1;
      if (e.outState === 'missing') day.noCheckout += 1;
    }
    day.present = day.onTime + day.late;
    // Today: only the people already in are counted (see the rules above).
    day.expected = day.present + day.absent;
    day.rate = pct(day.present, day.expected);
    entries.push(...dayEntries);
    days.push(day);
  }

  // Per person.
  const byPerson = new Map<string, PeriodEntry[]>();
  for (const e of entries) byPerson.set(e.userId, [...(byPerson.get(e.userId) ?? []), e]);
  const persons: PeriodPerson[] = ids.map((id) => {
    const mine = (byPerson.get(id) ?? []).filter((e) => e.date >= trackingFrom);
    const came = mine.filter((e) => e.in);
    const absent = mine.filter((e) => e.status === 'absent');
    const late = came.filter((e) => e.status === 'late');
    const withHours = came.filter((e) => e.minutes != null);
    let run = 0;
    let longest = 0;
    for (const e of mine) {
      if (e.status === 'absent') { run += 1; longest = Math.max(longest, run); } else if (e.status !== 'not_in') run = 0;
    }
    const expectedDays = came.length + absent.length;
    const who = people.get(id)!;
    return {
      userId: id, name: who.name, role: who.role, own: mine.some((e) => e.own),
      expectedDays, present: came.length, onTime: came.length - late.length, late: late.length, absent: absent.length,
      earlyLeave: came.filter((e) => e.outState === 'early').length,
      noCheckout: came.filter((e) => e.outState === 'missing').length,
      extraDays: came.filter((e) => e.extra).length,
      lateMinutes: late.reduce((a, e) => a + e.lateBy, 0),
      minutesWorked: withHours.reduce((a, e) => a + (e.minutes as number), 0),
      daysWithHours: withHours.length,
      expectedMinutes: withHours.reduce((a, e) => a + (e.expectedMinutes ?? 0), 0),
      avgIn: hhmm(avg(came.map((e) => mins(e.in)).filter((m): m is number => m != null))),
      avgOut: hhmm(avg(came.map((e) => mins(e.out)).filter((m): m is number => m != null))),
      rate: pct(came.length, expectedDays),
      punctuality: pct(came.length - late.length, came.length),
      longestAbsence: longest,
    };
  }).sort((a, b) => a.name.localeCompare(b.name));

  const school = days.filter((d) => d.kind === 'school');
  const counted = entries.filter((e) => e.date >= trackingFrom);
  const cameAll = counted.filter((e) => e.in);
  const lateAll = cameAll.filter((e) => e.status === 'late');
  const withHours = cameAll.filter((e) => e.minutes != null);
  const present = school.reduce((a, d) => a + d.present, 0);
  const absent = school.reduce((a, d) => a + d.absent, 0);
  const minutesWorked = withHours.reduce((a, e) => a + (e.minutes as number), 0);
  const kpis: PeriodKpis = {
    staff: ids.length,
    schoolDays: school.length,
    expected: present + absent,
    present,
    onTime: present - lateAll.length,
    late: lateAll.length,
    absent,
    notInToday: school.filter((d) => d.today).reduce((a, d) => a + d.notIn, 0),
    rate: pct(present, present + absent),
    punctuality: pct(present - lateAll.length, present),
    earlyLeave: cameAll.filter((e) => e.outState === 'early').length,
    noCheckout: cameAll.filter((e) => e.outState === 'missing').length,
    avgIn: hhmm(avg(cameAll.map((e) => mins(e.in)).filter((m): m is number => m != null))),
    avgLateMinutes: avg(lateAll.map((e) => e.lateBy).filter((m) => m > 0)),
    minutesWorked,
    avgMinutesPerDay: withHours.length ? Math.round(minutesWorked / withHours.length) : null,
    needsReview: cameAll.filter((e) => e.needsReview).length,
    invalid: counted.filter((e) => e.invalid).length,
    cardCheckIns: cameAll.filter((e) => e.source === 'card').length,
    perfect: persons.filter((p) => p.expectedDays > 0 && p.absent === 0 && p.late === 0).length,
  };

  return { from, to: to > today ? today : to, today, trackingFrom, kpis, days, persons, entries };
}

export type PeriodPreset = 'today' | 'yesterday' | 'week' | 'month' | 'term';

/** The dates a named period covers, on the school's calendar. `term` needs the term's dates. */
export function presetRange(preset: PeriodPreset, today: string, weekStart: string, term: { start: string; end: string } | null): { from: string; to: string } | null {
  if (preset === 'today') return { from: today, to: today };
  if (preset === 'yesterday') return { from: addDays(today, -1), to: addDays(today, -1) };
  if (preset === 'week') return { from: weekStart, to: today };
  if (preset === 'month') return { from: `${today.slice(0, 7)}-01`, to: today };
  if (!term) return null;
  return { from: term.start, to: term.end < today ? term.end : today };
}

/** The same number of days, just before: what "compared with before" means. */
export function previousRange(from: string, to: string): { from: string; to: string } {
  const span = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1;
  return { from: addDays(from, -span), to: addDays(from, -1) };
}
