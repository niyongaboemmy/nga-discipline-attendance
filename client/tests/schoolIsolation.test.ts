// Cross-school isolation audit 2026-11-25, client findings TD-ISO-3, WEB-ISO-2
// and WEB-ISO-5 (src/offline/outbox.ts, used by src/api/client.ts). Run with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CACHE_MAX_AGE_MS, clearCache, enqueue, list, ownerOfToken, pruneOtherIdentities, readCacheForSession,
  tokenUnexpired, waitingElsewhere, writeCache, writeCacheForToken, type RegisterPayload, type Waiting,
} from '../src/offline/outbox.ts';

class Mem {
  m = new Map<string, string>();
  get length() { return this.m.size; }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string) { this.m.set(k, v); }
  removeItem(k: string) { this.m.delete(k); }
}
const NOW = Date.UTC(2026, 10, 25, 9);
const token = (claims: object) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
const live = (id: string, tid: number) => token({ id, tid, exp: Math.floor(NOW / 1000) + 3600 });
const signIn = (kv: Mem, id: string, tid: number, email = 'aline@school.test') => {
  kv.setItem('sso_user', JSON.stringify({ id, tid, tenantSlug: `s${tid}`, email }));
  kv.setItem('sso_token', live(id, tid));
};
const reg = (over: Partial<RegisterPayload> = {}): RegisterPayload => ({
  classId: 'c7', date: '2026-11-20', period: 1, sessionType: 'class', records: [{ studentId: '501', status: 'absent' }], ...over,
});
const ROSTER = '/api/mis/students?class_id=c7';

test('TD-ISO-3 waitingElsewhere matches other schools by stamped e-mail only, never by a bare id', () => {
  const kv = new Mem();
  // Person 42 in school 1, queued before e-mail stamps existed (no email on the item).
  kv.setItem('tendo.outbox.v2.1.42', JSON.stringify([{ key: 'a', payload: reg(), savedAt: NOW, attempts: 0, tid: 1, uid: '42' } satisfies Waiting]));
  // A DIFFERENT person who happens to have id 42 in school 2 signs in.
  signIn(kv, '42', 2, 'bob@other.test');
  assert.deepEqual(waitingElsewhere(kv), []);

  // Same e-mail in another school is still listed.
  signIn(kv, '7', 3, 'bob@other.test');
  enqueue(kv, reg(), NOW);
  signIn(kv, '42', 2, 'BOB@other.test');
  assert.deepEqual(waitingElsewhere(kv), [{ tid: 3, slug: 's3', count: 1 }]);

  // Signed in with no e-mail: no count at all.
  kv.setItem('sso_user', JSON.stringify({ id: '42', tid: 2 }));
  assert.deepEqual(waitingElsewhere(kv), []);
});

test('TD-ISO-3 sign-in expires OTHER identities’ registers and rosters older than 7 days, keeps recent ones and its own', () => {
  const kv = new Mem();
  const old = NOW - CACHE_MAX_AGE_MS - 1000;
  signIn(kv, '42', 1);
  enqueue(kv, reg({ period: 1 }), old); // own, old: kept
  writeCache(kv, ROSTER, { mine: true });
  kv.setItem(`tendo.cache.v2.1.42.${ROSTER}`, JSON.stringify({ at: old, body: { mine: true } }));
  signIn(kv, '77', 2, 'x@y.test');
  enqueue(kv, reg({ period: 1 }), old); // other, old: goes
  enqueue(kv, reg({ period: 2 }), NOW - 1000); // other, recent: stays
  kv.setItem(`tendo.cache.v2.2.77.${ROSTER}`, JSON.stringify({ at: old, body: {} }));
  kv.setItem(`tendo.cache.v2.2.77./api/mis/classes`, JSON.stringify({ at: NOW - 1000, body: {} }));
  signIn(kv, '900', 3, 'z@y.test');
  enqueue(kv, reg(), old); // a whole queue that goes

  signIn(kv, '42', 1);
  pruneOtherIdentities(kv, '1.42', NOW);
  assert.equal(list(kv, '1.42').length, 1);
  assert.ok(kv.getItem(`tendo.cache.v2.1.42.${ROSTER}`));
  assert.deepEqual(list(kv, '2.77').map((w) => w.payload.period), [2]);
  assert.equal(kv.getItem(`tendo.cache.v2.2.77.${ROSTER}`), null);
  assert.ok(kv.getItem('tendo.cache.v2.2.77./api/mis/classes'));
  assert.equal(kv.getItem('tendo.outbox.v2.3.900'), null);
});

