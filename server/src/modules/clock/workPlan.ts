import type { Database } from 'sqlite';
import { dayOfWeekFor, safeClockLabel, timeToMinutes } from '../../shared/schoolTime.js';
import { schoolDays, schoolSetting, staffLateCutoffMinutes } from '../../tenancy/settings.js';

/**
 * A person's own working week. Most staff follow the school's rules (working
 * days, "late after", "early leave before"); a part-time teacher, a guard or a
 * cook may not. A plan says, per weekday, whether the person works and between
 * which times. No plan = the school's rules.
 *
 * Plans are dated: a version applies from its `effective_from` day until the
 * next version, so changing someone's hours never rewrites how earlier days
 * were counted. A version with no days means "back to the school's rules".
 *
 * Every place that asks "was this person expected?" or "is this late?" goes
 * through PlanBook: the tap, the person's page, the day overview, the period
 * report and a person's history.
 */

export interface DayPlan {
  works: boolean;
  /** HH:MM. Checking in after this is late. */
  start: string;
  /** HH:MM. Checking out before this is early. */
  end: string;
}

/** Keys '0'..'6' (0 = Sunday, like dayOfWeekFor). */
export type WeekPlan = Record<string, DayPlan>;

export interface PlanVersion {
  userId: string;
  effectiveFrom: string;
  days: WeekPlan | null;
  note: string | null;
  updatedBy: string | null;
  updatedByName: string | null;
  updatedAt: string;
}

export interface SchoolHours {
  weekdays: Set<number>;
  /** minutes after midnight */
  lateAfter: number;
  earlyBefore: number;
}

export interface DayRule {
  /** the person is expected this weekday (holidays are the caller's business) */
  works: boolean;
  /** minutes after midnight; null = no "late" on this day (an own-plan day off) */
  lateAfter: number | null;
  earlyBefore: number | null;
  start: string | null;
  end: string | null;
  /** from the person's own plan, not the school's rules */
  own: boolean;
}

export const DOWS = ['0', '1', '2', '3', '4', '5', '6'] as const;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

export function schoolHours(): SchoolHours {
  return {
    weekdays: schoolDays(),
    lateAfter: staffLateCutoffMinutes(),
    earlyBefore: timeToMinutes(schoolSetting('STAFF_EARLY_LEAVE_BEFORE')),
  };
}

/** The school's rules written as a week, the starting point of every own plan. */
export function schoolWeek(s: SchoolHours): WeekPlan {
  const out: WeekPlan = {};
  for (const d of DOWS) out[d] = { works: s.weekdays.has(Number(d)), start: hhmm(s.lateAfter), end: hhmm(s.earlyBefore) };
  return out;
}

/** A clean week from untrusted input, or the reason it cannot be saved. */
export function parseWeekPlan(raw: unknown): { days: WeekPlan } | { error: string } {
  if (!raw || typeof raw !== 'object') return { error: 'Send the seven days of the week.' };
  const names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const days: WeekPlan = {};
  for (const d of DOWS) {
    const v = (raw as any)[d];
    if (!v || typeof v !== 'object') return { error: `${names[Number(d)]} is missing.` };
    const works = v.works === true;
    const start = String(v.start ?? '');
    const end = String(v.end ?? '');
    if (works) {
      if (!TIME_RE.test(start) || !TIME_RE.test(end)) return { error: `${names[Number(d)]}: use times like 08:30.` };
      if (timeToMinutes(end) <= timeToMinutes(start)) return { error: `${names[Number(d)]}: the end must be after the start.` };
    }
    days[d] = { works, start: TIME_RE.test(start) ? start : '08:00', end: TIME_RE.test(end) ? end : '17:00' };
  }
  return { days };
}

export const sameWeek = (a: WeekPlan, b: WeekPlan): boolean =>
  DOWS.every((d) => a[d].works === b[d].works && (!a[d].works || (a[d].start === b[d].start && a[d].end === b[d].end)));

export class PlanBook {
  constructor(public readonly school: SchoolHours, private readonly versions: Map<string, PlanVersion[]>) {}

  /** The version in force for a person on a day (null: the school's rules). */
  versionFor(userId: string, date: string): PlanVersion | null {
    const list = this.versions.get(String(userId));
    if (!list) return null;
    let hit: PlanVersion | null = null;
    for (const v of list) {
      if (v.effectiveFrom <= date) hit = v;
      else break;
    }
    return hit && hit.days ? hit : null;
  }

  /** A version saved for a later day (shown as "changes on ..."). */
  upcoming(userId: string, date: string): PlanVersion | null {
    return (this.versions.get(String(userId)) ?? []).find((v) => v.effectiveFrom > date) ?? null;
  }

  history(userId: string): PlanVersion[] {
    return [...(this.versions.get(String(userId)) ?? [])];
  }

  hasOwn(userId: string, date: string): boolean {
    return !!this.versionFor(userId, date);
  }

  weekFor(userId: string, date: string): WeekPlan {
    return this.versionFor(userId, date)?.days ?? schoolWeek(this.school);
  }

