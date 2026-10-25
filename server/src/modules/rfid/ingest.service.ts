import { Database } from 'sqlite';
import { schoolDateString, schoolClockLabel } from '../../shared/schoolTime.js';
import { notifyStudentMarked } from '../attendance/notifier.service.js';
import { triggerLowAttendanceCheck } from '../../routes/attendance.js';
import { normalizeUid } from './uid.js';
import {
  RegisterTarget, ScanOutcome, buildBlocks, decideRecord, effectiveScanTime, isDebounced, pickBlock, registersForTap,
} from './engine.js';
import {
  BREAK_MIN_GAP_MS, DEBOUNCE_SECONDS, GRACE_MINUTES, HOMEROOM_PERIOD, dayStartFor, isSchoolDay, lessonsFor,
} from './timetable.service.js';
import { resolveEnrolment, schoolYearForDate } from './roster.service.js';
import { enqueue, rfidEvents, ScanProcessedEvent } from './workQueue.js';

/**
 * Raw tap → scan event → the registers a teacher would otherwise have marked.
 *
 * A tap is the student's arrival. It is judged against *their own class's*
 * timetable for that day (see engine.ts): it fills the morning register if it
 * falls in the day's first block, and every lesson from now until the next break.
 *
 * Every input source (the Supabase bridge, a future direct device endpoint,
 * an admin typing a UID) calls ingestScan. The event row is written first as
 * 'pending' and processed afterwards. Processing is idempotent (see
 * reprocessPending), so a crash between the two steps loses nothing.
 */

export const RFID_ACTOR_ID = 'system:rfid';

export interface ScanInput {
  source: 'supabase' | 'direct' | 'manual_entry';
  /** Upstream id (e.g. the Supabase row id). Makes replays a no-op. */
  sourceRef?: string | null;
  deviceCode?: string | null;
  uid: string;
  deviceTs?: string | null;
  /** The firmware says it stored this tap while offline and is replaying it. */
  buffered?: boolean;
  receivedAt?: string | null;
  /** Staff member who entered it (manual_entry only). */
  recordedBy?: string | null;
}

export interface ScanResult {
  scanId: number;
  outcome: ScanOutcome;
  replay: boolean;
  studentId: string | null;
  studentName: string | null;
  className: string | null;
  status: 'present' | 'late' | null;
  at: string;
  clock: string;
  /** Short line suitable for the scanner's display and the live feed. */
  message: string;
}

export const OUTCOME_MESSAGES: Record<ScanOutcome, string> = {
  pending: 'Processing',
  recorded_present: 'Present',
  recorded_late: 'Late',
  already_recorded: 'Already recorded',
  debounced: 'Already scanned',
  conflict_record: 'Already marked by staff',
  unknown_card: 'Card not registered',
  unassigned_card: 'Card not assigned',
  disabled_card: 'Card disabled',
  malformed_uid: 'Card not read, try again',
  device_disabled: 'Scanner disabled',
  no_active_session: 'No lesson now',
  not_enrolled: 'Not enrolled in a class',
  enrolment_ambiguous: 'Class unclear, see the office',
  error: 'Error, see the office',
};

const parseInstant = (v: string | null | undefined): number | null => {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
};

export function ingestScan(db: Database, input: ScanInput, now: Date = new Date()): Promise<ScanResult> {
  return enqueue(() => recordAndProcess(db, input, now));
}

