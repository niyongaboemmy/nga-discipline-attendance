import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getSnapshot, noteAccessVersion, __ageSnapshot, __resetSnapshotCache } from '../access/snapshot.js';

const snap = (v: number) => ({
  v, app: 'da', core: '1.0.0', user: { id: 42, persona: 'TEACHER', school_id: 1 }, year: 5,
  caps: { ATTENDANCE_MARK: [{ depth: null, scope: { class_groups: [7] }, via: [1] }] },
  grants: {}, home: null, systems: ['da'], generated_at: '2026-09-27T00:00:00Z',
});

const user = { id: '42' };
const MIN = 60 * 1000;

describe('access snapshot client', () => {
  let version = 1;
  let mode: 'ok' | 'down' | '503' = 'ok';
  let calls = 0;

  beforeEach(() => {
    __resetSnapshotCache();
    version = 1;
    mode = 'ok';
    calls = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls += 1;
      expect(String(url)).toContain('/access/me?app=da');
      expect((init?.headers as any)?.Authorization).toBe('Bearer mis-token');
      if (mode === 'down') throw new TypeError('fetch failed');
      if (mode === '503') return new Response('{"success":false}', { status: 503 });
      return new Response(JSON.stringify({ success: true, data: snap(version) }), { status: 200 });
    }));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('caches per MIS user and de-duplicates concurrent fetches', async () => {
    const [a, b] = await Promise.all([getSnapshot(user, 'mis-token'), getSnapshot(user, 'mis-token')]);
    expect(a?.v).toBe(1);
    expect(b).toBe(a);
    await getSnapshot(user, 'mis-token');
    expect(calls).toBe(1);
  });

  it('re-fetches when verify-mis reports a different access_version, not when it is the same', async () => {
    await getSnapshot(user, 'mis-token');
    noteAccessVersion(42, 1);
    await getSnapshot(user, 'mis-token');
    expect(calls).toBe(1);

    version = 2;
    noteAccessVersion(42, 2);
    const s = await getSnapshot(user, 'mis-token');
    expect(s?.v).toBe(2);
    expect(calls).toBe(2);
  });

  it('ignores a non-numeric access_version (older MIS)', async () => {
    await getSnapshot(user, 'mis-token');
    noteAccessVersion(42, null);
    noteAccessVersion(42, undefined);
    await getSnapshot(user, 'mis-token');
    expect(calls).toBe(1);
  });

  it('refreshes after the freshness window', async () => {
    await getSnapshot(user, 'mis-token');
    __ageSnapshot(42, 6 * MIN);
    await getSnapshot(user, 'mis-token');
    expect(calls).toBe(2);
  });

  it('keeps the last good snapshot while MIS is unreachable, then fails closed after 24h', async () => {
    await getSnapshot(user, 'mis-token');
    mode = 'down';
    __ageSnapshot(42, 6 * MIN);
    expect((await getSnapshot(user, 'mis-token'))?.v).toBe(1);

    __resetSnapshotCache();
    mode = 'ok';
    await getSnapshot(user, 'mis-token');
    mode = 'down';
    __ageSnapshot(42, 24 * 60 * MIN + 1);
    expect(await getSnapshot(user, 'mis-token')).toBeNull();
  });

  it('treats 503 (access v2 not installed on MIS) as unavailable and backs off', async () => {
    mode = '503';
    expect(await getSnapshot(user, 'mis-token')).toBeNull();
    expect(await getSnapshot(user, 'mis-token')).toBeNull();
    expect(calls).toBe(1);
  });

  it('has nothing for a user without a numeric MIS id or a MIS token', async () => {
    expect(await getSnapshot({ id: 'admin-1' }, 'mis-token')).toBeNull();
    expect(await getSnapshot(user, undefined)).toBeNull();
    expect(calls).toBe(0);
  });
});
