import type { Overview, OverviewRow } from '../../api/staffClock';

/**
 * The Gate view's numbers and lists, worked out from the day's overview: who is
 * still expected (people already late first, then the nearest start), who walked
 * in (newest first), and the check-ins that wait for a yes. "Leaving" is the same
 * picture for the end of the day: who is still inside, who left.
 *
 * Pure (no React, no fetch), so the rules can be tested on their own.
 */

export type GateMode = 'in' | 'out';
/** late: past their time · soon: within SOON_MIN minutes · later: after that */
export type GateKind = 'late' | 'soon' | 'later';

export const SOON_MIN = 30;

export interface GateWaiting {
  userId: string; name: string; role: string; kind: GateKind;
  /** their hours today, "07:30 – 16:00" */
  hours: string; own: boolean;
  /** minutes past (late) or minutes to go (soon, later) */
  minutes: number;
  /** "24 min late", "in 6 min", "at 09:00" */
  status: string;
  /** their phone gets reminders, and a reminder makes sense now */
  canRemind: boolean;
  reminders: boolean;
}

export interface GateEvent {
  userId: string; name: string; role: string; at: string; card: boolean;
  /** late (arriving) or left early (leaving) */
  warn: boolean;
  /** "On time", "8 min late", "Left early" */
  tag: string;
  /** minutes since it happened (0 = this minute) */
  ago: number;
  needsReview: boolean;
}

/** Not expected today: their own day off, or the school is closed. */
export interface GateOff { userId: string; name: string; role: string; note: string }

export interface GateCheck { recordId: number; userId: string; name: string; at: string | null; reason: string }

export interface GateModel {
  mode: GateMode;
  /** the ring: `done` of `total` (arrived of expected; left of checked in) */
  done: number; total: number;
  waiting: GateWaiting[];
  counts: Record<GateKind, number>;
  events: GateEvent[];
  checks: GateCheck[];
  /** the next start (or end) still ahead: time, people on it, minutes to go */
  next: { at: string; people: number; minutes: number } | null;
  onTime: number; lateArrived: number; dayOff: number;
  /** the people behind the day-off number, by name */
  off: GateOff[];
  /** the people a "remind all" reaches */
  remindIds: string[];
  /** still waiting, with reminders off on their phone */
  noReminders: number;
}

export const toMin = (t: string | null | undefined): number | null => (t && /^\d\d:\d\d/.test(t) ? Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5)) : null);
export const hhmm = (m: number) => `${String(Math.floor((((m % 1440) + 1440) % 1440) / 60)).padStart(2, '0')}:${String((((m % 1440) + 1440) % 1440) % 60).padStart(2, '0')}`;

