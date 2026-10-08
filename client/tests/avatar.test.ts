// Run with `npm test` (node --test; Node >= 23 strips TypeScript natively).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { avatarSrc, initialsOf, withPolledAvatar, type MisAvatar } from '../src/utils/avatar.ts';

const A: MisAvatar = {
  version: 1790000000,
  sm: 'https://api.amashuri.com/avatars/1/1790000000/sm.webp?s=a',
  md: 'https://api.amashuri.com/avatars/1/1790000000/md.webp?s=a',
  lg: 'https://api.amashuri.com/avatars/1/1790000000/lg.webp?s=a',
};
const B: MisAvatar = { ...A, version: 1790000500, md: A.md.replace('1790000000', '1790000500') };

test('picks a rendition sharp enough for 2x screens', () => {
  assert.equal(avatarSrc(A, 28), A.sm);
  assert.equal(avatarSrc(A, 48), A.md);
  assert.equal(avatarSrc(A, 200), A.lg);
  assert.equal(avatarSrc(null, 28), null);
});

test('a poll that reports the same picture changes nothing', () => {
  const user = { id: '1', avatar: A };
  assert.equal(withPolledAvatar(user, { ...A }), user);
  assert.equal(withPolledAvatar(user, undefined), user);
});

test('a poll with a new or removed picture updates the user', () => {
  const user = { id: '1', avatar: A };
  assert.deepEqual(withPolledAvatar(user, B), { id: '1', avatar: B });
  assert.deepEqual(withPolledAvatar(user, null), { id: '1', avatar: null });
  const none = { id: '1' } as { id: string; avatar?: MisAvatar | null };
  assert.equal(withPolledAvatar(none, null), none);
  assert.deepEqual(withPolledAvatar(none, A), { id: '1', avatar: A });
});

test('initials', () => {
  assert.equal(initialsOf('Aline Uwase'), 'AU');
  assert.equal(initialsOf('Jean Paul Habimana'), 'JH');
  assert.equal(initialsOf('aline'), 'A');
  assert.equal(initialsOf(''), '?');
});
