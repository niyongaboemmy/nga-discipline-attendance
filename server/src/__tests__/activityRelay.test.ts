import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import zlib from 'zlib';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { Database } from 'sqlite';
import { setupTestDb, createTestUser, authHeader } from './testUtils.js';
import { config } from '../config.js';
import { app } from '../app.js';
import { activityRouter } from '../routes/activity.js';
import { activityRelay, buildActivityRelay } from '../activity/relay.js';

/**
 * Usage analytics relay (nga_central_mis USAGE_ANALYTICS_IMPLEMENTATION_PLAN.md §5.2):
 * the browser posts to /api/activity, the relay stamps the MIS user id from
 * the Tendo session (never from the body) and forwards to MIS.
 */
const TENDO = 'https://tendo.amashuri.com';
const ENV = {
  NGA_MIS_BASE_URL: 'https://api.example',
  SSO_CLIENT_ID: 'discipline_attendance',
  SSO_CLIENT_SECRET: 's3cret',
};

type Sent = { url: string; body: any };
let sent: Sent[] = [];
const fetchImpl = vi.fn(async (url: string, init: any) => {
  const raw = init?.body
    ? (init.headers?.['Content-Encoding'] === 'gzip' ? zlib.gunzipSync(init.body).toString() : String(init.body))
    : null;
  sent.push({ url, body: raw ? JSON.parse(raw) : null });
  return new Response(JSON.stringify({ accepted: 1, commands: [] }), { status: 202 });
}) as any;

const envelope = (extra: Record<string, unknown> = {}) => ({
  v: 1,
  app: 'tendo',
  did: 'AAAAAAAAAAAAAAAAAAAAAA',
  tab: 't1',
  sent_at: Date.now(),
  events: [{ id: '01J00000000000000000000000', n: 'page_view', t: Date.now(), r: '/dashboard' }],
  ...extra,
});

/** The real router + the real app's proxy setting, around a relay we can inspect. */
const harness = (env: Record<string, string> = ENV) => {
  const relay = buildActivityRelay(env, { fetchImpl, flushMs: 60_000, logger: { warn: () => undefined, error: () => undefined } });
  const server = express();
  server.set('trust proxy', app.get('trust proxy'));
  server.use('/api/activity', activityRouter(relay));
  return { relay, server };
};

