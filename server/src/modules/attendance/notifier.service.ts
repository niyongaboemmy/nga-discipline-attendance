import { Database } from 'sqlite';
import { AuthenticatedRequest } from '../../middleware/auth.js';
import { resolveAcademicPeriod } from '../../utils/academicPeriod.js';
import {
  schoolDateString,
  schoolMinutesOfDay,
  dayOfWeekFor,
  timeToMinutes,
} from '../../shared/schoolTime.js';
import { fetchTimetable, buildDaySessions, loadAttendance } from './schedule.routes.js';

/**
 * In-app notification engine.
 *
 * The `notifications` table row is the notification; this module decides which
 * rows should exist for a user right now and writes the missing ones. Every
 * generator is idempotent through `notifications.dedupe_key` (unique partial
 * index `uq_notifications_dedupe`) so calling `generateForUser` on every poll
 * of GET /api/notifications is cheap and safe.
 *
 * External channels (email/SMS) stay with utils/notifier.ts.
 */

export type NotificationType =
  | 'register_missing'
  | 'homeroom_missing'
  | 'lesson_soon'
  | 'attendance_marked'
  | 'excuse_decided'
  | 'low_attendance'
  | 'system';

export type Severity = 'info' | 'warning' | 'critical' | 'success';

interface PushInput {
  userId: string;
  type: NotificationType;
  title: string;
  message: string;
  link?: string | null;
  severity?: Severity;
  dedupeKey?: string | null;
}

/** Insert a notification, skipping silently if an identical one (same
 *  dedupe_key) already exists. Returns true when a new row was created. */
