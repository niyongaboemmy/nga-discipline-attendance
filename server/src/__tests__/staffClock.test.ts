import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { webcrypto } from 'crypto';
import type { Database } from 'sqlite';
import { app } from '../app.js';
import { initDatabase, getDbFor } from '../database.js';
import { setupTestDb, createTestUser, authHeader } from './testUtils.js';
import { __setTenants, primaryTenantCtx, runWithTenant } from '../tenancy/index.js';
import { setSchoolSetting } from '../tenancy/settings.js';
import { __setGoogleVerifier } from '../modules/clock/google.js';
import { __setIdentityResolver, type MisStaffIdentity } from '../modules/clock/identity.js';
import { __setClockNow } from '../modules/clock/clock.service.js';
import { __resetNonces, punchMessage } from '../modules/clock/deviceAuth.js';
import { __resetClockRateLimits } from '../modules/clock/clock.routes.js';
import { __resetPhoneTaps, phoneTapMessage } from '../modules/clock/phoneTap.js';
import { haversine, judge, onSchoolNetwork, plausibilityFlags } from '../modules/clock/geofence.js';

/**
 * Staff attendance clock (STAFF_ATTENDANCE_CLOCK_PLAN.md): device registration with
 * Google + MIS identity, one-tap check-in / check-out inside the school zone on the
 * school clock, device rules, and the school-admin side.
 */

const subtle = webcrypto.subtle;
type CryptoKeyPair = webcrypto.CryptoKeyPair;
type JsonWebKey = webcrypto.JsonWebKey;
const CENTER = { lat: -1.95362, lng: 30.10441 };
/** ~40 m north of the centre. */
const INSIDE = { lat: -1.95326, lng: 30.10441, accuracy: 18 };
/** ~1.2 km away. */
const FAR = { lat: -1.94282, lng: 30.10441, accuracy: 15 };

/** 2026-11-24 is a Tuesday. Kigali is UTC+2. */
const kigali = (hhmm: string, date = '2026-11-24') => Date.parse(`${date}T${hhmm}:00+02:00`);

interface FakeDevice {
  keys: CryptoKeyPair;
  jwk: JsonWebKey;
  installUuid: string;
  token?: string;
}

async function newDevice(): Promise<FakeDevice> {
  const keys = (await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])) as CryptoKeyPair;
  const full = await subtle.exportKey('jwk', keys.publicKey);
  return { keys, jwk: { kty: full.kty, crv: full.crv, x: full.x, y: full.y }, installUuid: webcrypto.randomUUID() };
}

async function sign(device: FakeDevice, message: string): Promise<string> {
  const sig = await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, device.keys.privateKey, new TextEncoder().encode(message));
  return Buffer.from(sig).toString('base64url');
}

const people = new Map<string, MisStaffIdentity>();
function misPerson(id: number, name: string, email: string, extra: Partial<MisStaffIdentity> = {}) {
  const p: MisStaffIdentity = { user_id: id, name, email, status: 'ACTIVE', user_type: 'TEACHER', is_student: false, roles: ['TEACHER'], permissions: ['MARK_ATTENDANCE'], ...extra };
  people.set(email, p);
  return p;
}

async function register(slug: string, email: string, device: FakeDevice, extra: Record<string, unknown> = {}) {
  const res = await request(app)
    .post(`/api/clock/${slug}/register`)
    .set('User-Agent', 'Mozilla/5.0 (Linux; Android 13) Chrome/131')
    .send({ credential: `google:${email}`, publicKeyJwk: device.jwk, installUuid: device.installUuid, device: { browser: 'Chrome', os: 'Android', model: 'Tecno Spark 10', formFactor: 'phone' }, confirm: true, ...extra });
  if (res.body?.data?.deviceToken) device.token = res.body.data.deviceToken;
  return res;
}

async function tap(slug: string, device: FakeDevice, position: { lat: number; lng: number; accuracy: number }, opts: { samples?: unknown[]; clientTime?: string } = {}) {
  const ch = await request(app).post(`/api/clock/${slug}/challenge`).set('X-Clock-Device', device.token!);
  if (ch.status !== 200) return ch;
  const nonce = ch.body.data.nonce;
  return request(app)
    .post(`/api/clock/${slug}/punch`)
    .set('X-Clock-Device', device.token!)
    .send({ nonce, signature: await sign(device, punchMessage(nonce, position)), position: { ...position, ts: Date.now() }, samples: opts.samples ?? [], clientTime: opts.clientTime });
}

let db: Database;
let adminToken: string;
let now = kigali('07:40');

async function settings(tid: number, values: Record<string, string>) {
  const d = getDbFor(tid);
  for (const [k, v] of Object.entries(values)) await setSchoolSetting(d, tid, k as any, v);
}