async function recordAndProcess(db: Database, input: ScanInput, now: Date): Promise<ScanResult> {
  if (input.sourceRef) {
    const seen = await db.get(
      `SELECT id, outcome FROM rfid_scan_events WHERE source = ? AND source_ref = ?`,
      input.source, input.sourceRef
    );
    if (seen) {
      if (seen.outcome === 'pending') await processEvent(db, seen.id);
      return { ...(await resultFor(db, seen.id)), replay: true };
    }
  }

  const receivedAt = parseInstant(input.receivedAt) ?? now.getTime();
  const deviceTs = parseInstant(input.deviceTs);
  const eff = effectiveScanTime({ receivedAt, deviceTs, buffered: !!input.buffered });

  let deviceId: number | null = null;
  const deviceCode = input.deviceCode?.trim().slice(0, 64) || null;
  if (deviceCode) {
    await db.run(
      `INSERT INTO rfid_devices (code, name, created_at) VALUES (?, ?, ?) ON CONFLICT(code) DO NOTHING`,
      deviceCode, deviceCode, now.toISOString()
    );
    const device = await db.get(`SELECT id FROM rfid_devices WHERE code = ?`, deviceCode);
    deviceId = device.id;
    await db.run(
      `UPDATE rfid_devices SET last_seen_at = ?, last_clock_skew_ms = ? WHERE id = ?`,
      new Date(receivedAt).toISOString(), deviceTs != null ? receivedAt - deviceTs : null, deviceId
    );
  }

  const inserted = await db.run(
    `INSERT INTO rfid_scan_events
       (source, source_ref, device_id, uid_raw, uid, device_ts, received_at, effective_at, time_source, recorded_by, outcome)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
    input.source, input.sourceRef ?? null, deviceId, String(input.uid ?? '').slice(0, 128),
    normalizeUid(input.uid), deviceTs != null ? new Date(deviceTs).toISOString() : null,
    new Date(receivedAt).toISOString(), new Date(eff.at).toISOString(), eff.source, input.recordedBy ?? null
  );
  const scanId = Number(inserted.lastID);
  await processEvent(db, scanId);
  return { ...(await resultFor(db, scanId)), replay: false };
}

interface Resolution {
  outcome: ScanOutcome;
  detail?: string | null;
  cardId?: number | null;
  studentId?: string | null;
  studentName?: string | null;
  classId?: string | null;
  className?: string | null;
  attendanceRecordId?: number | null;
  status?: 'present' | 'late' | null;
  sessionDate?: string | null;
  period?: string | null;
}

/** Decide and apply one stored scan event. Must run inside the work queue. */
async function processEvent(db: Database, scanId: number): Promise<void> {
  const ev = await db.get(
    `SELECT e.*, d.status AS device_status FROM rfid_scan_events e
       LEFT JOIN rfid_devices d ON d.id = e.device_id WHERE e.id = ?`,
    scanId
  );
  let res: Resolution;
  try {
    res = await resolve(db, ev);
  } catch (err) {
    console.error(`RFID scan ${scanId} failed:`, err);
    res = { outcome: 'error', detail: (err as Error).message.slice(0, 300) };
  }

  await db.run(
    `UPDATE rfid_scan_events SET outcome = ?, detail = ?, card_id = COALESCE(?, card_id),
            student_id = ?, student_name = ?, class_id = ?, class_name = ?,
            attendance_record_id = ?, processed_at = ?
      WHERE id = ?`,
    res.outcome, res.detail ?? null, res.cardId ?? null, res.studentId ?? null, res.studentName ?? null,
    res.classId ?? null, res.className ?? null, res.attendanceRecordId ?? null,
    new Date().toISOString(), scanId
  );

  const device = ev.device_id ? await db.get(`SELECT name FROM rfid_devices WHERE id = ?`, ev.device_id) : null;
  const evt: ScanProcessedEvent = {
    type: 'scan',
    scanId,
    outcome: res.outcome,
    at: ev.effective_at,
    studentId: res.studentId ?? null,
    studentName: res.studentName ?? null,
    classId: res.classId ?? null,
    className: res.className ?? null,
    status: res.status ?? null,
    detail: res.detail ?? null,
    sessionDate: res.sessionDate ?? null,
    period: res.period ?? null,
    uid: ev.uid,
    deviceName: device?.name ?? null,
  };
  rfidEvents.emit('event', evt);
}

async function resolve(db: Database, ev: any): Promise<Resolution> {
  if (!ev.uid) return { outcome: 'malformed_uid', detail: `Unreadable UID "${ev.uid_raw}"` };
  if (ev.device_status === 'disabled') return { outcome: 'device_disabled' };

  const t = Date.parse(ev.effective_at);
  const atIso = ev.effective_at as string;
  const nowIso = new Date().toISOString();

  // --- card ---------------------------------------------------------------
  await db.run(
    `INSERT INTO rfid_cards (uid, status, first_seen_at, last_seen_at, created_at, updated_at)
     VALUES (?, 'unassigned', ?, ?, ?, ?) ON CONFLICT(uid) DO NOTHING`,
    ev.uid, atIso, atIso, nowIso, nowIso
  );
  const card = await db.get(`SELECT * FROM rfid_cards WHERE uid = ?`, ev.uid);
  await db.run(
    `UPDATE rfid_cards SET
       first_seen_at = CASE WHEN first_seen_at IS NULL OR first_seen_at > ? THEN ? ELSE first_seen_at END,
       last_seen_at  = CASE WHEN last_seen_at  IS NULL OR last_seen_at  < ? THEN ? ELSE last_seen_at  END
     WHERE id = ?`,
    atIso, atIso, atIso, atIso, card.id
  );

  // The holder *at the moment of the tap*. A replayed tap from before a card
  // was disabled still counts; a tap after it was disabled finds no holder.
  const holder = await db.get(
    `SELECT student_id, student_name FROM rfid_card_assignments
      WHERE card_id = ? AND assigned_at <= ? AND (ended_at IS NULL OR ended_at > ?)
      ORDER BY assigned_at DESC LIMIT 1`,
    card.id, atIso, atIso
  );
  if (!holder) {
    if (['disabled', 'lost', 'retired'].includes(card.status)) {
      return { outcome: 'disabled_card', cardId: card.id, detail: `Card is ${card.status}` };
    }
    // "Unknown" = no one has ever held it; "unassigned" = it was returned.
    const everHeld = await db.get(`SELECT 1 FROM rfid_card_assignments WHERE card_id = ? LIMIT 1`, card.id);
    return { outcome: everHeld ? 'unassigned_card' : 'unknown_card', cardId: card.id };
  }

  const base: Resolution = {
    outcome: 'pending', cardId: card.id, studentId: holder.student_id, studentName: holder.student_name,
  };

  // --- class --------------------------------------------------------------
  const sessionDate = schoolDateString(new Date(t));
  const { yearId, termId } = await schoolYearForDate(db, sessionDate);
  const enrol = await resolveEnrolment(db, holder.student_id, yearId);
  const current = await db.get(`SELECT name FROM roster_students WHERE student_id = ?`, holder.student_id);
  if (current?.name) base.studentName = current.name;
  if (enrol.kind === 'none') return { ...base, outcome: 'not_enrolled' };
  if (enrol.kind === 'ambiguous') {
    return { ...base, outcome: 'enrolment_ambiguous', detail: `Active in classes ${enrol.classIds.join(', ')}` };
  }
  base.classId = enrol.classId;
  base.className = enrol.className;
  base.sessionDate = sessionDate;

  // --- timetable ----------------------------------------------------------
  const day = await isSchoolDay(db, sessionDate);
  if (!day.open) return { ...base, outcome: 'no_active_session', detail: day.reason };
  const lessons = await lessonsFor(db, enrol.classId, sessionDate);
  if (lessons.length === 0) {
    return { ...base, outcome: 'no_active_session', detail: `No lessons on ${enrol.className}'s timetable today` };
  }
  const block = pickBlock(t, buildBlocks(lessons, BREAK_MIN_GAP_MS, dayStartFor(sessionDate)));
  if (!block) return { ...base, outcome: 'no_active_session', detail: 'After the last lesson of the day' };

  // --- repeats ------------------------------------------------------------
  const previous = await db.get(
    `SELECT effective_at FROM rfid_scan_events
      WHERE card_id = ? AND id != ? AND effective_at <= ? AND outcome NOT IN ('pending','malformed_uid')
      ORDER BY effective_at DESC LIMIT 1`,
    card.id, ev.id, atIso
  );
  if (isDebounced(t, previous ? Date.parse(previous.effective_at) : null, DEBOUNCE_SECONDS)) {
    return { ...base, outcome: 'debounced' };
  }

  // --- registers ----------------------------------------------------------
  const targets = registersForTap(t, block, GRACE_MINUTES, HOMEROOM_PERIOD);
  const clock = schoolClockLabel(new Date(t));
  const who = {
    studentId: holder.student_id as string, studentName: base.studentName as string, classId: enrol.classId,
    className: enrol.className, sessionDate, yearId: enrol.academicYearId, termId,
  };
  const results: { target: RegisterTarget; outcome: ScanOutcome; recordId: number | null }[] = [];
  for (const target of targets) {
    results.push({ target, ...(await applyToRegister(db, ev, target, t, clock, who)) });
  }

  const written = results.filter((r) => r.outcome.startsWith('recorded_'));
  if (written.length > 0) {
    // The same follow-ups as a teacher saving these registers.
    for (const r of written) {
      void notifyStudentMarked(db, {
        studentId: who.studentId, status: r.target.status, date: sessionDate, period: r.target.period,
        sessionType: r.target.sessionType, classId: enrol.classId, className: enrol.className,
        subjectId: r.target.subjectId, subjectName: r.target.subjectName,
      }).catch(() => {});
    }
    for (const type of new Set(written.map((r) => r.target.sessionType))) {
      void triggerLowAttendanceCheck(enrol.classId, enrol.className, type, termId ?? undefined);
    }
  }

  const label = (r: RegisterTarget) => (r.sessionType === 'homeroom' ? 'Morning register' : r.subjectName);
  const shown = written.length > 0 ? written : results;
  const lead = written[0] ?? results.find((r) => r.outcome === 'conflict_record') ?? results[0];
  return {
    ...base,
    outcome: written.length > 0
      ? written[0].outcome
      : results.some((r) => r.outcome === 'conflict_record') ? 'conflict_record' : 'already_recorded',
    status: written.length > 0 ? written[0].target.status : null,
    detail: shown
      .map((r) => `${label(r.target)}: ${r.outcome.startsWith('recorded_') ? r.target.status : r.outcome === 'conflict_record' ? 'kept staff mark' : 'already recorded'}`)
      .join(' · '),
    attendanceRecordId: lead?.recordId ?? null,
    period: lead?.target.period ?? null,
  };
}

