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