beforeAll(async () => {
  db = await setupTestDb();
  ({ token: adminToken } = await createTestUser(db, { id: '900', name: 'Admin Office', email: 'admin@school.rw', roleLevel: 'ADMIN' }));
  __setGoogleVerifier(async (credential) => {
    if (!credential.startsWith('google:')) throw Object.assign(new (await import('../modules/clock/google.js')).GoogleTokenError('bad'), {});
    const email = credential.slice(7);
    return { sub: `sub-${email}`, email };
  });
  __setIdentityResolver(async ({ email }) => {
    const p = people.get(email);
    return p ? { kind: 'found', person: p } : { kind: 'no_match' };
  });
  __setClockNow(() => now);
  await db.run(
    `INSERT INTO attendance_zones (name, kind, center_lat, center_lng, radius_m, active, updated_at) VALUES ('Main campus', 'circle', ?, ?, 150, 1, ?)`,
    CENTER.lat, CENTER.lng, new Date().toISOString()
  );
  await settings(1, { STAFF_CLOCK_ENABLED: '1' });
});

beforeEach(() => {
  __resetNonces();
  __resetClockRateLimits();
});

afterAll(() => {
  __setGoogleVerifier(null);
  __setIdentityResolver(null);
  __setClockNow(null);
  __setTenants([primaryTenantCtx()]);
});

describe('geofence (pure)', () => {
  it('measures distances and judges circles with the accuracy allowance', () => {
    expect(Math.round(haversine(CENTER, INSIDE))).toBeGreaterThan(35);
    expect(Math.round(haversine(CENTER, INSIDE))).toBeLessThan(45);
    const zone = [{ id: 1, name: 'Main', kind: 'circle' as const, center_lat: CENTER.lat, center_lng: CENTER.lng, radius_m: 150, polygon_geojson: null, active: 1 }];
    expect(judge(INSIDE, zone, { maxAccuracy: 100, allowance: 50 }).inside).toBe(true);
    // 180 m out, 40 m precision: 150 + min(40, 50) = 190 -> inside on the allowance.
    const edge = { lat: CENTER.lat + 180 / 111_195, lng: CENTER.lng, accuracy: 40 };
    expect(judge(edge, zone, { maxAccuracy: 100, allowance: 50 }).inside).toBe(true);
    expect(judge({ ...edge, accuracy: 10 }, zone, { maxAccuracy: 100, allowance: 50 }).inside).toBe(false);
    const vague = judge({ ...INSIDE, accuracy: 240 }, zone, { maxAccuracy: 100, allowance: 50 });
    expect(vague.preciseEnough).toBe(false);
    expect(vague.inside).toBe(false);
  });

  it('flags readings that look made up and knows school networks', () => {
    const same = { ...INSIDE, accuracy: 5 };
    const flags = plausibilityFlags({ fix: same, samples: [same, same, same], serverNow: Date.now(), clientSkewMs: 0 });
    expect(flags).toContain('no_jitter');
    expect(flags).toContain('suspicious_accuracy');
    expect(plausibilityFlags({ fix: INSIDE, samples: [], serverNow: Date.now(), clientSkewMs: 20 * 60_000 })).toContain('clock_skew');
    expect(onSchoolNetwork('41.186.10.7', '41.186.10.0/24')).toBe(true);
    expect(onSchoolNetwork('::ffff:41.186.10.7', '41.186.10.0/24')).toBe(true);
    expect(onSchoolNetwork('41.186.11.7', '41.186.10.0/24')).toBe(false);
  });
});