/** Write one register for this tap, the way a teacher's save would. */
async function applyToRegister(
  db: Database, ev: any, target: RegisterTarget, t: number, clock: string,
  who: { studentId: string; studentName: string; classId: string; className: string; sessionDate: string; yearId: number; termId: number | null }
): Promise<{ outcome: ScanOutcome; recordId: number | null }> {
  const existing = await db.get(
    `SELECT id, status, source, auto_status, first_scan_at, scan_event_id FROM attendance_records
      WHERE student_id = ? AND class_id = ? AND session_date = ? AND session_type = ? AND period = ?
        AND (subject_id IS ? OR subject_id = ?)`,
    who.studentId, who.classId, who.sessionDate, target.sessionType, target.period, target.subjectId, target.subjectId
  );
  if (existing && existing.scan_event_id === ev.id) {
    // Re-processing a tap whose write already landed (crash recovery).
    return { outcome: existing.status === 'late' ? 'recorded_late' : 'recorded_present', recordId: existing.id };
  }
  const decision = decideRecord(
    existing ? {
      status: existing.status, source: existing.source, autoStatus: existing.auto_status,
      firstScanAt: existing.first_scan_at ? Date.parse(existing.first_scan_at) : null,
    } : null,
    target.status,
    t
  );
  if (decision.action === 'none') return { outcome: decision.outcome, recordId: existing?.id ?? null };

  const atIso = new Date(t).toISOString();
  const note = `Card tap ${clock}`;
  if (target.subjectId != null) {
    // attendance_records.subject_id references the local subjects cache.
    await db.run(
      `INSERT INTO subjects (id, name) VALUES (?, ?) ON CONFLICT(id) DO NOTHING`,
      target.subjectId, target.subjectName ?? `Subject ${target.subjectId}`
    );
  }
  if (decision.action === 'insert') {
    const r = await db.run(
      `INSERT INTO attendance_records
         (student_id, student_name, class_id, class_name, session_date, period, session_type, subject_id,
          status, notes, marked_by, academic_year_id, academic_term_id, source, auto_status, first_scan_at,
          scan_event_id, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'rfid', ?, ?, ?, CURRENT_TIMESTAMP)`,
      who.studentId, who.studentName, who.classId, who.className, who.sessionDate, target.period, target.sessionType,
      target.subjectId, target.status, note, RFID_ACTOR_ID, who.yearId, who.termId, target.status, atIso, ev.id
    );
    return { outcome: decision.outcome, recordId: Number(r.lastID) };
  }

  await db.run(
    `INSERT INTO attendance_record_history
       (attendance_record_id, student_id, class_id, session_date, period, session_type, subject_id,
        previous_status, new_status, previous_notes, new_notes, changed_by, changed_by_name, reason, change_source)
     SELECT id, student_id, class_id, session_date, period, session_type, subject_id,
            status, ?, notes, ?, ?, 'Card tap', ?, 'rfid'
       FROM attendance_records WHERE id = ?`,
    target.status, note, RFID_ACTOR_ID,
    existing.source === 'system' ? `Tapped in at ${clock} after being marked absent` : `Earlier tap at ${clock} arrived late`,
    existing.id
  );
  await db.run(
    `UPDATE attendance_records SET status = ?, auto_status = ?, source = 'rfid', first_scan_at = ?, scan_event_id = ?,
            notes = ?, marked_by = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?`,
    target.status, target.status, atIso, ev.id, note, RFID_ACTOR_ID, existing.id
  );
  return { outcome: decision.outcome, recordId: existing.id };
}