/** "24 min", "1 h 05". */
export function span(min: number): string {
  const m = Math.max(0, Math.round(min));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`;
}

const hoursOf = (r: OverviewRow) => (r.plan?.start && r.plan.end ? `${r.plan.start} – ${r.plan.end}` : '');
const counted = (r: OverviewRow) => r.status !== 'invalid';

export function gateModel(ov: Overview, nowMin: number, mode: GateMode): GateModel {
  const rows = ov.rows;
  const checks: GateCheck[] = ov.review.map((v) => ({ recordId: v.recordId, userId: v.userId, name: v.name, at: v.at, reason: v.flagText[0] ?? 'Unusual check-in' }));
  const off: GateOff[] = rows.filter((r) => r.status === 'day_off')
    .map((r) => ({ userId: r.userId, name: r.name, role: r.role, note: ov.holiday ? 'School closed today' : r.plan?.own ? 'Own hours: day off' : 'Day off' }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const dayOff = off.length;
  const arrived = rows.filter((r) => r.checkIn && counted(r));
  const lateArrived = arrived.filter((r) => r.status === 'late').length;
  const base = { mode, checks, dayOff, off, onTime: arrived.length - lateArrived, lateArrived };

  const waitingOf = (list: OverviewRow[], pointOf: (r: OverviewRow) => number | null, words: { late: (m: number) => string; soon: (m: number) => string; later: (t: string) => string }, remindable: (r: OverviewRow, kind: GateKind) => boolean): GateWaiting[] =>
    list.map((r) => {
      const point = pointOf(r) ?? nowMin;
      const diff = point - nowMin;
      const kind: GateKind = diff <= 0 ? 'late' : diff <= SOON_MIN ? 'soon' : 'later';
      const minutes = Math.abs(diff);
      return {
        userId: r.userId, name: r.name, role: r.role, kind, minutes, hours: hoursOf(r), own: !!r.plan?.own, reminders: !!r.reminders,
        status: kind === 'late' ? words.late(minutes) : kind === 'soon' ? words.soon(minutes) : words.later(hhmm(point)),
        canRemind: !!r.reminders && remindable(r, kind),
      };
    }).sort((a, b) => {
      const rank = { late: 0, soon: 1, later: 2 } as const;
      // Longest late first; then the nearest time.
      return rank[a.kind] - rank[b.kind] || (a.kind === 'late' ? b.minutes - a.minutes : a.minutes - b.minutes) || a.name.localeCompare(b.name);
    });
  const tally = (w: GateWaiting[]) => ({ late: w.filter((x) => x.kind === 'late').length, soon: w.filter((x) => x.kind === 'soon').length, later: w.filter((x) => x.kind === 'later').length });
  const nextOf = (w: GateWaiting[]) => {
    const ahead = w.filter((x) => x.kind !== 'late');
    if (!ahead.length) return null;
    const minutes = Math.min(...ahead.map((x) => x.minutes));
    return { at: hhmm(nowMin + minutes), people: ahead.filter((x) => x.minutes === minutes).length, minutes };
  };
  const ago = (t: string) => Math.max(0, nowMin - (toMin(t) ?? nowMin));

  if (mode === 'in') {
    // Expected today, no check-in yet. Their day already over (absent) stays listed as late, but a reminder no longer helps.
    const list = rows.filter((r) => r.expected && !r.checkIn && (r.moment === 'due_now' || r.moment === 'due_later' || r.moment === 'missed'));
    const waiting = waitingOf(list, (r) => toMin(r.plan?.start), { late: (m) => (m ? `${span(m)} late` : 'due now'), soon: (m) => `in ${span(m)}`, later: (t) => `at ${t}` },
      // A reminder helps the people late or about to be; not someone who starts hours from now, nor after their day.
      (r, kind) => r.moment !== 'missed' && kind !== 'later');
    const events: GateEvent[] = arrived.map((r) => {
      const lateBy = r.status === 'late' ? Math.max(0, (toMin(r.checkIn) ?? 0) - (toMin(r.plan?.start) ?? toMin(ov.rules.lateAfter) ?? 0)) : 0;
      return { userId: r.userId, name: r.name, role: r.role, at: r.checkIn!, card: r.source === 'card', warn: r.status === 'late', tag: r.status === 'late' ? (lateBy ? `${span(lateBy)} late` : 'Late') : 'On time', ago: ago(r.checkIn!), needsReview: r.needsReview };
    }).sort((a, b) => b.at.localeCompare(a.at) || a.name.localeCompare(b.name));
    const expectedToday = rows.filter((r) => r.expected).length;
    const done = rows.filter((r) => r.expected && r.checkIn && counted(r)).length;
    return {
      ...base, waiting, counts: tally(waiting), events, next: nextOf(waiting), done, total: expectedToday,
      remindIds: waiting.filter((w) => w.canRemind).map((w) => w.userId),
      noReminders: waiting.filter((w) => !w.reminders).length,
    };
  }

  // Leaving: still inside (checked in, not out), people past their end first.
  const inside = arrived.filter((r) => !r.checkOut);
  const waiting = waitingOf(inside, (r) => toMin(r.plan?.end) ?? toMin(ov.rules.earlyLeaveBefore), { late: (m) => (m ? `${span(m)} over` : 'day over'), soon: (m) => `ends in ${span(m)}`, later: (t) => `ends ${t}` },
    (_r, kind) => kind === 'late');
  const events: GateEvent[] = arrived.filter((r) => r.checkOut).map((r) => {
    const early = r.outStatus === 'early';
    return { userId: r.userId, name: r.name, role: r.role, at: r.checkOut!, card: r.source === 'card', warn: early, tag: early ? 'Left early' : 'On time', ago: ago(r.checkOut!), needsReview: false };
  }).sort((a, b) => b.at.localeCompare(a.at) || a.name.localeCompare(b.name));
  return {
    ...base, waiting, counts: tally(waiting), events, next: nextOf(waiting), done: events.length, total: arrived.length,
    remindIds: waiting.filter((w) => w.canRemind).map((w) => w.userId),
    noReminders: waiting.filter((w) => w.kind === 'late' && !w.reminders).length,
  };
}

/** The line under the ring: what happens next. */
export function gateHeadline(m: GateModel): { kicker: string; line: string; tone: 'warn' | 'calm' } {
  const late = m.counts.late;
  if (m.mode === 'in') {
    if (m.next && m.next.minutes <= SOON_MIN) return { kicker: `Start ${m.next.at} · ${m.next.people} ${m.next.people === 1 ? 'person' : 'people'}`, line: `Late in ${span(m.next.minutes)}`, tone: 'warn' };
    if (late) return { kicker: m.next ? `Next start ${m.next.at}` : 'No start left today', line: `${late} late now`, tone: 'warn' };
    if (m.next) return { kicker: `Next start ${m.next.at}`, line: `${m.next.people} still to come`, tone: 'calm' };
    return { kicker: m.total ? 'Nobody left to wait for' : 'Nobody is expected today', line: m.total ? 'Everyone is in' : 'Quiet day', tone: 'calm' };
  }
  if (late) return { kicker: 'Their day is over', line: `${late} still inside`, tone: 'warn' };
  if (m.next) return { kicker: `Next end ${m.next.at} · ${m.next.people} ${m.next.people === 1 ? 'person' : 'people'}`, line: m.next.minutes <= SOON_MIN ? `Ends in ${span(m.next.minutes)}` : `${m.waiting.length} inside`, tone: 'calm' };
  return { kicker: 'Nobody is inside', line: m.total ? 'Everyone has left' : 'Nobody came today', tone: 'calm' };
}

/** "just now", "3 min ago", "1 h 05 ago". */
export const agoText = (min: number) => (min <= 0 ? 'just now' : `${span(min)} ago`);