describe('the public page', () => {
  it('bootstraps from the slug with the school clock and zones, and refuses unknown schools', async () => {
    const res = await request(app).get('/api/clock/nga/bootstrap');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ school: { slug: 'nga' }, open: true, timezone: 'Africa/Kigali', schoolDate: '2026-11-24' });
    expect(res.body.data.zones[0]).toMatchObject({ name: 'Main campus', radius: 150 });
    expect((await request(app).get('/api/clock/nope/bootstrap')).status).toBe(404);
  });

  it('registers a teacher phone, checks in on time, refuses a second check-in tap pattern, checks out after the minimum shift', async () => {
    misPerson(101, 'Grace Mukamana', 'grace@gmail.com');
    const phone = await newDevice();
    now = kigali('07:42');
    // The confirm screen first: who this is, nothing saved.
    const preview = await register('nga', 'grace@gmail.com', phone, { confirm: false });
    expect(preview.body.data).toMatchObject({ preview: true, deviceStatus: 'active', person: { name: 'Grace Mukamana' }, email: 'grace@gmail.com' });
    expect(preview.body.data.deviceToken).toBeUndefined();
    expect(await db.get(`SELECT 1 FROM attendance_devices WHERE user_id = '101'`)).toBeUndefined();
    const reg = await register('nga', 'grace@gmail.com', phone);
    expect(reg.status).toBe(200);
    expect(reg.body.data).toMatchObject({ deviceStatus: 'active', person: { firstName: 'Grace', initials: 'GM', role: 'Teacher' } });

    const me = await request(app).get('/api/clock/nga/me').set('X-Clock-Device', phone.token!);
    expect(me.body.data).toMatchObject({ next: 'check_in', device: { status: 'active' } });

    const inRes = await tap('nga', phone, INSIDE);
    expect(inRes.status).toBe(200);
    expect(inRes.body.data).toMatchObject({ action: 'check_in', at: '07:42', status: 'present', zone: 'Main campus' });
    expect(inRes.body.data.state).toMatchObject({ next: 'check_out', checkoutOpensAt: '08:42' });

    now = kigali('08:00');
    const tooSoon = await tap('nga', phone, INSIDE);
    expect(tooSoon.status).toBe(409);
    expect(tooSoon.body).toMatchObject({ code: 'TOO_SOON', checkoutOpensAt: '08:42' });

    now = kigali('16:10');
    const out = await tap('nga', phone, INSIDE);
    expect(out.status).toBe(200);
    expect(out.body.data).toMatchObject({ action: 'check_out', at: '16:10', status: 'on_time' });
    expect(out.body.data.state).toMatchObject({ next: 'done', today: { checkIn: '07:42', checkOut: '16:10', minutesAtSchool: 508 } });

    const again = await tap('nga', phone, INSIDE);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('ALREADY_DONE');

    const row = await db.get(`SELECT * FROM staff_attendance WHERE staff_id = '101'`);
    expect(row).toMatchObject({ date: '2026-11-24', source: 'device', status: 'present', out_status: 'on_time' });
  });

  it('uses the school clock, never the phone clock', async () => {
    misPerson(102, 'Patrick Habimana', 'patrick@gmail.com');
    const phone = await newDevice();
    now = kigali('08:44');
    await register('nga', 'patrick@gmail.com', phone);
    // The phone says 07:00 -- it is ignored (but recorded as skew and flagged).
    const res = await tap('nga', phone, INSIDE, { clientTime: new Date(kigali('07:00')).toISOString() });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ at: '08:44', status: 'late' });
    expect(res.body.data.flags).toContain('clock_skew');
    const row = await db.get(`SELECT client_skew_ms FROM staff_attendance WHERE staff_id = '102'`);
    expect(row.client_skew_ms).toBe(kigali('07:00') - kigali('08:44'));
  });

  it('refuses outside the zone and vague fixes, and logs every refusal', async () => {
    misPerson(103, 'Diane Umutoni', 'diane@gmail.com');
    const phone = await newDevice();
    now = kigali('07:30');
    await register('nga', 'diane@gmail.com', phone);
    const far = await tap('nga', phone, FAR);
    expect(far.status).toBe(403);
    expect(far.body.code).toBe('OUTSIDE_ZONE');
    expect(far.body.distance).toBeGreaterThan(1100);
    const vague = await tap('nga', phone, { ...INSIDE, accuracy: 240 });
    expect(vague.status).toBe(422);
    expect(vague.body).toMatchObject({ code: 'LOW_ACCURACY', accuracy: 240 });
    const events = await db.all(`SELECT reason FROM attendance_events WHERE user_id = '103' AND kind = 'refused'`);
    expect(events.map((e: any) => e.reason)).toEqual(['outside_zone', 'low_accuracy']);
    expect(await db.get(`SELECT 1 FROM staff_attendance WHERE staff_id = '103'`)).toBeUndefined();
  });

  it('rejects replayed nonces, wrong signatures and copied tokens', async () => {
    misPerson(104, 'Olivier Mugisha', 'olivier@gmail.com');
    const phone = await newDevice();
    const thief = await newDevice();
    now = kigali('07:31');
    await register('nga', 'olivier@gmail.com', phone);
    const ch = await request(app).post('/api/clock/nga/challenge').set('X-Clock-Device', phone.token!);
    const nonce = ch.body.data.nonce;
    // Token copied to another device: that device's key cannot sign for it.
    const forged = await request(app).post('/api/clock/nga/punch').set('X-Clock-Device', phone.token!)
      .send({ nonce, signature: await sign(thief, punchMessage(nonce, INSIDE)), position: INSIDE });
    expect(forged.status).toBe(401);
    expect(forged.body.code).toBe('BAD_SIGNATURE');
    // The nonce was burnt by that attempt.
    const replay = await request(app).post('/api/clock/nga/punch').set('X-Clock-Device', phone.token!)
      .send({ nonce, signature: await sign(phone, punchMessage(nonce, INSIDE)), position: INSIDE });
    expect(replay.status).toBe(401);
    expect(replay.body.code).toBe('BAD_CHALLENGE');
    // A signature over different coordinates than the ones sent fails.
    const ch2 = await request(app).post('/api/clock/nga/challenge').set('X-Clock-Device', phone.token!);
    const moved = await request(app).post('/api/clock/nga/punch').set('X-Clock-Device', phone.token!)
      .send({ nonce: ch2.body.data.nonce, signature: await sign(phone, punchMessage(ch2.body.data.nonce, FAR)), position: INSIDE });
    expect(moved.body.code).toBe('BAD_SIGNATURE');
    expect((await request(app).get('/api/clock/nga/me').set('X-Clock-Device', 'x'.repeat(43))).status).toBe(401);
  });

  it('refuses students, unknown Google accounts and inactive accounts', async () => {
    misPerson(105, 'Student One', 'student@gmail.com', { is_student: true, user_type: 'STUDENT', roles: ['STUDENT'] });
    misPerson(106, 'Gone Teacher', 'gone@gmail.com', { status: 'INACTIVE' });
    expect((await register('nga', 'student@gmail.com', await newDevice())).body.code).toBe('STUDENT');
    const unknown = await register('nga', 'stranger@gmail.com', await newDevice());
    expect(unknown.status).toBe(404);
    expect(unknown.body.code).toBe('NO_ACCOUNT');
    expect((await register('nga', 'gone@gmail.com', await newDevice())).body.code).toBe('INACTIVE');
    const forgedGoogle = await request(app).post('/api/clock/nga/register').send({ credential: 'not-a-google-token', publicKeyJwk: {}, installUuid: webcrypto.randomUUID() });
    expect(forgedGoogle.status).toBe(401);
  });

  it('one person per device, re-keying the same phone, and approval for a second device within 30 days', async () => {
    misPerson(107, 'Claudine Uwase', 'claudine@gmail.com');
    misPerson(108, 'Jean Bosco Niyonzima', 'jb@gmail.com');
    now = kigali('07:20');
    const phone = await newDevice();
    expect((await register('nga', 'claudine@gmail.com', phone)).body.data.deviceStatus).toBe('active');

    // Someone else signs in on Claudine's phone (same install id, new key): refused.
    const sameInstall = await newDevice();
    sameInstall.installUuid = phone.installUuid;
    const taken = await register('nga', 'jb@gmail.com', sameInstall);
    expect(taken.status).toBe(409);
    expect(taken.body.code).toBe('DEVICE_TAKEN');

    // Claudine clears storage on the same phone: re-key, active at once, old token dead.
    const rekey = await newDevice();
    rekey.installUuid = phone.installUuid;
    const oldToken = phone.token!;
    expect((await register('nga', 'claudine@gmail.com', rekey)).body.data.deviceStatus).toBe('active');
    expect((await request(app).get('/api/clock/nga/me').set('X-Clock-Device', oldToken)).body.code).toBe('DEVICE_REVOKED');

    // A genuinely new phone: replaces by itself (first self-replacement).
    const second = await newDevice();
    const r2 = await register('nga', 'claudine@gmail.com', second, { device: { browser: 'Safari', os: 'iOS', model: 'iPhone 11', formFactor: 'phone' } });
    expect(r2.body.data).toMatchObject({ deviceStatus: 'active', replaced: true });

    // A third, a week later: waits for the school, while the second keeps working.
    now = kigali('07:25', '2026-12-01');
    const third = await newDevice();
    const r3 = await register('nga', 'claudine@gmail.com', third, { device: { browser: 'Chrome', os: 'Android', model: 'Samsung A15', formFactor: 'tablet' } });
    expect(r3.body.data.deviceStatus).toBe('pending');
    expect((await request(app).get('/api/clock/nga/me').set('X-Clock-Device', third.token!)).body.data.device.status).toBe('pending');
    expect((await request(app).post('/api/clock/nga/challenge').set('X-Clock-Device', third.token!)).body.code).toBe('DEVICE_PENDING');
    expect((await request(app).post('/api/clock/nga/challenge').set('X-Clock-Device', second.token!)).status).toBe(200);

    // The admin approves: third active, second replaced.
    const list = await request(app).get('/api/staff/clock/devices?status=pending').set(authHeader(adminToken));
    const pendingId = list.body.data.find((d: any) => d.user_id === '107').id;
    const ok = await request(app).post(`/api/staff/clock/devices/${pendingId}/approve`).set(authHeader(adminToken));
    expect(ok.status).toBe(200);
    expect((await request(app).post('/api/clock/nga/challenge').set('X-Clock-Device', third.token!)).status).toBe(200);
    expect((await request(app).post('/api/clock/nga/challenge').set('X-Clock-Device', second.token!)).body.code).toBe('DEVICE_REVOKED');

    // Revoke needs a reason, then the device is out.
    expect((await request(app).post(`/api/staff/clock/devices/${pendingId}/revoke`).set(authHeader(adminToken)).send({})).body.code).toBe('REASON_REQUIRED');
    expect((await request(app).post(`/api/staff/clock/devices/${pendingId}/revoke`).set(authHeader(adminToken)).send({ reason: 'Lost tablet' })).status).toBe(200);
    expect((await request(app).get('/api/clock/nga/me').set('X-Clock-Device', third.token!)).body.code).toBe('DEVICE_REVOKED');
  });

  it('an account made inactive locally loses its device', async () => {
    misPerson(109, 'Fabrice Ndayisaba', 'fabrice@gmail.com');
    now = kigali('07:20');
    const phone = await newDevice();
    await register('nga', 'fabrice@gmail.com', phone);
    await db.run(`UPDATE users SET status = 'inactive' WHERE id = '109'`);
    const res = await request(app).get('/api/clock/nga/me').set('X-Clock-Device', phone.token!);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('DEVICE_REVOKED');
  });
});