test('TD-ISO-3 sign-out deletes the signed-out person’s cached rosters, their waiting registers stay', () => {
  const kv = new Mem();
  signIn(kv, '42', 1);
  writeCache(kv, ROSTER, { a: 1 });
  enqueue(kv, reg(), NOW);
  clearCache(kv, '1.42', NOW);
  assert.equal(kv.getItem(`tendo.cache.v2.1.42.${ROSTER}`), null);
  assert.equal(list(kv, '1.42').length, 1);
});

test('WEB-ISO-2 cached reads only for an unexpired session that owns them', () => {
  const kv = new Mem();
  signIn(kv, '42', 1);
  writeCache(kv, ROSTER, { success: true, data: ['A'] });
  assert.deepEqual(readCacheForSession(kv, ROSTER, kv.getItem('sso_token'), NOW)?.body, { success: true, data: ['A'] });

  // Expired token: nothing.
  const expired = token({ id: '42', tid: 1, exp: Math.floor(NOW / 1000) - 1 });
  assert.equal(readCacheForSession(kv, ROSTER, expired, NOW), null);
  // No exp, not a JWT, no token: nothing.
  assert.equal(readCacheForSession(kv, ROSTER, token({ id: '42', tid: 1 }), NOW), null);
  assert.equal(readCacheForSession(kv, ROSTER, 'test-token', NOW), null);
  assert.equal(readCacheForSession(kv, ROSTER, null, NOW), null);
  // A live token of another school or person than the stored user: nothing.
  assert.equal(readCacheForSession(kv, ROSTER, live('42', 2), NOW), null);
  assert.equal(readCacheForSession(kv, ROSTER, live('43', 1), NOW), null);
  // Stored user replaced by someone else while the old token lingers: nothing.
  kv.setItem('sso_user', JSON.stringify({ id: '43', tid: 1 }));
  assert.equal(readCacheForSession(kv, ROSTER, live('42', 1), NOW), null);
  assert.equal(tokenUnexpired(live('1', 1), NOW), true);
});

test('WEB-ISO-5 a reply is cached under the token that was sent, not the one stored when it arrives', () => {
  const kv = new Mem();
  const sentA = live('42', 1);
  signIn(kv, '900', 2); // the session changed while the request was in flight
  writeCacheForToken(kv, ROSTER, { success: true, data: ['school-1 roster'] }, sentA);
  assert.ok(kv.getItem(`tendo.cache.v2.1.42.${ROSTER}`));
  assert.equal(kv.getItem(`tendo.cache.v2.2.900.${ROSTER}`), null);
  assert.equal(readCacheForSession(kv, ROSTER, kv.getItem('sso_token'), NOW), null);
  // No usable token sent: nothing stored.
  writeCacheForToken(kv, '/api/mis/classes', { x: 1 }, null);
  writeCacheForToken(kv, '/api/mis/classes', { x: 1 }, 'opaque');
  assert.equal([...kv.m.keys()].filter((k) => k.includes('/api/mis/classes')).length, 0);
  assert.equal(ownerOfToken(live('42', 1)), '1.42');
  assert.equal(ownerOfToken(token({ id: '42' })), '1.42'); // pre-tenancy session = school 1
});
