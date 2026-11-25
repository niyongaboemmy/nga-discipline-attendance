// School switching (src/tenancy/school.ts + the outbox's school rules). Run with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  activityUserKey, allowSwitchAttempt, cachedBranding, clearSessionSlot, guardDecision, misHomeOf, parseSchoolCookie,
  rememberBranding, schoolLabel, sessionTid, storageChange, switchAttemptsExhausted, switchSchoolUrl, tidOfToken,
  MAX_TRIES, TRY_WINDOW_MS,
} from '../src/tenancy/school.ts';
import { clearCache, enqueue, flush, list, waitingElsewhere, writeCache, readCache, tokenFitsItem, type RegisterPayload } from '../src/offline/outbox.ts';

class Mem {
  m = new Map<string, string>();
  get length() { return this.m.size; }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string) { this.m.set(k, v); }
  removeItem(k: string) { this.m.delete(k); }
}
const token = (claims: object) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
const signIn = (kv: Mem, id: string, tid: number, email = 'aline@school.test', slug = `s${tid}`) => {
  kv.setItem('sso_user', JSON.stringify({ id, tid, tenantSlug: slug, email }));
  kv.setItem('sso_token', token({ id, tid }));
  kv.setItem('sso_permissions', '[]');
  kv.setItem('sso_role_permissions', '[]');
};
const reg = (over: Partial<RegisterPayload> = {}): RegisterPayload => ({
  classId: 'c7', className: 'S2 A', date: '2026-11-25', period: 2, sessionType: 'homeroom', records: [{ studentId: '501', status: 'absent' }], ...over,
});

test('reads the nga_school cookie exactly as Appendix A.1 defines it', () => {
  assert.deepEqual(parseSchoolCookie('a=1; nga_school=2.abcDEF12_-; b=2'), { tid: 2, sid: 'abcDEF12_-' });
  assert.deepEqual(parseSchoolCookie('nga_school=2%2Eabcdefgh'), { tid: 2, sid: 'abcdefgh' });
  assert.equal(parseSchoolCookie('nga_school=2.short'), null); // sid under 8 chars
  assert.equal(parseSchoolCookie('nga_school=x.abcdefgh'), null);
  assert.equal(parseSchoolCookie('nga_school=0.abcdefgh'), null);
  assert.equal(parseSchoolCookie('other_nga_school=2.abcdefgh'), null);
  assert.equal(parseSchoolCookie(''), null);
});

test('guard: re-sign in only when the cookie and the session name different schools', () => {
  assert.equal(guardDecision(2, 1), 'switch');
  assert.equal(guardDecision(1, 1), 'ok');
  assert.equal(guardDecision(null, 1), 'ok'); // MIS cookie absent: nothing (A.1)
  assert.equal(guardDecision(2, null), 'ok'); // signed out here: nothing to switch
});

test('the session school comes from sso_user; a pre-tenancy session is school 1; signed out is null', () => {
  const kv = new Mem();
  assert.equal(sessionTid(kv), null);
  signIn(kv, '42', 2);
  assert.equal(sessionTid(kv), 2);
  kv.setItem('sso_user', JSON.stringify({ id: '42' }));
  assert.equal(sessionTid(kv), 1);
  assert.equal(tidOfToken(token({ id: '42', tid: 7 })), 7);
  assert.equal(tidOfToken(token({ id: '42' })), 1);
  assert.equal(tidOfToken(null), null);
});

test('loop guard: 3 automatic re-sign-ins per 2 minutes, then the manual sign-in', () => {
  const kv = new Mem();
  const t0 = 1_000_000;
  for (let i = 0; i < MAX_TRIES; i++) assert.equal(allowSwitchAttempt(kv, t0 + i), true);
  assert.equal(allowSwitchAttempt(kv, t0 + 10), false);
  assert.equal(switchAttemptsExhausted(kv, t0 + 10), true);
  // Once the window has passed, it may try again.
  assert.equal(switchAttemptsExhausted(kv, t0 + TRY_WINDOW_MS + 5), false);
  assert.equal(allowSwitchAttempt(kv, t0 + TRY_WINDOW_MS + 5), true);
});

test('clearing the session slot is not a sign-out: queue, cache and branding stay', () => {
  const kv = new Mem();
  signIn(kv, '42', 1);
  enqueue(kv, reg(), 1);
  writeCache(kv, '/api/mis/classes', { ok: 1 });
  rememberBranding(kv, { tid: 1, name: 'NGA', logoUrl: null });
  clearSessionSlot(kv);
  for (const k of ['sso_token', 'sso_user', 'sso_permissions', 'sso_role_permissions']) assert.equal(kv.getItem(k), null);
  assert.ok(kv.getItem('tendo.outbox.v2.1.42'));
  assert.ok(kv.getItem('tendo.cache.v2.1.42./api/mis/classes'));
  assert.equal(cachedBranding(kv, 1)!.name, 'NGA');
});

test('other tabs: another school or person reloads, a cleared slot waits, a re-signed token is fine', () => {
  const own = { token: token({ id: '42', tid: 1 }), tid: 1, uid: '42' };
  assert.equal(storageChange('sso_token', token({ id: '42', tid: 2 }), own), 'reload');
  assert.equal(storageChange('sso_token', token({ id: '42', tid: 1, academicTermId: 9 }), own), 'ignore');
  assert.equal(storageChange('sso_token', own.token, own), 'ignore');
  assert.equal(storageChange('sso_token', null, own), 'wait');
  assert.equal(storageChange('sso_user', JSON.stringify({ id: '77', tid: 2 }), own), 'reload');
  assert.equal(storageChange('sso_user', JSON.stringify({ id: '42', tid: 1, avatar: null }), own), 'ignore');
  assert.equal(storageChange('sso_user', null, own), 'wait');
  assert.equal(storageChange(null, null, own), 'wait'); // localStorage.clear()
  assert.equal(storageChange('theme', 'dark', own), 'ignore');
  // A signed-out tab picks up a sign-in made elsewhere.
  assert.equal(storageChange('sso_token', token({ id: '42', tid: 1 }), { token: null, tid: null, uid: null }), 'reload');
});