describe('the school admin side', () => {
  it('saves rules with validation and refuses to open the clock without a zone', async () => {
    const bad = await request(app).put('/api/staff/clock/config').set(authHeader(adminToken)).send({ lateAfter: '8:30' });
    expect(bad.status).toBe(400);
    const ok = await request(app).put('/api/staff/clock/config').set(authHeader(adminToken)).send({ lateAfter: '08:30', maxAccuracy: 100 });
    expect(ok.status).toBe(200);
    expect(ok.body.data.rules).toMatchObject({ lateAfter: '08:30', maxAccuracy: 100 });
    const cfg = await request(app).get('/api/staff/clock/config').set(authHeader(adminToken));
    expect(cfg.body.data.link.slug).toBe('nga');
    expect(cfg.body.data.zones).toHaveLength(1);
  });

  it('remembers setup checklist steps (rules saved count as reviewed)', async () => {
    const r1 = await request(app).put('/api/staff/clock/config').set(authHeader(adminToken)).send({ setupDone: ['tested'] });
    expect(r1.body.data.rules.setupDone).toEqual(expect.arrayContaining(['tested', 'rules']));
    const r2 = await request(app).put('/api/staff/clock/config').set(authHeader(adminToken)).send({ setupDone: ['shared'] });
    expect(r2.body.data.rules.setupDone.sort()).toEqual(['rules', 'shared', 'tested']);
    expect((await request(app).put('/api/staff/clock/config').set(authHeader(adminToken)).send({ setupDone: ['nope'] })).status).toBe(400);
  });

  it('creates, edits and deletes zones; the last zone gone closes the clock', async () => {
    const created = await request(app).post('/api/staff/clock/zones').set(authHeader(adminToken)).send({ name: 'Sports ground', lat: -1.95391, lng: 30.10662, radius: 70 });
    expect(created.status).toBe(201);
    expect((await request(app).post('/api/staff/clock/zones').set(authHeader(adminToken)).send({ name: 'Tiny', lat: 0, lng: 0, radius: 10 })).status).toBe(400);
    const id = created.body.data.id;
    const edited = await request(app).put(`/api/staff/clock/zones/${id}`).set(authHeader(adminToken)).send({ radius: 90, name: 'Sports ground and parking area near the market road' });
    expect(edited.body.data).toMatchObject({ radius_m: 90 });
    expect((await request(app).delete(`/api/staff/clock/zones/${id}`).set(authHeader(adminToken))).status).toBe(200);
  });

  it('builds the day overview: KPIs, arrivals, rows, unusual check-ins, phones', async () => {
    now = kigali('10:15');
    const res = await request(app).get('/api/staff/clock/overview?date=2026-11-24').set(authHeader(adminToken));
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.kpis.checkedIn).toBeGreaterThanOrEqual(2);
    expect(d.kpis.late).toBeGreaterThanOrEqual(1);
    expect(d.arrivals.some((b: any) => b.late > 0)).toBe(true);
    const grace = d.rows.find((r: any) => r.userId === '101');
    expect(grace).toMatchObject({ checkIn: '07:42', checkOut: '16:10', status: 'present' });
    expect(d.phones.registered).toBeGreaterThanOrEqual(3);
    expect(d.health).toMatchObject({ zones: 1, unregistered: expect.any(Number) });
    // 10:15 today: the check-out window (16:00) is not open, so nobody is "missing" a check-out yet.
    expect(d.missing).toMatchObject({ checkoutOpen: false, noCheckoutToday: [] });
  });

  it('lists missing check-outs: today only after the check-out window opens, and the last 7 days', async () => {
    await db.run(`INSERT INTO staff_attendance (staff_id, staff_name, date, clock_in, status, source) VALUES ('777', 'Open Day', '2026-12-05', '2026-12-05T05:30:00.000Z', 'present', 'device')`);
    await db.run(`INSERT INTO staff_attendance (staff_id, staff_name, date, clock_in, status, source) VALUES ('777', 'Open Day', '2026-12-06', '2026-12-06T05:30:00.000Z', 'present', 'device')`);
    now = kigali('10:00', '2026-12-06');
    const morning = (await request(app).get('/api/staff/clock/overview').set(authHeader(adminToken))).body.data;
    expect(morning.missing.checkoutOpen).toBe(false);
    expect(morning.missing.noCheckoutToday).toEqual([]);
    expect(morning.missing.recentNoCheckout).toEqual(expect.arrayContaining([expect.objectContaining({ userId: '777', date: '2026-12-05', checkIn: '07:30' })]));
    now = kigali('17:30', '2026-12-06');
    const evening = (await request(app).get('/api/staff/clock/overview').set(authHeader(adminToken))).body.data;
    expect(evening.missing.noCheckoutToday).toEqual([expect.objectContaining({ userId: '777', name: 'Open Day', checkIn: '07:30' })]);
  });

  it('reviews a flagged check-in and exports CSV', async () => {
    misPerson(110, 'Twin One', 'twin1@gmail.com');
    now = kigali('07:05', '2026-12-02');
    const p = await newDevice();
    await register('nga', 'twin1@gmail.com', p);
    const same = { ...INSIDE, accuracy: 5 };
    const r = await tap('nga', p, same, { samples: [same, same, same] });
    expect(r.body.data.flags).toEqual(expect.arrayContaining(['no_jitter', 'suspicious_accuracy']));
    const ov = await request(app).get('/api/staff/clock/overview?date=2026-12-02').set(authHeader(adminToken));
    const item = ov.body.data.review.find((x: any) => x.userId === '110');
    expect(item.flagText).toContain('Location did not move between readings');
    expect((await request(app).post(`/api/staff/clock/attendance/${item.recordId}/review`).set(authHeader(adminToken)).send({ decision: 'invalid' })).body.code).toBe('REASON_REQUIRED');
    expect((await request(app).post(`/api/staff/clock/attendance/${item.recordId}/review`).set(authHeader(adminToken)).send({ decision: 'accepted' })).status).toBe(200);
    const ov2 = await request(app).get('/api/staff/clock/overview?date=2026-12-02').set(authHeader(adminToken));
    expect(ov2.body.data.review.find((x: any) => x.userId === '110')).toBeUndefined();
    const csv = await request(app).get('/api/staff/clock/export?from=2026-11-24&to=2026-12-02').set(authHeader(adminToken));
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text).toContain('Grace Mukamana');
  });

  it('teachers cannot manage the zone or devices', async () => {
    const { token } = await createTestUser(db, { id: '950', name: 'T', email: 't@x', roleLevel: 'TEACHER' });
    expect((await request(app).put('/api/staff/clock/config').set(authHeader(token)).send({ enabled: false })).status).toBe(403);
    expect((await request(app).get('/api/staff/clock/devices').set(authHeader(token))).status).toBe(403);
  });

  it('the old desktop clock-in is closed while the zone is required', async () => {
    const { token } = await createTestUser(db, { id: '951', name: 'T2', email: 't2@x', roleLevel: 'TEACHER' });
    const res = await request(app).post('/api/staff/clock-in').set(authHeader(token));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('USE_STAFF_CLOCK');
  });
});

