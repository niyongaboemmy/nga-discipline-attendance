import { Database } from 'sqlite';
import { addDays, schoolDateString } from '../../shared/schoolTime.js';
import { recordAudit } from '../../shared/audit.js';
import { notifyStudentMarked } from '../attendance/notifier.service.js';
import { triggerLowAttendanceCheck } from '../../routes/attendance.js';
import { buildBlocks, Lesson } from './engine.js';
import { BREAK_MIN_GAP_MS, HOMEROOM_PERIOD, dayStartFor, isSchoolDay, lessonsFor } from './timetable.service.js';
import { schoolYearForDate } from './roster.service.js';
import { excludeInactiveSql } from '../../services/activeStudents.js';
import { rfidEvents, RegisterChangedEvent } from './workQueue.js';

/**
 * Closing registers: what a teacher does by marking the students who never
 * showed up. When a lesson ends, every student who held a card for it and has
 * no mark gets `absent`, or `excused` if an approved excuse covers that
 * register. The morning register closes when the morning block ends, so a
 * student arriving during the second lesson is still late rather than absent.
 *
 * Only card holders are closed. A class (or student) without cards is left to
 * its teacher exactly as before. Days off and dates outside every term are skipped.
 */

export const SYSTEM_ACTOR = { id: 'system:checkin', name: 'Check-in system' };

interface Register {
  key: string;
  sessionType: 'homeroom' | 'subject';
  subjectId: number | null;
  subjectName: string | null;
  period: string;
  opensAt: number;
  closesAt: number;
}

/** The registers a class's timetable produces for one day, with close times. */
export function registersForDay(lessons: Lesson[], dayStart: number): Register[] {
  const blocks = buildBlocks(lessons, BREAK_MIN_GAP_MS, dayStart);
  if (blocks.length === 0) return [];
  const out: Register[] = [{
    key: `homeroom|${HOMEROOM_PERIOD}`, sessionType: 'homeroom', subjectId: null, subjectName: null,
    period: HOMEROOM_PERIOD, opensAt: blocks[0].start, closesAt: blocks[0].end,
  }];
  const byKey = new Map<string, Register>();
  for (const l of lessons) {
    const key = `subject|${l.subjectId}|${l.period}`;
    const r = byKey.get(key);
    if (r) {
      r.opensAt = Math.min(r.opensAt, l.start);
      r.closesAt = Math.max(r.closesAt, l.end);
    } else {
      byKey.set(key, {
        key, sessionType: 'subject', subjectId: l.subjectId, subjectName: l.subjectName,
        period: l.period, opensAt: l.start, closesAt: l.end,
      });
    }
  }
  return [...out, ...byKey.values()];
}

/** Close whatever has ended, today and yesterday (catch-up after downtime).
 *  Idempotent, and safe to run every 30 s. Callers queue it through workQueue. */
export async function tick(db: Database, now: Date = new Date()): Promise<void> {
  const today = schoolDateString(now);
  for (const date of [addDays(today, -1), today]) {
    await closeEndedRegisters(db, date, now.getTime());
  }
}

export async function closeEndedRegisters(db: Database, dateStr: string, nowMs: number): Promise<number> {
  if (!(await isSchoolDay(db, dateStr)).open) return 0;
  const { yearId, termId } = await schoolYearForDate(db, dateStr);
  const year = yearId ?? (await db.get(`SELECT MAX(academic_year_id) AS y FROM roster_enrolments WHERE status = 'ACTIVE'`))?.y;
  if (year == null) return 0;

  // Every card assignment that existed at any point that day, with the
  // holder's class. A student active in two classes is ambiguous and skipped.
  const dayStart = dayStartFor(dateStr);
  const dayEnd = dayStart + 24 * 3600_000;
  const holders = await db.all(
    `SELECT a.student_id, a.assigned_at, a.ended_at, e.class_id,
            COALESCE(c.name, 'Class ' || e.class_id) AS class_name,
            COALESCE(s.name, a.student_name) AS student_name, s.mis_status
       FROM rfid_card_assignments a
       JOIN roster_enrolments e ON e.student_id = a.student_id AND e.status = 'ACTIVE' AND e.academic_year_id = ?
       LEFT JOIN roster_class_groups c ON c.class_id = e.class_id
       LEFT JOIN roster_students s ON s.student_id = a.student_id
      WHERE a.assigned_at < ? AND (a.ended_at IS NULL OR a.ended_at > ?)${excludeInactiveSql('a.student_id')}
        AND (SELECT COUNT(*) FROM roster_enrolments e2
              WHERE e2.student_id = a.student_id AND e2.status = 'ACTIVE' AND e2.academic_year_id = ?) = 1`,
    year, new Date(dayEnd).toISOString(), new Date(dayStart).toISOString(), year
  );
  const byClass = new Map<string, any[]>();
  for (const h of holders) {
    if (!byClass.has(h.class_id)) byClass.set(h.class_id, []);
    byClass.get(h.class_id)!.push(h);
  }

  let written = 0;
  for (const [classId, classHolders] of byClass) {
    const lessons = await lessonsFor(db, classId, dateStr);
    for (const reg of registersForDay(lessons, dayStart)) {
      if (nowMs < reg.closesAt) continue;
      const done = await db.get(
        `SELECT 1 FROM rfid_closed_registers WHERE class_id = ? AND session_date = ? AND register_key = ?`,
        classId, dateStr, reg.key
      );
      if (done) continue;
      written += await closeRegister(db, dateStr, classId, reg, classHolders, year, termId);
    }
  }
  return written;
}