export async function pushNotification(db: Database, n: PushInput): Promise<boolean> {
  try {
    const result = await db.run(
      `INSERT OR IGNORE INTO notifications (user_id, type, title, message, link, severity, dedupe_key)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      n.userId, n.type, n.title, n.message, n.link ?? null, n.severity ?? 'info', n.dedupeKey ?? null
    );
    return (result.changes ?? 0) > 0;
  } catch (err) {
    console.error('pushNotification failed:', (err as Error).message);
    return false;
  }
}

// A register is "late" this many minutes after the lesson starts.
const LATE_GRACE_MIN = 15;
// A lesson is "starting soon" within this window.
const SOON_WINDOW_MIN = 20;

/**
 * Reconcile a user's schedule-derived notifications for today.
 * Safe to call opportunistically (poll, post-mark). Never throws.
 */
export async function generateForUser(db: Database, req: AuthenticatedRequest): Promise<void> {
  const user = req.user;
  if (!user || user.role === 'unassigned') return;
  // Students get schedule reminders too, but only "lesson soon"; the missing-
  // register nudges are for whoever records them.
  const isStaff = user.role === 'teacher' || user.role === 'admin';

  try {
    const { academicTermId } = resolveAcademicPeriod(req);
    const { slots } = await fetchTimetable(
      req,
      academicTermId != null ? String(academicTermId) : undefined
    );
    if (slots.length === 0) return;

    const date = schoolDateString();
    const nowMin = schoolMinutesOfDay();
    const dow = dayOfWeekFor(date);
    const daySlots = slots.filter((s) => s.dayOfWeek === dow);
    if (daySlots.length === 0) return;

    const classIds = [...new Set(daySlots.map((s) => s.classId))];
    const agg = await loadAttendance(classIds, date, date, null, academicTermId);
    const sessions = buildDaySessions(daySlots, date, agg, user.id);

    // Clear nudges for sessions that have since been recorded, so the bell
    // doesn't keep an obsolete "register missing" around.
    const staleKeys: string[] = [];
    for (const s of sessions) {
      if (s.status !== 'recorded') continue;
      if (s.kind === 'subject') {
        staleKeys.push(
          `reg:${user.id}:${date}:${s.classId}:${s.subjectId}`,
          `soon:${user.id}:${date}:${s.classId}:${s.subjectId}`
        );
      } else {
        staleKeys.push(`hr:${user.id}:${date}:${s.classId}`);
      }
    }
    if (staleKeys.length > 0) {
      await db.run(
        `DELETE FROM notifications WHERE user_id = ? AND dedupe_key IN (${staleKeys.map(() => '?').join(',')})`,
        user.id, ...staleKeys
      );
    }

    let firstHomeroom = true;
    for (const s of sessions) {
      const startMin = timeToMinutes(s.startTime);

      if (isStaff && s.status === 'missing') {
        if (s.kind === 'subject' && nowMin >= startMin + LATE_GRACE_MIN) {
          await pushNotification(db, {
            userId: user.id,
            type: 'register_missing',
            severity: 'warning',
            title: 'Register not taken',
            message: `${s.subjectName ?? 'Lesson'} · ${s.className} (${s.startTime}) still needs its register.`,
            link: s.deepLink,
            dedupeKey: `reg:${user.id}:${date}:${s.classId}:${s.subjectId}`,
          });
        }
        if (s.kind === 'homeroom' && firstHomeroom && nowMin >= startMin + LATE_GRACE_MIN) {
          await pushNotification(db, {
            userId: user.id,
            type: 'homeroom_missing',
            severity: 'warning',
            title: 'Morning check not done',
            message: `The homeroom register for ${s.className} hasn’t been recorded yet.`,
            link: s.deepLink,
            dedupeKey: `hr:${user.id}:${date}:${s.classId}`,
          });
        }
      }

      if (s.kind === 'homeroom') firstHomeroom = false;

      if (
        s.kind === 'subject' &&
        s.status === 'missing' &&
        startMin - nowMin > 0 &&
        startMin - nowMin <= SOON_WINDOW_MIN
      ) {
        await pushNotification(db, {
          userId: user.id,
          type: 'lesson_soon',
          severity: 'info',
          title: 'Lesson starting soon',
          message: `${s.subjectName ?? 'Lesson'} · ${s.className} at ${s.startTime}${s.room ? ` · ${s.room}` : ''}.`,
          link: isStaff ? s.deepLink : '/schedule',
          dedupeKey: `soon:${user.id}:${date}:${s.classId}:${s.subjectId}`,
        });
      }
    }
  } catch (err) {
    console.error('generateForUser failed:', (err as Error).message);
  }
}

/** Notify a student that one of their excuse requests was decided. */
export async function notifyExcuseDecision(
  db: Database,
  opts: { studentId: string; approved: boolean; sessionDate: string; excuseId: number }
): Promise<void> {
  await pushNotification(db, {
    userId: opts.studentId,
    type: 'excuse_decided',
    severity: opts.approved ? 'success' : 'info',
    title: opts.approved ? 'Excuse approved' : 'Excuse declined',
    message: `Your excuse for ${opts.sessionDate} was ${opts.approved ? 'approved' : 'declined'}.`,
    link: `/excuses/${opts.excuseId}`,
    dedupeKey: `excuse:${opts.excuseId}:${opts.approved ? 'a' : 'd'}`,
  });
}

/** Statuses a student should be told about. Present is the expected case and
 *  excused was their own request — neither needs a ping. */
const NOTIFY_STATUSES = new Set(['absent', 'late']);

const humanDate = (d: string) =>
  new Date(`${d}T00:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });

/**
 * Tell a student how *they* were marked for one session — "You were marked
 * absent for JavaScript". This is the only attendance notification a student
 * gets about a register; the class-level ones stay with staff.
 *
 * Idempotent per session + status, and a correction withdraws the earlier
 * notice: absent → present deletes the "absent" row rather than leaving a
 * stale alarm in the bell; absent → late swaps it for a "late" one.
 */
export async function notifyStudentMarked(
  db: Database,
  opts: {
    studentId: string;
    status: string;
    date: string;
    period: string;
    sessionType: 'homeroom' | 'subject';
    classId: string;
    className: string;
    subjectId: number | null;
    subjectName: string | null;
  }
): Promise<void> {
  const base = `att:${opts.studentId}:${opts.date}:${opts.sessionType}:${opts.classId}:${opts.subjectId ?? '-'}:${opts.period}`;
  const key = `${base}:${opts.status}`;
  try {
    // Drop any notice for this session with a different status (ids can
    // contain `_`, which LIKE treats as a wildcard — escape it).
    const likeBase = base.replace(/[\\%_]/g, (c) => `\\${c}`);
    await db.run(
      `DELETE FROM notifications WHERE user_id = ? AND dedupe_key LIKE ? ESCAPE '\\' AND dedupe_key <> ?`,
      opts.studentId, `${likeBase}:%`, key
    );
    if (!NOTIFY_STATUSES.has(opts.status)) return;

    const what = opts.sessionType === 'homeroom'
      ? 'the morning check'
      : (opts.subjectName ?? 'a lesson');
    const qs = new URLSearchParams({ date: opts.date, classId: opts.classId, sessionType: opts.sessionType });
    if (opts.sessionType === 'subject' && opts.subjectId != null) qs.set('subjectId', String(opts.subjectId));

    await pushNotification(db, {
      userId: opts.studentId,
      type: 'attendance_marked',
      severity: opts.status === 'absent' ? 'warning' : 'info',
      title: opts.status === 'absent' ? 'Marked absent' : 'Marked late',
      message: `You were marked ${opts.status} for ${what} · ${opts.className}, ${humanDate(opts.date)}.`,
      link: `/attendance/session?${qs.toString()}`,
      dedupeKey: key,
    });
  } catch (err) {
    console.error('notifyStudentMarked failed:', (err as Error).message);
  }
}