describe('staff QR cards (no smartphone)', () => {
  it('an admin prints a card; a scanner checks the person in and out at school, on the same rules', async () => {
    now = kigali('07:10', '2026-12-03');
    const issued = await request(app).post('/api/staff/clock/cards').set(authHeader(adminToken)).send({ people: [{ id: '301', name: 'Mukamana Jeanne' }] });
    expect(issued.status).toBe(201);
    const code: string = issued.body.data.cards[0].code;
    expect(code).toMatch(/^TC1-[A-Z2-9]{20}$/);
    expect((await db.get(`SELECT code_hash FROM staff_clock_cards WHERE user_id = '301'`)).code_hash).not.toBe(code);

    const position = { lat: INSIDE.lat, lng: INSIDE.lng, accuracy: 12 };
    const scanIn = await request(app).post('/api/staff/clock/scan').set(authHeader(adminToken)).send({ code: code.toLowerCase(), position });
    expect(scanIn.status).toBe(200);
    expect(scanIn.body.data).toMatchObject({ action: 'check_in', at: '07:10', status: 'present', person: { name: 'Mukamana Jeanne' }, checkIn: '07:10' });
    expect(await db.get(`SELECT source, in_by FROM staff_attendance WHERE staff_id = '301'`)).toMatchObject({ source: 'card', in_by: '900' });

    const tooSoon = await request(app).post('/api/staff/clock/scan').set(authHeader(adminToken)).send({ code, position });
    expect(tooSoon.body).toMatchObject({ code: 'TOO_SOON', name: 'Mukamana Jeanne' });

    // The scanner must be at school too.
    now = kigali('16:30', '2026-12-03');
    const far = await request(app).post('/api/staff/clock/scan').set(authHeader(adminToken)).send({ code, position: { lat: FAR.lat, lng: FAR.lng, accuracy: 10 } });
    expect(far.body.code).toBe('OUTSIDE_ZONE');

    const out = await request(app).post('/api/staff/clock/scan').set(authHeader(adminToken)).send({ code, position });
    expect(out.body.data).toMatchObject({ action: 'check_out', at: '16:30', status: 'on_time', checkOut: '16:30' });

    // Reprinting replaces the old card.
    const again = await request(app).post('/api/staff/clock/cards').set(authHeader(adminToken)).send({ people: [{ id: '301', name: 'Mukamana Jeanne' }] });
    now = kigali('07:00', '2026-12-04');
    const old = await request(app).post('/api/staff/clock/scan').set(authHeader(adminToken)).send({ code, position });
    expect(old.status).toBe(410);
    expect(old.body.code).toBe('CARD_REPLACED');
    const fresh = await request(app).post('/api/staff/clock/scan').set(authHeader(adminToken)).send({ code: again.body.data.cards[0].code, position });
    expect(fresh.body.data.action).toBe('check_in');

    expect((await request(app).post('/api/staff/clock/scan').set(authHeader(adminToken)).send({ code: 'hello', position })).body.code).toBe('BAD_CARD');
    expect((await request(app).post('/api/staff/clock/scan').set(authHeader(adminToken)).send({ code: 'TC1-' + 'A'.repeat(20), position })).body.code).toBe('UNKNOWN_CARD');
  });

  it('only holders of STAFF_CLOCK_SCAN may scan, and only card managers may print', async () => {
    const { token } = await createTestUser(db, { id: '952', name: 'T3', email: 't3@x', roleLevel: 'TEACHER' });
    expect((await request(app).post('/api/staff/clock/scan').set(authHeader(token)).send({ code: 'TC1-' + 'A'.repeat(20) })).status).toBe(403);
    expect((await request(app).post('/api/staff/clock/cards').set(authHeader(token)).send({ people: [{ id: '1', name: 'x' }] })).status).toBe(403);
  });
});