async function resultFor(db: Database, scanId: number): Promise<Omit<ScanResult, 'replay'>> {
  const e = await db.get(
    `SELECT e.*, a.status AS att_status FROM rfid_scan_events e
       LEFT JOIN attendance_records a ON a.id = e.attendance_record_id WHERE e.id = ?`,
    scanId
  );
  const outcome = e.outcome as ScanOutcome;
  const clock = schoolClockLabel(e.effective_at);
  const recorded = outcome.startsWith('recorded_') || outcome === 'already_recorded' || outcome === 'debounced';
  const status = recorded && (e.att_status === 'present' || e.att_status === 'late') ? e.att_status : null;
  return {
    scanId,
    outcome,
    studentId: e.student_id,
    studentName: e.student_name,
    className: e.class_name,
    status,
    at: e.effective_at,
    clock,
    message: outcome.startsWith('recorded_') ? `${OUTCOME_MESSAGES[outcome]} ${clock}` : OUTCOME_MESSAGES[outcome],
  };
}

/** Finish scans left 'pending' by a crash or restart. Call once at boot. */
export function reprocessPending(db: Database): Promise<number> {
  return enqueue(async () => {
    const rows = await db.all(`SELECT id FROM rfid_scan_events WHERE outcome = 'pending' ORDER BY id`);
    for (const r of rows) await processEvent(db, r.id);
    return rows.length;
  });
}
