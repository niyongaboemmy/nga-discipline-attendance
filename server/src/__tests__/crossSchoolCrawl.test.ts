import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import type { Database } from 'sqlite';
import { app } from '../app.js';
import { config } from '../config.js';
import { closeTenantDb, getDbFor, initDatabase } from '../database.js';
import { __setTenants, primaryTenantCtx, type TenantCtx } from '../tenancy/index.js';
import { __resetMisBearerCache } from '../middleware/misBearerAuth.js';

/**
 * Cross-school canary crawl (isolation audit 2026-11-25, kept as a permanent
 * test). Three schools: tenant 1 (in memory), tenants 2 and 3 (files under a
 * temp TENDO_DATA_DIR). Every table of every school gets a canary row whose
 * text says which school it belongs to (CANARY1/2/3) and whose ids are that
 * school's own (`cx-<n>`, integer <n>7001).
 *
 * Then, as an admin of school A, EVERY route of the Express app (listed from
 * the router, mutations included) is called with school B's ids in the path,
 * query and body, a spoofed X-NGA-Tenant header and spoofed tid/tenant query
 * parameters -- and the other way round. Asserted: no response ever contains
 * another school's canary text, no outgoing service call names another
 * school, and the other schools' databases hash the same before and after.
 *
 * Default: one combined request per route and direction (fast). With
 * CROSS_SCHOOL_CRAWL=full every variant (plain / header spoof / query spoof
 * x text id / integer id) is a request of its own.
 */

const FULL = process.env.CROSS_SCHOOL_CRAWL === 'full';
const tenant = (tid: number): TenantCtx => ({
  tid, slug: `s${tid}`, name: `School ${tid}`, status: 'ACTIVE', isPrimary: tid === 1, timezone: 'Africa/Kigali', pkg: 'starter',
});
const TIDS = [1, 2, 3];
const ADMIN = '501';
const intId = (tid: number) => tid * 10000 + 7001;
const textId = (tid: number) => `cx-${tid}`;
const marker = (tid: number) => `CANARY${tid}`;

let dataDir: string;
const prevDataDir = process.env.TENDO_DATA_DIR;
const realFetch = globalThis.fetch;
/** X-NGA-Tenant values of outgoing service calls, per crawl. */
let outgoingTenants: string[] = [];

// ---------------------------------------------------------------- canaries

function checkValues(sql: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /"?(\w+)"?\s+[^,]*?CHECK\s*\(\s*"?(\w+)"?\s+IN\s*\(([^)]*)\)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql))) {
    const lit = /'([^']*)'/.exec(m[3]) ?? /(-?\d+)/.exec(m[3]);
    if (lit) out.set(m[2], lit[1]);
  }
  return out;
}

function valueFor(tid: number, table: string, col: { name: string; type: string; pk: number }, checks: Map<string, string>): unknown {
  if (checks.has(col.name)) return checks.get(col.name);
  const n = col.name.toLowerCase();
  const t = (col.type || '').toUpperCase();
  const isInt = t.includes('INT') || t.includes('REAL') || t.includes('NUM') || t.includes('BOOL');
  if (n === 'id' || n.endsWith('_id') || n.endsWith('id')) return isInt ? intId(tid) : textId(tid);
  if (isInt) return 1;
  if (n.includes('date') || n === 'day') return '2026-11-20';
  if (n.endsWith('_at') || n.includes('time')) return n.includes('time') && !n.endsWith('_at') ? '08:00' : '2026-11-20T08:00:00.000Z';
  if (n === 'email' || n.endsWith('_email')) return `${marker(tid).toLowerCase()}@${table}.test`;
  // A JSON string literal, so code that JSON.parses a column still gets a value.
  return JSON.stringify(`${marker(tid)} ${table}.${col.name}`);
}

async function plantCanaries(db: Database, tid: number): Promise<{ planted: string[]; skipped: string[] }> {
  const tables = await db.all(`SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`);
  const planted: string[] = [];
  const skipped: string[] = [];
  await db.run('PRAGMA foreign_keys = OFF');
  for (const { name, sql } of tables) {
    const cols = await db.all(`PRAGMA table_info("${name}")`);
    const checks = checkValues(sql || '');
    const names = cols.map((c: any) => `"${c.name}"`).join(', ');
    const values = cols.map((c: any) => valueFor(tid, name, c, checks));
    try {
      await db.run(`INSERT OR IGNORE INTO "${name}" (${names}) VALUES (${cols.map(() => '?').join(', ')})`, ...values);
      planted.push(name);
    } catch {
      skipped.push(name);
    }
  }
  await db.run('PRAGMA foreign_keys = ON');
  return { planted, skipped };
}

