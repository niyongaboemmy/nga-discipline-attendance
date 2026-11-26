import { addDays, dayOfWeekFor, weekStartFor } from '../../shared/schoolTime.js';

/**
 * Staff attendance report (Tendo -> Staff attendance dashboard): a period seen as
 * calendar days, weeks, weekdays and groups of staff. Pure: the routes load the
 * rows and the roster, this turns them into numbers.
 *
 * Rules shared with the day overview and a person's history:
 *  - a school day is a configured weekday that is not a day off;
 *  - days before the school's first device/card check-in are 'untracked', never absent;
 *  - a check-in an administrator marked invalid does not count;
 *  - today counts the people who are in, and "not in yet" is not an absence.
 */

export type ReportDayKind = 'school' | 'off' | 'untracked' | 'future';

export interface ReportRecord {
  staffId: string;
  name: string;
  date: string;
  /** minutes after midnight on the school clock, null when the stored time is unreadable */
  inMinutes: number | null;
  late: boolean;
}

export interface ReportInput {
  /** the period being reported (inclusive) */
  from: string;
  to: string;
  /** the days to describe for the calendars: covers from..to, may be wider */
  calFrom: string;
  calTo: string;
  today: string;
  trackingFrom: string;
  weekdays: Set<number>;
  offDays: Set<string>;
  roster: Array<{ id: string; name: string }>;
  /** valid check-ins from the previous period's start through calTo */
  records: ReportRecord[];
  lateAfter: number;
  opens: number;
}

export interface ReportDay {
  date: string;
  kind: ReportDayKind;
  onTime: number;
  late: number;
  /** on today: staff who are not in yet */
  absent: number;
  staff: number;
  today: boolean;
}

export interface ReportPerson {
  userId: string;
  name: string;
  schoolDays: number;
  attended: number;
  late: number;
  absent: number;
  rate: number | null;
  punctuality: number | null;
}

export type ReportGroupKey = 'conversation' | 'often_late' | 'rarely_absent' | 'on_time';

export interface ReportGroup {
  key: ReportGroupKey;
  label: string;
  rule: string;
  count: number;
}

const pct = (part: number, whole: number): number | null => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/** How a day counts, before looking at who checked in. */
export function dayKind(date: string, i: Pick<ReportInput, 'today' | 'trackingFrom' | 'weekdays' | 'offDays'>): ReportDayKind {
  if (date > i.today) return 'future';
  if (!i.weekdays.has(dayOfWeekFor(date)) || i.offDays.has(date)) return 'off';
  if (date < i.trackingFrom) return 'untracked';
  return 'school';
}

/** The thresholds behind the staff groups, scaled to the number of school days. */
export function groupRules(schoolDays: number) {
  const n = Math.max(1, schoolDays);
  return {
    conversationAbsent: Math.max(2, Math.ceil(n * 0.1)),
    conversationLate: Math.max(3, Math.ceil(n * 0.2)),
    oftenLate: Math.max(2, Math.ceil(n * 0.15)),
    rarelyAbsent: Math.floor(n * 0.04),
  };
}

const days = (n: number) => `${n} day${n === 1 ? '' : 's'}`;

export function groupTests(schoolDays: number): Array<{ key: ReportGroupKey; label: string; rule: string; test: (p: ReportPerson) => boolean }> {
  const r = groupRules(schoolDays);
  return [
    { key: 'conversation', label: 'Need a conversation', rule: `Absent ${days(r.conversationAbsent)} or more, or late ${days(r.conversationLate)} or more`, test: (p) => p.absent >= r.conversationAbsent || p.late >= r.conversationLate },
    { key: 'often_late', label: 'Often late', rule: `Late on ${days(r.oftenLate)} or more`, test: (p) => p.late >= r.oftenLate },
    { key: 'rarely_absent', label: 'Rarely absent', rule: r.rarelyAbsent === 0 ? 'Never absent in this period' : `Absent ${days(r.rarelyAbsent)} or fewer`, test: (p) => p.schoolDays > 0 && p.absent <= r.rarelyAbsent },
    { key: 'on_time', label: 'On time 90% of days', rule: 'On time at least nine days in ten they came', test: (p) => p.attended > 0 && (p.punctuality ?? 0) >= 90 },
  ];
}

