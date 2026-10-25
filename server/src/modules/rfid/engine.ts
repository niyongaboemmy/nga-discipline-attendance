/**
 * The card-attendance rules, as pure functions over plain data (epoch
 * milliseconds), so every boundary can be unit-tested with a fixed clock.
 * ingest.service.ts and finalize.service.ts do the I/O around these.
 *
 * The model follows each class's own timetable:
 *   - A class's lessons for the day split into BLOCKS wherever the timetable has
 *     a break (a gap between lessons).
 *   - A card tap is the student's ARRIVAL for the block it falls in: from the end
 *     of the previous block (or the start of the day) until the block's last
 *     lesson ends. Tapping during the break counts for the lessons after it.
 *   - That arrival applies to every lesson in the block. It is on time for a
 *     lesson up to GRACE minutes after the lesson starts, late while the lesson
 *     is running, and missed once the lesson has ended.
 *   - The first block also fills the morning (homeroom) register.
 */

export const SCAN_OUTCOMES = [
  'pending',
  'recorded_present',
  'recorded_late',
  'already_recorded',
  'debounced',
  'conflict_record',
  'unknown_card',
  'unassigned_card',
  'disabled_card',
  'malformed_uid',
  'device_disabled',
  'no_active_session',
  'not_enrolled',
  'enrolment_ambiguous',
  'error',
] as const;
export type ScanOutcome = (typeof SCAN_OUTCOMES)[number];

/** Outcomes where the card resolved to nobody. They feed the "cards to assign" queue. */
export const UNRESOLVED_CARD_OUTCOMES: ScanOutcome[] = ['unknown_card', 'unassigned_card'];

export type Period = 'Morning' | 'Afternoon' | 'Evening';

/** One timetabled lesson on a specific date, times as epoch ms. */
export interface Lesson {
  subjectId: number;
  subjectName: string;
  start: number;
  end: number;
  /** Register period, matching what the calendar and teachers' registers use. */
  period: Period;
}

export interface Block {
  index: number;
  lessons: Lesson[];
  /** Taps from here (inclusive) count as arriving for this block. */
  opensAt: number;
  start: number;
  end: number;
}

/**
 * Group a day's lessons into blocks. Lessons whose gap to the previous one is
 * shorter than `breakGapMs` (back-to-back lessons, a short changeover) stay in
 * one block; a longer gap is a break and starts a new block.
 */
export function buildBlocks(lessons: Lesson[], breakGapMs: number, dayStart: number): Block[] {
  const sorted = [...lessons].filter((l) => l.end > l.start).sort((a, b) => a.start - b.start || a.end - b.end);
  const blocks: Block[] = [];
  for (const lesson of sorted) {
    const current = blocks[blocks.length - 1];
    if (current && lesson.start - current.end < breakGapMs) {
      current.lessons.push(lesson);
      current.end = Math.max(current.end, lesson.end);
    } else {
      blocks.push({
        index: blocks.length,
        lessons: [lesson],
        opensAt: current ? current.end : dayStart,
        start: lesson.start,
        end: lesson.end,
      });
    }
  }
  return blocks;
}

/** The block a tap at `t` is an arrival for, or null outside the school day. */
export function pickBlock(t: number, blocks: Block[]): Block | null {
  return blocks.find((b) => t >= b.opensAt && t < b.end) ?? null;
}

export type LessonVerdict = 'present' | 'late' | 'missed';

/**
 * A grace of 3 minutes means a lesson starting 09:50 is still on time for any
 * tap during 09:53 (the clock a student would read), and late from 09:54.
 */
export function lessonVerdict(t: number, lesson: { start: number; end: number }, graceMinutes: number): LessonVerdict {
  if (t < lesson.start + (graceMinutes + 1) * 60_000) return 'present';
  if (t < lesson.end) return 'late';
  return 'missed';
}

export interface RegisterTarget {
  sessionType: 'homeroom' | 'subject';
  subjectId: number | null;
  subjectName: string | null;
  period: Period;
  status: 'present' | 'late';
  /** When this register's lesson starts. Used for ordering and feedback. */
  start: number;
}

