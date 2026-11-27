import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import crypto from 'crypto';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { Database } from 'sqlite';
import { setupTestDb, authHeader } from './testUtils.js';
import { config } from '../config.js';
import { app } from '../app.js';
import { LOGOUT_EVENT, setJwksFetcher } from '../utils/ssoLogout.js';
import { sidOfMisToken } from '../auth/revocation.js';
import {
  __setRegistryStrict, effectiveTenant, legacyDefaultTid, loadTenantsFromMis, strictActive, strictFlagOf,
  tenancyMode, tidOfClaims, TenantContextMissing,
} from '../tenancy/index.js';
import { __resetFallbacks, fallbackSnapshot, noteFallback, reportFallbacks } from '../tenancy/fallbacks.js';
import { brandingOf, mySchoolsOf, __clearBrandingCache } from '../routes/sso.js';

/**
 * Switching school (TENANT_SWITCHING_PLAN.md, Appendix A): back-channel
 * logout by sid, the fallback counters and their report, automatic strict
 * mode, and the my-schools / branding / SCHOOL_CHANGED server pieces.
 */

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...(publicKey.export({ format: 'jwk' }) as object), kid: 'k1', alg: 'RS256', use: 'sig' };

const logoutToken = (sub: string, claims: Record<string, unknown> = {}) =>
  jwt.sign(
    { iss: config.ngaMisBaseUrl.replace(/\/$/, ''), aud: config.ssoClientId, jti: crypto.randomUUID(), sub, tid: 1, events: { [LOGOUT_EVENT]: {} }, ...claims },
    privateKey,
    { algorithm: 'RS256', keyid: 'k1', expiresIn: 120 },
  );

/** A MIS token as /sso/token hands it out (only its claims matter here). */
const misToken = (claims: Record<string, unknown>) => jwt.sign({ userId: 9101, tid: 1, ...claims }, 'mis-secret');

const session = (id: string, mis: string | undefined, iatSecondsAgo = 30) =>
  jwt.sign(
    { id, name: 'Aline', email: 'aline@school.test', role: 'teacher', tid: 1, tenantSlug: 'nga', misToken: mis, iat: Math.floor(Date.now() / 1000) - iatSecondsAgo },
    config.jwtSecret,
    { expiresIn: '1h' },
  );

const probe = (token: string) => request(app).get('/api/attendance/schedule/day').set(authHeader(token));
const logout = (token: string) => request(app).post('/api/sso/backchannel-logout').type('form').send({ logout_token: token });

describe('back-channel logout with sid (Appendix A.3)', { timeout: 30_000 }, () => {
  let db: Database;
  beforeAll(async () => {
    db = await setupTestDb();
    setJwksFetcher(async () => ({ keys: [jwk as any] }));
    for (const id of ['9101', '9102']) {
      await db.run(`INSERT INTO users (id, name, email, role) VALUES (?, 'Aline', 'aline@school.test', 'teacher')`, id);
    }
  });
  afterAll(() => setJwksFetcher(null));

  it('reads a well-formed sid out of the MIS token only', () => {
    expect(sidOfMisToken(misToken({ sid: 'browserA_123' }))).toBe('browserA_123');
    expect(sidOfMisToken(misToken({ sid: 'x' }))).toBeNull();
    expect(sidOfMisToken(misToken({}))).toBeNull();
    expect(sidOfMisToken(undefined)).toBeNull();
  });

  it('a logout with sid ends that browser session (and sid-less ones), never the other device', async () => {
    const laptop = session('9101', misToken({ sid: 'laptopSess01' }));
    const phone = session('9101', misToken({ sid: 'phoneSess002' }));
    const old = session('9101', misToken({})); // a session from before sids
    for (const t of [laptop, phone, old]) expect((await probe(t)).status).not.toBe(401);

    expect((await logout(logoutToken('9101', { sid: 'laptopSess01' }))).status).toBe(200);

    const l = await probe(laptop);
    expect(l.status).toBe(401);
    expect(l.body.code).toBe('SESSION_ENDED');
    expect((await probe(old)).status).toBe(401);
    expect((await probe(phone)).status).not.toBe(401);
  });

  it('a logout without sid still ends every session of the person, as before', async () => {
    const a = session('9102', misToken({ sid: 'laptopSess01' }));
    const b = session('9102', misToken({ sid: 'phoneSess002' }));
    expect((await logout(logoutToken('9102'))).status).toBe(200);
    expect((await probe(a)).status).toBe(401);
    expect((await probe(b)).status).toBe(401);
  });

  it('a sign-in after the switch-out works again in that browser', async () => {
    await new Promise((r) => setTimeout(r, 1100));
    const back = session('9101', misToken({ sid: 'laptopSess01' }), 0);
    expect((await probe(back)).status).not.toBe(401);
  });
});

