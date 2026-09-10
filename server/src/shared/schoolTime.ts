/**
 * Remediation A15 — "today", "now" and the staff late-cutoff were computed
 * three different ways (UTC `toISOString()` here, server-local `setHours` there),
 * so near midnight or a mis-configured server they disagreed.
 *
 * One helper, one timezone. `SCHOOL_TIMEZONE` (IANA name, e.g. `Africa/Kigali`)
 * defaults to the school's actual zone; override via env for other deployments.
 */
const SCHOOL_TIMEZONE = process.env.SCHOOL_TIMEZONE || 'Africa/Kigali';

/** `YYYY-MM-DD` for a given instant (default: now) in the school's timezone. */
export function schoolDateString(at: Date = new Date()): string {
  // en-CA formats as ISO `YYYY-MM-DD`.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: SCHOOL_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

/** Minutes since local midnight for a given instant in the school's timezone. */
export function schoolMinutesOfDay(at: Date = new Date()): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: SCHOOL_TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(at);
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  return h * 60 + m;
}

/** True when `dateStr` (YYYY-MM-DD) is after the school's current date. */
export function isFutureSchoolDate(dateStr: string): boolean {
  return dateStr > schoolDateString();
}

/**
 * Day of week for a `YYYY-MM-DD` string, using the MIS convention
 * (0=Sunday .. 6=Saturday — see nga_central_mis calendarConstants.ts and the
 * CalendarSlot.day_of_week column). Computed from the date parts directly so
 * it never drifts with the server's own timezone.
 */
export function dayOfWeekFor(dateStr: string): number {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** `HH:MM` -> minutes since midnight. Tolerates `HH:MM:SS` and empty input. */
export function timeToMinutes(hhmm: string | null | undefined): number {
  if (!hhmm) return 0;
  const [h, m] = hhmm.split(':').map(Number);
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
}

/** Monday-based start of the week (YYYY-MM-DD) containing `dateStr`. */
export function weekStartFor(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dow = dt.getUTCDay(); // 0=Sun
  const backToMonday = (dow + 6) % 7;
  dt.setUTCDate(dt.getUTCDate() - backToMonday);
  return dt.toISOString().slice(0, 10);
}

/** Add `n` days to a `YYYY-MM-DD` string, returning `YYYY-MM-DD`. */
export function addDays(dateStr: string, n: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}