test('queued registers are stamped with their school and person', () => {
  const kv = new Mem();
  signIn(kv, '42', 2, 'Aline@School.test', 'nga2');
  const w = enqueue(kv, reg(), 1)!;
  assert.equal(w.tid, 2);
  assert.equal(w.uid, '42');
  assert.equal(w.email, 'aline@school.test');
  assert.equal(w.slug, 'nga2');
});

test('a register of school A is never sent with school B\'s token, checked before every send', async () => {
  const kv = new Mem();
  signIn(kv, '42', 1);
  enqueue(kv, reg({ period: 1 }), 1);
  enqueue(kv, reg({ period: 2 }), 2);
  const owner = '1.42';
  const sentWith: string[] = [];
  // The school changes in another tab while the first send is in flight.
  const r = await flush(kv, async (_p, tok) => {
    sentWith.push(tok);
    kv.setItem('sso_user', JSON.stringify({ id: '9', tid: 2 }));
    kv.setItem('sso_token', token({ id: '9', tid: 2 }));
    return { ok: true };
  }, owner);
  assert.equal(sentWith.length, 1);
  assert.equal(tidOfToken(sentWith[0]), 1);
  assert.equal(r.sent, 1);
  assert.equal(r.blocked, true);
  assert.equal(list(kv, owner).length, 1); // the second one waits for school 1
  // Back in school 1 (same person): it goes.
  signIn(kv, '42', 1);
  const again = await flush(kv, async () => ({ ok: true }), owner);
  assert.equal(again.sent, 1);
  assert.equal(list(kv, owner).length, 0);
});

test('tokenFitsItem: school and person must both match; old unstamped items use their queue owner', () => {
  const w = { key: 'k', payload: reg(), savedAt: 1, attempts: 0, tid: 1, uid: '42' };
  assert.equal(tokenFitsItem(token({ id: '42', tid: 1 }), w, '1.42'), true);
  assert.equal(tokenFitsItem(token({ id: '42', tid: 2 }), w, '1.42'), false);
  assert.equal(tokenFitsItem(token({ id: '43', tid: 1 }), w, '1.42'), false);
  assert.equal(tokenFitsItem(null, w, '1.42'), false);
  const old = { key: 'k', payload: reg(), savedAt: 1, attempts: 0 };
  assert.equal(tokenFitsItem(token({ id: '42', tid: 3 }), old, '3.42'), true);
  assert.equal(tokenFitsItem(token({ id: '42', tid: 1 }), old, '3.42'), false);
});

test('registers waiting in another school are listed for the same person (by e-mail) only', () => {
  const kv = new Mem();
  signIn(kv, '42', 1, 'aline@school.test', 'nga');
  enqueue(kv, reg({ period: 1 }), 1);
  enqueue(kv, reg({ period: 2 }), 2);
  rememberBranding(kv, { tid: 1, name: 'NGA Coding Academy', logoUrl: null });
  signIn(kv, '77', 3, 'someone@else.test', 'other');
  enqueue(kv, reg(), 3);
  // Same person, account 900 in school 2.
  signIn(kv, '900', 2, 'ALINE@school.test', 'nga2');
  assert.deepEqual(waitingElsewhere(kv), [{ tid: 1, slug: 'nga', count: 2 }]);
  assert.equal(schoolLabel(kv, 1, 'nga'), 'NGA Coding Academy');
  assert.equal(schoolLabel(kv, 5, 'five'), 'five');
  assert.equal(schoolLabel(kv, 6), 'school 6');
  assert.equal(list(kv).length, 0); // nothing of school 1 is in school 2's queue
});

test('sign-out clears this school\'s cached reads and old ones, keeps another school\'s recent copy', () => {
  const kv = new Mem();
  const now = Date.now();
  signIn(kv, '42', 1);
  writeCache(kv, '/api/mis/classes', { a: 1 });
  signIn(kv, '900', 2);
  writeCache(kv, '/api/mis/classes', { b: 1 });
  kv.setItem('tendo.cache.v2.3.5./api/mis/classes', JSON.stringify({ at: now - 8 * 24 * 3600 * 1000, body: {} }));
  enqueue(kv, reg(), 1);
  clearCache(kv, '2.900', now);
  assert.equal(readCache(kv, '/api/mis/classes'), null);
  assert.equal(kv.getItem('tendo.cache.v2.3.5./api/mis/classes'), null);
  assert.ok(kv.getItem('tendo.cache.v2.1.42./api/mis/classes'));
  assert.equal(list(kv).length, 1); // waiting registers stay
});

test('switch link, MIS home and the analytics identity key', () => {
  assert.equal(
    switchSchoolUrl('https://mis.amashuri.com/', 'https://tendo.amashuri.com'),
    'https://mis.amashuri.com/switch-school?return=https%3A%2F%2Ftendo.amashuri.com%2F%3Fsso%3D1',
  );
  assert.equal(misHomeOf(undefined, 'https://mis.amashuri.com/login'), 'https://mis.amashuri.com');
  assert.equal(misHomeOf('http://localhost:5173', undefined), 'http://localhost:5173');
  const kv = new Mem();
  assert.equal(activityUserKey(kv), null);
  signIn(kv, '42', 2);
  assert.equal(activityUserKey(kv), '2:42');
  kv.setItem('sso_user', JSON.stringify({ id: '42' }));
  assert.equal(activityUserKey(kv), '1:42');
});
