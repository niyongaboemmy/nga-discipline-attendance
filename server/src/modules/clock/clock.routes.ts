import { Router, type Request, type Response, type NextFunction } from 'express';
import { config } from '../../config.js';
import { ensureTenantDb, getDb, tenantDbExists } from '../../database.js';
import { gateTenant, runWithTenant, tenantRegistry, type TenantCtx } from '../../tenancy/index.js';
import { schoolDateString } from '../../shared/schoolTime.js';
import { resolveAndPersistUser, resolveMisRole, schoolBranding } from '../../routes/sso.js';
import { resolvePermissions } from '../../middleware/auth.js';
import { domainAllowed, GoogleTokenError, verifyGoogleCredential } from './google.js';
import { IdentityUnavailable, resolveStaffIdentity } from './identity.js';
import { addPairReading, pairingExists } from './pairing.js';
import { polygonFromZone } from './geofence.js';
import { createPhoneTap, previewPhoneTap, readPhoneTap, submitPhoneTap } from './phoneTap.js';
import { createHandoff, HANDOFF_RE, takeHandoff } from './handoff.js';
import { hasSubscription, parseSubscription, removeSubscription, saveSubscription, sendTest, vapidKeys } from './reminders.js';
import {
  challengeFor,
  claimCheckout,
  ClockError,
  clockNow,
  clockReady,
  clockRules,
  loadZones,
  logEvent,
  personCalendar,
  personState,
  personView,
  punch,
  registerDevice,
  requireDevice,
  roleLabelOf,
  signOutDevice,
} from './clock.service.js';

/**
 * The public staff clock (/c/<school-slug> page): no session, the school comes
 * from the slug, a device proves itself with its token + key signature.
 * STAFF_ATTENDANCE_CLOCK_PLAN.md §6.5.
 */

const router = Router({ mergeParams: true });

// ---------------------------------------------------------------------------
// Tiny per-key rate limiter (one Tendo process).
// ---------------------------------------------------------------------------

const hits = new Map<string, number[]>();
function limited(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
  recent.push(now);
  hits.set(key, recent);
  if (hits.size > 20_000) {
    for (const [k, v] of hits) if (v.every((t) => now - t >= windowMs)) hits.delete(k);
  }
  return recent.length > max;
}
export function __resetClockRateLimits(): void {
  hits.clear();
}

const ipOf = (req: Request) => (req.ip || req.socket?.remoteAddress || '').replace(/^::ffff:/, '') || null;
const deviceTokenOf = (req: Request) => (req.get('X-Clock-Device') || '').trim();

function send(res: Response, err: unknown) {
  if (err instanceof ClockError) {
    return res.status(err.status).json({ success: false, code: err.code, message: err.message, ...err.extra });
  }
  console.error('[clock]', err);
  return res.status(500).json({ success: false, code: 'SERVER_ERROR', message: 'Something went wrong. Try again.' });
}

/** Find the school from :slug, apply the tenant gates, open its file, run the rest inside it. */
async function tenantFromSlug(req: Request, res: Response, next: NextFunction) {
  const slug = String(req.params.slug || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(slug)) {
    return res.status(404).json({ success: false, code: 'SCHOOL_UNKNOWN', message: 'This link does not belong to a school.' });
  }
  let tenant: TenantCtx | undefined = (await tenantRegistry().list()).find((t) => t.slug.toLowerCase() === slug);
  if (!tenant) {
    tenantRegistry().invalidate();
    tenant = (await tenantRegistry().list()).find((t) => t.slug.toLowerCase() === slug);
  }
  if (!tenant) return res.status(404).json({ success: false, code: 'SCHOOL_UNKNOWN', message: 'This link does not belong to a school.' });
  const gate = await gateTenant(tenant.tid);
  if (!gate.ok) return res.status(403).json({ success: false, code: gate.code, message: 'This school is not open on Amashuri right now.' });
  // A school that never used Tendo has no file: the clock is simply not set up there.
  if (!tenantDbExists(gate.tenant.tid)) {
    return res.status(403).json({ success: false, code: 'CLOCK_OFF', message: 'Staff attendance is not open for this school yet.' });
  }
  try {
    await ensureTenantDb(gate.tenant.tid);
  } catch (err) {
    return next(err);
  }
  (req as any).clockTenant = gate.tenant;
  return runWithTenant(gate.tenant, () => next());
}