async function closeRegister(
  db: Database, dateStr: string, classId: string, reg: Register, classHolders: any[], year: number, termId: number | null
): Promise<number> {
  const opensIso = new Date(reg.opensAt).toISOString();
  // Held a card when the register opened: getting a card at 10:00 doesn't make
  // someone absent from the 08:00 lesson.
  const expected = classHolders.filter((h) =>
    h.assigned_at <= opensIso && (h.ended_at == null || h.ended_at > opensIso) && (!h.mis_status || h.mis_status === 'ACTIVE'));
  const marked: { studentId: string; status: string; className: string }[] = [];
  let absent = 0;
  let excused = 0;

  await db.run('BEGIN TRANSACTION');
  try {
    for (const h of expected) {
      const existing = await db.get(
        `SELECT 1 FROM attendance_records
          WHERE student_id = ? AND session_date = ? AND session_type = ? AND period = ?
            AND (subject_id IS ? OR subject_id = ?) LIMIT 1`,
        h.student_id, dateStr, reg.sessionType, reg.period, reg.subjectId, reg.subjectId
      );
      if (existing) continue;
      const excuse = await db.get(
        `SELECT id FROM excuse_requests
          WHERE student_id = ? AND session_date = ? AND status = 'approved'
            AND COALESCE(session_type, 'homeroom') = ? AND (? = 'homeroom' OR subject_id = ?)
            AND (period IS NULL OR period = ?)
          LIMIT 1`,
        h.student_id, dateStr, reg.sessionType, reg.sessionType, reg.subjectId, reg.period
      );
      const status = excuse ? 'excused' : 'absent';
      await db.run(
        `INSERT INTO attendance_records
           (student_id, student_name, class_id, class_name, session_date, period, session_type, subject_id,
            status, notes, marked_by, academic_year_id, academic_term_id, source, auto_status, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'system', ?, CURRENT_TIMESTAMP)`,
        h.student_id, h.student_name, classId, h.class_name, dateStr, reg.period, reg.sessionType, reg.subjectId,
        status, excuse ? 'Approved excuse' : 'No card tap', SYSTEM_ACTOR.id, year, termId, status
      );
      marked.push({ studentId: h.student_id, status, className: h.class_name });
      if (excuse) excused++; else absent++;
    }
    await db.run(
      `INSERT OR IGNORE INTO rfid_closed_registers (class_id, session_date, register_key, closed_at, absent, excused)
       VALUES (?, ?, ?, ?, ?, ?)`,
      classId, dateStr, reg.key, new Date().toISOString(), absent, excused
    );
    if (marked.length > 0) {
      await recordAudit(db, SYSTEM_ACTOR, 'attendance.mark', 'attendance_session',
        `${classId}:${dateStr}:${reg.period}:${reg.sessionType}:${reg.subjectId ?? '-'}`,
        { classId, date: dateStr, period: reg.period, sessionType: reg.sessionType, subjectId: reg.subjectId, absent, excused, by: 'card attendance' },
        { required: true });
    }
    await db.run('COMMIT');
  } catch (err) {
    await db.run('ROLLBACK');
    throw err;
  }

  if (marked.length > 0) {
    // The same follow-ups as a teacher saving a register.
    const className = marked[0].className;
    for (const m of marked) {
      void notifyStudentMarked(db, {
        studentId: m.studentId, status: m.status, date: dateStr, period: reg.period, sessionType: reg.sessionType,
        classId, className, subjectId: reg.subjectId, subjectName: reg.subjectName,
      }).catch(() => {});
    }
    void triggerLowAttendanceCheck(classId, className, reg.sessionType, termId ?? undefined);
    const evt: RegisterChangedEvent = { type: 'register', sessionDate: dateStr, period: reg.period, classIds: [classId] };
    rfidEvents.emit('event', evt);
  }
  return marked.length;
}
