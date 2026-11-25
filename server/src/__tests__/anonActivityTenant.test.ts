import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import request from 'supertest';
import zlib from 'zlib';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { closeTenantDb, getDbFor, initDatabase } from '../database.js';
import { __setTenants, primaryTenantCtx, type TenantCtx } from '../tenancy/index.js';
import { __resetFallbacks, fallbackSnapshot } from '../tenancy/fallbacks.js';
import { activityRouter } from '../routes/activity.js';
import { buildTenantActivityRelay, stripUserIds, tidOfRequest } from '../activity/relay.js';

/**
 * Anonymous (signed-out) activity belongs to no school: it is never routed by
 * a session's school, never sent under a school's X-NGA-Tenant other than the
 * platform's primary bucket, and never carries a user id on the wire.
 */

const TENDO = 'https://tendo.amashuri.com';
const ENV = { NGA_MIS_BASE_URL: 'https://api.example', SSO_CLIENT_ID: 'discipline_attendance', SSO_CLIENT_SECRET: 's3cret' };
const T1 = primaryTenantCtx();
const T2: TenantCtx = { tid: 2, slug: 's2', name: 'School 2', status: 'ACTIVE', isPrimary: false, timezone: 'Africa/Kigali', pkg: 'starter' };

type Sent = { url: string; tenant: string | undefined; body: any };
let sent: Sent[] = [];
const fetchImpl = vi.fn(async (url: string, init: any) => {
  const raw = init?.body
    ? (init.headers?.['Content-Encoding'] === 'gzip' ? zlib.gunzipSync(init.body).toString() : String(init.body))
    : null;
  sent.push({ url, tenant: init?.headers?.['X-NGA-Tenant'], body: raw ? JSON.parse(raw) : null });
  return new Response(JSON.stringify({ accepted: 1, commands: [] }), { status: 202 });
}) as any;

const envelope = () => ({
  v: 1,
  app: 'tendo',
  did: 'AAAAAAAAAAAAAAAAAAAAAA',
  tab: 't1',
  sent_at: Date.now(),
  events: [{ id: '01J00000000000000000000000', n: 'page_view', t: Date.now(), r: '/dashboard' }],
});

const harness = () => {
  const relay = buildTenantActivityRelay(ENV, { fetchImpl, flushMs: 60_000, logger: { warn: () => undefined, error: () => undefined } });
  const server = express();
  server.use('/api/activity', activityRouter(relay));
  return { relay, server };
};
const session = (id: string, tid: number, extra: Record<string, unknown> = {}) =>
  jwt.sign({ id, role: 'teacher', tid, ...extra }, config.jwtSecret, { expiresIn: '1h' });
const ingests = () => sent.filter((s) => s.url.endsWith('/activity/ingest'));

let dataDir: string;
const prevDataDir = process.env.TENDO_DATA_DIR;

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tendo-anon-activity-'));
  process.env.TENDO_DATA_DIR = dataDir;
  __setTenants([T1, T2]);
  await initDatabase(':memory:');
  await initDatabase(2);
  const insert = 'INSERT INTO users (id, name, email, role) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO NOTHING';
  await getDbFor(1).run(insert, '4012', 'One Teacher', 'one@school.test', 'teacher');
  await getDbFor(2).run(insert, '4013', 'Two Teacher', 'two@school.test', 'teacher');
});

