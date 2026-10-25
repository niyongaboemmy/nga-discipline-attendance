import { Database } from 'sqlite';
import { dayOfWeekFor, periodForTime, schoolLocalToUtc } from '../../shared/schoolTime.js';
import { Lesson, Period } from './engine.js';

/**
 * Each class's timetable, as Tendo's attendance calendar shows it (MIS
 * CalendarSlot rows), cached locally so a card tap can be judged with no
 * signed-in user. Filled by roster.service.ts from /integrations/sync/academics.
 */

/** Minutes after a lesson starts that still count as on time. */
export const GRACE_MINUTES = Number(process.env.RFID_GRACE_MINUTES || 3);
/** A gap between lessons at least this long is a break (starts a new block). */
export const BREAK_MIN_GAP_MS = Number(process.env.RFID_BREAK_MIN_GAP_MINUTES || 10) * 60_000;
/** Same value the calendar uses for the morning register (schedule.routes.ts). */
export const HOMEROOM_PERIOD = (process.env.HOMEROOM_PERIOD || 'Morning') as Period;
/** Taps of one card closer together than this are one tap. */
export const DEBOUNCE_SECONDS = Number(process.env.RFID_DEBOUNCE_SECONDS || 10);

const hhmm = (v: string) => String(v).slice(0, 5);

/**
 * The term a date belongs to, from the cached MIS calendar. Falls back to the
 * term flagged current, then to null (every active slot applies).
 */
async function termForDate(db: Database, dateStr: string): Promise<number | null> {
  const byDate = await db.get(
    `SELECT id FROM academic_terms
      WHERE start_date IS NOT NULL AND end_date IS NOT NULL AND date(?) BETWEEN date(start_date) AND date(end_date)
      ORDER BY start_date DESC LIMIT 1`,
    dateStr
  );
  if (byDate) return Number(byDate.id);
  const current = await db.get(`SELECT id FROM academic_terms WHERE is_current = 1 ORDER BY id DESC LIMIT 1`);
  return current ? Number(current.id) : null;
}

/** A class's lessons on one date, as dated instants, earliest first. */
export async function lessonsFor(db: Database, classId: string, dateStr: string): Promise<Lesson[]> {
  const dow = dayOfWeekFor(dateStr);
  const termId = await termForDate(db, dateStr);
  let rows = await db.all(
    `SELECT t.subject_id, t.start_time, t.end_time, t.academic_term_id, COALESCE(s.name, 'Subject ' || t.subject_id) AS subject_name
       FROM timetable_slots t LEFT JOIN subjects s ON s.id = t.subject_id
      WHERE t.class_id = ? AND t.day_of_week = ? AND t.is_active = 1`,
    classId, dow
  );
  if (termId != null && rows.some((r: any) => r.academic_term_id === termId)) {
    rows = rows.filter((r: any) => r.academic_term_id === termId || r.academic_term_id == null);
  } else if (rows.some((r: any) => r.academic_term_id != null)) {
    // Term unknown locally: use the newest term that has slots, never a mix of terms.
    const newest = Math.max(...rows.filter((r: any) => r.academic_term_id != null).map((r: any) => r.academic_term_id));
    rows = rows.filter((r: any) => r.academic_term_id === newest || r.academic_term_id == null);
  }
  return rows
    .map((r: any) => ({
      subjectId: Number(r.subject_id),
      subjectName: r.subject_name,
      start: schoolLocalToUtc(dateStr, hhmm(r.start_time)).getTime(),
      end: schoolLocalToUtc(dateStr, hhmm(r.end_time)).getTime(),
      period: periodForTime(hhmm(r.start_time)) as Period,
    }))
    .filter((l: Lesson) => Number.isFinite(l.start) && Number.isFinite(l.end) && l.end > l.start)
    .sort((a: Lesson, b: Lesson) => a.start - b.start);
}

export function dayStartFor(dateStr: string): number {
  return schoolLocalToUtc(dateStr, '00:00').getTime();
}

/**
 * False on a day marked closed, and outside every known term (holidays between
 * terms). When no term dates are cached at all, every timetabled day counts.
 */
