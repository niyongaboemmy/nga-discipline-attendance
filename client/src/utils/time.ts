/** Shared date/time formatting. Previously each page re-implemented these. */

/** "Sep 10, 2:45 PM" for an ISO-ish string (tolerates a space instead of `T`
 *  and a missing `Z`). Empty string on anything unparseable. */
export const fmtWhen = (iso: string | null | undefined): string => {
  if (!iso) return '';
  const d = new Date(String(iso).replace(' ', 'T') + (String(iso).includes('Z') ? '' : 'Z'));
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};

/** Just the clock part: "2:45 PM". */
export const fmtTime = (iso: string | null | undefined): string => {
  if (!iso) return '';
  const d = new Date(String(iso).replace(' ', 'T') + (String(iso).includes('Z') ? '' : 'Z'));
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
};

/** "just now" / "5 min ago" / "3 h ago" / falls back to fmtWhen past a day. */
export const relativeTime = (iso: string | null | undefined): string => {
  if (!iso) return '';
  const d = new Date(String(iso).replace(' ', 'T') + (String(iso).includes('Z') ? '' : 'Z'));
  if (Number.isNaN(d.getTime())) return '';
  const secs = Math.round((Date.now() - d.getTime()) / 1000);
  if (secs < 45) return 'just now';
  if (secs < 3600) return `${Math.round(secs / 60)} min ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)} h ago`;
  if (secs < 172800) return 'yesterday';
  return fmtWhen(iso);
};

/** Local `YYYY-MM-DD` for a Date (default today). */
export const isoDate = (d: Date = new Date()): string => {
  const tz = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - tz).toISOString().slice(0, 10);
};

/** "HH:MM" (drops seconds) for display. */
export const clock = (hhmm: string | null | undefined): string =>
  hhmm ? String(hhmm).slice(0, 5) : '';

export const DOW_LABEL = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** The school's timezone. Check-in times are school rules, so they are shown
 *  in school time whatever timezone the viewer's device is set to. */
export const SCHOOL_TIMEZONE = 'Africa/Kigali';

const parseIso = (iso: string) => new Date(String(iso).replace(' ', 'T') + (/Z|[+-]\d\d:?\d\d$/.test(String(iso)) ? '' : 'Z'));

/** "07:24" in school time. */
export const fmtSchoolClock = (iso: string | null | undefined, withSeconds = false): string => {
  if (!iso) return '';
  const d = parseIso(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('en-GB', {
    timeZone: SCHOOL_TIMEZONE, hour: '2-digit', minute: '2-digit', ...(withSeconds ? { second: '2-digit' } : {}), hour12: false,
  });
};

/** "25 Sep, 07:24" in school time. */
export const fmtSchoolWhen = (iso: string | null | undefined): string => {
  if (!iso) return '';
  const d = parseIso(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('en-GB', {
    timeZone: SCHOOL_TIMEZONE, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  });
};

/** Today's date (YYYY-MM-DD) in school time. */
export const schoolToday = (): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: SCHOOL_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