afterAll(async () => {
  await closeTenantDb(2);
  __setTenants([primaryTenantCtx()]);
  if (prevDataDir === undefined) delete process.env.TENDO_DATA_DIR;
  else process.env.TENDO_DATA_DIR = prevDataDir;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

afterEach(() => {
  sent = [];
  fetchImpl.mockClear();
  __resetFallbacks();
});

describe('anonymous activity is never attributed to a school', () => {
  it('a signed-in school-2 batch goes under school 2 with its user id', async () => {
    const { relay, server } = harness();
    await request(server).post('/api/activity').set('Authorization', `Bearer ${session('4013', 2)}`).send(envelope());
    await relay.flush();
    expect(ingests()).toHaveLength(1);
    expect(ingests()[0].tenant).toBe('2');
    expect(ingests()[0].body.batches[0].user_id).toBe(4013);
    await relay.stop();
  });

  it('a signed-out visitor goes to the primary bucket explicitly, with no user id, and counts no fallback', async () => {
    const { relay, server } = harness();
    await request(server).post('/api/activity').set('Origin', TENDO).set('Content-Type', 'text/plain').send(JSON.stringify({ ...envelope(), user_id: 4013 }));
    await relay.flush();
    expect(ingests()).toHaveLength(1);
    expect(ingests()[0].tenant).toBe('1');
    expect(ingests()[0].body.batches[0].user_id).toBeNull();
    expect(ingests()[0].body.batches[0].envelope.user_id).toBeUndefined();
    expect(Object.values(fallbackSnapshot().counts).reduce((a, b) => a + b, 0)).toBe(0);
    await relay.stop();
  });

  it("a dead school-2 session (revoked, or user gone) is anonymous -- not filed under school 2", async () => {
    const { relay, server } = harness();
    const db2 = getDbFor(2);
    const old = session('4013', 2, { iat: Math.floor(Date.now() / 1000) - 120 });
    await db2.run('INSERT INTO session_revocations (user_id, revoked_at) VALUES (?, ?)', '4013', Date.now() - 60_000);
    try {
      await request(server).post('/api/activity').set('Authorization', `Bearer ${old}`).set('Origin', TENDO).send(envelope());
      await request(server).post('/api/activity').set('Authorization', `Bearer ${session('999999', 2)}`).set('Origin', TENDO).send(envelope());
      await relay.flush();
      expect(ingests().map((s) => s.tenant)).toEqual(['1']);
      expect(ingests()[0].body.batches).toHaveLength(2);
      expect(ingests()[0].body.batches.every((b: any) => b.user_id === null)).toBe(true);
    } finally {
      await db2.run('DELETE FROM session_revocations WHERE user_id = ?', '4013');
      await relay.stop();
    }
  });

  it('a school-1 session never lends its user id to school 2, and vice versa', async () => {
    const { relay, server } = harness();
    await request(server).post('/api/activity').set('Authorization', `Bearer ${session('4012', 1)}`).send(envelope());
    await request(server).post('/api/activity').set('Authorization', `Bearer ${session('4013', 2)}`).send(envelope());
    // A school-1 token naming a user that only exists in school 2: anonymous.
    await request(server).post('/api/activity').set('Authorization', `Bearer ${session('4013', 1)}`).set('Origin', TENDO).send(envelope());
    await relay.flush();
    // School 1's own relay and the anonymous (primary-bucket) relay post separately.
    const posts = ingests().map((s) => ({ tenant: s.tenant, users: s.body.batches.map((b: any) => b.user_id) }));
    expect(posts).toHaveLength(3);
    expect(posts).toEqual(expect.arrayContaining([
      { tenant: '1', users: [4012] },
      { tenant: '2', users: [4013] },
      { tenant: '1', users: [null] },
    ]));
    await relay.stop();
  });

  it('tidOfRequest is null for anonymous visitors', async () => {
    const req = (auth?: string) => ({ headers: auth ? { authorization: `Bearer ${auth}` } : {} }) as any;
    expect(await tidOfRequest(req())).toBeNull();
    expect(await tidOfRequest(req('not-a-jwt'))).toBeNull();
    expect(await tidOfRequest(req(session('4013', 2)))).toBe(2);
  });

  it('stripUserIds nulls every user id of an ingest body', () => {
    const body = stripUserIds({
      batches: [{ user_id: 5, envelope: { user_id: 5, did: 'x' } }, { user_id: null, envelope: {} }],
      server_events: [{ user_id: 7, n: 'a' }],
    });
    expect(body.batches.map((b: any) => b.user_id)).toEqual([null, null]);
    expect(body.batches[0].envelope.user_id).toBeUndefined();
    expect(body.server_events[0].user_id).toBeNull();
  });
});