describe('fallback counters and the report to MIS (Appendix A.6)', { timeout: 30_000 }, () => {
  afterEach(() => __resetFallbacks());

  it('counts no_context, legacy_tid and payload_no_tid with their sites', async () => {
    __resetFallbacks();
    effectiveTenant('nightly sweep');
    tidOfClaims({ id: 1 }, 1, 'session token'); // no tid: legacy default used
    tidOfClaims({ id: 1, tid: 2 }, 1); // has its own tid: not a fallback
    tidOfClaims({ id: 1 }, null); // no default to fall back to: not counted
    // A logout token without tid goes through the payload kind.
    noteFallback('payload_no_tid', 'back-channel logout');
    const snap = fallbackSnapshot();
    expect(snap.app).toBe('tendo');
    expect(snap.day).toBe(new Date().toISOString().slice(0, 10));
    expect(snap.counts).toEqual({ no_context: 1, legacy_tid: 1, payload_no_tid: 1 });
    expect(snap.sites).toEqual(expect.arrayContaining(['nightly sweep', 'session token', 'back-channel logout']));
  });

  it('a token without tid on a real request is counted', async () => {
    __resetFallbacks();
    const legacy = jwt.sign({ id: 'nobody', role: 'teacher' }, config.jwtSecret, { expiresIn: '1h' });
    await probe(legacy);
    expect(fallbackSnapshot().counts.legacy_tid).toBeGreaterThanOrEqual(1);
  });

  it('reports the cumulative day, even when all zero (heartbeat), with the service credentials', async () => {
    __resetFallbacks();
    const calls: Array<{ url: string; init: any }> = [];
    const fetchImpl = (async (url: any, init: any) => {
      calls.push({ url: String(url), init });
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    expect(await reportFallbacks({ misBaseUrl: 'https://mis.test/', authHeader: 'Bearer svc', fetchImpl })).toBe('sent');
    noteFallback('legacy_tid', 'x');
    noteFallback('legacy_tid', 'x');
    expect(await reportFallbacks({ misBaseUrl: 'https://mis.test', authHeader: 'Bearer svc', fetchImpl })).toBe('sent');
    expect(calls[0].url).toBe('https://mis.test/platform/tenancy/fallbacks');
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.headers.Authorization).toBe('Bearer svc');
    expect(JSON.parse(calls[0].init.body).counts).toEqual({ no_context: 0, legacy_tid: 0, payload_no_tid: 0 });
    expect(JSON.parse(calls[1].init.body)).toMatchObject({ app: 'tendo', counts: { legacy_tid: 2 }, sites: ['x'] });
  });

  it('never throws when MIS does not support it (404/403), is down, or is not configured', async () => {
    __resetFallbacks();
    const answer = (status: number) => (async () => new Response('no', { status })) as unknown as typeof fetch;
    expect(await reportFallbacks({ misBaseUrl: 'https://mis.test', authHeader: 'Bearer svc', fetchImpl: answer(404) })).toBe('unsupported');
    expect(await reportFallbacks({ misBaseUrl: 'https://mis.test', authHeader: 'Bearer svc', fetchImpl: answer(403) })).toBe('unsupported');
    expect(await reportFallbacks({ misBaseUrl: 'https://mis.test', authHeader: 'Bearer svc', fetchImpl: answer(500) })).toBe('failed');
    const down = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    expect(await reportFallbacks({ misBaseUrl: 'https://mis.test', authHeader: 'Bearer svc', fetchImpl: down })).toBe('failed');
    expect(await reportFallbacks({ misBaseUrl: 'https://mis.test', authHeader: null })).toBe('skipped');
  });

  it('after midnight (UTC) the previous day is delivered once with its final counts', async () => {
    let now = Date.parse('2026-11-25T23:30:00Z');
    __resetFallbacks(() => now);
    const bodies: any[] = [];
    const fetchImpl = (async (_u: any, init: any) => (bodies.push(JSON.parse(init.body)), new Response('{}'))) as typeof fetch;
    await reportFallbacks({ misBaseUrl: 'https://mis.test', authHeader: 'Bearer svc', fetchImpl });
    noteFallback('no_context', 'late job');
    now = Date.parse('2026-11-26T00:30:00Z');
    await reportFallbacks({ misBaseUrl: 'https://mis.test', authHeader: 'Bearer svc', fetchImpl });
    expect(bodies.map((b) => [b.day, b.counts.no_context])).toEqual([
      ['2026-11-25', 0],
      ['2026-11-25', 1],
      ['2026-11-26', 0],
    ]);
  });
});

describe('automatic strict mode from the registry (Appendix A.6)', { timeout: 30_000 }, () => {
  afterEach(() => {
    __setRegistryStrict(false);
    delete process.env.TENANCY_STRICT;
    delete process.env.MIS_INTEGRATION_TOKEN;
  });

  const registry = (body: unknown) => (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;

  it('reads tenancy.strict.tendo, in either envelope', () => {
    expect(strictFlagOf({ tenancy: { strict: { tendo: true } } })).toBe(true);
    expect(strictFlagOf({ data: { tenancy: { strict: { tendo: false, mis: true } } } })).toBe(false);
    expect(strictFlagOf({ tenants: [] })).toBeUndefined();
  });

  it('turns on legacy tid none + enforce when MIS says so, and off again', async () => {
    process.env.MIS_INTEGRATION_TOKEN = 'tok';
    await loadTenantsFromMis(registry({ tenants: [{ tid: 1, slug: 'nga' }], tenancy: { strict: { tendo: true, tupo: false } } }));
    expect(strictActive()).toBe(true);
    expect(tenancyMode()).toBe('enforce');
    expect(legacyDefaultTid()).toBeNull();
    expect(() => effectiveTenant('a job')).toThrow(TenantContextMissing);

    await loadTenantsFromMis(registry({ tenants: [{ tid: 1, slug: 'nga' }], tenancy: { strict: { tendo: false } } }));
    expect(strictActive()).toBe(false);
    expect(tenancyMode()).toBe('shadow');
    expect(legacyDefaultTid()).toBe(1);
  });

  it('an MIS without the field means not strict; a failed fetch keeps the last answer', async () => {
    process.env.MIS_INTEGRATION_TOKEN = 'tok';
    await loadTenantsFromMis(registry({ tenants: [{ tid: 1 }], tenancy: { strict: { tendo: true } } }));
    await loadTenantsFromMis((async () => new Response('down', { status: 503 })) as unknown as typeof fetch);
    expect(strictActive()).toBe(true);
    await loadTenantsFromMis(registry({ tenants: [{ tid: 1 }] }));
    expect(strictActive()).toBe(false);
  });

  it('TENANCY_STRICT=off is the kill switch', async () => {
    process.env.MIS_INTEGRATION_TOKEN = 'tok';
    process.env.TENANCY_STRICT = 'off';
    await loadTenantsFromMis(registry({ tenants: [{ tid: 1 }], tenancy: { strict: { tendo: true } } }));
    expect(strictActive()).toBe(false);
    expect(tenancyMode()).toBe('shadow');
    expect(legacyDefaultTid()).toBe(1);
  });

  it('in strict mode a session without tid is refused (TENANT_REQUIRED)', async () => {
    await setupTestDb();
    __setRegistryStrict(true);
    const legacy = jwt.sign({ id: 'x', role: 'teacher' }, config.jwtSecret, { expiresIn: '1h' });
    const r = await probe(legacy);
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('TENANT_REQUIRED');
  });
});

describe('my-schools, branding and SCHOOL_CHANGED', { timeout: 30_000 }, () => {
  let db: Database;
  const realFetch = globalThis.fetch;
  beforeAll(async () => {
    db = await setupTestDb();
    await db.run(`INSERT INTO users (id, name, email, role) VALUES ('9201', 'Aline', 'aline@school.test', 'teacher')`);
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    __clearBrandingCache();
  });

  it('keeps only well-formed schools from /auth/my-schools', () => {
    const list = mySchoolsOf({ data: { schools: [
      { tid: 1, slug: 'nga', name: 'NGA', logoUrl: 'https://x/logo.png', current: true },
      { tid: '2', slug: 'nga2', name: '', logoUrl: 'javascript:alert(1)' },
      { tid: 2, slug: 'dup' },
      { slug: 'no-tid' },
    ] } }, 1);
    expect(list).toEqual([
      { tid: 1, slug: 'nga', name: 'NGA', logoUrl: 'https://x/logo.png', current: true },
      { tid: 2, slug: 'nga2', name: 'nga2', logoUrl: null, current: false },
    ]);
    expect(mySchoolsOf(null)).toEqual([]);
  });

  it('reads school_name and logoUrl from /tenant/branding', () => {
    expect(brandingOf({ data: { school_name: ' New Generation Academy ', logoUrl: 'https://cdn/x.png' } }, 2))
      .toEqual({ tid: 2, name: 'New Generation Academy', documentsLogoUrl: null, logoUrl: 'https://cdn/x.png', documentsFooterUrl: null, documentsFooterText: null });
    // The document letterhead's footer (absent on an older MIS: null).
    expect(brandingOf({ data: { school_name: 'S', logos: { documents: 'https://cdn/d.png', footer: 'https://cdn/f.png' }, documents_footer_text: ' Line one\nLine two ' } }, 2))
      .toMatchObject({ documentsLogoUrl: 'https://cdn/d.png', documentsFooterUrl: 'https://cdn/f.png', documentsFooterText: 'Line one\nLine two' });
    expect(brandingOf({ data: {} }, 2)).toBeNull();
  });

  it('GET /api/sso/my-schools proxies MIS with the session MIS token; an old MIS answers an empty list', async () => {
    const mis = misToken({ userId: 9201 });
    const seen: any[] = [];
    globalThis.fetch = (async (url: any, init: any) => {
      seen.push({ url: String(url), auth: init?.headers?.Authorization });
      return new Response(JSON.stringify({ data: { schools: [{ tid: 1, slug: 'nga', name: 'NGA' }, { tid: 2, slug: 'b', name: 'B' }] } }));
    }) as typeof fetch;
    const r = await request(app).get('/api/sso/my-schools').set(authHeader(session('9201', mis)));
    expect(r.status).toBe(200);
    expect(r.body.data.schools.map((s: any) => [s.tid, s.current])).toEqual([[1, true], [2, false]]);
    expect(seen[0].url).toMatch(/\/auth\/my-schools$/);
    expect(seen[0].auth).toBe(`Bearer ${mis}`);

    globalThis.fetch = (async () => new Response('not found', { status: 404 })) as typeof fetch;
    const old = await request(app).get('/api/sso/my-schools').set(authHeader(session('9201', mis)));
    expect(old.body.data.schools).toEqual([]);
  });

  it('GET /api/sso/branding asks MIS for this session school', async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: any) => (urls.push(String(url)), new Response(JSON.stringify({ data: { school_name: 'NGA', logoUrl: 'https://cdn/l.png' } })))) as typeof fetch;
    const r = await request(app).get('/api/sso/branding').set(authHeader(session('9201', misToken({}))));
    expect(r.body.data).toEqual({ tid: 1, name: 'NGA', documentsLogoUrl: null, documentsFooterUrl: null, documentsFooterText: null, logoUrl: 'https://cdn/l.png' });
    expect(urls[0]).toMatch(/\/tenant\/branding\?tid=1$/);
  });

  it('verify-mis answers 409 SCHOOL_CHANGED when the MIS session is in another school', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ success: true, data: { currentTid: 2 } }))) as typeof fetch;
    const r = await request(app).get('/api/sso/verify-mis').set(authHeader(session('9201', misToken({}))));
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('SCHOOL_CHANGED');

    globalThis.fetch = (async () => new Response(JSON.stringify({ success: true, data: { currentTid: 1 } }))) as typeof fetch;
    expect((await request(app).get('/api/sso/verify-mis').set(authHeader(session('9201', misToken({}))))).status).toBe(200);
  });
});

