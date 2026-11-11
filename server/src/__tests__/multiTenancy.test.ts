import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import type { AddressInfo } from 'net';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { open, Database } from 'sqlite';
import sqlite3 from 'sqlite3';
import { app } from '../app.js';
import { config } from '../config.js';
import {
  closeTenantDb, getDb, getDbFor, initDatabase, migrateTenantDb, tenantDbExists, tenantDbPath,
} from '../database.js';
import {
  TenantContextMissing, __setTenants, primaryTenantCtx, runWithTenant, type TenantCtx,
} from '../tenancy/index.js';
import { schoolSetting, schoolTimezone, setSchoolSetting } from '../tenancy/settings.js';
import { emitRfidEvent } from '../modules/rfid/workQueue.js';
import { LOGOUT_EVENT, setJwksFetcher } from '../utils/ssoLogout.js';
import { __resetMisBearerCache } from '../middleware/misBearerAuth.js';

/**
 * Multi-tenancy (MULTI_TENANCY_GAP_FIX_PLAN.md Phase 5, packages/tenancy/
 * CONTRACT.md): one SQLite file per school, every request inside its
 * tenant's context, nothing of school A reachable as school B.
 */

const tenant = (tid: number, over: Partial<TenantCtx> = {}): TenantCtx => ({
  tid, slug: `s${tid}`, name: `School ${tid}`, status: 'ACTIVE', isPrimary: tid === 1, timezone: 'Africa/Kigali', pkg: 'starter', ...over,
});
const T1 = primaryTenantCtx();
const T2 = tenant(2, { timezone: 'Africa/Nairobi' });
const T3 = tenant(3, { status: 'PENDING' });
const T4 = tenant(4, { status: 'SUSPENDED' });
const T5 = tenant(5, { status: 'GRACE' });

let dataDir: string;
const prevDataDir = process.env.TENDO_DATA_DIR;

async function adminIn(db: Database, id: string, tid: number | null, extra: Record<string, unknown> = {}) {
  const role = await db.get(`SELECT id FROM roles WHERE level = 'ADMIN' AND is_system = 1`);
  await db.run(
    `INSERT INTO users (id, name, email, role, role_id) VALUES (?, ?, ?, 'admin', ?)
     ON CONFLICT(id) DO UPDATE SET role_id = excluded.role_id`,
    id, `Admin ${id}`, `${id}@school.test`, role.id
  );
  const claims: Record<string, unknown> = { id, name: `Admin ${id}`, email: `${id}@school.test`, role: 'admin', ...extra };
  if (tid != null) claims.tid = tid;
  return jwt.sign(claims, config.jwtSecret, { expiresIn: '1h' });
}
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tendo-mt-'));
  process.env.TENDO_DATA_DIR = dataDir;
  __setTenants([T1, T2, T3, T4, T5]);
  await initDatabase(':memory:'); // tenant 1
  await initDatabase(2); // tenant 2, a real file under TENDO_DATA_DIR
});

