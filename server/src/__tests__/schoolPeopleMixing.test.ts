import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { app } from '../app.js';
import { config } from '../config.js';
import { closeTenantDb, getDbFor, initDatabase } from '../database.js';
import { __setTenants, primaryTenantCtx, runWithTenant, type TenantCtx } from '../tenancy/index.js';
import { installMisTenantFetch, withSchoolHeader } from '../tenancy/misTenantFetch.js';
import { createTestUser, authHeader } from './testUtils.js';

/**
 * 2026-11-26: a Cambridge (school 2) admin saw Coding Academy (school 1) staff on
 * Tendo's Staff tab. Every list is read from the MIS with the session's MIS
 * token; a token naming no school is answered by the MIS for school 1, and
 * Tendo let a school-2 session carry one. These pin the three fixes.
 */

const T1 = primaryTenantCtx();
const T2: TenantCtx = { tid: 2, slug: 'cam', name: 'School 2', status: 'ACTIVE', isPrimary: false, timezone: 'Africa/Kigali', pkg: 'max' };

let dataDir: string;
const prevDataDir = process.env.TENDO_DATA_DIR;
const realFetch = globalThis.fetch;
const misJwt = (claims: Record<string, unknown>) => jwt.sign({ userId: 5151, ...claims }, 'mis-secret');
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify({ success: status < 400, data }), { status, headers: { 'Content-Type': 'application/json' } });
let ssoAnswer: Record<string, unknown> = {};

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tendo-people-mix-'));
  process.env.TENDO_DATA_DIR = dataDir;
  __setTenants([T1, T2]);
  await initDatabase(':memory:');
  await initDatabase(2);
  for (const tid of [1, 2]) {
    await getDbFor(tid).run(`INSERT OR IGNORE INTO users (id, name, email, role) VALUES ('5151', 'Cam Admin', 'cam@x.test', 'admin')`);
  }
  globalThis.fetch = (async (input: any) => (String(input).includes('/sso/token') ? json(ssoAnswer) : json({}))) as typeof fetch;
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
  delete process.env.TENANCY_LEGACY_DEFAULT_TID;
});

const session = (tid: number, misToken: string) =>
  jwt.sign({ id: '5151', name: 'Cam Admin', email: 'cam@x.test', role: 'admin', tid, misToken }, config.jwtSecret, { expiresIn: '1h' });
const probe = (token: string) => request(app).get('/api/attendance/schedule/day').set(authHeader(token));

describe('a session and its MIS token must be of the same school', () => {
  it('a school-2 session carrying an MIS token that names no school is refused (the MIS would answer for school 1)', async () => {
    const res = await probe(session(2, misJwt({})));
    expect([res.status, res.body.code]).toEqual([401, 'TENANT_MISMATCH']);
  });

  it('a school-1 session with such a legacy token still works, and a school-2 token in a school-2 session too', async () => {
    expect((await probe(session(1, misJwt({})))).status).not.toBe(401);
    expect((await probe(session(2, misJwt({ tid: 2 })))).status).not.toBe(401);
  });

  it('sign-in refuses an MIS answer for school 2 whose token names no school', async () => {
    ssoAnswer = {
      token: misJwt({ userId: 5152 }),
      tenant: { tid: 2, slug: 'cam', status: 'ACTIVE' },
      user: { user_id: 5152, username: 'x', email: 'x@x.test' },
      permissions: [],
    };
    const res = await request(app).post('/api/sso/exchange').send({ code: 'mix-1' });
    expect([res.status, res.body.code]).toEqual([401, 'TENANT_MISMATCH']);
    expect(await getDbFor(2).get(`SELECT 1 FROM users WHERE id = '5152'`)).toBeUndefined();
  });
});

describe('every user-token MIS call names the school', () => {
  const mis = `${config.ngaMisBaseUrl.replace(/\/+$/, '')}/users?limit=1000`;

  it('adds X-NGA-Tenant only to a Bearer call to the MIS made inside a school', () => {
    const bearer = { headers: { Authorization: 'Bearer t' } };
    expect(withSchoolHeader(mis, bearer, 2)?.get('X-NGA-Tenant')).toBe('2');
    expect(withSchoolHeader(mis, bearer, null)).toBeNull();
    expect(withSchoolHeader(mis, { headers: { Authorization: 'Basic abc' } }, 2)).toBeNull();
    expect(withSchoolHeader('https://elsewhere.example/users', bearer, 2)).toBeNull();
    expect(withSchoolHeader(mis, { headers: { Authorization: 'Bearer t', 'X-NGA-Tenant': '1' } }, 2)).toBeNull();
  });

  it('the installed fetch sends the request’s school and keeps plain header objects plain', async () => {
    const seen: any[] = [];
    const prev = globalThis.fetch;
    globalThis.fetch = (async (_i: any, init?: RequestInit) => {
      seen.push(init?.headers);
      return json({});
    }) as typeof fetch;
    try {
      installMisTenantFetch();
      await runWithTenant(T2, () => fetch(mis, { headers: { Authorization: 'Bearer t' } }));
      await fetch(mis, { headers: { Authorization: 'Bearer t' } });
    } finally {
      globalThis.fetch = prev;
    }
    expect(seen[0]).toEqual({ Authorization: 'Bearer t', 'X-NGA-Tenant': '2' });
    expect(seen[1]).toEqual({ Authorization: 'Bearer t' });
  });
});

describe('Staff tab without an MIS list', () => {
  it('lists only this school’s members, not rows the MIS sync marked as another school’s', async () => {
    const db = getDbFor(1);
    const { token } = await createTestUser(db, { id: '5160', name: 'Office Admin', email: 'oa@x.test', roleLevel: 'ADMIN' });
    await db.run(`INSERT INTO users (id, name, email, role, status, school_member) VALUES ('5161', 'Here Teacher', 'h@x.test', 'teacher', 'active', 1)`);
    // Belt and braces: even a row left 'active' is hidden once it is not a member.
    await db.run(`INSERT INTO users (id, name, email, role, status, school_member) VALUES ('5162', 'Other School', 'o@x.test', 'teacher', 'active', 0)`);
    const res = await request(app).get('/api/staff/clock/overview').set(authHeader(token));
    expect(res.status).toBe(200);
    const names = JSON.stringify(res.body.data);
    expect(names).toContain('Here Teacher');
    expect(names).not.toContain('Other School');
  });
});