describe('Usage analytics relay (/api/activity)', () => {
  let db: Database;
  let token: string;

  beforeAll(async () => {
    db = await setupTestDb();
    token = (await createTestUser(db, { id: '4012', name: 'Tess Teacher', email: 'tess@school.test', roleLevel: 'TEACHER' })).token;
  });

  afterEach(() => {
    sent = [];
    fetchImpl.mockClear();
  });

  it('stamps a signed-in batch with the MIS user id and the real client IP, ignoring any id in the body', async () => {
    const { relay, server } = harness();
    const res = await request(server)
      .post('/api/activity')
      .set(authHeader(token))
      .set('X-Forwarded-For', '102.22.1.9')
      .send({ ...envelope(), user_id: 999 });
    expect(res.status).toBe(204);
    expect(relay._queue().batches).toBe(1);

    await relay.flush();
    expect(sent[0].url).toBe('https://api.example/activity/ingest');
    expect(sent[0].body.app).toBe('tendo');
    const batch = sent[0].body.batches[0];
    expect(batch).toMatchObject({ user_id: 4012, ip: '102.22.1.9' });
    expect(batch.envelope.user_id).toBeUndefined();
    await relay.stop();
  });

  it('accepts a text/plain beacon from its own origin as an anonymous visitor', async () => {
    const { relay, server } = harness();
    const res = await request(server)
      .post('/api/activity')
      .set('Origin', TENDO)
      .set('Content-Type', 'text/plain')
      .send(JSON.stringify(envelope()));
    expect(res.status).toBe(204);
    await relay.flush();
    expect(sent[0].body.batches[0].user_id).toBeNull();
    await relay.stop();
  });

  it('drops an anonymous batch from a foreign origin (or with no origin)', async () => {
    const { relay, server } = harness();
    expect((await request(server).post('/api/activity').set('Origin', 'https://evil.example').send(envelope())).status).toBe(204);
    expect((await request(server).post('/api/activity').send(envelope())).status).toBe(204);
    expect(relay._queue().batches).toBe(0);
    await relay.stop();
  });

  it('treats an invalid, expired, revoked or orphaned session as anonymous -- never a 401', async () => {
    const { relay, server } = harness();
    const bad = [
      'not-a-jwt',
      jwt.sign({ id: '4012' }, 'some-other-secret'),
      jwt.sign({ id: '4012', exp: Math.floor(Date.now() / 1000) - 60 }, config.jwtSecret),
      jwt.sign({ id: '777777' }, config.jwtSecret), // no local user row
    ];
    for (const t of bad) {
      const res = await request(server).post('/api/activity').set(authHeader(t)).set('Origin', 'https://evil.example').send(envelope());
      expect(res.status).toBe(204);
    }
    expect(relay._queue().batches).toBe(0);

    // Single sign-out: a session issued before the MIS sign-out is over.
    const old = jwt.sign({ id: '4012', iat: Math.floor(Date.now() / 1000) - 120 }, config.jwtSecret);
    await db.run('INSERT INTO session_revocations (user_id, revoked_at) VALUES (?, ?)', '4012', Date.now() - 60_000);
    try {
      await request(server).post('/api/activity').set(authHeader(old)).set('Origin', TENDO).send(envelope());
      await relay.flush();
      expect(sent[0].body.batches[0].user_id).toBeNull();
    } finally {
      await db.run('DELETE FROM session_revocations WHERE user_id = ?', '4012');
      await relay.stop();
    }
  });

  it('is a no-op without MIS configured: 204 on POST, {enabled:false} config, nothing forwarded', async () => {
    const { relay, server } = harness({});
    const res = await request(server).post('/api/activity').set(authHeader(token)).send(envelope());
    expect(res.status).toBe(204);
    const cfg = await request(server).get('/api/activity/config?did=AAAAAAAAAAAAAAAAAAAAAA');
    expect(cfg.status).toBe(200);
    expect(cfg.body).toEqual({ enabled: false, v: 1 });
    relay.track(4012, null, 'tendo.register.save', {});
    await relay.flush();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(relay._queue()).toEqual({ batches: 0, serverEvents: 0 });
  });

  it('a malformed body is dropped with 204, not an error page', async () => {
    const { server } = harness();
    const res = await request(server).post('/api/activity').set('Content-Type', 'application/json').send('{"oops"');
    expect(res.status).toBe(204);
  });

  it('is mounted on the real app ahead of the 200 kB global parser, with no auth', async () => {
    // ~220 kB: over the global 200 kB limit, under the relay's 256 kB.
    const big = JSON.stringify(envelope({ pad: 'x'.repeat(220 * 1024) }));
    const res = await request(app).post('/api/activity').set('Origin', 'https://evil.example').set('Content-Type', 'text/plain').send(big);
    expect(res.status).toBe(204);
    expect(app.get('trust proxy')).toBe('loopback');
  });

  it('records the key events server-side: register saved, incident logged, excuse approved', async () => {
    const track = vi.spyOn(activityRelay, 'track');
    const student = await createTestUser(db, { id: '5001', name: 'Sam Student', email: 'sam@school.test', roleLevel: 'STUDENT' });

    const mark = await request(app).post('/api/attendance/mark').set(authHeader(token)).send({
      classId: 'c-1', className: 'S1 A', date: '2026-06-02', period: 'Morning',
      records: [{ studentId: '5001', studentName: 'Sam Student', status: 'absent' }],
    });
    expect(mark.status).toBe(200);

    const incident = await request(app).post('/api/discipline').set(authHeader(token)).send({
      studentId: '5001', studentName: 'Sam Student', type: 'demerit', category: 'Misconduct', severity: 'minor',
      title: 'Late to class', incidentDate: '2026-06-02',
    });
    expect(incident.status).toBe(200);

    const excuse = await request(app).post('/api/attendance/excuse').set(authHeader(student.token)).send({
      classId: 'c-1', className: 'S1 A', sessionDate: '2026-06-02', reason: 'Medical',
    });
    expect(excuse.status).toBeLessThan(300);
    const approve = await request(app).put(`/api/attendance/excuse/${excuse.body.data.id}/status`)
      .set(authHeader(token)).send({ status: 'approved' });
    expect(approve.status).toBe(200);

    const calls = track.mock.calls.map(([userId, , name, params]) => ({ userId, name, params }));
    track.mockRestore();
    expect(calls).toEqual([
      { userId: 4012, name: 'tendo.register.save', params: expect.objectContaining({ class_id: 'c-1', students: 1, inserted: 1, updated: 0 }) },
      { userId: 4012, name: 'tendo.incident.create', params: expect.objectContaining({ type: 'demerit', count: 1, bulk: false }) },
      { userId: 4012, name: 'tendo.excuse.approve', params: expect.objectContaining({ excuse_id: excuse.body.data.id, bulk: false }) },
    ]);
    // Never free text.
    expect(JSON.stringify(calls)).not.toMatch(/Late to class|Medical|Sam Student/);
  });

  it('vendored relay copy matches its provenance hash', () => {
    const text = fs.readFileSync(path.resolve(__dirname, '../vendor/nga-activity-relay/relay.ts'), 'utf8');
    const [, , shaLine, ...rest] = text.split('\n');
    expect(shaLine).toBe(`// sha256:${crypto.createHash('sha256').update(rest.join('\n')).digest('hex')}`);
  });

  it('the feature catalog is well formed and lists the key events', () => {
    const catalog = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../activity/catalog.json'), 'utf8'));
    expect(catalog.app).toBe('tendo');
    const keys = catalog.features.map((f: any) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const f of catalog.features) {
      expect(f.key).toMatch(/^tendo\.[a-z0-9_.]+$/);
      expect(typeof f.label).toBe('string');
      expect(Boolean(f.event) !== Boolean(f.patterns?.length)).toBe(true);
    }
    for (const k of ['tendo.register.save', 'tendo.incident.create', 'tendo.excuse.approve']) {
      expect(catalog.features.find((f: any) => f.key === k)).toMatchObject({ event: true, key_event: true });
    }
  });
});
