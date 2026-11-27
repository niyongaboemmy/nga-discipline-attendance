import type { ReportsData, ReportsEntry, ReportsKpis, ReportsPerson } from '../../../api/staffClock';

/**
 * The Reports page's documents, cut from one period of facts (ReportsData): what
 * each report is, its columns and rows, and the headline numbers with their change
 * against the period just before. The same tables feed the preview, the PDF and
 * the Excel file, so the three can never disagree.
 *
 * Pure (no React, no fetch): the rules are tested on their own.
 */

export type ReportId = 'summary' | 'daily' | 'register' | 'staff' | 'late' | 'absent' | 'leaving' | 'hours' | 'review';
export type Tone = 'on' | 'late' | 'abs' | 'off';
export type Cell = string | number;

export interface Column {
  key: string;
  label: string;
  align?: 'left' | 'center' | 'right';
  /** Excel column width (characters) and the PDF's share of the page */
  width: number;
  /** this column carries the row's tone (coloured, bold) */
  toned?: boolean;
}

export interface ReportRow { cells: Record<string, Cell>; tone?: Tone }

export interface ReportTable {
  id: ReportId;
  title: string;
  /** the question the report answers */
  question: string;
  /** who usually asks for it */
  usedFor: string;
  columns: Column[];
  rows: ReportRow[];
  /** short facts printed above the table */
  facts: Array<{ label: string; value: string; tone?: Tone }>;
  /** "12 late arrivals" on the card */
  countText: string;
  empty: string;
}

// ---- words ----------------------------------------------------------------------------