router.use(tenantFromSlug);

/** School, rules, zones and the server clock: everything the page needs before anyone signs in. */
router.get('/bootstrap', async (req: Request, res: Response) => {
  const tenant: TenantCtx = (req as any).clockTenant;
  try {
    const db = getDb();
    const rules = clockRules();
    const zones = (await loadZones(db, true)).map((z) => ({
      id: z.id, name: z.name, kind: z.kind, lat: z.center_lat, lng: z.center_lng, radius: z.kind === 'polygon' ? null : z.radius_m,
      polygon: z.kind === 'polygon' ? polygonFromZone(z) : null,
    }));
    const now = new Date(clockNow());
    // The school's logo from Amashuri (cached); never hold the page up for it.
    const brand = await Promise.race([schoolBranding(tenant.tid).catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), 1500))]);
    return res.json({
      success: true,
      data: {
        school: { name: tenant.name, slug: tenant.slug, logoUrl: brand?.logoUrl ?? null },
        open: await clockReady(db, rules),
        googleClientId: config.googleClientId || null,
        // Staff whose Gmail is not their Amashuri e-mail link it on their Amashuri profile.
        profileUrl: `${config.ngaMisFrontendUrl}/profile#staff-attendance`,
        serverNow: now.toISOString(),
        schoolDate: schoolDateString(now),
        timezone: tenant.timezone,
        rules: {
          allowance: rules.allowance,
          opens: rules.opens,
          lateAfter: rules.lateAfter,
          earlyLeaveBefore: rules.earlyLeaveBefore,
          minShiftMinutes: rules.minShiftMinutes,
          maxAccuracy: rules.maxAccuracy,
          requireZone: rules.requireZone,
          // A weaker reading still counts (flagged for review) up to this many metres; 0 = never.
          weakMaxAccuracy: rules.weakLocation === 'review' ? rules.weakMaxAccuracy : 0,
          /** minutes before a person's start / end that their phone reminds them; 0 = off */
          remindMinutes: rules.remindMinutes,
        },
        zones,
        /** Web Push key for check-in / check-out reminders (null: reminders are off) */
        pushKey: rules.remindMinutes > 0 ? vapidKeys()?.publicKey ?? null : null,
      },
    });
  } catch (err) {
    return send(res, err);
  }
});

/**
 * The install manifest of one school's check-in page: the Home Screen icon opens
 * THIS school (a shared static manifest started at /c/ with no school, so the
 * installed app could not check in). An optional handoff code rides in the start
 * address so the installed app on an iPhone can take over the sign-in (handoff.ts).
 */