describe('phone GPS for a setup test on a computer', () => {
  it('an admin pairs a phone; the phone sends its location without signing in; only that admin reads it', async () => {
    const made = await request(app).post('/api/staff/clock/pair').set(authHeader(adminToken));
    expect(made.status).toBe(200);
    const { code, url } = made.body.data;
    expect(url).toContain(`/c/nga/pair/${code}`);
    expect((await request(app).get(`/api/clock/nga/pair/${code}`)).status).toBe(200);
    expect((await request(app).post(`/api/clock/nga/pair/${code}`).send({ position: { lat: INSIDE.lat, lng: INSIDE.lng, accuracy: 9 } })).status).toBe(200);
    const read = await request(app).get(`/api/staff/clock/pair/${code}`).set(authHeader(adminToken));
    expect(read.body.data.readings[0]).toMatchObject({ lat: INSIDE.lat, accuracy: 9 });
    // Wrong school, unknown code, teacher reading it: refused.
    expect((await request(app).post('/api/clock/nga/pair/nope').send({ position: INSIDE })).status).toBe(404);
    const { token } = await createTestUser(db, { id: '953', name: 'T4', email: 't4@x', roleLevel: 'TEACHER' });
    expect((await request(app).get(`/api/staff/clock/pair/${code}`).set(authHeader(token))).status).toBe(403);
    // No attendance was recorded by any of this.
    expect(await db.get(`SELECT 1 FROM attendance_events WHERE kind = 'check_in' AND lat = ? AND accuracy_m = 9`, INSIDE.lat)).toBeUndefined();
  });
});

