import type { ReportDay } from '../../api/staffClock';

/**
 * Numbers behind the staff attendance dashboard, kept free of React so they can
 * be tested on their own: sums over a range of days, month calendars (Monday
 * first), the current month as a weeks-by-weekdays grid, and the colour level
 * of a day.
 */

export interface DaySum { schoolDays: number; onTime: number; late: number; absent: number; staffDays: number; rate: number | null }

export const addDays = (date: string, n: number): string => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
/** Monday = 0 ... Sunday = 6. */
export const dowMon = (date: string): number => (new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7;
export const fmtDate = (date: string, opts: Intl.DateTimeFormatOptions = { weekday: 'short', day: 'numeric', month: 'short' }): string =>
  new Date(`${date}T12:00:00Z`).toLocaleDateString('en-GB', { ...opts, timeZone: 'UTC' });

/** Share of staff in on a day (0-100), null when the day has nobody to count. */
export const dayRate = (d: Pick<ReportDay, 'onTime' | 'late' | 'staff'>): number | null => (d.staff > 0 ? ((d.onTime + d.late) / d.staff) * 100 : null);

export function sumDays(days: ReportDay[], from: string, to: string): DaySum {
  const t = { schoolDays: 0, onTime: 0, late: 0, absent: 0, staffDays: 0 };
  for (const d of days) {
    if (d.kind !== 'school' || d.date < from || d.date > to) continue;
    t.schoolDays += 1; t.onTime += d.onTime; t.late += d.late; t.absent += d.absent; t.staffDays += d.staff;
  }
  return { ...t, rate: t.staffDays > 0 ? ((t.onTime + t.late) / t.staffDays) * 100 : null };
}

/** 1 (fewest in) to 4 (most in); 0 when there is nothing to colour. */
export function heatLevel(rate: number | null): 0 | 1 | 2 | 3 | 4 {
  if (rate == null) return 0;
  if (rate >= 95) return 4;
  if (rate >= 90) return 3;
  if (rate >= 80) return 2;
  return 1;
}

export interface MonthBlock { key: string; name: string; sum: DaySum; cells: Array<ReportDay | null> }

/** Whole months as Monday-first cells; null pads the first week. */
export function monthBlocks(days: ReportDay[]): MonthBlock[] {
  const out: MonthBlock[] = [];
  for (const d of days) {
    const key = d.date.slice(0, 7);
    let block = out[out.length - 1];
    if (!block || block.key !== key) {
      block = { key, name: fmtDate(d.date, { month: 'long' }), sum: sumDays([], '', ''), cells: Array.from({ length: dowMon(d.date) }, () => null) };
      out.push(block);
    }
    block.cells.push(d);
  }
  for (const b of out) {
    const list = b.cells.filter((c): c is ReportDay => !!c);
    b.sum = sumDays(list, list[0].date, list[list.length - 1].date);
  }
  return out;
}

export interface WeekColumn { label: string; cells: Array<ReportDay | null> }

/** One month as columns of weeks, each Monday to Sunday (the contribution-grid shape). */
export function monthGrid(days: ReportDay[], month: string): WeekColumn[] {
  const list = days.filter((d) => d.date.startsWith(month));
  if (!list.length) return [];
  const cols: WeekColumn[] = [];
  let col: WeekColumn = { label: '', cells: Array.from({ length: dowMon(list[0].date) }, () => null) };
  for (const d of list) {
    if (dowMon(d.date) === 0 && col.cells.length) { cols.push(col); col = { label: '', cells: [] }; }
    if (dowMon(d.date) === 0) col.label = String(Number(d.date.slice(8)));
    col.cells.push(d);
  }
  while (col.cells.length < 7) col.cells.push(null);
  cols.push(col);
  return cols;
}

/** The lowest and the best finished school day in a list. */
export function lowAndBest(days: ReportDay[]): { low: ReportDay | null; best: ReportDay | null } {
  let low: ReportDay | null = null;
  let best: ReportDay | null = null;
  for (const d of days) {
    if (d.kind !== 'school' || d.today) continue;
    const r = dayRate(d);
    if (r == null) continue;
    if (!low || r < (dayRate(low) as number)) low = d;
    if (!best || r > (dayRate(best) as number)) best = d;
  }
  return { low, best };
}

/** The middle value of clock labels like "07:42" (null when there are none). */
export function medianTime(labels: Array<string | null | undefined>): string | null {
  const mins = labels.filter((l): l is string => !!l && /^\d{2}:\d{2}$/.test(l)).map((l) => Number(l.slice(0, 2)) * 60 + Number(l.slice(3))).sort((a, b) => a - b);
  if (!mins.length) return null;
  const m = mins[Math.floor(mins.length / 2)];
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

export const pct = (rate: number | null, digits = 0): string => (rate == null ? '–' : `${rate.toFixed(digits)}%`);
/** "+2.1 pts" between two rates, null when either is missing. */
export const delta = (now: number | null, before: number | null): { text: string; up: boolean } | null => {
  if (now == null || before == null) return null;
  const d = Math.round((now - before) * 10) / 10;
  return { text: `${d >= 0 ? '+' : '−'}${Math.abs(d)} pts`, up: d >= 0 };
};