router.get('/manifest.webmanifest', (req: Request, res: Response) => {
  const tenant: TenantCtx = (req as any).clockTenant;
  const h = HANDOFF_RE.test(String(req.query.h || '')) ? String(req.query.h) : null;
  const start = `/c/${tenant.slug}`;
  res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  return res.send(JSON.stringify({
    id: start,
    name: `${tenant.name} · Check-in`,
    short_name: 'Check-in',
    description: 'Check in and out at school with one tap.',
    start_url: h ? `${start}?h=${h}` : start,
    scope: '/c/',
    display: 'standalone',
    orientation: 'any',
    background_color: '#ffffff',
    theme_color: '#2563eb',
    icons: [
      { src: '/pwa-192x192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/pwa-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/pwa-maskable-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  }));
});

/** The signed-in page asks for a code its installed app can trade for its own registration. */
router.post('/handoff', async (req: Request, res: Response) => {
  const tenant: TenantCtx = (req as any).clockTenant;
  const db = getDb();
  try {
    const device = await requireDevice(db, deviceTokenOf(req));
    if (limited(`ho:${tenant.tid}:${device.id}`, 30, 3600_000)) throw new ClockError(429, 'RATE_LIMITED', 'Too many tries. Wait a little.');
    return res.json({ success: true, data: createHandoff(tenant.tid, device, clockNow()) });
  } catch (err) {
    return send(res, err);
  }
});

/** The installed app (empty storage, new key) takes over the sign-in of the page it was installed from. */
router.post('/handoff/claim', async (req: Request, res: Response) => {
  const tenant: TenantCtx = (req as any).clockTenant;
  const ip = ipOf(req);
  const userAgent = req.get('User-Agent') || null;
  if (limited(`hoc:${tenant.tid}:${ip}`, 20, 3600_000)) return res.status(429).json({ success: false, code: 'RATE_LIMITED', message: 'Too many tries. Wait a little.' });
  const db = getDb();
  try {
    if (!(await clockReady(db))) throw new ClockError(403, 'CLOCK_OFF', 'Staff attendance is not open for this school yet.');
    const h = takeHandoff(tenant.tid, req.body?.code, clockNow());
    if (!h) throw new ClockError(410, 'HANDOFF_EXPIRED', 'This sign-in link expired. Sign in with Google.');
    // The page it came from must still be this person's device.
    const from = await db.get<{ status: string; user_id: string }>(`SELECT status, user_id FROM attendance_devices WHERE id = ?`, h.deviceId);
    const user = await db.get<{ status: string | null; role: string | null }>(`SELECT status, role FROM users WHERE id = ?`, h.userId);
    if (!from || from.status !== 'active' || from.user_id !== h.userId || user?.status === 'inactive') {
      throw new ClockError(410, 'HANDOFF_EXPIRED', 'This sign-in link expired. Sign in with Google.');
    }
    const result = await registerDevice(db, {
      userId: h.userId, userName: h.userName, google: { sub: h.googleSub, email: h.googleEmail },
      jwk: req.body?.publicKeyJwk, installUuid: req.body?.installUuid, ngaDid: req.body?.ngaDid,
      device: req.body?.device ?? {}, userAgent, ip, sameDeviceHandoff: true,
    });
    return res.json({
      success: true,
      data: {
        deviceToken: result.deviceToken, deviceStatus: result.status, replaced: false,
        person: personView(h.userName, user?.role === 'admin' ? 'Administrator' : user?.role === 'teacher' ? 'Teacher' : 'Staff'),
        email: h.googleEmail,
      },
    });
  } catch (err) {
    return send(res, err);
  }
});

/** The person signs this device out themselves (the page then asks for Google sign-in again). */
router.post('/signout', async (req: Request, res: Response) => {
  const db = getDb();
  try {
    const device = await requireDevice(db, deviceTokenOf(req), { allowPending: true });
    await signOutDevice(db, device, 'signed_out_by_owner');
    return res.json({ success: true, data: { signedOut: true } });
  } catch (err) {
    return send(res, err);
  }
});

/** Register this device: Google proves the person, MIS says who they are here. */
router.post('/register', async (req: Request, res: Response) => {
  const tenant: TenantCtx = (req as any).clockTenant;
  const ip = ipOf(req);
  const userAgent = req.get('User-Agent') || null;
  if (limited(`reg:${tenant.tid}:${ip}`, 8, 3600_000)) {
    return res.status(429).json({ success: false, code: 'RATE_LIMITED', message: 'Too many tries from this network. Wait a while and try again.' });
  }
  const db = getDb();
  try {
    const rules = clockRules();
    if (!(await clockReady(db, rules))) throw new ClockError(403, 'CLOCK_OFF', 'Staff attendance is not open for this school yet.');

    let google;
    try {
      google = await verifyGoogleCredential(String(req.body?.credential || ''));
    } catch (err) {
      if (err instanceof GoogleTokenError) throw new ClockError(err.code === 'GOOGLE_NOT_CONFIGURED' ? 503 : 401, err.code, err.message);
      throw err;
    }
    if (!domainAllowed(google.email, rules.googleDomains)) {
      await logEvent(db, { kind: 'refused', reason: 'domain', ip, userAgent });
      throw new ClockError(403, 'DOMAIN_NOT_ALLOWED', 'Use the Google account your school gave you.');
    }

    let identity;
    try {
      identity = await resolveStaffIdentity(google);
    } catch (err) {
      if (err instanceof IdentityUnavailable) throw new ClockError(503, 'MIS_UNAVAILABLE', err.message);
      throw err;
    }
    if (identity.kind === 'no_match') {
      await logEvent(db, { kind: 'refused', reason: 'no_account', ip, userAgent });
      throw new ClockError(404, 'NO_ACCOUNT', 'No staff account at this school uses this Google account. Ask your school admin to add it to your Amashuri profile.', { email: google.email });
    }
    const person = identity.person;
    if (person.status && person.status.toUpperCase() !== 'ACTIVE') {
      throw new ClockError(403, 'INACTIVE', 'This account is not active. Talk to your school admin.');
    }
    if (person.is_student) {
      await logEvent(db, { kind: 'refused', reason: 'student', userId: String(person.user_id), ip, userAgent });
      throw new ClockError(403, 'STUDENT', 'This page is for teachers and staff only.');
    }

    // Keep the local account in step, exactly like an SSO sign-in does.
    const id = String(person.user_id);
    const role = await resolveAndPersistUser(id, person.name, person.email || google.email, resolveMisRole({ role: person.user_type }, person.permissions));
    await db.run(`UPDATE users SET status = 'active' WHERE id = ?`, id).catch(() => undefined);
    const perms = await resolvePermissions(id);
    const canClock = perms?.permissions.has('STAFF_ATTENDANCE_CLOCK') || (role === 'unassigned' && rules.allowUnassignedStaff);
    if (!canClock) {
      await logEvent(db, { kind: 'refused', reason: 'no_permission', userId: id, ip, userAgent });
      throw new ClockError(403, 'NOT_ALLOWED', 'Your role at this school does not use the staff clock. Talk to your school admin.');
    }

    const result = await registerDevice(db, {
      userId: id,
      userName: person.name,
      google,
      jwk: req.body?.publicKeyJwk,
      installUuid: req.body?.installUuid,
      ngaDid: req.body?.ngaDid,
      device: req.body?.device ?? {},
      userAgent,
      ip,
      dryRun: req.body?.confirm !== true,
    });
    if (req.body?.confirm !== true) {
      // The confirm screen: who this is and what will happen, nothing saved yet.
      return res.json({
        success: true,
        data: {
          preview: true,
          deviceStatus: result.status,
          replaces: result.replaced,
          person: personView(person.name, roleLabelOf(person.user_type, person.roles)),
          email: google.email,
        },
      });
    }
    return res.json({
      success: true,
      data: {
        deviceToken: result.deviceToken,
        deviceStatus: result.status,
        replaced: result.replaced,
        person: personView(person.name, roleLabelOf(person.user_type, person.roles)),
        email: google.email,
      },
    });
  } catch (err) {
    return send(res, err);
  }
});

/** A phone lending its GPS to an admin's setup test on a computer (no sign-in; the code is the key). */
router.get('/pair/:code', (req: Request, res: Response) => {
  const tenant: TenantCtx = (req as any).clockTenant;
  if (!pairingExists(tenant.tid, String(req.params.code))) return res.status(404).json({ success: false, code: 'PAIR_EXPIRED', message: 'This link expired. Make a new one on the computer.' });
  return res.json({ success: true, data: { school: { name: tenant.name, slug: tenant.slug } } });
});

router.post('/pair/:code', (req: Request, res: Response) => {
  const tenant: TenantCtx = (req as any).clockTenant;
  if (limited(`pair:${tenant.tid}:${ipOf(req)}`, 30, 600_000)) return res.status(429).json({ success: false, code: 'RATE_LIMITED', message: 'Too many tries. Wait a little.' });
  const r = addPairReading(tenant.tid, String(req.params.code), req.body?.position);
  if (r === 'unknown') return res.status(404).json({ success: false, code: 'PAIR_EXPIRED', message: 'This link expired. Make a new one on the computer.' });
  if (r === 'bad') return res.status(400).json({ success: false, code: 'NO_LOCATION', message: 'No location was sent.' });
  if (r === 'full') return res.status(409).json({ success: false, code: 'PAIR_FULL', message: 'Enough readings were sent. Look at the computer.' });
  return res.json({ success: true, data: { received: true } });
});

// ---------------------------------------------------------------------------
// Check in from a computer with a phone's location (QR code on the computer).
// ---------------------------------------------------------------------------

/** The computer (the person's own, signed) asks for a 2-minute code to show as a QR. */
router.post('/phone-tap', async (req: Request, res: Response) => {
  const tenant: TenantCtx = (req as any).clockTenant;
  const db = getDb();
  try {
    const device = await requireDevice(db, deviceTokenOf(req));
    if (limited(`pt:${tenant.tid}:${device.id}`, 20, 600_000)) throw new ClockError(429, 'RATE_LIMITED', 'Too many codes. Wait a little.');
    if (!(await clockReady(db))) throw new ClockError(403, 'CLOCK_OFF', 'Staff attendance is not open for this school yet.');
    const p = createPhoneTap(tenant.tid, device, req.body ?? {});
    return res.json({ success: true, data: { ...p, url: `${config.appPublicUrl}/c/${tenant.slug}/tap/${p.code}` } });
  } catch (err) {
    return send(res, err);
  }
});

/** The computer polls: waiting, the phone is locating, done (with the result) or refused. */
router.get('/phone-tap/:code', async (req: Request, res: Response) => {
  const tenant: TenantCtx = (req as any).clockTenant;
  const db = getDb();
  try {
    const device = await requireDevice(db, deviceTokenOf(req));
    const r = readPhoneTap(tenant.tid, device.id, String(req.params.code));
    if (!r) return res.status(404).json({ success: false, code: 'TAP_EXPIRED', message: 'This code expired.' });
    const state = r.state === 'done' ? await personState(db, device) : null;
    return res.json({ success: true, data: { ...r, dayState: state } });
  } catch (err) {
    return send(res, err);
  }
});

/** The phone (no sign-in, the code is the key): whose tap and what it will be. */
router.get('/tap/:code', async (req: Request, res: Response) => {
  const tenant: TenantCtx = (req as any).clockTenant;
  try {
    const p = await previewPhoneTap(getDb(), tenant.tid, String(req.params.code));
    return res.json({ success: true, data: { school: { name: tenant.name, slug: tenant.slug }, ...p } });
  } catch (err) {
    return send(res, err);
  }
});

/** The phone sends its location: the tap is recorded for the computer's owner. */
router.post('/tap/:code', async (req: Request, res: Response) => {
  const tenant: TenantCtx = (req as any).clockTenant;
  if (limited(`tap:${tenant.tid}:${ipOf(req)}`, 30, 600_000)) return res.status(429).json({ success: false, code: 'RATE_LIMITED', message: 'Too many tries. Wait a little.' });
  try {
    const r = await submitPhoneTap(getDb(), tenant.tid, String(req.params.code), req.body ?? {}, { ip: ipOf(req), userAgent: req.get('User-Agent') || null });
    return res.json({ success: true, data: r });
  } catch (err) {
    return send(res, err);
  }
});

/** The person's state: drives the single button. Pending devices get an answer too. */
router.get('/me', async (req: Request, res: Response) => {
  const tenant: TenantCtx = (req as any).clockTenant;
  const db = getDb();
  try {
    const device = await requireDevice(db, deviceTokenOf(req), { allowPending: true });
    const user = await db.get<{ role: string }>(`SELECT role FROM users WHERE id = ?`, device.user_id);
    const rules = clockRules();
    return res.json({
      success: true,
      data: {
        school: { name: tenant.name, slug: tenant.slug },
        open: await clockReady(db, rules),
        person: personView(device.user_name, user?.role === 'admin' ? 'Administrator' : user?.role === 'teacher' ? 'Teacher' : 'Staff'),
        email: device.google_email,
        device: { status: device.status, label: device.label, formFactor: device.form_factor, registeredAt: device.registered_at },
        reminders: { on: await hasSubscription(db, device.id) },
        // `rules` (today's times for this person) comes with the state.
        ...(await personState(db, device)),
      },
    });
  } catch (err) {
    return send(res, err);
  }
});

/** The person's own calendar: a month of expected hours, days off and what was recorded. */
router.get('/calendar', async (req: Request, res: Response) => {
  const db = getDb();
  try {
    const device = await requireDevice(db, deviceTokenOf(req));
    return res.json({ success: true, data: await personCalendar(db, device, req.query.month) });
  } catch (err) {
    return send(res, err);
  }
});

/** This phone asks for check-in / check-out reminders (its Web Push subscription). */
router.post('/push', async (req: Request, res: Response) => {
  const tenant: TenantCtx = (req as any).clockTenant;
  const db = getDb();
  try {
    const device = await requireDevice(db, deviceTokenOf(req));
    if (limited(`push:${tenant.tid}:${device.id}`, 10, 600_000)) throw new ClockError(429, 'RATE_LIMITED', 'Too many tries. Wait a little.');
    if (clockRules().remindMinutes <= 0 || !vapidKeys()) throw new ClockError(403, 'REMINDERS_OFF', 'Your school has not turned reminders on.');
    const sub = parseSubscription(req.body?.subscription);
    if (!sub) throw new ClockError(400, 'INVALID', 'This browser could not set up notifications.');
    await saveSubscription(db, device, sub, String(req.body?.lang || 'en'));
    let tested = false;
    if (req.body?.test) tested = await sendTest(db, device, tenant.slug).catch(() => false);
    return res.json({ success: true, data: { on: true, tested } });
  } catch (err) {
    return send(res, err);
  }
});

router.delete('/push', async (req: Request, res: Response) => {
  const db = getDb();
  try {
    const device = await requireDevice(db, deviceTokenOf(req), { allowPending: true });
    await removeSubscription(db, device.id);
    return res.json({ success: true, data: { on: false } });
  } catch (err) {
    return send(res, err);
  }
});

/** A day left without a check-out: the person says when they left; the office confirms. */
router.post('/missed-checkout', async (req: Request, res: Response) => {
  const tenant: TenantCtx = (req as any).clockTenant;
  const db = getDb();
  try {
    const device = await requireDevice(db, deviceTokenOf(req));
    if (limited(`mc:${tenant.tid}:${device.id}`, 10, 600_000)) throw new ClockError(429, 'RATE_LIMITED', 'Too many tries. Wait a little.');
    await claimCheckout(db, device, req.body ?? {}, { ip: ipOf(req), userAgent: req.get('User-Agent') || null });
    return res.json({ success: true, data: { ...(await personState(db, device)) } });
  } catch (err) {
    return send(res, err);
  }
});

/** A single-use nonce for the next tap (60 s). */
router.post('/challenge', async (req: Request, res: Response) => {
  const tenant: TenantCtx = (req as any).clockTenant;
  const db = getDb();
  try {
    const device = await requireDevice(db, deviceTokenOf(req));
    if (limited(`ch:${tenant.tid}:${device.id}`, 20, 60_000)) throw new ClockError(429, 'RATE_LIMITED', 'Slow down a little and tap again.');
    return res.json({ success: true, data: { ...challengeFor(tenant.tid, device), serverNow: new Date(clockNow()).toISOString() } });
  } catch (err) {
    return send(res, err);
  }
});

/** The tap: the server decides check-in or check-out. */
router.post('/punch', async (req: Request, res: Response) => {
  const tenant: TenantCtx = (req as any).clockTenant;
  const db = getDb();
  try {
    const device = await requireDevice(db, deviceTokenOf(req));
    if (limited(`p:${tenant.tid}:${device.id}`, 10, 60_000)) throw new ClockError(429, 'RATE_LIMITED', 'Slow down a little and tap again.');
    const result = await punch(db, tenant.tid, device, req.body ?? {}, { ip: ipOf(req), userAgent: req.get('User-Agent') || null });
    return res.json({ success: true, data: { ...result, state: await personState(db, device) } });
  } catch (err) {
    return send(res, err);
  }
});

export default router;
