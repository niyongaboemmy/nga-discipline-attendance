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
import { __setPushSender, dueReminders, type PushPayload } from '../modules/clock/reminders.js';
import { runReminderTick } from '../modules/clock/clock.scheduler.js';
import { haversine, judge, onSchoolNetwork, plausibilityFlags, edgeDistance } from '../modules/clock/geofence.js';
import { clockLive, type ClockLiveEvent } from '../modules/clock/clockLive.js';

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
  // A fixed school list: the MIS-backed registry re-asks the network mid-run and made this suite flaky (random 404s).
  __setTenants([primaryTenantCtx()]);
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

  it('judges an outline by its walls: inside, within the edge tolerance, and outside', () => {
    // A 100 m x 60 m compound around CENTER ([lng, lat] corners).
    const dx = 50 / (111_320 * Math.cos((CENTER.lat * Math.PI) / 180));
    const dy = 30 / 111_195;
    const ring: Array<[number, number]> = [[CENTER.lng - dx, CENTER.lat - dy], [CENTER.lng + dx, CENTER.lat - dy], [CENTER.lng + dx, CENTER.lat + dy], [CENTER.lng - dx, CENTER.lat + dy]];
    const zone = [{ id: 9, name: 'Compound', kind: 'polygon' as const, center_lat: CENTER.lat, center_lng: CENTER.lng, radius_m: null, polygon_geojson: JSON.stringify({ type: 'Polygon', coordinates: [ring] }), active: 1 }];
    const opts = { maxAccuracy: 100, allowance: 15 };
    expect(judge({ ...CENTER, accuracy: 10 }, zone, opts)).toMatchObject({ inside: true, distance: 0, zoneName: 'Compound' });
    // 10 m north of the north wall, 12 m precision: within the 15 m tolerance.
    const near = { lat: CENTER.lat + (30 + 10) / 111_195, lng: CENTER.lng, accuracy: 12 };
    expect(Math.round(edgeDistance(near, ring))).toBe(10);
    expect(judge(near, zone, opts).inside).toBe(true);
    // The street 40 m past the wall: refused, 25 m beyond the tolerance (a circle of the
    // same size would have let it in).
    const street = { lat: CENTER.lat + (30 + 40) / 111_195, lng: CENTER.lng, accuracy: 20 };
    const out = judge(street, zone, opts);
    expect(out).toMatchObject({ inside: false, distance: 40 });
    expect(out.outsideBy).toBeCloseTo(25, 1);
    // The tolerance never exceeds the phone's own error: 10 m out with 4 m precision is out.
    expect(judge({ ...near, accuracy: 4 }, zone, opts).inside).toBe(false);
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
    const vague = await tap('nga', phone, { ...INSIDE, accuracy: 900 });
    expect(vague.status).toBe(422);
    expect(vague.body).toMatchObject({ code: 'LOW_ACCURACY', accuracy: 900 });
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

  it('saves an outline zone (corners, no radius), refuses a giant one, and the public page sends the corners', async () => {
    const far = { lat: -1.9, lng: 30.2 };
    const corners = [[far.lng, far.lat], [far.lng + 0.001, far.lat], [far.lng + 0.001, far.lat + 0.0008], [far.lng, far.lat + 0.0008]];
    const made = await request(app).post('/api/staff/clock/zones').set(authHeader(adminToken)).send({ name: 'Annex', kind: 'polygon', polygon: corners, lat: far.lat + 0.0004, lng: far.lng + 0.0005, radius: 150 });
    expect(made.status).toBe(201);
    expect(made.body.data).toMatchObject({ kind: 'polygon', radius_m: null });
    expect(JSON.parse(made.body.data.polygon_geojson).coordinates[0]).toHaveLength(4);
    expect((await request(app).post('/api/staff/clock/zones').set(authHeader(adminToken)).send({ name: 'Two', kind: 'polygon', polygon: corners.slice(0, 2) })).status).toBe(400);
    expect((await request(app).post('/api/staff/clock/zones').set(authHeader(adminToken)).send({ name: 'Huge', kind: 'polygon', polygon: [[30, -1.9], [30.1, -1.9], [30.1, -1.8]] })).status).toBe(400);
    const boot = await request(app).get('/api/clock/nga/bootstrap');
    const annex = boot.body.data.zones.find((z: any) => z.name === 'Annex');
    expect(annex).toMatchObject({ kind: 'polygon', radius: null });
    expect(annex.polygon).toHaveLength(4);
    expect(boot.body.data.rules.allowance).toBe(50);
    // Back to a circle: corners dropped.
    const back = await request(app).put(`/api/staff/clock/zones/${made.body.data.id}`).set(authHeader(adminToken)).send({ kind: 'circle', radius: 120 });
    expect(back.body.data).toMatchObject({ kind: 'circle', radius_m: 120, polygon_geojson: null });
    expect((await request(app).delete(`/api/staff/clock/zones/${made.body.data.id}`).set(authHeader(adminToken))).status).toBe(200);
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

  it("builds one person's history: on time, late, absent, days off, today, streaks", async () => {
    const add = (date: string, inT: string, status: string, outT?: string, outStatus?: string) =>
      db.run(`INSERT INTO staff_attendance (staff_id, staff_name, date, clock_in, clock_out, status, out_status, source) VALUES ('888', 'Ange Mukamana nul', ?, ?, ?, ?, ?, 'device')`,
        date, `${date}T${inT}:00.000Z`, outT ? `${date}T${outT}:00.000Z` : null, status, outStatus ?? null);
    await add('2026-12-07', '05:40', 'present', '14:30', 'on_time'); // Mon 07:40
    await add('2026-12-08', '07:10', 'late', '14:20', 'on_time'); // Tue 09:10 late
    await add('2026-12-10', '05:30', 'present', '12:00', 'early'); // Thu, left early
    now = kigali('10:00', '2026-12-11'); // Fri, not in yet
    const res = await request(app).get('/api/staff/clock/people/888/history?days=7').set(authHeader(adminToken));
    expect(res.status).toBe(200);
    const h = res.body.data;
    expect(h.person.name).toBe('Ange Mukamana');
    expect(h.days.map((d: any) => [d.date, d.kind])).toEqual([
      ['2026-12-05', 'off'], ['2026-12-06', 'off'], ['2026-12-07', 'on_time'], ['2026-12-08', 'late'],
      ['2026-12-09', 'absent'], ['2026-12-10', 'on_time'], ['2026-12-11', 'today'],
    ]);
    expect(h.days[2]).toMatchObject({ in: '07:40', out: '16:30', minutes: 530 });
    expect(h.days[5]).toMatchObject({ early: true });
    expect(h.summary).toMatchObject({ schoolDays: 4, attended: 3, onTime: 2, late: 1, absent: 1, early: 1, rate: 75, punctuality: 67, streak: 1, bestStreak: 1 });
    // Teachers cannot read it.
    const { token } = await createTestUser(db, { id: '955', name: 'T6', email: 't6@x', roleLevel: 'TEACHER' });
    expect((await request(app).get('/api/staff/clock/people/888/history').set(authHeader(token))).status).toBe(403);
  });

  it('names the school and its documents logo for exported reports', async () => {
    const { brandingOf } = await import('../routes/sso.js');
    expect(brandingOf({ data: { school_name: 'NGA', logoUrl: 'https://x/l/primary', logos: { documents: 'https://x/l/documents' } } }, 1))
      .toMatchObject({ name: 'NGA', logoUrl: 'https://x/l/primary', documentsLogoUrl: 'https://x/l/documents' });
    expect(brandingOf({ data: { school_name: 'NGA', logoUrl: 'https://x/l/primary' } }, 1)).toMatchObject({ documentsLogoUrl: null });
    const res = await request(app).get('/api/staff/clock/document-brand').set(authHeader(adminToken));
    expect(res.status).toBe(200);
    expect(typeof res.body.data.name).toBe('string');
    expect(res.body.data.logo === null || String(res.body.data.logo).startsWith('data:image/')).toBe(true);
    const { token } = await createTestUser(db, { id: '956', name: 'T7', email: 't7@x', roleLevel: 'TEACHER' });
    expect((await request(app).get('/api/staff/clock/document-brand').set(authHeader(token))).status).toBe(403);
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
    const vague = await request(app).post(`/api/clock/nga/tap/${code}`).send({ position: { lat: INSIDE.lat, lng: INSIDE.lng, accuracy: 900 } });
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

describe('on their own network (mobile data): a weak GPS reading', () => {
  it('counts while its circle still reaches the school, flagged for review; a school can refuse it instead', async () => {
    misPerson(130, 'Weak Signal', 'weak@gmail.com');
    misPerson(131, 'Strict School', 'strict@gmail.com');
    const phone = await newDevice();
    const phone2 = await newDevice();
    now = kigali('07:30', '2027-01-05');
    await register('nga', 'weak@gmail.com', phone);
    await register('nga', 'strict@gmail.com', phone2);
    expect((await request(app).get('/api/clock/nga/bootstrap')).body.data.rules.weakMaxAccuracy).toBe(500);

    // ±240 m around a point inside the school: beyond the 100 m rule, still plausible.
    const res = await tap('nga', phone, { ...INSIDE, accuracy: 240 });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ action: 'check_in', status: 'present' });
    expect(res.body.data.flags).toContain('weak_location');
    const ov = (await request(app).get('/api/staff/clock/overview').set(authHeader(adminToken))).body.data;
    expect(ov.review).toEqual(expect.arrayContaining([expect.objectContaining({ userId: '130', flags: expect.arrayContaining(['weak_location']) })]));
    expect(ov.rows.find((r: any) => r.userId === '130').needsReview).toBe(true);

    // A coarse reading whose circle cannot reach the school is still refused.
    expect((await tap('nga', phone2, { ...FAR, accuracy: 240 })).status).toBe(422);
    // The school turns it off: precise readings only.
    const saved = await request(app).put('/api/staff/clock/config').set(authHeader(adminToken)).send({ weakLocation: 'refuse' });
    expect(saved.body.data.rules.weakLocation).toBe('refuse');
    expect((await request(app).get('/api/clock/nga/bootstrap')).body.data.rules.weakMaxAccuracy).toBe(0);
    expect((await tap('nga', phone2, { ...INSIDE, accuracy: 240 })).body.code).toBe('LOW_ACCURACY');
    await request(app).put('/api/staff/clock/config').set(authHeader(adminToken)).send({ weakLocation: 'review' });
  });
});

describe("a person's own working week", () => {
  const week = (over: Record<string, { works: boolean; start?: string; end?: string }>) =>
    Object.fromEntries(['0', '1', '2', '3', '4', '5', '6'].map((d) => [d, { start: '08:00', end: '17:00', ...(over[d] ?? { works: false }) }]));
  const plan = (id: string, body: unknown, token = adminToken) => request(app).put(`/api/staff/clock/people/${id}/plan`).set(authHeader(token)).send(body as any);

  it('judges late, early, days off and absences by the plan, everywhere', async () => {
    misPerson(132, 'Part Timer', 'part@gmail.com');
    misPerson(133, 'Full Timer', 'full@gmail.com');
    const phone = await newDevice();
    const phone2 = await newDevice();
    now = kigali('07:00', '2027-01-05'); // Tuesday
    await register('nga', 'part@gmail.com', phone);
    await register('nga', 'full@gmail.com', phone2);

    // Validation, permissions, and "the same as the school" is not an own plan.
    expect((await plan('132', { days: week({ 2: { works: true, start: '14:00', end: '10:00' } }) })).status).toBe(400);
    const { token: teacher } = await createTestUser(db, { id: '956', name: 'T7', email: 't7@x', roleLevel: 'TEACHER' });
    expect((await plan('132', { days: week({}) }, teacher)).status).toBe(403);
    const school = (await request(app).get('/api/staff/clock/people/132/plan').set(authHeader(adminToken))).body.data;
    expect(school).toMatchObject({ own: false });
    expect(school.days['2']).toEqual({ works: true, start: '08:30', end: '16:00' });
    expect((await plan('132', { days: school.days })).body.data.plan.own).toBe(false);

    // Tuesday 10:00-14:00 and Saturday 09:00-12:00, nothing else.
    const saved = await plan('132', { days: week({ 2: { works: true, start: '10:00', end: '14:00' }, 6: { works: true, start: '09:00', end: '12:00' } }), note: 'Part time' });
    expect(saved.status).toBe(200);
    expect(saved.body.data.plan).toMatchObject({ own: true, effectiveFrom: '2027-01-05', note: 'Part time' });

    // 09:45: late for the school (08:30), on time for them.
    now = kigali('09:45', '2027-01-05');
    const me = (await request(app).get('/api/clock/nga/me').set('X-Clock-Device', phone.token!)).body.data;
    expect(me.rules).toMatchObject({ lateAfter: '10:00', earlyLeaveBefore: '14:00', own: true });
    // Monday was before the plan started (the school's rules); from Tuesday on, their own days.
    expect(me.week.map((d: any) => d.date)).toEqual(['2027-01-04', '2027-01-05', '2027-01-09']);
    expect((await tap('nga', phone, INSIDE)).body.data).toMatchObject({ action: 'check_in', status: 'present' });
    expect((await tap('nga', phone2, INSIDE)).body.data).toMatchObject({ action: 'check_in', status: 'late' });
    // 14:05: early for the school (16:00), on time for them.
    now = kigali('14:05', '2027-01-05');
    expect((await tap('nga', phone, INSIDE)).body.data).toMatchObject({ action: 'check_out', status: 'on_time' });
    expect((await tap('nga', phone2, INSIDE)).body.data).toMatchObject({ action: 'check_out', status: 'early' });

    // Wednesday: their day off. Not "not in", not absent.
    now = kigali('11:00', '2027-01-06');
    const wed = (await request(app).get('/api/staff/clock/overview').set(authHeader(adminToken))).body.data;
    const row = wed.rows.find((r: any) => r.userId === '132');
    expect(row).toMatchObject({ status: 'day_off', expected: false, plan: { own: true, works: false } });
    expect(wed.rows.find((r: any) => r.userId === '133')).toMatchObject({ status: 'not_in', expected: true, plan: { own: false, start: '08:30', end: '16:00' } });
    expect(wed.kpis.staff + wed.kpis.dayOff).toBe(wed.rows.length);
    expect(wed.kpis.notIn).toBe(wed.rows.filter((r: any) => r.status === 'not_in').length);
    expect(wed.ownPlans).toBe(1);
    // Right now (11:00): the full-timer should be here and is not; the part-timer is off.
    expect(row.moment).toBe('day_off');
    expect(wed.rows.find((r: any) => r.userId === '133').moment).toBe('due_now');
    expect(wed.now).toMatchObject({ at: '11:00', notHere: wed.rows.filter((r: any) => r.moment === 'due_now').length, dayOff: wed.kpis.dayOff });
    expect(wed.now.shouldBeHere).toBe(wed.now.here + wed.now.notHere + wed.now.leftEarly);
    // 07:00: nobody is due yet. 17:00: the day is over, the absent are "missed".
    now = kigali('07:00', '2027-01-06');
    expect((await request(app).get('/api/staff/clock/overview').set(authHeader(adminToken))).body.data.rows.find((r: any) => r.userId === '133').moment).toBe('due_later');
    now = kigali('17:00', '2027-01-06');
    const eve = (await request(app).get('/api/staff/clock/overview').set(authHeader(adminToken))).body.data;
    expect(eve.rows.find((r: any) => r.userId === '133').moment).toBe('missed');
    expect(eve.now).toMatchObject({ shouldBeHere: 0, notHere: 0 });
    // A past day has no "now".
    expect((await request(app).get('/api/staff/clock/overview?date=2027-01-05').set(authHeader(adminToken))).body.data.now).toBeNull();

    // Saturday: a working day for them only; late after their 09:00, and no "not a working day" flag.
    now = kigali('09:30', '2027-01-09');
    const sat = await tap('nga', phone, INSIDE);
    expect(sat.body.data).toMatchObject({ action: 'check_in', status: 'late' });
    expect(sat.body.data.flags).not.toContain('non_school_day');
    // The full-timer has a day off: check-in is closed for them (the school's default), with the reason and their next day.
    const closed = await tap('nga', phone2, INSIDE);
    expect(closed.status).toBe(403);
    expect(closed.body).toMatchObject({ code: 'NOT_SCHOOL_DAY', message: expect.stringContaining('day off') });
    const meOff = (await request(app).get('/api/clock/nga/me').set('X-Clock-Device', phone2.token!)).body.data;
    expect(meOff).toMatchObject({ next: 'closed', dayOff: true, dayOffClosed: true, nextDay: { date: '2027-01-11', start: '08:30' } });
    expect((await request(app).get('/api/clock/nga/me').set('X-Clock-Device', phone.token!)).body.data).toMatchObject({ dayOff: false, dayOffClosed: false });
    // A school may allow it instead: the check-in counts and is flagged.
    await request(app).put('/api/staff/clock/config').set(authHeader(adminToken)).send({ nonSchoolDays: 'allow_flag' });
    const satFull = await tap('nga', phone2, INSIDE);
    expect(satFull.body.data.flags).toContain('non_school_day');
    await request(app).put('/api/staff/clock/config').set(authHeader(adminToken)).send({ nonSchoolDays: 'refuse' });

    // History: Tue on time, Wed-Fri off, Sat late; nothing absent.
    const h = (await request(app).get('/api/staff/clock/people/132/history?days=7').set(authHeader(adminToken))).body.data;
    // (Monday the 4th is before the plan started: the school's rules, an absence.)
    expect(h.days.slice(-5).map((d: any) => [d.date, d.kind])).toEqual([
      ['2027-01-05', 'on_time'], ['2027-01-06', 'off'], ['2027-01-07', 'off'], ['2027-01-08', 'off'], ['2027-01-09', 'late'],
    ]);
    expect(h.days[2]).toMatchObject({ start: '10:00', end: '14:00', extra: false });
    expect(h.days[1]).toMatchObject({ date: '2027-01-04', kind: 'absent', start: '08:30' });
    expect(h.summary).toMatchObject({ schoolDays: 3, attended: 2, absent: 1 });
    expect(h.plan).toMatchObject({ own: true });
    // The full-timer came on a Saturday: it counts for them, Wed-Fri are absences.
    const hf = (await request(app).get('/api/staff/clock/people/133/history?days=7').set(authHeader(adminToken))).body.data;
    expect(hf.days[6]).toMatchObject({ kind: 'late', extra: true });
    expect(hf.summary).toMatchObject({ schoolDays: 6, attended: 2, absent: 4 });

    // The period report: Saturday is a day because somebody is expected, and each person has their own days.
    const rep = (await request(app).get('/api/staff/clock/report?from=2027-01-05&to=2027-01-09').set(authHeader(adminToken))).body.data;
    expect(rep.days.find((d: any) => d.date === '2027-01-09')).toMatchObject({ kind: 'school', staff: 2, late: 2, absent: 0 });
    expect(rep.ownPlans).toBe(1);
    const staff = (await request(app).get('/api/staff/clock/report/staff?from=2027-01-05&to=2027-01-08').set(authHeader(adminToken))).body.data.people;
    expect(staff.find((p: any) => p.userId === '132')).toBeUndefined(); // never late or absent on their own days
    expect(staff.find((p: any) => p.userId === '133')).toMatchObject({ schoolDays: 4, attended: 1, absent: 3 });
    // The export says which hours applied.
    const csv = await request(app).get('/api/staff/clock/export?from=2027-01-05&to=2027-01-05').set(authHeader(adminToken));
    expect(csv.text).toContain('10:00-14:00 (own)');

    // Changing the hours from a past day judges the recorded days again.
    const earlier = await plan('132', { effectiveFrom: '2027-01-05', days: week({ 2: { works: true, start: '09:00', end: '15:00' }, 6: { works: true, start: '10:00', end: '12:00' } }) });
    expect(earlier.body.data.rejudged).toBe(2);
    const rows = await db.all(`SELECT date, status, out_status FROM staff_attendance WHERE staff_id = '132' AND date >= '2027-01-05' ORDER BY date`);
    expect(rows).toEqual([{ date: '2027-01-05', status: 'late', out_status: 'early' }, { date: '2027-01-09', status: 'present', out_status: null }]);

    // Back to the school's rules from next Monday: this week keeps the plan.
    const back = await plan('132', { days: null, effectiveFrom: '2027-01-11' });
    expect(back.body.message).toContain("school's hours");
    expect(back.body.data.plan).toMatchObject({ own: true, upcoming: { effectiveFrom: '2027-01-11', days: null } });
    now = kigali('07:00', '2027-01-12');
    expect((await request(app).get('/api/clock/nga/me').set('X-Clock-Device', phone.token!)).body.data.rules).toMatchObject({ lateAfter: '08:30', own: false });
    const audit = await db.get(`SELECT COUNT(*) AS n FROM audit_log WHERE action LIKE 'STAFF_CLOCK_PLAN_%'`).catch(() => null);
    if (audit) expect(audit.n).toBeGreaterThanOrEqual(3);
  });
});

describe('reminders and forgotten check-outs', () => {
  const rule: import('../modules/clock/workPlan.js').DayRule = { works: true, lateAfter: 510, earlyBefore: 960, start: '08:30', end: '16:00', own: false };

  it('knows which reminder is due from the person\'s own day', () => {
    const at = (nowMin: number, checkedIn = false, checkedOut = false, r = rule, lead = 15) => dueReminders({ nowMin, rule: r, lead, checkedIn, checkedOut });
    expect(at(494)).toEqual([]);
    expect(at(495)).toEqual(['in_soon']); // 08:15
    expect(at(510)).toEqual(['in_now']); // 08:30, still not in
    expect(at(556)).toEqual([]); // too late to be useful
    expect(at(500, true)).toEqual([]); // already in
    expect(at(945, true)).toEqual(['out_soon']); // 15:45
    expect(at(990, true)).toEqual(['out_late']); // 16:30, still in
    expect(at(990, true, true)).toEqual([]);
    expect(at(945)).toEqual([]); // never came: no check-out reminder
    expect(at(495, false, false, rule, 0)).toEqual([]); // the school turned reminders off
    expect(at(495, false, false, { ...rule, works: false, lateAfter: null, earlyBefore: null })).toEqual([]); // day off
  });

  it('sends each reminder once, at the times of the person\'s own hours, and stops when the tap is done', async () => {
    const sent: Array<PushPayload & { endpoint: string }> = [];
    __setPushSender(async (sub, payload) => { sent.push({ ...payload, endpoint: sub.endpoint }); return 'ok'; });
    const tick = async (hhmm: string, date: string) => { now = kigali(hhmm, date); sent.length = 0; await runReminderTick({ list: async () => [primaryTenantCtx()] } as any); return sent.map((x) => x.title); };

    misPerson(140, 'Remind Me', 'remind@gmail.com');
    misPerson(141, 'Own Hours', 'ownhours@gmail.com');
    const phone = await newDevice();
    const phone2 = await newDevice();
    now = kigali('06:00', '2027-02-02'); // Tuesday
    await register('nga', 'remind@gmail.com', phone);
    await register('nga', 'ownhours@gmail.com', phone2);
    const boot = (await request(app).get('/api/clock/nga/bootstrap')).body.data;
    expect(boot.pushKey).toEqual(expect.any(String));
    expect(boot.rules.remindMinutes).toBe(15);

    const subscribe = (d: FakeDevice, n: number, extra: Record<string, unknown> = {}) => request(app).post('/api/clock/nga/push').set('X-Clock-Device', d.token!)
      .send({ subscription: { endpoint: `https://fcm.googleapis.com/fcm/send/dev${n}`, keys: { p256dh: 'p'.repeat(87), auth: 'a'.repeat(22) } }, lang: 'en', ...extra });
    // Only real push services, and only a registered device.
    expect((await request(app).post('/api/clock/nga/push').set('X-Clock-Device', phone.token!).send({ subscription: { endpoint: 'https://evil.example/x', keys: { p256dh: 'p'.repeat(87), auth: 'a'.repeat(22) } } })).status).toBe(400);
    expect((await request(app).post('/api/clock/nga/push').send({})).status).toBe(401);
    const on = await subscribe(phone, 1, { test: true });
    expect(on.body.data).toEqual({ on: true, tested: true });
    expect(sent.pop()).toMatchObject({ title: 'Reminders are on', url: '/c/nga' });
    await subscribe(phone2, 2);
    expect((await request(app).get('/api/clock/nga/me').set('X-Clock-Device', phone.token!)).body.data.reminders).toEqual({ on: true });
    // Person 141 works 10:00-14:00 on Tuesdays.
    const week = Object.fromEntries(['0', '1', '2', '3', '4', '5', '6'].map((d) => [d, d === '2' ? { works: true, start: '10:00', end: '14:00' } : { works: false, start: '08:00', end: '17:00' }]));
    expect((await request(app).put('/api/staff/clock/people/141/plan').set(authHeader(adminToken)).send({ days: week })).status).toBe(200);

    expect(await tick('08:10', '2027-02-02')).toEqual([]);
    expect(await tick('08:15', '2027-02-02')).toEqual(['Check in soon']); // school hours: 08:30
    expect(sent[0]).toMatchObject({ endpoint: 'https://fcm.googleapis.com/fcm/send/dev1', body: expect.stringContaining('08:30'), url: '/c/nga', tag: 'clock-in' });
    expect(await tick('08:16', '2027-02-02')).toEqual([]); // once
    expect(await tick('08:30', '2027-02-02')).toEqual(['You have not checked in']);
    expect((await tap('nga', phone, INSIDE)).status).toBe(200);
    expect(await tick('09:45', '2027-02-02')).toEqual(['Check in soon']); // own hours: 10:00
    expect(sent[0]).toMatchObject({ endpoint: 'https://fcm.googleapis.com/fcm/send/dev2', body: expect.stringContaining('10:00') });
    expect((await tap('nga', phone2, INSIDE)).status).toBe(200);
    expect(await tick('10:00', '2027-02-02')).toEqual([]); // checked in: no nudge
    expect(await tick('13:45', '2027-02-02')).toEqual(['Remember to check out']); // own end 14:00
    expect(await tick('14:30', '2027-02-02')).toEqual(['You have not checked out']);
    expect(await tick('15:45', '2027-02-02')).toEqual(['Remember to check out']); // school end 16:00
    now = kigali('16:05', '2027-02-02');
    expect((await tap('nga', phone, INSIDE)).body.data.action).toBe('check_out');
    expect(await tick('16:30', '2027-02-02')).toEqual([]); // 140 is out; 141 was already reminded

    // Wednesday: 141's day off. A dropped subscription is forgotten. A school can turn reminders off.
    __setPushSender(async (sub, payload) => { sent.push({ ...payload, endpoint: sub.endpoint }); return 'gone'; });
    expect(await tick('08:15', '2027-02-03')).toEqual(['Check in soon']);
    expect(await db.get(`SELECT 1 FROM staff_clock_push WHERE endpoint LIKE '%dev1'`)).toBeUndefined();
    expect(await tick('09:45', '2027-02-03')).toEqual([]);
    await request(app).put('/api/staff/clock/config').set(authHeader(adminToken)).send({ remindMinutes: 0 });
    expect((await request(app).get('/api/clock/nga/bootstrap')).body.data.pushKey).toBeNull();
    expect((await subscribe(phone, 1)).body.code).toBe('REMINDERS_OFF');
    await request(app).put('/api/staff/clock/config').set(authHeader(adminToken)).send({ remindMinutes: 15 });
    expect((await request(app).delete('/api/clock/nga/push').set('X-Clock-Device', phone2.token!)).body.data).toEqual({ on: false });
    // A leader nudges people who should be here: only those not in, with reminders on, once a day.
    __setPushSender(async (sub, payload) => { sent.push({ ...payload, endpoint: sub.endpoint }); return 'ok'; });
    now = kigali('09:00', '2027-02-04'); // Thursday: 140 (school hours) is due, has no subscription any more; 141 is off
    await subscribe(phone, 1);
    sent.length = 0;
    const nudge = (body: unknown, token = adminToken) => request(app).post('/api/staff/clock/nudge').set(authHeader(token)).send(body as any);
    const n1 = await nudge({ kind: 'in', userIds: ['140', '141', '999'] });
    expect(n1.body).toMatchObject({ message: 'Reminder sent to 1 person', data: { sent: 1, noReminders: 2, already: 0, notNeeded: 0 } });
    expect(sent[0]).toMatchObject({ title: 'Please check in', endpoint: 'https://fcm.googleapis.com/fcm/send/dev1' });
    expect((await nudge({ kind: 'in', userIds: ['140'] })).body.data).toMatchObject({ sent: 0, already: 1 });
    expect((await nudge({ kind: 'out', userIds: ['140'] })).body.data).toMatchObject({ sent: 0, notNeeded: 1 });
    const ovN = (await request(app).get('/api/staff/clock/overview').set(authHeader(adminToken))).body.data;
    expect(ovN.rows.find((r: any) => r.userId === '140')).toMatchObject({ reminders: true, moment: 'due_now' });
    __setPushSender(null);

    // 141 never checked out on Tuesday. On Wednesday their page asks when they left.
    now = kigali('09:00', '2027-02-03');
    const me = (await request(app).get('/api/clock/nga/me').set('X-Clock-Device', phone2.token!)).body.data;
    expect(me.week.find((d: any) => d.date === '2027-02-02')).toMatchObject({ start: '10:00', end: '14:00' });
    // Their calendar for February: Tuesdays 10:00-14:00, every other day off; the 2nd was worked (no check-out), the rest are still to come.
    const cal = (await request(app).get('/api/clock/nga/calendar?month=2027-02').set('X-Clock-Device', phone2.token!)).body.data;
    expect(cal).toMatchObject({ month: '2027-02', today: '2027-02-03' });
    expect(cal.days).toHaveLength(28);
    expect(cal.days[1]).toMatchObject({ date: '2027-02-02', kind: 'on_time', start: '10:00', end: '14:00', in: '09:45', out: null, noOut: true, own: true });
    expect(cal.days[2]).toMatchObject({ date: '2027-02-03', kind: 'off', start: null });
    expect(cal.days[8]).toMatchObject({ date: '2027-02-09', kind: 'planned', start: '10:00', end: '14:00' });
    // (Monday the 1st was before their own hours started: a school day, absent.)
    expect(cal.summary).toMatchObject({ workDays: 5, worked: 1, late: 0, absent: 1, daysOff: 23, plannedMinutes: 1410, left: 3 });
    // The other person (school hours) was absent on a past weekday of their own month view; far months are clamped.
    const calSchool = (await request(app).get('/api/clock/nga/calendar?month=2027-02').set('X-Clock-Device', phone.token!)).body.data;
    expect(calSchool.days[0]).toMatchObject({ date: '2027-02-01', kind: 'absent', start: '08:30', end: '16:00', own: false });
    expect(calSchool.days[5]).toMatchObject({ date: '2027-02-06', kind: 'off' });
    expect((await request(app).get('/api/clock/nga/calendar?month=2031-01').set('X-Clock-Device', phone.token!)).body.data.month).toBe(cal.max);
    expect((await request(app).get('/api/clock/nga/calendar').send()).status).toBe(401);
    // Signed in to Tendo (not the phone page): their own week for the home card. Admin '900' has no records: Mon-Tue absent, today Wednesday.
    const wk = (await request(app).get('/api/staff/clock/my-week').set(authHeader(adminToken))).body.data;
    expect(wk).toMatchObject({ today: '2027-02-03', nowMinutes: 540, own: false });
    expect(wk.days.map((d: any) => d.kind)).toEqual(['absent', 'absent', 'today', 'planned', 'planned', 'off', 'off']);
    expect(wk.days[2]).toMatchObject({ date: '2027-02-03', start: '08:30', end: '16:00' });
    expect(wk.summary).toMatchObject({ workDays: 5, worked: 0, absent: 2, plannedMinutes: 2250 });
    expect((await request(app).get('/api/staff/clock/my-week')).status).toBe(401);
    expect(me.myWeek).toMatchObject({ own: true, days: { '2': { works: true, start: '10:00', end: '14:00' }, '3': { works: false } } });
    expect(me.missedOut).toEqual({ date: '2027-02-02', checkIn: '09:45' });
    const claim = (body: unknown) => request(app).post('/api/clock/nga/missed-checkout').set('X-Clock-Device', phone2.token!).send(body as any);
    expect((await claim({ date: '2027-02-02', time: '09:00' })).status).toBe(400); // before the check-in
    expect((await claim({ date: '2027-02-03', time: '14:00' })).status).toBe(400); // not today
    const claimed = await claim({ date: '2027-02-02', time: '14:10' });
    expect(claimed.status).toBe(200);
    expect(claimed.body.data.missedOut).toBeNull();
    // The claim alone changes nothing: the office sees it and saves the time.
    const before = await db.get(`SELECT id, clock_out, out_claim FROM staff_attendance WHERE staff_id = '141' AND date = '2027-02-02'`);
    expect(before).toMatchObject({ clock_out: null, out_claim: '14:10' });
    const ov = (await request(app).get('/api/staff/clock/overview').set(authHeader(adminToken))).body.data;
    expect(ov.missing.recentNoCheckout).toEqual(expect.arrayContaining([expect.objectContaining({ userId: '141', recordId: before.id, claim: '14:10' })]));
    const setOut = (id: number, body: unknown, token = adminToken) => request(app).post(`/api/staff/clock/attendance/${id}/checkout`).set(authHeader(token)).send(body as any);
    const { token: teacher } = await createTestUser(db, { id: '957', name: 'T8', email: 't8@x', roleLevel: 'TEACHER' });
    expect((await setOut(before.id, { time: '14:10' }, teacher)).status).toBe(403);
    expect((await setOut(before.id, { time: '09:00' })).status).toBe(400);
    const saved = await setOut(before.id, { time: '14:10', note: 'Confirmed with the gate book' });
    expect(saved.body).toMatchObject({ success: true, message: 'Check-out saved: 14:10', data: { outStatus: 'on_time' } }); // their end is 14:00
    expect((await setOut(before.id, { time: '15:00' })).status).toBe(409);
    // The office signs a person's device out from their window: the phone is refused until they sign in again.
    const who = (await request(app).get('/api/staff/clock/people/140/history?days=7').set(authHeader(adminToken))).body.data;
    expect(who.device).toMatchObject({ label: expect.any(String), status: 'active', google_email: 'remind@gmail.com', reminders: 1 });
    expect((await request(app).post(`/api/staff/clock/devices/${who.device.id}/revoke`).set(authHeader(adminToken)).send({ reason: 'Signed out by the office' })).status).toBe(200);
    expect((await request(app).get('/api/clock/nga/me').set('X-Clock-Device', phone.token!)).body).toMatchObject({ code: 'DEVICE_REVOKED' });
    expect(await db.get(`SELECT 1 FROM staff_clock_push WHERE device_id = ?`, who.device.id)).toBeUndefined();
    expect((await request(app).get('/api/staff/clock/people/140/history?days=7').set(authHeader(adminToken))).body.data.device).toBeNull();
    // They sign in again with Google on the same phone and carry on.
    expect((await register('nga', 'remind@gmail.com', phone)).body.data).toMatchObject({ deviceStatus: 'active' });
    expect((await request(app).get('/api/clock/nga/me').set('X-Clock-Device', phone.token!)).status).toBe(200);

    const h = (await request(app).get('/api/staff/clock/people/141/history?days=7').set(authHeader(adminToken))).body.data;
    expect(h.days.find((d: any) => d.date === '2027-02-02')).toMatchObject({ out: '14:10', noOut: false, manualOut: true, minutes: 265 });
  });
});

describe('the installed app (Add to Home Screen) and signing out', () => {
  it('installs for THIS school, carries the sign-in over on the same phone, and lets a person sign out', async () => {
    misPerson(150, 'Home Screen', 'home@gmail.com');
    const safari = await newDevice();
    now = kigali('07:30', '2027-03-02');
    await register('nga', 'home@gmail.com', safari);

    // The icon starts at this school, never at a bare /c/.
    const man = await request(app).get('/api/clock/nga/manifest');
    // (the old address still answers, for pages opened before this release)
    expect((await request(app).get('/api/clock/nga/manifest.webmanifest')).status).toBe(200);
    expect(man.headers['content-type']).toContain('application/manifest+json');
    expect(JSON.parse(man.text)).toMatchObject({ id: '/c/nga', start_url: '/c/nga', scope: '/c/', display: 'standalone', name: expect.stringContaining('Check-in') });
    expect((await request(app).get('/api/clock/nope-school/manifest')).status).toBe(404);

    // The signed-in page gets a code; it rides in the icon's start address.
    const ho = await request(app).post('/api/clock/nga/handoff').set('X-Clock-Device', safari.token!);
    expect(ho.status).toBe(200);
    const code = ho.body.data.code;
    expect(JSON.parse((await request(app).get(`/api/clock/nga/manifest?h=${code}`)).text).start_url).toBe(`/c/nga?h=${code}`);
    expect(JSON.parse((await request(app).get('/api/clock/nga/manifest?h=<script>')).text).start_url).toBe('/c/nga');
    expect((await request(app).post('/api/clock/nga/handoff').send({})).status).toBe(401);

    // The installed app (empty storage, a new key) trades the code once: same person, no Google, no approval.
    const installed = await newDevice();
    const claim = (c: string, d: FakeDevice) => request(app).post('/api/clock/nga/handoff/claim')
      .set('User-Agent', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148')
      .send({ code: c, publicKeyJwk: d.jwk, installUuid: d.installUuid, device: { browser: 'Safari', os: 'iOS', model: 'iPhone', formFactor: 'phone' } });
    expect((await claim('nope-nope-nope-nope-nope-nope', installed)).status).toBe(410);
    const got = await claim(code, installed);
    expect(got.status).toBe(200);
    expect(got.body.data).toMatchObject({ deviceStatus: 'active', email: 'home@gmail.com', person: { firstName: 'Home' } });
    installed.token = got.body.data.deviceToken;
    expect((await claim(code, await newDevice())).status).toBe(410); // single use
    expect((await tap('nga', installed, INSIDE)).body.data).toMatchObject({ action: 'check_in' });
    // The browser's old registration is replaced, without using the person's "new phone" allowance.
    expect((await request(app).get('/api/clock/nga/me').set('X-Clock-Device', safari.token!)).body.code).toBe('DEVICE_REVOKED');
    expect(await db.get(`SELECT revoke_reason FROM attendance_devices WHERE user_id = '150' AND status = 'replaced'`)).toEqual({ revoke_reason: 'moved_to_installed_app' });
    expect(await db.get(`SELECT 1 FROM attendance_events WHERE user_id = '150' AND kind = 'register' AND reason = 'replace'`)).toBeUndefined();

    // Without a code, Safari and the installed app on one iPhone still count as the same phone.
    const { sameBrowserFamily } = await import('../modules/clock/clock.service.js');
    expect(sameBrowserFamily(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148')).toBe(true);
    expect(sameBrowserFamily('Mozilla/5.0 (Linux; Android 13) Chrome/131', 'Mozilla/5.0 (Linux; Android 14) Chrome/131')).toBe(false);

    // The person signs the device out on the page itself: it is refused until they sign in again.
    expect((await request(app).post('/api/clock/nga/signout').set('X-Clock-Device', installed.token!)).body.data).toEqual({ signedOut: true });
    expect((await request(app).get('/api/clock/nga/me').set('X-Clock-Device', installed.token!)).body.code).toBe('DEVICE_REVOKED');
    expect((await register('nga', 'home@gmail.com', installed)).body.data.deviceStatus).toBe('active');

    // ...or from their Tendo account (a lost phone): their own week shows the device, and they sign it out there.
    const { token: self } = await createTestUser(db, { id: '150', name: 'Home Screen', email: 'home@gmail.com', roleLevel: 'TEACHER' });
    const mine = (await request(app).get('/api/staff/clock/my-week').set(authHeader(self))).body.data;
    expect(mine.device).toMatchObject({ status: 'active', google_email: 'home@gmail.com' });
    expect((await request(app).post('/api/staff/clock/my-device/signout').set(authHeader(self))).body).toMatchObject({ success: true, message: 'Device signed out' });
    expect((await request(app).get('/api/clock/nga/me').set('X-Clock-Device', installed.token!)).body.code).toBe('DEVICE_REVOKED');
    expect((await request(app).get('/api/staff/clock/my-week').set(authHeader(self))).body.data.device).toBeNull();
    expect((await request(app).post('/api/staff/clock/my-device/signout').set(authHeader(self))).status).toBe(404);
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

describe('live changes for the Gate view', () => {
  it('announces a check-in the moment it is saved, stamped with its school, without names', async () => {
    now = kigali('07:20', '2026-12-01'); // a Tuesday no other test uses
    misPerson(310, 'Live Tester', 'live.tester@gmail.com');
    const phone = await newDevice();
    expect((await register('nga', 'live.tester@gmail.com', phone)).status).toBe(200);
    const seen: ClockLiveEvent[] = [];
    const listen = (e: ClockLiveEvent) => seen.push(e);
    clockLive.on('event', listen);
    try {
      const refused = await tap('nga', phone, FAR);
      expect(refused.status).not.toBe(200);
      expect(seen).toEqual([]); // a refused tap changes nothing
      const ok = await tap('nga', phone, INSIDE);
      expect(ok.status).toBe(200);
      expect(seen.map((e) => [e.type, e.userId, e.tid])).toEqual([['check_in', '310', 1]]);
    } finally {
      clockLive.off('event', listen);
    }
  });

  it('the stream needs the right to see all staff attendance', async () => {
    expect((await request(app).get('/api/staff/clock/stream')).status).toBe(401);
    const { token } = await createTestUser(db, { id: '311', name: 'Plain Teacher', email: 'plain@school.rw', roleLevel: 'TEACHER' });
    expect((await request(app).get('/api/staff/clock/stream').set(authHeader(token))).status).toBe(403);
  });
});
