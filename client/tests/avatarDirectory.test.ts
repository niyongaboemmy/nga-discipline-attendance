// Run with `npm test` (node --test; Node >= 23 strips TypeScript natively).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { requestAvatar, getCachedAvatar, primeAvatar, isMisId, _setAvatarTransportForTests } from '../src/utils/avatarDirectory.ts';

const A = (id: number) => ({ version: 1, sm: `https://api.amashuri.com/avatars/${id}/1/sm.webp?s=x`, md: `https://x/${id}/md`, lg: `https://x/${id}/lg` });
const settle = () => new Promise((r) => setTimeout(r, 40));
let calls: string[][] = [];

beforeEach(() => {
  calls = [];
  _setAvatarTransportForTests(async (ids) => {
    calls.push(ids);
    return Object.fromEntries(ids.filter((id) => id !== '2').map((id) => [id, A(Number(id))]));
  });
});

test('every id asked for in one render goes out as one lookup, without duplicates', async () => {
  requestAvatar('1');
  requestAvatar(2);
  requestAvatar('1');
  await settle();
  assert.deepEqual(calls, [['1', '2']]);
  assert.deepEqual(getCachedAvatar(1), A(1));
  assert.equal(getCachedAvatar('2'), null);
  requestAvatar('2');
  await settle();
  assert.equal(calls.length, 1, 'no photo is remembered too');
});

test('ids that are not MIS user ids are never sent', async () => {
  for (const id of ['', 'MIS-USER', 'aline@school.test', '0', '-3', null, undefined]) requestAvatar(id as any);
  await settle();
  assert.deepEqual(calls, []);
  assert.equal(isMisId('9101'), true);
  assert.equal(isMisId('someone@x.rw'), false);
});

test('a failed lookup leaves initials and does not retry', async () => {
  _setAvatarTransportForTests(async (ids) => { calls.push(ids); throw new Error('offline'); });
  requestAvatar('7');
  await settle();
  requestAvatar('7');
  await settle();
  assert.equal(calls.length, 1);
  assert.equal(getCachedAvatar('7'), null);
});

test('large pages are split into lookups of 500', async () => {
  for (let i = 1; i <= 501; i++) requestAvatar(String(1000 + i));
  await settle();
  assert.deepEqual(calls.map((c) => c.length), [500, 1]);
});

test('a primed photo is used without asking', async () => {
  primeAvatar('55', A(55));
  requestAvatar('55');
  await settle();
  assert.deepEqual(calls, []);
});