const D = (date: string) => new Date(`${date}T12:00:00Z`);
export const dayName = (date: string) => D(date).toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' });
export const shortDate = (date: string) => D(date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
export const longDate = (date: string) => D(date).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

/** "Thursday, 26 November 2026" or "23 Nov 2026 to 26 Nov 2026". */
export function periodLabel(from: string, to: string): string {
  return from === to ? longDate(from) : `${shortDate(from)} to ${shortDate(to)}`;
}

/** "7 h 45", "45 min", "0 min". */
export function duration(min: number | null | undefined): string {
  if (min == null) return '';
  const m = Math.max(0, Math.round(min));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`;
}
export const percent = (n: number | null | undefined) => (n == null ? '' : `${Number.isInteger(n) ? n : n.toFixed(1)}%`);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const FLAG_WORDS: Record<string, string> = {
  weak_location: 'Weak location', phone_location: 'Location from a phone', 'out:manual': 'Check-out entered by the office',
  mock_location: 'Location may be faked', new_device: 'New device', far_jump: 'Moved too far too fast', own_network: 'On the school network',
  outside_zone: 'Outside the area', low_accuracy: 'Imprecise location',
};
export const flagWords = (flag: string): string => {
  const out = flag.startsWith('out:');
  const known = FLAG_WORDS[flag] ?? FLAG_WORDS[flag.replace(/^out:/, '')];
  const words = known ?? flag.replace(/^out:/, '').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
  return out && !FLAG_WORDS[flag] ? `${words} (check-out)` : words;
};
const howOf = (e: ReportsEntry) => (e.source === 'card' ? 'Staff card' : e.source === 'device' ? 'Own device' : e.source ? 'Office' : '');
const statusOf = (e: ReportsEntry): { text: string; tone: Tone } =>
  e.status === 'on_time' ? { text: 'On time', tone: 'on' } : e.status === 'late' ? { text: 'Late', tone: 'late' } : e.status === 'absent' ? { text: 'Absent', tone: 'abs' } : { text: 'Not in yet', tone: 'off' };
const hoursOf = (e: ReportsEntry) => (e.start && e.end ? `${e.start} – ${e.end}` : e.extra ? 'Not expected' : '');

// ---- headline numbers -------------------------------------------------------------------

export interface Kpi {
  id: string;
  label: string;
  value: string;
  /** one line under the number */
  detail: string;
  /** change against the period before, ready to show; null when there is nothing to compare */
  change: { text: string; good: boolean | null } | null;
  /** the report that lists what is behind the number */
  report: ReportId;
  tone?: Tone;
}

const delta = (now: number | null, before: number | null, o: { unit: 'pts' | 'count' | 'min'; lowerIsBetter?: boolean }): Kpi['change'] => {
  if (now == null || before == null) return null;
  const d = Math.round((now - before) * 10) / 10;
  if (d === 0) return { text: 'Same as before', good: null };
  const size = o.unit === 'pts' ? `${Math.abs(d)} pts` : o.unit === 'min' ? duration(Math.abs(d)) : String(Math.abs(d));
  return { text: `${d > 0 ? 'Up' : 'Down'} ${size}`, good: o.lowerIsBetter ? d < 0 : d > 0 };
};

export function kpiList(data: ReportsData): Kpi[] {
  const k = data.kpis;
  const b = data.previous.kpis;
  // Nothing to compare with when the period before had no tracked school day.
  const cmp = b.schoolDays > 0;
  const c = <T,>(v: T) => (cmp ? v : null);
  const single = data.from === data.to;
  return [
    { id: 'rate', label: 'Attendance', value: percent(k.rate) || '–', detail: k.expected ? `${k.present} of ${k.expected} expected ${single ? 'staff came' : 'staff days'}` : 'Nobody was expected', change: delta(k.rate, c(b.rate), { unit: 'pts' }), report: 'daily', tone: 'on' },
    { id: 'punctuality', label: 'On time', value: percent(k.punctuality) || '–', detail: k.present ? `${k.onTime} of ${k.present} arrivals by ${data.rules.lateAfter}` : 'No arrivals', change: delta(k.punctuality, c(b.punctuality), { unit: 'pts' }), report: 'staff', tone: 'on' },
    { id: 'late', label: 'Late arrivals', value: String(k.late), detail: k.avgLateMinutes != null ? `${duration(k.avgLateMinutes)} late on average` : 'Nobody was late', change: delta(k.late, c(b.late), { unit: 'count', lowerIsBetter: true }), report: 'late', tone: 'late' },
    { id: 'absent', label: 'Absences', value: String(k.absent), detail: k.notInToday ? `${plural(k.notInToday, 'person', 'people')} not in yet today (not counted)` : k.absent ? `across ${plural(k.schoolDays, 'school day')}` : 'Nobody was absent', change: delta(k.absent, c(b.absent), { unit: 'count', lowerIsBetter: true }), report: 'absent', tone: 'abs' },
    { id: 'early', label: 'Left early', value: String(k.earlyLeave), detail: `before ${data.rules.earlyLeaveBefore} or their own end`, change: delta(k.earlyLeave, c(b.earlyLeave), { unit: 'count', lowerIsBetter: true }), report: 'leaving', tone: 'late' },
    { id: 'noout', label: 'No check-out', value: String(k.noCheckout), detail: 'came, never checked out', change: delta(k.noCheckout, c(b.noCheckout), { unit: 'count', lowerIsBetter: true }), report: 'leaving', tone: 'late' },
    { id: 'arrival', label: 'Average arrival', value: k.avgIn ?? '–', detail: `late after ${data.rules.lateAfter}`, change: null, report: 'register' },
    { id: 'hours', label: 'Time at school', value: k.avgMinutesPerDay != null ? duration(k.avgMinutesPerDay) : '–', detail: k.minutesWorked ? `a day on average · ${duration(k.minutesWorked)} in all` : 'needs a check-in and a check-out', change: delta(k.avgMinutesPerDay, c(b.avgMinutesPerDay), { unit: 'min' }), report: 'hours' },
    { id: 'review', label: 'To review', value: String(k.needsReview), detail: k.invalid ? `${plural(k.invalid, 'check-in')} marked invalid` : 'unusual check-ins waiting', change: null, report: 'review', tone: k.needsReview ? 'late' : undefined },
    { id: 'perfect', label: 'Full attendance', value: String(k.perfect), detail: `of ${k.staff} staff: never absent, never late`, change: delta(k.perfect, c(b.perfect), { unit: 'count' }), report: 'staff', tone: 'on' },
  ];
}

// ---- the reports ------------------------------------------------------------------------

const col = (key: string, label: string, width: number, align?: Column['align'], toned?: boolean): Column => ({ key, label, width, align, toned });

function summaryTable(data: ReportsData): ReportTable {
  const now = kpiList(data);
  const k = data.kpis;
  const rows: ReportRow[] = [
    { cells: { measure: 'Staff', value: String(k.staff), detail: 'on the staff list or checked in', change: '' } },
    { cells: { measure: 'School days', value: String(k.schoolDays), detail: 'days somebody was expected', change: '' } },
    ...now.map((x) => ({ cells: { measure: x.label, value: x.value, detail: x.detail, change: x.change?.text ?? '' }, tone: x.tone })),
    { cells: { measure: 'Staff card check-ins', value: String(k.cardCheckIns), detail: 'scanned for staff without a phone', change: '' } },
  ];
  return {
    id: 'summary', title: 'Attendance summary', question: 'How was staff attendance in this period?', usedFor: 'Head teacher, board and term reports',
    columns: [col('measure', 'Measure', 26), col('value', 'Value', 14, 'right', true), col('detail', 'What it means', 46), col('change', 'Against the period before', 26)],
    rows, facts: [], countText: `${now.length + 3} headline numbers`, empty: 'No numbers for this period.',
  };
}

function dailyTable(data: ReportsData): ReportTable {
  const days = data.days.filter((d) => d.kind === 'school');
  const best = days.filter((d) => d.rate != null).sort((a, b) => (b.rate as number) - (a.rate as number))[0];
  const worst = days.filter((d) => d.rate != null).sort((a, b) => (a.rate as number) - (b.rate as number))[0];
  return {
    id: 'daily', title: 'Day by day', question: 'Which days were good, and which were not?', usedFor: 'Spotting weak days and trends',
    columns: [col('date', 'Date', 14), col('day', 'Day', 8), col('expected', 'Expected', 11, 'right'), col('present', 'Came', 9, 'right'), col('onTime', 'On time', 10, 'right'), col('late', 'Late', 8, 'right'), col('absent', 'Absent', 9, 'right'), col('early', 'Left early', 11, 'right'), col('noOut', 'No check-out', 13, 'right'), col('rate', 'Attendance', 12, 'right', true)],
    rows: days.map((d) => ({
      cells: { date: shortDate(d.date), day: dayName(d.date), expected: d.expected + (d.today ? d.notIn : 0), present: d.present, onTime: d.onTime, late: d.late, absent: d.today ? `${d.notIn} not in yet` : d.absent, early: d.earlyLeave, noOut: d.noCheckout, rate: percent(d.rate) || '–' },
      tone: d.rate == null ? 'off' : d.rate >= 90 ? 'on' : d.rate >= 75 ? 'late' : 'abs',
    })),
    facts: [
      { label: 'School days', value: String(days.length) },
      ...(best && days.length > 1 ? [{ label: 'Best day', value: `${dayName(best.date)} ${shortDate(best.date)} · ${percent(best.rate)}`, tone: 'on' as Tone }] : []),
      ...(worst && days.length > 1 && worst !== best ? [{ label: 'Weakest day', value: `${dayName(worst.date)} ${shortDate(worst.date)} · ${percent(worst.rate)}`, tone: 'abs' as Tone }] : []),
    ],
    countText: plural(days.length, 'school day'), empty: 'No school day in this period.',
  };
}

const nameOf = (data: ReportsData) => {
  const m = new Map(data.persons.map((p) => [p.userId, p] as const));
  return (id: string): ReportsPerson | undefined => m.get(id);
};
const byDateThenName = (who: (id: string) => ReportsPerson | undefined) => (a: ReportsEntry, b: ReportsEntry) => a.date.localeCompare(b.date) || (who(a.userId)?.name ?? '').localeCompare(who(b.userId)?.name ?? '');

function registerTable(data: ReportsData): ReportTable {
  const who = nameOf(data);
  const list = [...data.entries].sort(byDateThenName(who));
  return {
    id: 'register', title: 'Daily register', question: 'Who came, when, and when did they leave?', usedFor: 'The full record: payroll checks, disputes, audits',
    columns: [col('date', 'Date', 14), col('name', 'Staff', 30), col('role', 'Role', 14), col('hours', 'Expected', 15), col('in', 'In', 8, 'center'), col('out', 'Out', 8, 'center'), col('status', 'Status', 12, undefined, true), col('lateBy', 'Late by', 10, 'right'), col('time', 'At school', 11, 'right'), col('how', 'How', 12), col('notes', 'Notes', 30)],
    rows: list.map((e) => {
      const st = statusOf(e);
      const notes = [
        e.extra ? 'Came on a day off' : '', e.outState === 'early' ? `Left ${duration(e.earlyBy)} early` : '', e.outState === 'missing' ? 'No check-out' : '',
        e.invalid ? 'Check-in marked invalid' : '', e.needsReview ? 'Waiting for review' : '', ...e.flags.filter((f) => f !== 'own_network').map(flagWords),
      ].filter(Boolean);
      return { cells: { date: shortDate(e.date), name: who(e.userId)?.name ?? 'Staff member', role: who(e.userId)?.role ?? '', hours: hoursOf(e), in: e.in ?? '', out: e.out ?? '', status: st.text, lateBy: e.lateBy ? duration(e.lateBy) : '', time: duration(e.minutes), how: howOf(e), notes: [...new Set(notes)].join(' · ') }, tone: st.tone };
    }),
    facts: [{ label: 'Lines', value: String(list.length) }, { label: 'Came', value: String(data.kpis.present), tone: 'on' }, { label: 'Late', value: String(data.kpis.late), tone: 'late' }, { label: 'Absent', value: String(data.kpis.absent), tone: 'abs' }],
    countText: plural(list.length, 'line'), empty: 'Nobody was expected in this period.',
  };
}

function staffTable(data: ReportsData): ReportTable {
  const list = data.persons.filter((p) => p.expectedDays > 0 || p.present > 0);
  return {
    id: 'staff', title: 'Staff summary', question: 'How did each person do?', usedFor: 'Appraisals, one-to-one conversations',
    columns: [col('name', 'Staff', 30), col('role', 'Role', 14), col('days', 'Days expected', 13, 'right'), col('present', 'Came', 8, 'right'), col('onTime', 'On time', 9, 'right'), col('late', 'Late', 7, 'right'), col('absent', 'Absent', 8, 'right'), col('early', 'Left early', 10, 'right'), col('noOut', 'No check-out', 12, 'right'), col('rate', 'Attendance', 11, 'right', true), col('punct', 'On time %', 10, 'right'), col('avgIn', 'Avg arrival', 11, 'center'), col('time', 'At school', 11, 'right')],
    rows: [...list].sort((a, b) => (a.rate ?? 101) - (b.rate ?? 101) || b.late - a.late || a.name.localeCompare(b.name)).map((p) => ({
      cells: { name: p.name, role: p.role ?? '', days: p.expectedDays, present: p.present, onTime: p.onTime, late: p.late, absent: p.absent, early: p.earlyLeave, noOut: p.noCheckout, rate: percent(p.rate) || '–', punct: percent(p.punctuality) || '–', avgIn: p.avgIn ?? '', time: duration(p.minutesWorked) },
      tone: p.rate == null ? 'off' : p.rate >= 90 ? 'on' : p.rate >= 75 ? 'late' : 'abs',
    })),
    facts: [
      { label: 'Staff', value: String(list.length) },
      { label: 'Full attendance', value: String(data.kpis.perfect), tone: 'on' },
      { label: 'Below 75%', value: String(list.filter((p) => p.rate != null && p.rate < 75).length), tone: 'abs' },
    ],
    countText: plural(list.length, 'person', 'people'), empty: 'No staff were expected in this period.',
  };
}

function lateTable(data: ReportsData): ReportTable {
  const who = nameOf(data);
  const list = data.entries.filter((e) => e.status === 'late').sort(byDateThenName(who));
  const repeat = data.persons.filter((p) => p.late >= 2).sort((a, b) => b.late - a.late);
  const total = list.reduce((a, e) => a + e.lateBy, 0);
  return {
    id: 'late', title: 'Late arrivals', question: 'Who arrived late, on which day, by how much?', usedFor: 'Punctuality follow-up',
    columns: [col('date', 'Date', 14), col('day', 'Day', 8), col('name', 'Staff', 30), col('role', 'Role', 14), col('due', 'Expected by', 12, 'center'), col('in', 'Arrived', 10, 'center'), col('lateBy', 'Late by', 11, 'right', true), col('times', 'Times late in the period', 22, 'right')],
    rows: list.map((e) => ({ cells: { date: shortDate(e.date), day: dayName(e.date), name: who(e.userId)?.name ?? 'Staff member', role: who(e.userId)?.role ?? '', due: e.start ?? data.rules.lateAfter, in: e.in ?? '', lateBy: e.lateBy ? duration(e.lateBy) : 'Late', times: who(e.userId)?.late ?? 1 }, tone: 'late' as Tone })),
    facts: [
      { label: 'Late arrivals', value: String(list.length), tone: 'late' },
      { label: 'People', value: String(new Set(list.map((e) => e.userId)).size) },
      { label: 'Time lost', value: duration(total) || '0 min' },
      ...(repeat[0] ? [{ label: 'Most often', value: `${repeat[0].name} · ${repeat[0].late} times`, tone: 'late' as Tone }] : []),
    ],
    countText: plural(list.length, 'late arrival'), empty: 'Nobody arrived late in this period.',
  };
}

function absentTable(data: ReportsData): ReportTable {
  const who = nameOf(data);
  const list = data.entries.filter((e) => e.status === 'absent').sort(byDateThenName(who));
  const runs = data.persons.filter((p) => p.longestAbsence >= 2).sort((a, b) => b.longestAbsence - a.longestAbsence);
  return {
    id: 'absent', title: 'Absences', question: 'Who did not come, and on which days?', usedFor: 'Absence follow-up, leave records',
    columns: [col('date', 'Date', 14), col('day', 'Day', 8), col('name', 'Staff', 30), col('role', 'Role', 14), col('hours', 'Expected hours', 16), col('times', 'Days absent in the period', 22, 'right', true), col('run', 'Longest run', 12, 'right'), col('note', 'Note', 28)],
    rows: list.map((e) => {
      const p = who(e.userId);
      return { cells: { date: shortDate(e.date), day: dayName(e.date), name: p?.name ?? 'Staff member', role: p?.role ?? '', hours: hoursOf(e), times: p?.absent ?? 1, run: p && p.longestAbsence >= 2 ? `${p.longestAbsence} days` : '', note: e.invalid ? 'Checked in, marked invalid by the office' : '' }, tone: 'abs' as Tone };
    }),
    facts: [
      { label: 'Absences', value: String(list.length), tone: 'abs' },
      { label: 'People', value: String(new Set(list.map((e) => e.userId)).size) },
      ...(runs[0] ? [{ label: 'Longest run', value: `${runs[0].name} · ${runs[0].longestAbsence} days in a row`, tone: 'abs' as Tone }] : []),
      ...(data.kpis.notInToday ? [{ label: 'Not in yet today', value: `${data.kpis.notInToday} (not counted)` }] : []),
    ],
    countText: plural(list.length, 'absence'), empty: 'Nobody was absent in this period.',
  };
}

function leavingTable(data: ReportsData): ReportTable {
  const who = nameOf(data);
  const list = data.entries.filter((e) => e.outState === 'early' || e.outState === 'missing').sort(byDateThenName(who));
  return {
    id: 'leaving', title: 'Early leaving and missing check-outs', question: 'Who left early, and who never checked out?', usedFor: 'End-of-day follow-up, fixing incomplete days',
    columns: [col('date', 'Date', 14), col('day', 'Day', 8), col('name', 'Staff', 30), col('role', 'Role', 14), col('what', 'What happened', 16, undefined, true), col('until', 'Expected until', 14, 'center'), col('in', 'In', 8, 'center'), col('out', 'Left at', 9, 'center'), col('early', 'Early by', 10, 'right')],
    rows: list.map((e) => ({ cells: { date: shortDate(e.date), day: dayName(e.date), name: who(e.userId)?.name ?? 'Staff member', role: who(e.userId)?.role ?? '', what: e.outState === 'early' ? 'Left early' : 'No check-out', until: e.end ?? data.rules.earlyLeaveBefore, in: e.in ?? '', out: e.out ?? '', early: e.earlyBy ? duration(e.earlyBy) : '' }, tone: (e.outState === 'early' ? 'late' : 'off') as Tone })),
    facts: [{ label: 'Left early', value: String(data.kpis.earlyLeave), tone: 'late' }, { label: 'No check-out', value: String(data.kpis.noCheckout) }, { label: 'People', value: String(new Set(list.map((e) => e.userId)).size) }],
    countText: plural(list.length, 'day'), empty: 'Everybody checked out on time in this period.',
  };
}

function hoursTable(data: ReportsData): ReportTable {
  const list = data.persons.filter((p) => p.present > 0);
  return {
    id: 'hours', title: 'Time at school', question: 'How long was each person at school?', usedFor: 'Workload, payroll support, own-hours staff',
    columns: [col('name', 'Staff', 30), col('role', 'Role', 14), col('days', 'Days with both times', 18, 'right'), col('time', 'At school', 12, 'right', true), col('expected', 'Expected', 12, 'right'), col('diff', 'Difference', 12, 'right'), col('perDay', 'Average a day', 13, 'right'), col('avgIn', 'Avg arrival', 11, 'center'), col('avgOut', 'Avg leaving', 11, 'center'), col('noOut', 'Days not counted', 16, 'right')],
    rows: [...list].sort((a, b) => b.minutesWorked - a.minutesWorked || a.name.localeCompare(b.name)).map((p) => {
      const diff = p.minutesWorked - p.expectedMinutes;
      return {
        cells: { name: p.name, role: p.role ?? '', days: p.daysWithHours, time: duration(p.minutesWorked) || '0 min', expected: p.daysWithHours ? duration(p.expectedMinutes) : '', diff: !p.daysWithHours || !p.expectedMinutes ? '' : diff === 0 ? 'Exact' : `${diff > 0 ? '+' : '−'}${duration(Math.abs(diff))}`, perDay: p.daysWithHours ? duration(p.minutesWorked / p.daysWithHours) : '', avgIn: p.avgIn ?? '', avgOut: p.avgOut ?? '', noOut: p.present - p.daysWithHours },
        tone: (!p.daysWithHours ? 'off' : diff < -30 * p.daysWithHours ? 'late' : 'on') as Tone,
      };
    }),
    facts: [
      { label: 'Time at school', value: duration(data.kpis.minutesWorked) || '0 min' },
      { label: 'Average a day', value: data.kpis.avgMinutesPerDay != null ? duration(data.kpis.avgMinutesPerDay) : '–' },
      { label: 'Days without a check-out', value: String(data.kpis.noCheckout) },
    ],
    countText: plural(list.length, 'person', 'people'), empty: 'Nobody checked in during this period.',
  };
}

function reviewTable(data: ReportsData): ReportTable {
  const who = nameOf(data);
  const list = data.entries.filter((e) => e.needsReview || e.invalid || e.source === 'card' || e.extra || e.flags.some((f) => f !== 'own_network')).sort(byDateThenName(who));
  return {
    id: 'review', title: 'Check-ins to look at', question: 'Which check-ins were unusual or handled by the office?', usedFor: 'Integrity checks: weak location, staff cards, manual entries',
    columns: [col('date', 'Date', 14), col('name', 'Staff', 30), col('in', 'In', 8, 'center'), col('out', 'Out', 8, 'center'), col('how', 'How', 12), col('distance', 'Distance', 10, 'right'), col('why', 'Why it is listed', 40), col('state', 'State', 16, undefined, true)],
    rows: list.map((e) => {
      const why = [e.source === 'card' ? 'Checked in with a staff card' : '', e.extra ? 'Came on a day off' : '', ...e.flags.filter((f) => f !== 'own_network').map(flagWords)].filter(Boolean);
      return { cells: { date: shortDate(e.date), name: who(e.userId)?.name ?? 'Staff member', in: e.in ?? '', out: e.out ?? '', how: howOf(e), distance: e.distance != null ? `${e.distance} m` : '', why: [...new Set(why)].join(' · '), state: e.invalid ? 'Marked invalid' : e.needsReview ? 'Waiting for review' : 'Accepted' }, tone: (e.invalid ? 'abs' : e.needsReview ? 'late' : 'on') as Tone };
    }),
    facts: [{ label: 'Waiting for review', value: String(data.kpis.needsReview), tone: 'late' }, { label: 'Marked invalid', value: String(data.kpis.invalid), tone: 'abs' }, { label: 'Staff card check-ins', value: String(data.kpis.cardCheckIns) }],
    countText: plural(list.length, 'check-in'), empty: 'Nothing unusual in this period.',
  };
}

const BUILDERS: Record<ReportId, (d: ReportsData) => ReportTable> = { summary: summaryTable, daily: dailyTable, register: registerTable, staff: staffTable, late: lateTable, absent: absentTable, leaving: leavingTable, hours: hoursTable, review: reviewTable };
export const REPORT_ORDER: ReportId[] = ['summary', 'register', 'staff', 'daily', 'late', 'absent', 'leaving', 'hours', 'review'];

export const buildReportTable = (data: ReportsData, id: ReportId): ReportTable => BUILDERS[id](data);
export const buildAllReports = (data: ReportsData): ReportTable[] => REPORT_ORDER.map((id) => BUILDERS[id](data));

/** "staff-attendance-late-2026-11-23-to-2026-11-26" */
export const fileStem = (id: ReportId | 'all', from: string, to: string) => `staff-attendance-${id}-${from}${to !== from ? `-to-${to}` : ''}`;

/** Rows whose text contains every word typed. */
export function searchRows(table: ReportTable, query: string): ReportRow[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return table.rows;
  return table.rows.filter((r) => {
    const text = Object.values(r.cells).join(' ').toLowerCase();
    return words.every((w) => text.includes(w));
  });
}

export type { ReportsKpis };