export function buildReport(input: ReportInput) {
  const { from, to, calFrom, calTo, today } = input;

  // Everyone who should be here: the roster, plus anyone who checked in during the period.
  const people = new Map<string, string>();
  for (const p of input.roster) people.set(p.id, p.name);
  for (const r of input.records) if (r.date >= from && r.date <= to && !people.has(r.staffId)) people.set(r.staffId, r.name);
  const staff = people.size;

  const byDate = new Map<string, ReportRecord[]>();
  for (const r of input.records) byDate.set(r.date, [...(byDate.get(r.date) ?? []), r]);

  const describe = (date: string): ReportDay => {
    const kind = dayKind(date, input);
    const recs = kind === 'school' ? (byDate.get(date) ?? []).filter((r) => people.has(r.staffId)) : [];
    const late = recs.filter((r) => r.late).length;
    const onTime = recs.length - late;
    return { date, kind, onTime, late, absent: kind === 'school' ? Math.max(0, staff - recs.length) : 0, staff: kind === 'school' ? staff : 0, today: date === today };
  };

  const calendar: ReportDay[] = [];
  for (let d = calFrom; d <= calTo; d = addDays(d, 1)) calendar.push(describe(d));
  const inPeriod = calendar.filter((d) => d.date >= from && d.date <= to && d.kind === 'school');

  const sum = (list: ReportDay[]) => {
    const t = { schoolDays: list.length, onTime: 0, late: 0, absent: 0, staffDays: 0 };
    for (const d of list) { t.onTime += d.onTime; t.late += d.late; t.absent += d.absent; t.staffDays += d.staff; }
    return { ...t, rate: pct(t.onTime + t.late, t.staffDays) };
  };
  const totals = sum(inPeriod);

  // The same number of weeks, just before: the dashed "previous period" line.
  const weekStarts = [...new Set(inPeriod.map((d) => weekStartFor(d.date)))].sort();
  const firstWeek = weekStartFor(from);
  const shift = (Math.round((Date.parse(weekStartFor(to)) - Date.parse(firstWeek)) / 86_400_000) / 7 + 1) * 7;
  const prevOf = (weekStart: string) => {
    const list: ReportDay[] = [];
    for (let i = 0; i < 7; i++) {
      const d = describe(addDays(weekStart, i - shift));
      if (d.kind === 'school' && d.date < from) list.push(d);
    }
    return list;
  };
  const prevAll: ReportDay[] = [];
  const weeks = weekStarts.map((start) => {
    const list = inPeriod.filter((d) => weekStartFor(d.date) === start);
    const prev = prevOf(start);
    prevAll.push(...prev);
    const s = sum(list);
    return { start, rate: s.rate, late: s.late, prevRate: sum(prev).rate };
  });

  const weekdays = [...input.weekdays].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map((dow) => ({ dow, rate: sum(inPeriod.filter((d) => dayOfWeekFor(d.date) === dow)).rate }));

  // When staff arrive: every check-in of the period, per 15 minutes.
  const ins = input.records.filter((r) => r.date >= from && r.date <= to && r.inMinutes != null && people.has(r.staffId)).map((r) => ({ m: r.inMinutes as number, late: r.late }));
  const arrivals: Array<{ from: string; to: string; onTime: number; late: number }> = [];
  if (ins.length) {
    const floor15 = (m: number) => Math.floor(m / 15) * 15;
    const start = floor15(Math.max(input.opens, Math.min(input.lateAfter - 120, ...ins.map((x) => x.m))));
    const end = Math.max(input.lateAfter + 60, ...ins.map((x) => floor15(x.m) + 15));
    for (let m = start; m < Math.min(end, start + 15 * 24); m += 15) {
      const bucket = ins.filter((x) => x.m >= m && x.m < m + 15);
      arrivals.push({ from: hhmm(m), to: hhmm(m + 15), onTime: bucket.filter((x) => !x.late).length, late: bucket.filter((x) => x.late).length });
    }
  }

  // Per person: absences are counted on school days before today only.
  const counted = inPeriod.filter((d) => !d.today).map((d) => d.date);
  const todayIn = new Set((byDate.get(today) ?? []).map((r) => r.staffId));
  const persons: ReportPerson[] = [...people.entries()].map(([userId, name]) => {
    const mine = input.records.filter((r) => r.staffId === userId && r.date >= from && r.date <= to && dayKind(r.date, input) === 'school');
    const schoolDays = counted.length + (inPeriod.some((d) => d.today) && todayIn.has(userId) ? 1 : 0);
    const attended = mine.length;
    const late = mine.filter((r) => r.late).length;
    return {
      userId, name, schoolDays, attended, late,
      absent: Math.max(0, schoolDays - attended),
      rate: schoolDays ? Math.round((attended / schoolDays) * 100) : null,
      punctuality: attended ? Math.round(((attended - late) / attended) * 100) : null,
    };
  });
  persons.sort((a, b) => b.absent * 2 + b.late - (a.absent * 2 + a.late) || a.name.localeCompare(b.name));

  const tests = groupTests(counted.length);
  const groups: ReportGroup[] = tests.map((g) => ({ key: g.key, label: g.label, rule: g.rule, count: counted.length ? persons.filter(g.test).length : 0 }));

  return {
    today, from, to, trackingFrom: input.trackingFrom, staff, countedDays: counted.length,
    lateAfter: hhmm(input.lateAfter),
    days: calendar,
    totals: { ...totals, prevRate: sum(prevAll).rate },
    weeks,
    weekdays,
    arrivals,
    groups,
    persons,
  };
}

/** The staff of one group, or everyone late or absent in the period when no group is named. */
export function reportStaff(persons: ReportPerson[], schoolDays: number, group?: string): ReportPerson[] {
  const g = groupTests(schoolDays).find((x) => x.key === group);
  if (g) return schoolDays ? persons.filter(g.test) : [];
  return persons.filter((p) => p.late + p.absent > 0);
}
