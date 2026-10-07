// Offline registers (src/offline/outbox.ts). Run with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clearCache, enqueue, flush, list, readCache, registerKey, writeCache, type RegisterPayload, type SendOutcome } from '../src/offline/outbox.ts';

class Mem {
  m = new Map<string, string>();
  get length() { return this.m.size; }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string) { this.m.set(k, v); }
  removeItem(k: string) { this.m.delete(k); }
}
const signedIn = (id: string) => {
  const kv = new Mem();
  kv.setItem('sso_user', JSON.stringify({ id, name: 'T' }));
  return kv;
};
const reg = (over: Partial<RegisterPayload> = {}): RegisterPayload => ({
  classId: 'c7', className: 'S2 A', date: '2026-10-08', period: 2, sessionType: 'subject', subjectId: 's9',
  records: [{ studentId: '501', status: 'absent' }], ...over,
});

test('one slot per register: saving it again replaces the waiting copy', () => {
  const kv = signedIn('42');
  enqueue(kv, reg(), 1);
  enqueue(kv, reg({ records: [{ studentId: '501', status: 'present' }] }), 2);
  enqueue(kv, reg({ period: 3 }), 3);
  const items = list(kv);
  assert.equal(items.length, 2);
  assert.equal(items.find((w) => w.key === registerKey(reg()))!.payload.records[0].status, 'present');
  // Homeroom ignores the subject.
  assert.equal(registerKey(reg({ sessionType: 'homeroom', subjectId: 'x' })), 'c7|2026-10-08|2|homeroom|');
});

test('each signed-in person has their own queue; nobody signed in, nothing kept', () => {
  const kv = signedIn('42');
  enqueue(kv, reg(), 1);
  kv.setItem('sso_user', JSON.stringify({ id: '43' }));
  assert.equal(list(kv).length, 0);
  kv.removeItem('sso_user');
  assert.equal(enqueue(kv, reg()), null);
});

test('flush sends oldest first, stops when the network is down, keeps refusals with the reason', async () => {
  const kv = signedIn('42');
  enqueue(kv, reg({ period: 1 }), 1);
  enqueue(kv, reg({ period: 2 }), 2);
  enqueue(kv, reg({ period: 3 }), 3);
  const sent: Array<number | string> = [];
  const outcomes: SendOutcome[] = [{ ok: true }, { ok: false, refused: true, message: 'Not your class' }, { ok: false, refused: false }];
  const r = await flush(kv, async (p) => (sent.push(p.period), outcomes.shift()!));
  assert.deepEqual(sent, [1, 2, 3]);
  assert.deepEqual(r, { sent: 1, refused: 1, waiting: 1 });
  const left = list(kv);
  assert.equal(left.find((w) => w.payload.period === 2)!.error, 'Not your class');
  assert.equal(left.find((w) => w.payload.period === 3)!.attempts, 1);
  // Next time: the refused one is skipped (until dismissed), the other goes.
  const again = await flush(kv, async () => ({ ok: true }));
  assert.deepEqual(again, { sent: 1, refused: 1, waiting: 0 });
});

test('a network failure stops the run (no hammering)', async () => {
  const kv = signedIn('42');
  enqueue(kv, reg({ period: 1 }), 1);
  enqueue(kv, reg({ period: 2 }), 2);
  let calls = 0;
  await flush(kv, async () => (calls++, { ok: false, refused: false }));
  assert.equal(calls, 1);
});

test('only rosters and the timetable are cached, per person, and sign-out clears them', () => {
  const kv = signedIn('42');
  writeCache(kv, '/api/mis/students?class_id=c7', { success: true, data: [{ id: '501' }] });
  writeCache(kv, '/api/attendance/schedule/day?date=2026-10-08', { success: true, data: { lessons: [] } });
  writeCache(kv, '/api/admin/overview', { success: true });
  assert.deepEqual(readCache<any>(kv, '/api/mis/students?class_id=c7')!.body.data, [{ id: '501' }]);
  assert.equal(readCache(kv, '/api/admin/overview'), null);
  kv.setItem('sso_user', JSON.stringify({ id: '43' }));
  assert.equal(readCache(kv, '/api/mis/students?class_id=c7'), null);
  enqueue(kv, reg(), 1);
  clearCache(kv);
  assert.equal([...kv.m.keys()].filter((k) => k.startsWith('tendo.cache.')).length, 0);
  assert.equal(list(kv).length, 1); // the queue stays for its owner
});
