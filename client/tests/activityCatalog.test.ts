// Run with `npm test` (node --test; Node >= 23 strips TypeScript natively).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  _resetActivityForTests,
  _trackerForTests,
  initActivity,
  resolveRoute,
  type CatalogEntry,
} from '../src/vendor/nga-activity/index.ts';

/**
 * Usage analytics feature catalog (nga_central_mis USAGE_ANALYTICS_IMPLEMENTATION_PLAN.md §5.4):
 * every route in App.tsx must resolve to a named Tendo feature, and the client
 * copy must equal the server's source of truth (which is published to MIS).
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER_CATALOG = path.resolve(here, '../../server/src/activity/catalog.json');
const CLIENT_CATALOG = path.resolve(here, '../src/activity/catalog.json');
const catalog = JSON.parse(fs.readFileSync(CLIENT_CATALOG, 'utf8')) as { app: string; features: CatalogEntry[] };

/** The SDK's own route compiler, reached through a tracker that never starts. */
async function compiledPatterns() {
  const g = globalThis as unknown as Record<string, unknown>;
  const saved = { window: g.window, fetch: g.fetch };
  g.window = {}; // storage/cookie access is guarded, so a bare object is enough
  // Config says "disabled": the tracker destroys itself instead of attaching listeners.
  g.fetch = async () => ({ ok: true, json: async () => ({ enabled: false, v: 1 }) });
  try {
    initActivity({ app: 'tendo', endpoint: '/x', configUrl: '/x', catalog: catalog.features });
    const t = _trackerForTests();
    assert.ok(t, 'tracker initialised');
    const compiled = t.compiled;
    await new Promise((r) => setTimeout(r, 0)); // let loadConfig settle
    return compiled;
  } finally {
    _resetActivityForTests();
    g.window = saved.window;
    g.fetch = saved.fetch;
  }
}

test('client catalog equals the server source of truth (npm run activity:catalog)', () => {
  assert.equal(fs.readFileSync(CLIENT_CATALOG, 'utf8'), fs.readFileSync(SERVER_CATALOG, 'utf8'));
});

test('every <Route path> in App.tsx resolves to a named tendo feature', async () => {
  const app = fs.readFileSync(path.resolve(here, '../src/App.tsx'), 'utf8');
  const paths = [...new Set([...app.matchAll(/path="([^"]+)"/g)].map((m) => m[1]).filter((p) => p !== '*'))];
  assert.ok(paths.length > 20, `found ${paths.length} routes`);
  const compiled = await compiledPatterns();
  const concrete = (p: string) => p.replace(/:[A-Za-z]+/g, '123');
  const missing = paths.filter((p) => resolveRoute('tendo', compiled, concrete(p)).feature === 'tendo.other');
  assert.deepEqual(missing, []);
  // Spot-check specificity: a literal segment beats a :param.
  assert.equal(resolveRoute('tendo', compiled, '/excuses/review').feature, 'tendo.excuse_review');
  assert.equal(resolveRoute('tendo', compiled, '/excuses/42').feature, 'tendo.excuse_detail');
  assert.equal(resolveRoute('tendo', compiled, '/').feature, 'tendo.login');
});

test('feature keys are unique and namespaced', () => {
  assert.equal(catalog.app, 'tendo');
  const keys = catalog.features.map((f) => f.key);
  assert.equal(new Set(keys).size, keys.length);
  for (const k of keys) assert.match(k, /^tendo\.[a-z0-9_.]+$/);
});

test('every data-track key in the client is a catalogued event', () => {
  const events = new Set(catalog.features.filter((f) => f.event).map((f) => f.key));
  const used = new Set<string>();
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== 'vendor') walk(p);
      } else if (/\.tsx?$/.test(e.name)) {
        for (const m of fs.readFileSync(p, 'utf8').matchAll(/data-track="([^"]+)"/g)) used.add(m[1]);
      }
    }
  };
  walk(path.resolve(here, '../src'));
  assert.ok(used.size >= 6, `found ${used.size} tracked buttons`);
  assert.deepEqual([...used].filter((k) => !events.has(k)), []);
});

test('vendored SDK files match their provenance hash', () => {
  for (const f of ['index.ts', 'react.ts']) {
    const text = fs.readFileSync(path.resolve(here, '../src/vendor/nga-activity', f), 'utf8');
    const [, , shaLine, ...rest] = text.split('\n');
    assert.equal(shaLine, `// sha256:${crypto.createHash('sha256').update(rest.join('\n')).digest('hex')}`, f);
  }
});
