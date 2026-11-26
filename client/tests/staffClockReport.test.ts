import { test } from 'node:test';
import assert from 'node:assert/strict';
import { delta, heatLevel, lowAndBest, medianTime, monthBlocks, monthGrid, sumDays } from '../src/pages/staffClock/reportMath.ts';

type Day = { date: string; kind: 'school' | 'off' | 'untracked' | 'future'; onTime: number; late: number; absent: number; staff: number; today: boolean };
const day = (date: string, onTime = 0, late = 0, absent = 0, kind: Day['kind'] = 'school'): Day => ({ date, kind, onTime, late, absent, staff: kind === 'school' ? onTime + late + absent : 0, today: false });
// November 2026: the 1st is a Sunday.
const november: Day[] = Array.from({ length: 30 }, (_, i) => {
  const date = `2026-11-${String(i + 1).padStart(2, '0')}`;
  const dow = new Date(`${date}T12:00:00Z`).getUTCDay();
  if (dow === 0 || dow === 6) return day(date, 0, 0, 0, 'off');
  if (i + 1 > 26) return day(date, 0, 0, 0, 'future');
  return day(date, 8, 1, 1);
});

test('sums only school days inside the range', () => {
  const s = sumDays(november, '2026-11-02', '2026-11-08');
  assert.deepEqual({ schoolDays: s.schoolDays, onTime: s.onTime, late: s.late, absent: s.absent }, { schoolDays: 5, onTime: 40, late: 5, absent: 5 });
  assert.equal(s.rate, 90);
  assert.equal(sumDays(november, '2026-11-07', '2026-11-08').rate, null);
});

test('month calendar starts on Monday and pads the first week', () => {
  const [nov] = monthBlocks(november);
  assert.equal(nov.name, 'November');
  assert.equal(nov.cells.slice(0, 6).every((c) => c === null), true);
  assert.equal(nov.cells[6]?.date, '2026-11-01');
  assert.equal(nov.sum.schoolDays, 19);
  assert.equal(monthBlocks([...november, day('2026-12-01', 1)]).length, 2);
});

test('the month grid is weeks across, Monday to Sunday down', () => {
  const cols = monthGrid(november, '2026-11');
  assert.equal(cols.length, 6);
  assert.deepEqual(cols.map((c) => c.label), ['', '2', '9', '16', '23', '30']);
  assert.equal(cols[0].cells[6]?.date, '2026-11-01');
  assert.equal(cols[1].cells[0]?.date, '2026-11-02');
  assert.equal(cols[5].cells.length, 7);
  assert.equal(cols[5].cells[1], null);
  assert.deepEqual(monthGrid(november, '2026-10'), []);
});

test('colour levels, lowest and best day, median time and deltas', () => {
  assert.deepEqual([null, 70, 85, 92, 100].map(heatLevel), [0, 1, 2, 3, 4]);
  const days = [day('2026-11-02', 9, 0, 1), day('2026-11-03', 5, 0, 5), day('2026-11-04', 10, 0, 0), { ...day('2026-11-05', 1, 0, 9), today: true }];
  const { low, best } = lowAndBest(days);
  assert.equal(low?.date, '2026-11-03');
  assert.equal(best?.date, '2026-11-04');
  assert.equal(medianTime(['07:50', null, '07:10', '08:40']), '07:50');
  assert.equal(medianTime([]), null);
  assert.deepEqual(delta(93.1, 91), { text: '+2.1 pts', up: true });
  assert.deepEqual(delta(88, 90.5), { text: '−2.5 pts', up: false });
  assert.equal(delta(null, 90), null);
});
