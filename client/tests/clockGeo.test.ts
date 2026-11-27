// Run with `npm test`. The staff check-in's location reader against how Safari behaves:
// a permission question that stays open, "position unavailable" before a Mac finds
// itself, a refusal, and an error callback fired straight away.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appleBrowser, GeoError, sampleLocation } from '../src/clock/geo.ts';

type Ok = (p: unknown) => void;
type Fail = (e: { code: number }) => void;
interface Watch { ok: Ok; fail: Fail; opts: { enableHighAccuracy?: boolean; maximumAge?: number; timeout?: number } }

/** A stand-in for navigator.geolocation: the test decides what each watch answers. */
function fakeGeo(onWatch: (w: Watch, n: number) => void, permission: string | null = 'prompt') {
  const watches: Watch[] = [];
  const cleared: number[] = [];
  const nav = {
    geolocation: {
      watchPosition(ok: Ok, fail: Fail, opts: Watch['opts']) {
        const w = { ok, fail, opts };
        watches.push(w);
        onWatch(w, watches.length);
        return watches.length;
      },
      clearWatch(id: number) { cleared.push(id); },
    },
    permissions: { query: async () => { if (permission == null) throw new Error('no'); return { state: permission }; } },
    userAgent: 'test', maxTouchPoints: 0,
  };
  Object.defineProperty(globalThis, 'navigator', { value: nav, configurable: true });
  return { watches, cleared };
}
const pos = (accuracy: number) => ({ coords: { latitude: -1.95, longitude: 30.06, accuracy }, timestamp: Date.now() });

test('which Apple browser: Safari, other iPhone browsers, the installed app, a Mac', () => {
  const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
  const mac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
  assert.equal(appleBrowser(iphone, 5, false), 'ios-safari');
  assert.equal(appleBrowser(iphone, 5, true), 'ios-app');
  assert.equal(appleBrowser(iphone.replace('Version/18.0', 'CriOS/130.0'), 5, false), 'ios-other');
  assert.equal(appleBrowser(mac, 0, false), 'mac-safari');
  assert.equal(appleBrowser(mac, 5, false), 'ios-safari'); // an iPad says it is a Mac
  assert.equal(appleBrowser(mac.replace('Version/18.0 Safari/605.1.15', 'Chrome/130.0 Safari/537.36'), 0, false), null);
  assert.equal(appleBrowser('Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36', 5, false), null);
});

test('a permission question answered after the wait is over still gives the position', async () => {
  // Safari asks on most visits; the person took longer than maxMs to tap Allow.
  fakeGeo((w) => { setTimeout(() => w.ok(pos(12)), 200); setTimeout(() => w.ok(pos(11)), 220); });
  const r = await sampleLocation({ maxMs: 40, goodEnough: 20 });
  assert.equal(r.best.accuracy, 11);
});

test('no timeout is handed to the browser: our own clock decides', async () => {
  const g = fakeGeo((w) => { setTimeout(() => { w.ok(pos(10)); w.ok(pos(10)); }, 5); });
  await sampleLocation({ maxMs: 500 });
  assert.equal(g.watches[0].opts.timeout, undefined);
  assert.equal(g.watches[0].opts.enableHighAccuracy, true);
  assert.deepEqual(g.cleared, [1]);
});

test('permission already given: the wait is maxMs, not the question allowance', async () => {
  fakeGeo(() => { /* never answers */ }, 'granted');
  const t0 = Date.now();
  await assert.rejects(sampleLocation({ maxMs: 60 }), (e: unknown) => e instanceof GeoError && e.kind === 'timeout');
  assert.ok(Date.now() - t0 < 2000);
});

test('"position unavailable" first (a Mac that has not found itself): a second, coarse watch answers', async () => {
  const g = fakeGeo((w, n) => {
    if (n === 1) setTimeout(() => w.fail({ code: 2 }), 5);
    else setTimeout(() => w.ok(pos(65)), 30);
  });
  const r = await sampleLocation({ maxMs: 300 });
  assert.equal(r.best.accuracy, 65);
  assert.equal(g.watches.length, 2);
  assert.equal(g.watches[1].opts.enableHighAccuracy, false);
  assert.deepEqual(g.cleared.sort(), [1, 2]);
});

test('unavailable both ways: says so, quickly', async () => {
  fakeGeo((w) => { setTimeout(() => w.fail({ code: 2 }), 5); });
  await assert.rejects(sampleLocation({ maxMs: 5000 }), (e: unknown) => e instanceof GeoError && e.kind === 'unavailable');
});

test('a late error does not throw away a reading already in hand', async () => {
  fakeGeo((w) => { setTimeout(() => w.ok(pos(40)), 5); setTimeout(() => w.fail({ code: 2 }), 15); });
  const r = await sampleLocation({ maxMs: 80 });
  assert.equal(r.best.accuracy, 40);
});

test('a refusal is reported as denied, even when the callback fires at once', async () => {
  // Fired inside watchPosition, before it returned an id (must not crash on the id).
  fakeGeo((w) => w.fail({ code: 1 }));
  await assert.rejects(sampleLocation({ maxMs: 100 }), (e: unknown) => e instanceof GeoError && e.kind === 'denied');
});

test('no permissions API at all (older Safari): still works', async () => {
  fakeGeo((w) => { setTimeout(() => { w.ok(pos(8)); w.ok(pos(8)); }, 5); }, null);
  const r = await sampleLocation({ maxMs: 100 });
  assert.equal(r.best.accuracy, 8);
});
