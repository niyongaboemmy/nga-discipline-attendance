import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { app } from '../app.js';
import { config } from '../config.js';
import { closeTenantDb, getDbFor, initDatabase } from '../database.js';
import { __setRegistryStrict, __setTenants, primaryTenantCtx, runWithTenant, type TenantCtx } from '../tenancy/index.js';
import { __resetFallbacks, fallbackSnapshot } from '../tenancy/fallbacks.js';
import { __resetMisBearerCache } from '../middleware/misBearerAuth.js';
import { __resetSnapshotCache, getSnapshot } from '../access/snapshot.js';
import { LOGOUT_EVENT, setJwksFetcher } from '../utils/ssoLogout.js';
import { rfidBridgeTid } from '../modules/rfid/rfid.scheduler.js';

/**
 * Regression tests for the Tendo findings of the 2026-11-25 cross-school
 * isolation audit (TD-ISO-1, -2, -4, -5, -7). Two schools: tenant 1 in
 * memory, tenant 2 a real file under a temp TENDO_DATA_DIR.
 */

const T1 = primaryTenantCtx();
const T2: TenantCtx = { tid: 2, slug: 's2', name: 'School 2', status: 'ACTIVE', isPrimary: false, timezone: 'Africa/Kigali', pkg: 'starter' };

let dataDir: string;
const prevDataDir = process.env.TENDO_DATA_DIR;
const realFetch = globalThis.fetch;

/** An MIS-shaped JWT (only its claims matter to Tendo; MIS verifies it). */
const misJwt = (claims: Record<string, unknown>) => jwt.sign({ userId: 4242, ...claims }, 'mis-secret');
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify({ success: status < 400, data }), { status, headers: { 'Content-Type': 'application/json' } });

/** Fake MIS: /auth/verify answers `verify`, /access/me counts calls per token. */
let verify: Record<string, unknown> = {};
let accessCalls = 0;
let ssoToken: Record<string, unknown> = {};
function installMis() {
  globalThis.fetch = (async (input: any) => {
    const u = String(input);
    if (u.endsWith('/auth/verify')) return json(verify);
    if (u.includes('/access/me')) {
      accessCalls += 1;
      return json({ v: 1, caps: {}, app: 'da' });
    }
    if (u.includes('/sso/token')) return json(ssoToken);
    return json({});
  }) as typeof fetch;
}

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tendo-iso-fix-'));
  process.env.TENDO_DATA_DIR = dataDir;
  __setTenants([T1, T2]);
  await initDatabase(':memory:');
  await initDatabase(2);
  installMis();
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  await closeTenantDb(2);
  __setTenants([primaryTenantCtx()]);
  if (prevDataDir === undefined) delete process.env.TENDO_DATA_DIR;
  else process.env.TENDO_DATA_DIR = prevDataDir;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

afterEach(() => {
  delete process.env.TENANCY_MODE;
  delete process.env.TENANCY_LEGACY_DEFAULT_TID;
  __setRegistryStrict(false);
  __resetMisBearerCache();
  __resetSnapshotCache();
  __resetFallbacks();
  installMis();
});

const homeSummary = (token: string) => request(app).post('/api/integration/home-summary').set(bearer(token)).send({});

describe('TD-ISO-1: MIS bearer version hints run inside the tenant', () => {
  it('TD-ISO-1 enforce mode: a version hint on /api/integration/home-summary is 200, not 500', async () => {
    process.env.TENANCY_MODE = 'enforce';
    verify = { userId: 4242, tenant: { tid: 2, slug: 's2', status: 'ACTIVE' }, access_version: 3, ai_policy_v: 2, ai_routes_v: 4 };
    const res = await homeSummary(misJwt({ tid: 2, n: 1 }));
    expect(res.status).toBe(200);
  });

  it('TD-ISO-1 a school-2 version hint never evicts school 1’s snapshot (and still refreshes school 2’s)', async () => {
    const user = { id: '4242' };
    await runWithTenant(T1, () => getSnapshot(user, 'tok'));
    await runWithTenant(T2, () => getSnapshot(user, 'tok'));
    expect(accessCalls).toBe(2);

    verify = { userId: 4242, tenant: { tid: 2, slug: 's2', status: 'ACTIVE' }, access_version: 99 };
    expect((await homeSummary(misJwt({ tid: 2, n: 2 }))).status).toBe(200);

    await runWithTenant(T1, () => getSnapshot(user, 'tok'));
    expect(accessCalls).toBe(2); // school 1's cached snapshot untouched
    await runWithTenant(T2, () => getSnapshot(user, 'tok'));
    expect(accessCalls).toBe(3); // school 2's was dropped by its own hint
  });

  it('TD-ISO-1 a verification with hints counts no fallback', async () => {
    __resetFallbacks();
    verify = { userId: 4242, tenant: { tid: 2, slug: 's2', status: 'ACTIVE' }, access_version: 5, ai_policy_v: 1, ai_routes_v: 1 };
    expect((await homeSummary(misJwt({ tid: 2, n: 3 }))).status).toBe(200);
    expect(fallbackSnapshot().counts).toEqual({ no_context: 0, legacy_tid: 0, payload_no_tid: 0 });
  });
});

describe('TD-ISO-5: MIS verify tenant vs the token’s tid', () => {
  it('TD-ISO-5 a verify answer for another school than the token names is 401 TENANT_MISMATCH, never cached', async () => {
    const token = misJwt({ tid: 1, n: 5 });
    verify = { userId: 4242, tenant: { tid: 2, slug: 's2', status: 'ACTIVE' } };
    const bad = await homeSummary(token);
    expect([bad.status, bad.body.code]).toEqual([401, 'TENANT_MISMATCH']);

    verify = { userId: 4242, tenant: { tid: 1, slug: 'nga', status: 'ACTIVE' } };
    expect((await homeSummary(token)).status).toBe(200);
  });
});