async function dbHash(db: Database): Promise<string> {
  const h = crypto.createHash('sha256');
  const tables = await db.all(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`);
  for (const { name } of tables) {
    const rows = (await db.all(`SELECT * FROM "${name}"`)).map((r: any) => JSON.stringify(r)).sort();
    h.update(`${name}:${rows.join('\n')}\n`);
  }
  return h.digest('hex');
}

// ---------------------------------------------------------------- routes

interface Route { method: string; path: string }

function listRoutes(): Route[] {
  const out: Route[] = [];
  const walk = (stack: any[], prefix: string) => {
    for (const l of stack) {
      if (l.route) {
        for (const m of Object.keys(l.route.methods)) if (m !== '_all') out.push({ method: m.toUpperCase(), path: prefix + l.route.path });
      } else if (l.name === 'router' && l.handle?.stack) {
        const src = String(l.regexp.source)
          .replace('^\\', '')
          .replace('\\/?(?=\\/|$)', '')
          .replace(/\\\//g, '/')
          .replace('/?$', '');
        walk(l.handle.stack, prefix + src);
      }
    }
  };
  walk((app as any)._router.stack, '');
  return out;
}

const sessionFor = (tid: number) =>
  jwt.sign(
    {
      id: ADMIN, name: 'Crawler', email: 'crawler@school.test', role: 'admin', tid, tenantSlug: `s${tid}`,
      misToken: jwt.sign({ userId: Number(ADMIN), tid }, 'mis-secret'),
    },
    config.jwtSecret,
    { expiresIn: '1h' },
  );

type Variant = { ids: Array<string | number>; header: boolean; query: boolean };

function variants(): Variant[] {
  if (!FULL) return [{ ids: ['TEXT'], header: true, query: true }];
  const out: Variant[] = [];
  for (const id of ['TEXT', 'INT']) {
    out.push({ ids: [id], header: false, query: false });
    out.push({ ids: [id], header: true, query: false });
    out.push({ ids: [id], header: false, query: true });
  }
  return out;
}

interface CrawlResult { requests: number; leaks: string[]; statuses: Record<string, number>; timeouts: string[]; ownSeen: number }

async function crawl(attacker: number, victim: number, routes: Route[]): Promise<CrawlResult> {
  const token = sessionFor(attacker);
  const vText = textId(victim);
  const vInt = intId(victim);
  const others = TIDS.filter((t) => t !== attacker).map(marker);
  const result: CrawlResult = { requests: 0, leaks: [], statuses: {}, timeouts: [], ownSeen: 0 };

  for (const r of routes) {
    for (const v of variants()) {
      const id = v.ids[0] === 'INT' ? vInt : vText;
      const p = r.path.replace(/:(\w+)\??/g, () => String(id)).replace(/\*/g, String(id));
      const q: Record<string, string | number> = {
        id, class_id: vText, classId: vText, student_id: vText, studentId: vText, user_id: vText, userId: vText,
        subject_id: vText, subjectId: vText, date: '2026-11-20', from: '2026-11-01', to: '2026-11-30',
      };
      if (v.query) Object.assign(q, { tid: victim, tenant: victim, tenantId: victim, tenant_id: victim, school: victim });
      const body = {
        ...q, ids: [vInt, vText], studentIds: [vText], classIds: [vText], userIds: [vText],
        records: [{ studentId: vText, student_id: vText, status: 'present' }],
        name: `crawl ${attacker}`, title: `crawl ${attacker}`, type: 'merit', category: 'conduct', status: 'present',
        incident_date: '2026-11-20', period: 1, sessionType: 'class', roleId: vInt, role_id: vInt, permissions: [], enabled: true,
      };
      let req = (request(app) as any)[r.method.toLowerCase()](p).set('Authorization', `Bearer ${token}`).query(q);
      if (v.header) req = req.set('X-NGA-Tenant', String(victim));
      if (r.method !== 'GET') req = req.send(body);
      result.requests++;
      try {
        const res = await req.timeout({ response: 2500, deadline: 4000 });
        result.statuses[res.status] = (result.statuses[res.status] ?? 0) + 1;
        const text = res.text ?? '';
        for (const m of others) if (text.includes(m)) result.leaks.push(`${r.method} ${p} -> ${res.status} contains ${m}`);
        if (text.includes(marker(attacker))) result.ownSeen++;
      } catch (err: any) {
        if (err?.timeout) result.timeouts.push(`${r.method} ${r.path}`);
        else throw err;
      }
    }
  }
  return result;
}

// ---------------------------------------------------------------- the test

describe('cross-school canary crawl', { timeout: 240_000 }, () => {
  const hashes = new Map<number, string>();
  let routes: Route[] = [];
  const skippedTables: Record<number, string[]> = {};
  let plantedCount = 0;

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tendo-crawl-'));
    process.env.TENDO_DATA_DIR = dataDir;
    __setTenants(TIDS.map((t) => (t === 1 ? primaryTenantCtx() : tenant(t))));
    await initDatabase(':memory:');
    await initDatabase(2);
    await initDatabase(3);
    for (const tid of TIDS) {
      const db = getDbFor(tid);
      const role = await db.get(`SELECT id FROM roles WHERE level = 'ADMIN' AND is_system = 1`);
      await db.run(
        `INSERT INTO users (id, name, email, role, role_id) VALUES (?, 'Crawler', 'crawler@school.test', 'admin', ?)
         ON CONFLICT(id) DO UPDATE SET role_id = excluded.role_id, role = 'admin'`,
        ADMIN, role.id,
      );
      const { planted, skipped } = await plantCanaries(db, tid);
      plantedCount = planted.length;
      skippedTables[tid] = skipped;
    }
    // Fake MIS / AI / anything external: neutral answers, and every
    // X-NGA-Tenant an outgoing call carries is recorded.
    globalThis.fetch = (async (_input: any, init?: any) => {
      const h = init?.headers;
      const t = h instanceof Headers ? h.get('X-NGA-Tenant') : h?.['X-NGA-Tenant'] ?? h?.['x-nga-tenant'];
      if (t != null) outgoingTenants.push(String(t));
      return new Response(JSON.stringify({ success: true, data: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    routes = listRoutes();
  });

  afterAll(async () => {
    globalThis.fetch = realFetch;
    __resetMisBearerCache();
    await closeTenantDb(2);
    await closeTenantDb(3);
    __setTenants([primaryTenantCtx()]);
    if (prevDataDir === undefined) delete process.env.TENDO_DATA_DIR;
    else process.env.TENDO_DATA_DIR = prevDataDir;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('planted a canary in (nearly) every table and found the whole route table', () => {
    expect(routes.length).toBeGreaterThan(120);
    expect(routes.some((r) => r.method !== 'GET')).toBe(true);
    // Every table took a canary in every school (a skipped table would be a blind spot).
    for (const tid of TIDS) expect(skippedTables[tid]).toEqual([]);
    expect(plantedCount).toBeGreaterThan(20);
  });

  for (const [attacker, victim] of [[1, 2], [2, 1]] as const) {
    it(`school ${attacker} -> school ${victim}: 0 leaks, 0 writes to other schools, no service call for another school`, async () => {
      for (const tid of TIDS) hashes.set(tid, await dbHash(getDbFor(tid)));
      outgoingTenants = [];
      const res = await crawl(attacker, victim, routes);
      await new Promise((r) => setTimeout(r, 200)); // let fire-and-forget work settle
      if (process.env.CROSS_SCHOOL_CRAWL_REPORT) {
        console.log(`[crawl ${attacker}->${victim}] ${res.requests} requests, own canaries seen in ${res.ownSeen}, statuses ${JSON.stringify(res.statuses)}, timeouts ${JSON.stringify(res.timeouts)}`);
      }
      expect(res.leaks).toEqual([]);
      // Positive control: the crawler does read its OWN school's canaries
      // through the routes, so the absence of the others' is meaningful.
      expect(res.ownSeen).toBeGreaterThan(10);
      for (const tid of TIDS.filter((t) => t !== attacker)) {
        expect(await dbHash(getDbFor(tid)), `school ${tid} database changed`).toBe(hashes.get(tid));
      }
      expect(outgoingTenants.filter((t) => t !== String(attacker))).toEqual([]);
      // Only the live event stream may hold a request open.
      expect(res.timeouts.filter((t) => !t.endsWith('/api/rfid/stream'))).toEqual([]);
    });
  }
});