  dayFor(userId: string, date: string): DayRule {
    const dow = dayOfWeekFor(date);
    const v = this.versionFor(userId, date);
    if (!v) {
      const s = this.school;
      // The school's rules: its times apply every day, as they always did.
      return { works: s.weekdays.has(dow), lateAfter: s.lateAfter, earlyBefore: s.earlyBefore, start: hhmm(s.lateAfter), end: hhmm(s.earlyBefore), own: false };
    }
    const d = v.days![String(dow)];
    if (!d || !d.works) return { works: false, lateAfter: null, earlyBefore: null, start: null, end: null, own: true };
    return { works: true, lateAfter: timeToMinutes(d.start), earlyBefore: timeToMinutes(d.end), start: d.start, end: d.end, own: true };
  }

  /** How many of these people follow their own plan on a day. */
  ownCount(userIds: Iterable<string>, date: string): number {
    let n = 0;
    for (const id of userIds) if (this.hasOwn(id, date)) n += 1;
    return n;
  }
}

function rowToVersion(r: any): PlanVersion {
  let days: WeekPlan | null = null;
  try {
    const parsed = r.days ? parseWeekPlan(JSON.parse(r.days)) : null;
    days = parsed && 'days' in parsed ? parsed.days : null;
  } catch {
    days = null;
  }
  return {
    userId: String(r.user_id), effectiveFrom: String(r.effective_from), days, note: r.note ?? null,
    updatedBy: r.updated_by ?? null, updatedByName: r.updated_by_name ?? null, updatedAt: String(r.updated_at),
  };
}

/** Every plan (or one person's), ready to answer per person and day. */
export async function loadPlanBook(db: Database, userId?: string): Promise<PlanBook> {
  let rows: any[] = [];
  try {
    rows = userId
      ? await db.all(`SELECT * FROM staff_work_plans WHERE user_id = ? ORDER BY effective_from`, String(userId))
      : await db.all(`SELECT * FROM staff_work_plans ORDER BY user_id, effective_from`);
  } catch {
    rows = []; // a file opened before the table existed: everyone follows the school's rules
  }
  const map = new Map<string, PlanVersion[]>();
  for (const r of rows) {
    const v = rowToVersion(r);
    map.set(v.userId, [...(map.get(v.userId) ?? []), v]);
  }
  return new PlanBook(schoolHours(), map);
}

/**
 * Save a person's week from a day on (days = null: the school's rules again).
 * The save replaces whatever was planned from that day, then the check-ins
 * already recorded from that day are judged again against the new hours.
 */
export async function savePlan(
  db: Database,
  input: { userId: string; effectiveFrom: string; days: WeekPlan | null; note?: string | null; by: { id: string; name: string }; nowIso: string }
): Promise<{ rejudged: number }> {
  const userId = String(input.userId);
  await db.run(`DELETE FROM staff_work_plans WHERE user_id = ? AND effective_from >= ?`, userId, input.effectiveFrom);
  const earlier = await db.get<{ days: string | null }>(
    `SELECT days FROM staff_work_plans WHERE user_id = ? ORDER BY effective_from DESC LIMIT 1`, userId
  );
  // "School's rules" on top of the school's rules needs no row.
  if (input.days || earlier?.days) {
    await db.run(
      `INSERT INTO staff_work_plans (user_id, effective_from, days, note, updated_by, updated_by_name, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      userId, input.effectiveFrom, input.days ? JSON.stringify(input.days) : null, input.note?.trim() || null, input.by.id, input.by.name, input.nowIso
    );
  }
  return { rejudged: await rejudge(db, userId, input.effectiveFrom) };
}

/** Late / on time and early / on time again for a person's recorded days from a day on. */
export async function rejudge(db: Database, userId: string, from: string): Promise<number> {
  const book = await loadPlanBook(db, userId);
  const rows = await db.all<any[]>(
    `SELECT id, date, clock_in, clock_out, status, out_status FROM staff_attendance WHERE staff_id = ? AND date >= ? AND clock_in IS NOT NULL`, userId, from
  );
  let changed = 0;
  for (const r of rows) {
    const rule = book.dayFor(userId, String(r.date));
    const inLabel = safeClockLabel(r.clock_in);
    const outLabel = safeClockLabel(r.clock_out);
    let status = r.status;
    let outStatus = r.out_status;
    if (inLabel && (r.status === 'late' || r.status === 'present')) {
      status = rule.lateAfter != null && timeToMinutes(inLabel) > rule.lateAfter ? 'late' : 'present';
    }
    if (outLabel && (r.out_status === 'early' || r.out_status === 'on_time')) {
      outStatus = rule.earlyBefore != null && timeToMinutes(outLabel) < rule.earlyBefore ? 'early' : 'on_time';
    }
    if (status !== r.status || outStatus !== r.out_status) {
      await db.run(`UPDATE staff_attendance SET status = ?, out_status = ? WHERE id = ?`, status, outStatus, r.id);
      changed += 1;
    }
  }
  return changed;
}

/** When check-in opens for a person: the school's time, or an hour before an earlier own start. */
export function opensFor(schoolOpens: string, rule: DayRule): string {
  if (!rule.own || rule.lateAfter == null) return schoolOpens;
  return hhmm(Math.max(0, Math.min(timeToMinutes(schoolOpens), rule.lateAfter - 60)));
}

/** The shortest stay before check-out: the school's, never more than half of an own short day. */
export function minShiftFor(schoolMinutes: number, rule: DayRule): number {
  if (!rule.own || rule.lateAfter == null || rule.earlyBefore == null) return schoolMinutes;
  return Math.max(0, Math.min(schoolMinutes, Math.floor((rule.earlyBefore - rule.lateAfter) / 2)));
}
