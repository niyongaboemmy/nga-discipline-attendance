import { describe, it, expect } from 'vitest';
import { normalizeUid } from '../modules/rfid/uid.js';
import {
  Lesson, buildBlocks, decideRecord, effectiveScanTime, isDebounced, lessonVerdict, pickBlock, registersForTap,
} from '../modules/rfid/engine.js';
import { schoolLocalToUtc, schoolClockLabel } from '../shared/schoolTime.js';

const DAY = '2026-09-28';
const at = (hhmm: string, sec = 0) => schoolLocalToUtc(DAY, hhmm).getTime() + sec * 1000;
const lesson = (name: string, id: number, from: string, to: string): Lesson =>
  ({ subjectId: id, subjectName: name, start: at(from), end: at(to), period: from < '12:00' ? 'Morning' : 'Afternoon' });

/** Senior 3A, Monday: three lessons, a 20-minute break, two lessons. */
const TIMETABLE = [
  lesson('Maths', 1, '07:30', '08:10'),
  lesson('English', 2, '08:10', '08:50'),
  lesson('Physics', 3, '08:50', '09:30'),
  lesson('Chemistry', 4, '09:50', '10:30'),
  lesson('Biology', 5, '10:30', '11:10'),
];
const blocks = () => buildBlocks(TIMETABLE, 10 * 60_000, at('00:00'));
const GRACE = 3;
const summary = (t: number) => {
  const b = pickBlock(t, blocks());
  return b ? registersForTap(t, b, GRACE, 'Morning').map((r) => `${r.subjectName ?? 'Morning'}:${r.status}`) : null;
};

describe('normalizeUid', () => {
  it.each([
    ['79:43:01:04', '79430104'],
    ['04 A1 B2 C3', '04A1B2C3'],
    ['0x04a1b2c3', '04A1B2C3'],
    ['04-A1-B2-C3-D4-E5-F6', '04A1B2C3D4E5F6'],
  ])('%s -> %s', (raw, want) => expect(normalizeUid(raw)).toBe(want));

  it.each(['', 'XYZ', 'dh:dwad:!31', '04A1B2', '00000000', 'FFFFFFFF'])('rejects %j', (raw) => expect(normalizeUid(raw)).toBeNull());
});

describe('school time (Africa/Kigali, UTC+2)', () => {
  it('converts local wall-clock to UTC and back', () => {
    expect(schoolLocalToUtc(DAY, '07:30').toISOString()).toBe('2026-09-28T05:30:00.000Z');
    expect(schoolClockLabel('2026-09-28T05:24:00.000Z')).toBe('07:24');
  });
});

describe('blocks from a class timetable', () => {
  it('splits at the break, keeps back-to-back lessons together', () => {
    const b = blocks();
    expect(b.map((x) => x.lessons.map((l) => l.subjectName))).toEqual([['Maths', 'English', 'Physics'], ['Chemistry', 'Biology']]);
    expect(b[0].opensAt).toBe(at('00:00'));
    expect(b[1].opensAt).toBe(at('09:30')); // tapping during the break counts for the lessons after it
  });

  it('a short changeover is not a break', () => {
    const b = buildBlocks([lesson('A', 1, '08:00', '08:40'), lesson('B', 2, '08:45', '09:25')], 10 * 60_000, at('00:00'));
    expect(b).toHaveLength(1);
  });

  it('knows no block after the last lesson', () => {
    expect(pickBlock(at('11:10'), blocks())).toBeNull();
    expect(pickBlock(at('06:00'), blocks())?.index).toBe(0);
  });
});

describe('lessonVerdict — 3-minute grace', () => {
  const maths = { start: at('07:30'), end: at('08:10') };
  it.each([
    ['07:29', 0, 'present'],
    ['07:33', 59, 'present'], // still reads 07:33 on a clock
    ['07:34', 0, 'late'],
    ['08:09', 59, 'late'],
    ['08:10', 0, 'missed'],
  ])('%s:%s -> %s', (clock, sec, want) => expect(lessonVerdict(at(clock, sec as number), maths, GRACE)).toBe(want));
});

