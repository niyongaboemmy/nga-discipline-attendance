import { Router, type Request, type Response, type NextFunction } from 'express';
import { config } from '../../config.js';
import { ensureTenantDb, getDb, tenantDbExists } from '../../database.js';
import { gateTenant, runWithTenant, tenantRegistry, type TenantCtx } from '../../tenancy/index.js';
import { schoolDateString } from '../../shared/schoolTime.js';
import { resolveAndPersistUser, resolveMisRole } from '../../routes/sso.js';
import { resolvePermissions } from '../../middleware/auth.js';
import { domainAllowed, GoogleTokenError, verifyGoogleCredential } from './google.js';
import { IdentityUnavailable, resolveStaffIdentity } from './identity.js';
import {
  challengeFor,
  ClockError,
  clockNow,
  clockReady,
  clockRules,
  loadZones,
  logEvent,
  personState,
  personView,
  punch,
  registerDevice,
  requireDevice,
  roleLabelOf,
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
      id: z.id, name: z.name, kind: z.kind, lat: z.center_lat, lng: z.center_lng, radius: z.radius_m,
    }));
    const now = new Date(clockNow());
    return res.json({
      success: true,
      data: {
        school: { name: tenant.name, slug: tenant.slug },
        open: await clockReady(db, rules),
        googleClientId: config.googleClientId || null,
        serverNow: now.toISOString(),
        schoolDate: schoolDateString(now),
        timezone: tenant.timezone,
        rules: {
          opens: rules.opens,
          lateAfter: rules.lateAfter,
          earlyLeaveBefore: rules.earlyLeaveBefore,
          minShiftMinutes: rules.minShiftMinutes,
          maxAccuracy: rules.maxAccuracy,
          requireZone: rules.requireZone,
        },
        zones,
      },
    });
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
        rules: { lateAfter: rules.lateAfter, earlyLeaveBefore: rules.earlyLeaveBefore, minShiftMinutes: rules.minShiftMinutes },
        ...(await personState(db, device)),
      },
    });
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