export async function isSchoolDay(db: Database, dateStr: string): Promise<{ open: boolean; reason: string | null }> {
  const off = await db.get(`SELECT reason FROM rfid_days_off WHERE session_date = ?`, dateStr);
  if (off) return { open: false, reason: off.reason || 'School closed' };
  const dated = await db.get(`SELECT COUNT(*) AS n FROM academic_terms WHERE start_date IS NOT NULL AND end_date IS NOT NULL`);
  if (dated?.n > 0) {
    const inTerm = await db.get(
      `SELECT 1 FROM academic_terms WHERE start_date IS NOT NULL AND end_date IS NOT NULL
         AND date(?) BETWEEN date(start_date) AND date(end_date) LIMIT 1`,
      dateStr
    );
    if (!inTerm) return { open: false, reason: 'Outside term dates' };
  }
  return { open: true, reason: null };
}

/**
 * MySQL DATE columns arrive as ISO instants shifted by the MIS server's
 * timezone (2026-01-05 in Kigali serialises as 2026-01-04T22:00:00Z). Adding
 * 12 h before taking the date recovers the calendar day for any offset.
 */
export function misDate(v: unknown): string | null {
  if (!v) return null;
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t + 12 * 3600_000).toISOString().slice(0, 10) : null;
}

/** Write the reference data a timetable needs: years, terms, subjects. */
export async function upsertReference(db: Database, reference: any, syncedAt: string): Promise<void> {
  for (const y of reference?.academicYears ?? []) {
    if (y?.id == null) continue;
    await db.run(
      `INSERT INTO academic_years (id, name, start_date, end_date, is_current, synced_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, start_date = excluded.start_date, end_date = excluded.end_date,
         is_current = excluded.is_current, synced_at = excluded.synced_at`,
      Number(y.id), y.name ?? `Year ${y.id}`, misDate(y.startDate), misDate(y.endDate), Number(y.isCurrent) === 1 ? 1 : 0, syncedAt
    );
  }
  for (const t of reference?.academicTerms ?? []) {
    if (t?.id == null || t.academicYearId == null) continue;
    await db.run(
      `INSERT INTO academic_terms (id, academic_year_id, name, start_date, end_date, is_current, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET academic_year_id = excluded.academic_year_id, name = excluded.name, start_date = excluded.start_date,
         end_date = excluded.end_date, is_current = excluded.is_current, synced_at = excluded.synced_at`,
      Number(t.id), Number(t.academicYearId), t.name ?? `Term ${t.id}`, misDate(t.startDate), misDate(t.endDate),
      Number(t.isCurrent) === 1 ? 1 : 0, syncedAt
    );
  }
  for (const s of reference?.subjects ?? []) {
    if (s?.id == null) continue;
    await db.run(
      `INSERT INTO subjects (id, name, code, synced_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, code = excluded.code, synced_at = excluded.synced_at`,
      Number(s.id), s.name ?? `Subject ${s.id}`, s.code ?? null, syncedAt
    );
  }
}

/**
 * Replace the cached timetable with the MIS's current slots. Returns how many
 * were kept, or null when the MIS sent none while slots are cached (almost
 * certainly an outage, not a school with no lessons), leaving the cache as is.
 */
export async function replaceTimetable(db: Database, slots: any[], syncedAt: string): Promise<number | null> {
  const valid = (slots ?? []).filter((s: any) =>
    s?.id != null && s.classGroupId != null && s.subjectId != null && s.dayOfWeek != null && s.startTime && s.endTime);
  if (valid.length === 0) {
    const had = await db.get(`SELECT COUNT(*) AS n FROM timetable_slots`);
    if (had?.n > 0) return null;
  }
  for (const s of valid) {
    await db.run(
      `INSERT INTO subjects (id, name, synced_at) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING`,
      Number(s.subjectId), `Subject ${s.subjectId}`, syncedAt
    );
    await db.run(
      `INSERT INTO timetable_slots (slot_id, class_id, subject_id, day_of_week, start_time, end_time, academic_term_id, is_active, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(slot_id) DO UPDATE SET class_id = excluded.class_id, subject_id = excluded.subject_id,
         day_of_week = excluded.day_of_week, start_time = excluded.start_time, end_time = excluded.end_time,
         academic_term_id = excluded.academic_term_id, is_active = excluded.is_active, synced_at = excluded.synced_at`,
      Number(s.id), String(s.classGroupId), Number(s.subjectId), Number(s.dayOfWeek), hhmm(s.startTime), hhmm(s.endTime),
      s.academicTermId != null ? Number(s.academicTermId) : null, s.isActive === 0 || s.isActive === false ? 0 : 1, syncedAt
    );
  }
  await db.run(`DELETE FROM timetable_slots WHERE synced_at < ?`, syncedAt);
  return valid.length;
}