describe('TD-ISO-2: no legacy school at sign-in or for a tid-less MIS token', () => {
  it('TD-ISO-2 SSO /exchange refuses when neither MIS’s answer nor its token names a school', async () => {
    ssoToken = { token: 'opaque-mis-token', user: { user_id: 7701, username: 'nobody', email: 'n@x.test' }, permissions: [] };
    const res = await request(app).post('/api/sso/exchange').send({ code: 'c1' });
    expect([res.status, res.body.code]).toEqual([401, 'TENANT_REQUIRED']);
    expect(await getDbFor(1).get(`SELECT 1 FROM users WHERE id = '7701'`)).toBeUndefined();
    expect(await getDbFor(2).get(`SELECT 1 FROM users WHERE id = '7701'`)).toBeUndefined();
  });

  it('TD-ISO-2 SSO /exchange with a tid in the MIS token signs a session for that school', async () => {
    ssoToken = { token: misJwt({ userId: 7702, tid: 2 }), user: { user_id: 7702, username: 'b', email: 'b@x.test' }, permissions: [] };
    const res = await request(app).post('/api/sso/exchange').send({ code: 'c2' });
    expect(res.status).toBe(200);
    expect((jwt.decode(res.body.data.token) as any).tid).toBe(2);
    expect(await getDbFor(2).get(`SELECT 1 FROM users WHERE id = '7702'`)).toBeTruthy();
    expect(await getDbFor(1).get(`SELECT 1 FROM users WHERE id = '7702'`)).toBeUndefined();
  });

  it('TD-ISO-2 a session whose nested MIS token has no tid is refused in strict mode only', async () => {
    await getDbFor(1).run(`INSERT OR IGNORE INTO users (id, name, email, role) VALUES ('7703', 'C', 'c@x.test', 'teacher')`);
    const session = jwt.sign(
      { id: '7703', name: 'C', email: 'c@x.test', role: 'teacher', tid: 1, misToken: jwt.sign({ userId: 7703 }, 'mis-secret') },
      config.jwtSecret,
      { expiresIn: '1h' },
    );
    const probe = () => request(app).get('/api/attendance/schedule/day').set(bearer(session));
    expect((await probe()).status).not.toBe(401);

    __setRegistryStrict(true);
    const strict = await probe();
    expect([strict.status, strict.body.code]).toEqual([401, 'TENANT_REQUIRED']);
    __setRegistryStrict(false);

    process.env.TENANCY_LEGACY_DEFAULT_TID = 'none';
    expect((await probe()).body.code).toBe('TENANT_REQUIRED');
  });
});

describe('TD-ISO-4: back-channel logout without tid', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...(publicKey.export({ format: 'jwk' }) as object), kid: 'iso4', alg: 'RS256', use: 'sig' };
  const logoutToken = (sub: string, claims: Record<string, unknown> = {}) =>
    jwt.sign(
      { iss: config.ngaMisBaseUrl.replace(/\/$/, ''), aud: config.ssoClientId, jti: crypto.randomUUID(), sub, events: { [LOGOUT_EVENT]: {} }, ...claims },
      privateKey,
      { algorithm: 'RS256', keyid: 'iso4', expiresIn: 120 },
    );
  beforeAll(() => setJwksFetcher(async () => ({ keys: [jwk as any] })));
  afterAll(() => setJwksFetcher(null));

  it('TD-ISO-4 a logout token without tid is refused, revokes nothing and counts payload_no_tid', async () => {
    __resetFallbacks();
    const res = await request(app).post('/api/sso/backchannel-logout').type('form').send({ logout_token: logoutToken('7704') });
    expect(res.status).toBe(400);
    expect(await getDbFor(1).get(`SELECT 1 FROM session_revocations WHERE user_id = '7704'`)).toBeUndefined();
    expect(await getDbFor(2).get(`SELECT 1 FROM session_revocations WHERE user_id = '7704'`)).toBeUndefined();
    expect(fallbackSnapshot().counts.payload_no_tid).toBe(1);
  });

  it('TD-ISO-4 with a tid it still revokes in that school only', async () => {
    const res = await request(app).post('/api/sso/backchannel-logout').type('form').send({ logout_token: logoutToken('7705', { tid: 2 }) });
    expect(res.status).toBe(200);
    expect(await getDbFor(2).get(`SELECT 1 FROM session_revocations WHERE user_id = '7705'`)).toBeTruthy();
    expect(await getDbFor(1).get(`SELECT 1 FROM session_revocations WHERE user_id = '7705'`)).toBeUndefined();
  });
});

describe('TD-ISO-7: RFID_BRIDGE_TID', () => {
  it('TD-ISO-7 defaults to tenant 1 and follows a valid RFID_BRIDGE_TID', () => {
    expect(rfidBridgeTid({})).toBe(1);
    expect(rfidBridgeTid({ RFID_BRIDGE_TID: '' })).toBe(1);
    expect(rfidBridgeTid({ RFID_BRIDGE_TID: '2' })).toBe(2);
    expect(rfidBridgeTid({ RFID_BRIDGE_TID: 'abc' })).toBe(1);
    expect(rfidBridgeTid({ RFID_BRIDGE_TID: '-3' })).toBe(1);
  });
});