describe('check in from a computer with a phone (QR code)', () => {
  async function phoneCode(device: FakeDevice) {
    const ch = await request(app).post('/api/clock/nga/challenge').set('X-Clock-Device', device.token!);
    const nonce = ch.body.data.nonce;
    return request(app).post('/api/clock/nga/phone-tap').set('X-Clock-Device', device.token!).send({ nonce, signature: await sign(device, phoneTapMessage(nonce)) });
  }

  it('the computer shows a code; a phone scans it, sends its location and the tap is recorded for the computer owner', async () => {
    __resetPhoneTaps();
    misPerson(120, 'Aline Uwase', 'aline@gmail.com');
    const laptop = await newDevice();
    now = kigali('07:30', '2026-11-25');
    expect((await register('nga', 'aline@gmail.com', laptop, { device: { browser: 'Chrome', os: 'macOS', formFactor: 'desktop' } })).status).toBe(200);

    // A bad signature gets no code.
    const ch = await request(app).post('/api/clock/nga/challenge').set('X-Clock-Device', laptop.token!);
    expect((await request(app).post('/api/clock/nga/phone-tap').set('X-Clock-Device', laptop.token!).send({ nonce: ch.body.data.nonce, signature: 'AAAA' })).status).toBe(401);

    const made = await phoneCode(laptop);
    expect(made.status).toBe(200);
    const { code, url } = made.body.data;
    expect(url).toContain(`/c/nga/tap/${code}`);
    expect((await request(app).get(`/api/clock/nga/phone-tap/${code}`).set('X-Clock-Device', laptop.token!)).body.data.state).toBe('waiting');

    // The phone (no sign-in) sees whose tap it is, then sends a vague reading: refused, the code stays usable.
    const preview = await request(app).get(`/api/clock/nga/tap/${code}`);
    expect(preview.body.data).toMatchObject({ firstName: 'Aline', next: 'check_in' });
    const vague = await request(app).post(`/api/clock/nga/tap/${code}`).send({ position: { lat: INSIDE.lat, lng: INSIDE.lng, accuracy: 400 } });
    expect(vague.status).toBe(422);
    const seen = await request(app).get(`/api/clock/nga/phone-tap/${code}`).set('X-Clock-Device', laptop.token!);
    expect(seen.body.data).toMatchObject({ state: 'failed', error: { code: 'LOW_ACCURACY' } });

    const ok = await request(app).post(`/api/clock/nga/tap/${code}`).send({ position: { lat: INSIDE.lat, lng: INSIDE.lng, accuracy: 12 }, clientTime: new Date(now).toISOString() });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ action: 'check_in', at: '07:30', status: 'present', zone: 'Main campus' });
    expect(ok.body.data.flags).toContain('phone_location');
    const done = await request(app).get(`/api/clock/nga/phone-tap/${code}`).set('X-Clock-Device', laptop.token!);
    expect(done.body.data).toMatchObject({ state: 'done', result: { action: 'check_in' }, dayState: { next: 'check_out' } });
    const row = await db.get<{ source: string; flags: string; in_accuracy_m: number }>(`SELECT source, flags, in_accuracy_m FROM staff_attendance WHERE staff_id = '120' AND date = '2026-11-25'`);
    expect(row).toMatchObject({ source: 'device', in_accuracy_m: 12 });
    expect(JSON.parse(row!.flags)).toContain('phone_location');

    // One tap per code; another computer cannot read it; unknown codes are refused.
    expect((await request(app).post(`/api/clock/nga/tap/${code}`).send({ position: INSIDE })).status).toBe(409);
    const other = await newDevice();
    misPerson(121, 'Eric Habimana', 'eric.h@gmail.com');
    await register('nga', 'eric.h@gmail.com', other);
    expect((await request(app).get(`/api/clock/nga/phone-tap/${code}`).set('X-Clock-Device', other.token!)).status).toBe(404);
    expect((await request(app).get('/api/clock/nga/tap/nope-nope-nope')).status).toBe(404);

    // Outside the zone is still refused; codes expire after 2 minutes.
    now = kigali('16:30', '2026-11-25');
    const out1 = (await phoneCode(laptop)).body.data.code;
    expect((await request(app).post(`/api/clock/nga/tap/${out1}`).send({ position: FAR })).status).toBe(403);
    now += 3 * 60_000;
    expect((await request(app).post(`/api/clock/nga/tap/${out1}`).send({ position: INSIDE })).status).toBe(404);
    const out2 = (await phoneCode(laptop)).body.data.code;
    const out = await request(app).post(`/api/clock/nga/tap/${out2}`).send({ position: INSIDE });
    expect(out.body.data).toMatchObject({ action: 'check_out' });
  });
});