afterAll(async () => {
  await closeTenantDb(2);
  await closeTenantDb(5);
  await closeTenantDb(7);
  __setTenants([primaryTenantCtx()]);
  if (prevDataDir === undefined) delete process.env.TENDO_DATA_DIR;
  else process.env.TENDO_DATA_DIR = prevDataDir;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

afterEach(() => {
  delete process.env.TENANCY_MODE;
  delete process.env.TENANCY_LEGACY_DEFAULT_TID;
  delete process.env.TENANCY_PROVISION_SECRET;
});

describe('storage layout', () => {
  it('tenant 1 stays at DATABASE_PATH; tenant N gets TENDO_DATA_DIR/t<N>/attendance.db', () => {
    expect(tenantDbPath(1)).toBe(config.databasePath);
    expect(tenantDbPath(2)).toBe(path.join(dataDir, 't2', 'attendance.db'));
    expect(fs.existsSync(tenantDbPath(2))).toBe(true);
    expect(tenantDbExists(9)).toBe(false);
  });

  it('getDb() resolves from the tenant context', async () => {
    expect(runWithTenant(T1, () => getDb())).toBe(getDbFor(1));
    expect(runWithTenant(T2, () => getDb())).toBe(getDbFor(2));
    expect(getDbFor(1)).not.toBe(getDbFor(2));
  });

  it('shadow mode (default): no context means tenant 1', () => {
    expect(getDb()).toBe(getDbFor(1));
  });

  it('enforce mode: no context throws TenantContextMissing; a context still works', () => {
    process.env.TENANCY_MODE = 'enforce';
    expect(() => getDb()).toThrow(TenantContextMissing);
    expect(runWithTenant(T2, () => getDb())).toBe(getDbFor(2));
  });
});

describe('isolation through the real routes (canary rows)', () => {
  let tok1: string;
  let tok2: string;

  beforeAll(async () => {
    tok1 = await adminIn(getDbFor(1), '501', 1);
    tok2 = await adminIn(getDbFor(2), '501', 2); // same MIS id, other school
    await getDbFor(1).run(
      `INSERT INTO discipline_records (student_id, student_name, type, category, title, incident_date, logged_by)
       VALUES ('S-A', 'CANARY-A-student', 'demerit', 'conduct', 'CANARY-A-incident', '2026-10-01', '501')`
    );
    await getDbFor(1).run(`INSERT INTO users (id, name, email, role) VALUES ('CANARY-A-user', 'CANARY-A-name', 'a@x', 'teacher')`);
    await getDbFor(2).run(
      `INSERT INTO discipline_records (student_id, student_name, type, category, title, incident_date, logged_by)
       VALUES ('S-B', 'CANARY-B-student', 'merit', 'conduct', 'CANARY-B-incident', '2026-10-01', '501')`
    );
  });

  it('a school-2 admin sees only school 2 records and users', async () => {
    for (const url of ['/api/discipline', '/api/admin/users', '/api/admin/overview', '/api/discipline/overview']) {
      const res = await request(app).get(url).set(bearer(tok2));
      expect(res.status, url).toBe(200);
      expect(JSON.stringify(res.body), url).not.toContain('CANARY-A');
    }
    const list = await request(app).get('/api/discipline').set(bearer(tok2));
    expect(list.body.data.map((r: any) => r.title)).toEqual(['CANARY-B-incident']);
  });

  it('a school-1 admin sees only school 1 records', async () => {
    const res = await request(app).get('/api/discipline').set(bearer(tok1));
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain('CANARY-B');
    expect(res.body.data.map((r: any) => r.title)).toContain('CANARY-A-incident');
  });

  it('writes land in the caller’s own file', async () => {
    const res = await request(app)
      .post('/api/discipline')
      .set(bearer(tok2))
      .send({ studentId: 'S-B2', studentName: 'CANARY-B-new', type: 'demerit', category: 'Tardiness', severity: 'minor', title: 'CANARY-B-written', incidentDate: '2026-10-02' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await getDbFor(2).get(`SELECT 1 FROM discipline_records WHERE title = 'CANARY-B-written'`)).toBeTruthy();
    expect(await getDbFor(1).get(`SELECT 1 FROM discipline_records WHERE title = 'CANARY-B-written'`)).toBeUndefined();
  });

  it('a legacy token (no tid) is tenant 1; with TENANCY_LEGACY_DEFAULT_TID=none it is refused', async () => {
    const legacy = await adminIn(getDbFor(1), '502', null);
    const ok = await request(app).get('/api/discipline').set(bearer(legacy));
    expect(ok.status).toBe(200);
    expect(JSON.stringify(ok.body)).toContain('CANARY-A');
    process.env.TENANCY_LEGACY_DEFAULT_TID = 'none';
    const refused = await request(app).get('/api/discipline').set(bearer(legacy));
    expect(refused.status).toBe(401);
    expect(refused.body.code).toBe('TENANT_REQUIRED');
  });
});

describe('request gates (contract §6)', () => {
  const tokFor = (tid: number, extra: Record<string, unknown> = {}) =>
    jwt.sign({ id: '700', name: 'X', email: 'x@x', role: 'admin', tid, ...extra }, config.jwtSecret, { expiresIn: '1h' });

  it('unknown 401 TENANT_UNKNOWN, pending 403 TENANT_PENDING, suspended 403 TENANT_SUSPENDED', async () => {
    const unknown = await request(app).get('/api/discipline').set(bearer(tokFor(99)));
    expect([unknown.status, unknown.body.code]).toEqual([401, 'TENANT_UNKNOWN']);
    const pending = await request(app).get('/api/discipline').set(bearer(tokFor(3)));
    expect([pending.status, pending.body.code]).toEqual([403, 'TENANT_PENDING']);
    const suspended = await request(app).get('/api/discipline').set(bearer(tokFor(4)));
    expect([suspended.status, suspended.body.code]).toEqual([403, 'TENANT_SUSPENDED']);
    // Nothing was created for refused schools.
    expect(tenantDbExists(3)).toBe(false);
    expect(tenantDbExists(4)).toBe(false);
  });

  it('GRACE still works (its file is opened on first use)', async () => {
    expect(tenantDbExists(5)).toBe(false);
    const res = await request(app).get('/api/discipline').set(bearer(tokFor(5)));
    // The file now exists; the user row does not, so the session is dangling (401 without a code).
    expect(res.status).toBe(401);
    expect(res.body.code).toBeUndefined();
    expect(tenantDbExists(5)).toBe(true);
  });

  it('401 TENANT_MISMATCH when the MIS token inside the session names another school', async () => {
    const misToken = jwt.sign({ userId: 700, tid: 1 }, 'mis-secret');
    const res = await request(app).get('/api/discipline').set(bearer(tokFor(2, { misToken })));
    expect([res.status, res.body.code]).toEqual([401, 'TENANT_MISMATCH']);
  });
});

describe('primary-only data fix (TD-2)', () => {
  it('CORRECTED_ATTENDANCE_DATES purge never runs on another tenant', async () => {
    const file = path.join(dataDir, 'fix-check.db');
    const db = await open({ filename: file, driver: sqlite3.Database });
    try {
      await migrateTenantDb(db, { tid: 9, isPrimary: false });
      await db.run(
        `INSERT INTO attendance_records (student_id, student_name, class_id, class_name, session_date, period, status, marked_by)
         VALUES ('s1', 'S', 'c1', 'C', '2026-09-11', 'Morning', 'present', 't')`
      );
      await migrateTenantDb(db, { tid: 9, isPrimary: false });
      expect((await db.get(`SELECT COUNT(*) AS n FROM attendance_records`)).n).toBe(1);
      expect(await db.get(`SELECT 1 FROM data_migrations WHERE key LIKE 'purge-attendance%'`)).toBeUndefined();
      // The same file treated as the primary tenant gets NGA's fix.
      await migrateTenantDb(db, { tid: 1, isPrimary: true });
      expect((await db.get(`SELECT COUNT(*) AS n FROM attendance_records`)).n).toBe(0);
    } finally {
      await db.close();
    }
  });

  it('tenant 2’s file has no record of the NGA fix', async () => {
    expect(await getDbFor(2).get(`SELECT 1 FROM data_migrations WHERE key LIKE 'purge-attendance%'`)).toBeUndefined();
    expect(await getDbFor(1).get(`SELECT 1 FROM data_migrations WHERE key LIKE 'purge-attendance%'`)).toBeTruthy();
  });
});

describe('school settings (TD-6)', () => {
  it('per tenant: a school-2 row never leaks to school 1; tenant 1 falls back to env', async () => {
    process.env.ATTENDANCE_WARN_THRESHOLD = '70';
    try {
      await setSchoolSetting(getDbFor(2), 2, 'ATTENDANCE_WARN_THRESHOLD', '90');
      expect(runWithTenant(T2, () => schoolSetting('ATTENDANCE_WARN_THRESHOLD'))).toBe('90');
      expect(runWithTenant(T1, () => schoolSetting('ATTENDANCE_WARN_THRESHOLD'))).toBe('70');
      // Env never configures another school: tenant 5 has no row -> built-in default.
      expect(runWithTenant(T5, () => schoolSetting('ATTENDANCE_WARN_THRESHOLD'))).toBe('80');
    } finally {
      delete process.env.ATTENDANCE_WARN_THRESHOLD;
    }
  });

  it('timezone: the tenant context first', () => {
    expect(runWithTenant(T2, () => schoolTimezone())).toBe('Africa/Nairobi');
    expect(schoolTimezone()).toBe(process.env.SCHOOL_TIMEZONE || 'Africa/Kigali');
  });
});

describe('RFID live stream (TD-7)', () => {
  it('only forwards the subscriber’s own tenant’s events', async () => {
    const tok2 = await adminIn(getDbFor(2), '601', 2);
    const server = http.createServer(app).listen(0);
    const port = (server.address() as AddressInfo).port;
    const controller = new AbortController();
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/api/rfid/stream`, { headers: bearer(tok2), signal: controller.signal });
      expect(resp.status).toBe(200);
      const reader = resp.body!.getReader();
      const decoder = new TextDecoder();
      let text = '';
      const readUntil = async (needle: string) => {
        while (!text.includes(needle)) {
          const { value, done } = await reader.read();
          if (done) break;
          text += decoder.decode(value);
        }
      };
      await readUntil('event: ready');
      const scan = (name: string) => ({
        type: 'scan' as const, scanId: 1, outcome: 'marked', at: new Date().toISOString(), studentId: 's', studentName: name,
        classId: null, className: null, status: null, detail: null, sessionDate: null, period: null, uid: null, deviceName: null,
      });
      runWithTenant(T1, () => emitRfidEvent(scan('CANARY-A-scan')));
      runWithTenant(T2, () => emitRfidEvent(scan('CANARY-B-scan')));
      await readUntil('CANARY-B-scan');
      expect(text).toContain('CANARY-B-scan');
      expect(text).not.toContain('CANARY-A-scan');
      expect(text).not.toContain('"tid"');
    } finally {
      controller.abort();
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
    }
  });
});

describe('provisioning endpoint (contract §5)', () => {
  const url = '/api/integration/tenants/7/provision';
  const body = { tid: 7, slug: 'hill', name: 'Hill School', status: 'ACTIVE', timezone: 'Africa/Kampala', pkg: 'gold' };

  it('503 without TENANCY_PROVISION_SECRET, 401 with a wrong secret', async () => {
    expect((await request(app).post(url).send(body)).status).toBe(503);
    process.env.TENANCY_PROVISION_SECRET = 'prov-secret-123';
    expect((await request(app).post(url).set(bearer('nope')).send(body)).status).toBe(401);
    expect((await request(app).post(url).send(body)).status).toBe(401);
    expect(tenantDbExists(7)).toBe(false);
  });

  it('creates and seeds once, then is idempotent', async () => {
    process.env.TENANCY_PROVISION_SECRET = 'prov-secret-123';
    const first = await request(app).post(url).set(bearer('prov-secret-123')).send(body);
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ ok: true, tid: 7, created: true });
    expect(fs.existsSync(tenantDbPath(7))).toBe(true);
    const db = getDbFor(7);
    expect((await db.get(`SELECT COUNT(*) AS n FROM roles WHERE is_system = 1`)).n).toBe(3);
    expect((await db.get(`SELECT COUNT(*) AS n FROM role_permissions`)).n).toBeGreaterThan(0);
    expect((await db.get(`SELECT value FROM school_settings WHERE key = 'SCHOOL_TIMEZONE'`)).value).toBe('Africa/Kampala');
    // A school's own change survives re-provisioning.
    await setSchoolSetting(db, 7, 'RFID_GRACE_MINUTES', '6');
    const again = await request(app).post(url).set(bearer('prov-secret-123')).send(body);
    expect(again.body).toEqual({ ok: true, tid: 7, created: false });
    expect((await db.get(`SELECT value FROM school_settings WHERE key = 'RFID_GRACE_MINUTES'`)).value).toBe('6');
    expect((await db.get(`SELECT COUNT(*) AS n FROM roles WHERE is_system = 1`)).n).toBe(3);
  });

  it('tenant 1 is never re-seeded; a body/URL tid mismatch is refused', async () => {
    process.env.TENANCY_PROVISION_SECRET = 'prov-secret-123';
    const one = await request(app).post('/api/integration/tenants/1/provision').set(bearer('prov-secret-123')).send({ tid: 1 });
    expect(one.body).toEqual({ ok: true, tid: 1, created: false });
    expect((await getDbFor(1).get(`SELECT COUNT(*) AS n FROM school_settings`)).n).toBe(0);
    const bad = await request(app).post(url).set(bearer('prov-secret-123')).send({ ...body, tid: 8 });
    expect(bad.status).toBe(400);
  });
});

describe('back-channel logout per tenant (contract §2)', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...(publicKey.export({ format: 'jwk' }) as object), kid: 'mt1', alg: 'RS256', use: 'sig' };
  const logoutToken = (sub: string, claims: Record<string, unknown> = {}) =>
    jwt.sign(
      { iss: config.ngaMisBaseUrl.replace(/\/$/, ''), aud: config.ssoClientId, jti: crypto.randomUUID(), sub, events: { [LOGOUT_EVENT]: {} }, ...claims },
      privateKey,
      { algorithm: 'RS256', keyid: 'mt1', expiresIn: 120 },
    );
  beforeAll(() => setJwksFetcher(async () => ({ keys: [jwk as any] })));
  afterAll(() => setJwksFetcher(null));

  it('revokes (tid, sub) in that school’s file only', async () => {
    const res = await request(app).post('/api/sso/backchannel-logout').type('form').send({ logout_token: logoutToken('8080', { tid: 2 }) });
    expect(res.status).toBe(200);
    expect(await getDbFor(2).get(`SELECT 1 FROM session_revocations WHERE user_id = '8080'`)).toBeTruthy();
    expect(await getDbFor(1).get(`SELECT 1 FROM session_revocations WHERE user_id = '8080'`)).toBeUndefined();
    // No tid: tenant 1 (legacy default).
    await request(app).post('/api/sso/backchannel-logout').type('form').send({ logout_token: logoutToken('8081') });
    expect(await getDbFor(1).get(`SELECT 1 FROM session_revocations WHERE user_id = '8081'`)).toBeTruthy();
    expect(await getDbFor(2).get(`SELECT 1 FROM session_revocations WHERE user_id = '8081'`)).toBeUndefined();
  });
});

describe('MIS bearer auth (integration routes)', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    __resetMisBearerCache();
  });
  const verifyAs = (tenantBody: unknown) => {
    globalThis.fetch = (async (input: any, init?: any) => {
      if (String(input).endsWith('/auth/verify')) {
        return new Response(JSON.stringify({ success: true, data: { userId: 4242, tenant: tenantBody } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return realFetch(input, init);
    }) as typeof fetch;
  };

  it('enters the tenant MIS names; a different X-NGA-Tenant header is 403 TENANT_MISMATCH', async () => {
    verifyAs({ tid: 2, slug: 's2', status: 'ACTIVE' });
    const ok = await request(app).post('/api/integration/home-summary').set(bearer('mis-token-a')).send({});
    expect(ok.status).toBe(200);
    expect(ok.body.provisioned ?? ok.body.data?.provisioned).toBe(false);
    const mismatch = await request(app).post('/api/integration/home-summary').set(bearer('mis-token-a')).set('X-NGA-Tenant', '1').send({});
    expect([mismatch.status, mismatch.body.code]).toEqual([403, 'TENANT_MISMATCH']);
  });

  it('a suspended school is refused', async () => {
    verifyAs({ tid: 4, slug: 's4', status: 'SUSPENDED' });
    const res = await request(app).post('/api/integration/home-summary').set(bearer('mis-token-b')).send({});
    expect([res.status, res.body.code]).toEqual([403, 'TENANT_SUSPENDED']);
  });
});

describe('service calls and the registry (contract §3-4)', () => {
  it('MIS service calls carry X-NGA-Tenant for the current tenant', async () => {
    const { fetchHolders, __resetHoldersCache } = await import('../access/misService.js');
    const realFetch = globalThis.fetch;
    const sent: Array<Record<string, string>> = [];
    globalThis.fetch = (async (_url: any, init?: any) => {
      sent.push(init?.headers ?? {});
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }) as typeof fetch;
    try {
      __resetHoldersCache();
      await runWithTenant(T2, () => fetchHolders('DISCIPLINE_VIEW_ALL', null));
      await runWithTenant(T1, () => fetchHolders('DISCIPLINE_VIEW_ALL', null));
    } finally {
      globalThis.fetch = realFetch;
    }
    // Two calls: the holders cache is per tenant, so school 1 is not served school 2's answer.
    expect(sent.map((h) => h['X-NGA-Tenant'])).toEqual(['2', '1']);
  });

  it('the registry loader: an old MIS (404) or a list without tenant 1 still serves NGA', async () => {
    const { loadTenantsFromMis } = await import('../tenancy/index.js');
    process.env.MIS_INTEGRATION_TOKEN = 'tok';
    try {
      const old = await loadTenantsFromMis((async () => new Response('nope', { status: 404 })) as any);
      expect(old.map((x) => x.tid)).toEqual([1]);
      const seenHeaders: any[] = [];
      const list = await loadTenantsFromMis((async (_u: any, init: any) => {
        seenHeaders.push(init.headers);
        return new Response(JSON.stringify({ tenants: [{ tid: 2, slug: 'b', status: 'GRACE' }] }), { status: 200 });
      }) as any);
      expect(list.map((x) => [x.tid, x.status])).toEqual([[1, 'ACTIVE'], [2, 'GRACE']]);
      expect(seenHeaders[0].Authorization).toBe('Bearer tok');
    } finally {
      delete process.env.MIS_INTEGRATION_TOKEN;
    }
  });
});