/**
 * Every register a tap at `t` in `block` should write.
 *
 * Lessons that already ended are skipped: the student missed them, and closing
 * each lesson marks those absent. A subject taught twice in one period (a
 * double lesson) is one register, keyed by subject and period, as in the
 * teachers' registers; the first lesson of it the student can still attend
 * decides the status.
 */
export function registersForTap(
  t: number,
  block: Block,
  graceMinutes: number,
  homeroomPeriod: Period
): RegisterTarget[] {
  const out: RegisterTarget[] = [];
  if (block.index === 0) {
    const first = block.lessons[0];
    out.push({
      sessionType: 'homeroom', subjectId: null, subjectName: null, period: homeroomPeriod,
      status: lessonVerdict(t, first, graceMinutes) === 'present' ? 'present' : 'late',
      start: first.start,
    });
  }
  const seen = new Set<string>();
  for (const lesson of block.lessons) {
    const verdict = lessonVerdict(t, lesson, graceMinutes);
    if (verdict === 'missed') continue;
    const key = `${lesson.subjectId}|${lesson.period}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      sessionType: 'subject', subjectId: lesson.subjectId, subjectName: lesson.subjectName,
      period: lesson.period, status: verdict, start: lesson.start,
    });
  }
  return out;
}

/** The register row that already exists for this student and register. */
export interface ExistingRecord {
  status: string;
  source: 'manual' | 'rfid' | 'system';
  autoStatus: string | null;
  firstScanAt: number | null;
}

export type RecordDecision =
  | { action: 'insert' | 'update'; outcome: ScanOutcome }
  | { action: 'none'; outcome: ScanOutcome };

/**
 * What a tap does to one register.
 *
 * - No row yet: create it.
 * - A card row nobody has overridden: an *earlier* tap (a replay arriving out
 *   of order) replaces it, since the first tap decides; a later one is just
 *   "already recorded".
 * - The absent filled in when a lesson closed: the student has turned up while
 *   it can still be attended (only then is it offered here), so it is upgraded.
 * - Anything a person decided (a teacher's mark, an approved excuse, an
 *   override) is never changed by a card. A contradicting tap is flagged.
 */
export function decideRecord(
  existing: ExistingRecord | null,
  status: 'present' | 'late',
  t: number
): RecordDecision {
  const recorded: ScanOutcome = status === 'present' ? 'recorded_present' : 'recorded_late';
  if (!existing) return { action: 'insert', outcome: recorded };

  const untouched = existing.autoStatus != null && existing.status === existing.autoStatus;

  if (existing.source === 'rfid') {
    if (untouched && existing.firstScanAt != null && t < existing.firstScanAt) {
      return { action: 'update', outcome: recorded };
    }
    return { action: 'none', outcome: 'already_recorded' };
  }

  if (existing.source === 'system' && untouched && existing.status === 'absent') {
    return { action: 'update', outcome: recorded };
  }

  if (existing.status === 'present' || existing.status === 'late') {
    return { action: 'none', outcome: 'already_recorded' };
  }
  return { action: 'none', outcome: 'conflict_record' };
}

/** True when the previous tap of the same card is inside the debounce window.
 *  That covers a reader repeating one tap, or a nervous double-tap. */
export function isDebounced(t: number, previousTapAt: number | null, debounceSeconds: number): boolean {
  if (previousTapAt == null || debounceSeconds <= 0) return false;
  const gap = t - previousTapAt;
  return gap >= 0 && gap < debounceSeconds * 1000;
}

/**
 * Which instant a tap happened at. Supabase's insert time (or the server's
 * receive time) is the source of truth. A device clock is only trusted for a
 * tap the firmware says it buffered offline, and only when plausible: not in
 * the future, and no more than 24 h old.
 */
export function effectiveScanTime(input: {
  receivedAt: number;
  deviceTs: number | null;
  buffered: boolean;
}): { at: number; source: 'received' | 'device' } {
  const { receivedAt, deviceTs, buffered } = input;
  if (buffered && deviceTs != null && deviceTs <= receivedAt + 5_000 && receivedAt - deviceTs <= 24 * 3600_000) {
    return { at: deviceTs, source: 'device' };
  }
  return { at: receivedAt, source: 'received' };
}