describe('another school, another timezone', () => {
  it('a UTC-5 school decides today and lateness in its own zone', async () => {
    __setTenants([primaryTenantCtx(), { tid: 7, slug: 'nyc', name: 'NYC School', status: 'ACTIVE', isPrimary: false, timezone: 'America/New_York', pkg: 'max' }]);
    const d7 = await initDatabase(7, ':memory:');
    await d7.run(`INSERT INTO attendance_zones (name, kind, center_lat, center_lng, radius_m, active, updated_at) VALUES ('Campus', 'circle', ?, ?, 150, 1, ?)`, CENTER.lat, CENTER.lng, new Date().toISOString());
    await runWithTenant({ ...primaryTenantCtx(), tid: 7, slug: 'nyc', timezone: 'America/New_York', isPrimary: false }, async () => {
      await setSchoolSetting(d7, 7, 'STAFF_CLOCK_ENABLED', '1');
    });
    misPerson(201, 'Ny Teacher', 'ny@gmail.com');
    // 2026-11-25 01:30 UTC = 2026-11-24 20:30 in New York.
    now = Date.parse('2026-11-25T13:00:00Z'); // 08:00 New York
    const phone = await newDevice();
    expect((await register('nyc', 'ny@gmail.com', phone)).status).toBe(200);
    const r = await tap('nyc', phone, INSIDE);
    expect(r.body.data).toMatchObject({ at: '08:00', status: 'present' });
    expect(r.body.data.state.schoolDate).toBe('2026-11-25');
    // The NGA file has no row for this person: data stays in its school.
    expect(await db.get(`SELECT 1 FROM staff_attendance WHERE staff_id = '201'`)).toBeUndefined();
  });
});