describe('registersForTap — the school’s rule', () => {
  it('morning on time: morning register and every lesson until the break are present', () => {
    expect(summary(at('07:25'))).toEqual(['Morning:present', 'Maths:present', 'English:present', 'Physics:present']);
  });

  it('5 minutes late from break: late for the first lesson after it, present for the next', () => {
    expect(summary(at('09:55'))).toEqual(['Chemistry:late', 'Biology:present']);
  });

  it('tapping during the break is on time for the next block', () => {
    expect(summary(at('09:40'))).toEqual(['Chemistry:present', 'Biology:present']);
  });

  it('arriving mid-morning: late for the morning register and the running lesson, missed lessons skipped', () => {
    expect(summary(at('08:15'))).toEqual(['Morning:late', 'English:late', 'Physics:present']);
  });

  it('a double lesson is one register; the first part still attendable decides', () => {
    const doubleMaths = [lesson('Maths', 1, '07:30', '08:10'), lesson('Maths', 1, '08:10', '08:50'), lesson('Art', 9, '08:50', '09:30')];
    const b = buildBlocks(doubleMaths, 10 * 60_000, at('00:00'));
    const at815 = registersForTap(at('08:15'), b[0], GRACE, 'Morning').map((r) => `${r.subjectName ?? 'Morning'}:${r.status}`);
    expect(at815).toEqual(['Morning:late', 'Maths:late', 'Art:present']);
  });
});

describe('decideRecord', () => {
  const t = at('07:24');
  it('creates the row when none exists', () => {
    expect(decideRecord(null, 'present', t)).toEqual({ action: 'insert', outcome: 'recorded_present' });
    expect(decideRecord(null, 'late', t)).toEqual({ action: 'insert', outcome: 'recorded_late' });
  });
  it('a later tap of a card row is "already recorded"; an earlier replayed tap wins', () => {
    const existing = { status: 'late', source: 'rfid' as const, autoStatus: 'late', firstScanAt: at('07:40') };
    expect(decideRecord(existing, 'late', at('07:50')).outcome).toBe('already_recorded');
    expect(decideRecord(existing, 'present', at('07:20'))).toEqual({ action: 'update', outcome: 'recorded_present' });
  });
  it('upgrades the absent filled in when the register closed', () => {
    const absent = { status: 'absent', source: 'system' as const, autoStatus: 'absent', firstScanAt: null };
    expect(decideRecord(absent, 'late', t)).toEqual({ action: 'update', outcome: 'recorded_late' });
  });
  it('never overrides a person’s decision', () => {
    expect(decideRecord({ status: 'absent', source: 'manual', autoStatus: null, firstScanAt: null }, 'present', t).outcome).toBe('conflict_record');
    expect(decideRecord({ status: 'present', source: 'manual', autoStatus: null, firstScanAt: null }, 'present', t).outcome).toBe('already_recorded');
    expect(decideRecord({ status: 'excused', source: 'system', autoStatus: 'absent', firstScanAt: null }, 'present', t).outcome).toBe('conflict_record');
    expect(decideRecord({ status: 'present', source: 'rfid', autoStatus: 'late', firstScanAt: at('07:40') }, 'present', at('07:20')).action).toBe('none');
  });
});

describe('isDebounced / effectiveScanTime', () => {
  it('debounces inside the window only', () => {
    expect(isDebounced(at('07:42', 3), at('07:42'), 10)).toBe(true);
    expect(isDebounced(at('07:42', 10), at('07:42'), 10)).toBe(false);
    expect(isDebounced(at('07:42', 3), null, 10)).toBe(false);
  });
  it('trusts Supabase’s time unless the device replays a plausible buffered tap', () => {
    const received = at('07:50');
    expect(effectiveScanTime({ receivedAt: received, deviceTs: at('07:20'), buffered: false })).toEqual({ at: received, source: 'received' });
    expect(effectiveScanTime({ receivedAt: received, deviceTs: at('07:20'), buffered: true })).toEqual({ at: at('07:20'), source: 'device' });
    expect(effectiveScanTime({ receivedAt: received, deviceTs: at('09:00'), buffered: true }).source).toBe('received');
  });
});
