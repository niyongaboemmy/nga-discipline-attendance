import { Router, type Response } from 'express';
import { z } from 'zod';
import { config } from '../../config.js';
import { getDb } from '../../database.js';
import { authMiddleware, type AuthenticatedRequest } from '../../middleware/auth.js';
import { authorizePermission } from '../../middleware/authorize.js';
import { recordAudit } from '../../shared/audit.js';
import { addDays, safeClockLabel, schoolDateString, schoolMinutesOfDay, timeToMinutes } from '../../shared/schoolTime.js';
import { setSchoolSetting, staffLateCutoffMinutes, type SchoolSettingKey } from '../../tenancy/settings.js';
import { currentTenant } from '../../tenancy/index.js';
import { loadStaffRoster } from '../../routes/mis.js';
import { ClockError, clockNow, clockRules, issueCards, loadZones, needsReview, scanCard } from './clock.service.js';
import { validCidrList } from './geofence.js';
import { createPairing, readPairing } from './pairing.js';

/**
 * School admin side of the staff clock (Tendo -> Staff attendance): zone and rules,
 * devices, the day's overview, review of unusual check-ins, export.
 */

const router = Router();
router.use(authMiddleware);

const actorOf = (req: any) => ({ id: (req as AuthenticatedRequest).user!.id, name: (req as AuthenticatedRequest).user!.name });
const fail = (res: Response, err: unknown) => {
  if (err instanceof ClockError) return res.status(err.status).json({ success: false, code: err.code, message: err.message });
  if (err instanceof z.ZodError) return res.status(400).json({ success: false, code: 'INVALID', message: err.issues[0]?.message || 'Check the values and try again.' });
  console.error('[clock admin]', err);
  return res.status(500).json({ success: false, message: 'Something went wrong. Try again.' });
};

const TIME = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a time like 08:30.');

// ---------------------------------------------------------------------------
// Rules + zones
// ---------------------------------------------------------------------------

function linkFor(slug: string) {
  return { slug, url: `${config.appPublicUrl}/c/${slug}`, display: `${config.appPublicUrl.replace(/^https?:\/\//, '')}/c/${slug}` };
}

router.get('/config', authorizePermission('STAFF_ATTENDANCE_ZONES_MANAGE', 'STAFF_ATTENDANCE_VIEW_ALL'), async (_req, res) => {
  try {
    const tenant = currentTenant('clock config');
    return res.json({
      success: true,
      data: {
        rules: clockRules(),
        zones: await loadZones(getDb()),
        link: linkFor(tenant.slug),
        school: { name: tenant.name, slug: tenant.slug, timezone: tenant.timezone },
        googleConfigured: !!config.googleClientId,
      },
    });
  } catch (err) {
    return fail(res, err);
  }
});

const RulesBody = z.object({
  enabled: z.boolean().optional(),
  requireZone: z.boolean().optional(),
  maxAccuracy: z.number().int().min(20, 'Precision must be at least 20 m.').max(500, 'Precision must be 500 m or less.').optional(),
  allowance: z.number().int().min(0).max(200).optional(),
  opens: TIME.optional(),
  lateAfter: TIME.optional(),
  earlyLeaveBefore: TIME.optional(),
  minShiftMinutes: z.number().int().min(0).max(720).optional(),
  autoCloseAt: TIME.optional(),
  selfReplaceDays: z.number().int().min(0).max(365).optional(),
  googleDomains: z.string().max(400).regex(/^[a-z0-9.,\s@-]*$/i, 'List domains like gmail.com, school.rw').optional(),
  schoolNetworks: z.string().max(400).refine((v) => validCidrList(v), 'List IPv4 addresses or ranges like 41.186.10.0/24').optional(),
  nonSchoolDays: z.enum(['allow_flag', 'refuse']).optional(),
  allowUnassignedStaff: z.boolean().optional(),
  /** Mark setup checklist steps done (merged with the ones already done). */
  setupDone: z.array(z.enum(['rules', 'tested', 'shared'])).max(3).optional(),
});

router.put('/config', authorizePermission('STAFF_ATTENDANCE_ZONES_MANAGE'), async (req: any, res) => {
  try {
    const body = RulesBody.parse(req.body ?? {});
    const db = getDb();
    const tid = currentTenant('clock config').tid;
    const before = clockRules();
    if (body.enabled && (before.requireZone || body.requireZone) && body.requireZone !== false && (await loadZones(db, true)).length === 0) {
      throw new ClockError(400, 'NO_ZONE', 'Add a school zone before turning the clock on.');
    }
    const map: Array<[keyof typeof body, SchoolSettingKey, (v: any) => string]> = [
      ['enabled', 'STAFF_CLOCK_ENABLED', (v) => (v ? '1' : '0')],
      ['requireZone', 'STAFF_CLOCK_REQUIRE_ZONE', (v) => (v ? '1' : '0')],
      ['maxAccuracy', 'STAFF_CLOCK_MAX_ACCURACY_M', String],
      ['allowance', 'STAFF_CLOCK_ACCURACY_ALLOWANCE_M', String],
      ['opens', 'STAFF_CLOCK_OPENS', String],
      ['lateAfter', 'STAFF_LATE_CUTOFF_MINUTES', (v) => String(timeToMinutes(v))],
      ['earlyLeaveBefore', 'STAFF_EARLY_LEAVE_BEFORE', String],
      ['minShiftMinutes', 'STAFF_MIN_SHIFT_MINUTES', String],
      ['autoCloseAt', 'STAFF_AUTO_CLOSE_AT', String],
      ['selfReplaceDays', 'STAFF_DEVICE_SELF_REPLACE_DAYS', String],
      ['googleDomains', 'STAFF_CLOCK_GOOGLE_DOMAINS', (v) => String(v).trim()],
      ['schoolNetworks', 'STAFF_CLOCK_SCHOOL_NETWORKS', (v) => String(v).trim()],
      ['nonSchoolDays', 'STAFF_CLOCK_NON_SCHOOL_DAYS', String],
      ['allowUnassignedStaff', 'STAFF_CLOCK_ALLOW_UNASSIGNED_STAFF', (v) => (v ? '1' : '0')],
    ];
    for (const [field, key, toValue] of map) {
      if (body[field] !== undefined) await setSchoolSetting(db, tid, key, toValue(body[field]));
    }
    // Saving any rule counts as reviewing the rules.
    const ruleFields = ['opens', 'lateAfter', 'earlyLeaveBefore', 'minShiftMinutes', 'maxAccuracy', 'selfReplaceDays', 'googleDomains', 'schoolNetworks'] as const;
    const steps = new Set([...before.setupDone, ...(body.setupDone ?? []), ...(ruleFields.some((f) => body[f] !== undefined) ? ['rules'] : [])]);
    if (steps.size !== before.setupDone.length) await setSchoolSetting(db, tid, 'STAFF_CLOCK_SETUP', [...steps].sort().join(','));
    await recordAudit(db, actorOf(req), 'STAFF_CLOCK_RULES_UPDATED', 'school_settings', 'staff_clock', undefined, { previousValue: before, newValue: clockRules() });
    return res.json({ success: true, message: 'Saved', data: { rules: clockRules() } });
  } catch (err) {
    return fail(res, err);
  }
});

const ZoneBody = z
  .object({
    name: z.string().trim().min(1, 'Give the zone a name.').max(60, 'Keep the name under 60 characters.'),
    kind: z.enum(['circle', 'polygon']).default('circle'),
    lat: z.number().min(-90).max(90).optional(),
    lng: z.number().min(-180).max(180).optional(),
    radius: z.number().int().min(50, 'The radius must be at least 50 m.').max(500, 'The radius must be 500 m or less.').optional(),
    polygon: z.array(z.tuple([z.number(), z.number()])).min(3).max(200).optional(),
    active: z.boolean().default(true),
  })
  .refine((z0) => (z0.kind === 'circle' ? z0.lat !== undefined && z0.lng !== undefined && z0.radius !== undefined : !!z0.polygon), 'Place the zone on the map first.');

router.post('/zones', authorizePermission('STAFF_ATTENDANCE_ZONES_MANAGE'), async (req: any, res) => {
  try {
    const b = ZoneBody.parse(req.body ?? {});
    const db = getDb();
    const r = await db.run(
      `INSERT INTO attendance_zones (name, kind, center_lat, center_lng, radius_m, polygon_geojson, active, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      b.name, b.kind, b.lat ?? null, b.lng ?? null, b.radius ?? null, b.polygon ? JSON.stringify({ type: 'Polygon', coordinates: [b.polygon] }) : null,
      b.active ? 1 : 0, actorOf(req).id, new Date(clockNow()).toISOString()
    );
    const zone = await db.get(`SELECT * FROM attendance_zones WHERE id = ?`, r.lastID);
    await recordAudit(db, actorOf(req), 'STAFF_CLOCK_ZONE_CREATED', 'attendance_zone', r.lastID ?? null, zone);
    return res.status(201).json({ success: true, message: 'Zone added', data: zone });
  } catch (err) {
    return fail(res, err);
  }
});

router.put('/zones/:id', authorizePermission('STAFF_ATTENDANCE_ZONES_MANAGE'), async (req: any, res) => {
  try {
    const db = getDb();
    const before = await db.get(`SELECT * FROM attendance_zones WHERE id = ?`, Number(req.params.id));
    if (!before) throw new ClockError(404, 'NOT_FOUND', 'That zone no longer exists.');
    const b = ZoneBody.parse({
      name: before.name, kind: before.kind, lat: before.center_lat ?? undefined, lng: before.center_lng ?? undefined,
      radius: before.radius_m ?? undefined, active: !!before.active, ...(req.body ?? {}),
    });
    await db.run(
      `UPDATE attendance_zones SET name = ?, kind = ?, center_lat = ?, center_lng = ?, radius_m = ?, polygon_geojson = ?, active = ?, updated_by = ?, updated_at = ? WHERE id = ?`,
      b.name, b.kind, b.lat ?? null, b.lng ?? null, b.radius ?? null,
      b.polygon ? JSON.stringify({ type: 'Polygon', coordinates: [b.polygon] }) : b.kind === 'polygon' ? before.polygon_geojson : null,
      b.active ? 1 : 0, actorOf(req).id, new Date(clockNow()).toISOString(), before.id
    );
    // The last active zone switched off while the clock needs one: close the clock too.
    const rules = clockRules();
    if (rules.enabled && rules.requireZone && (await loadZones(db, true)).length === 0) {
      await setSchoolSetting(db, currentTenant('zone').tid, 'STAFF_CLOCK_ENABLED', '0');
    }
    const zone = await db.get(`SELECT * FROM attendance_zones WHERE id = ?`, before.id);
    await recordAudit(db, actorOf(req), 'STAFF_CLOCK_ZONE_UPDATED', 'attendance_zone', before.id, undefined, { previousValue: before, newValue: zone });
    return res.json({ success: true, message: 'Zone saved', data: zone, clockEnabled: clockRules().enabled });
  } catch (err) {
    return fail(res, err);
  }
});

router.delete('/zones/:id', authorizePermission('STAFF_ATTENDANCE_ZONES_MANAGE'), async (req: any, res) => {
  try {
    const db = getDb();
    const before = await db.get(`SELECT * FROM attendance_zones WHERE id = ?`, Number(req.params.id));
    if (!before) throw new ClockError(404, 'NOT_FOUND', 'That zone no longer exists.');
    await db.run(`DELETE FROM attendance_zones WHERE id = ?`, before.id);
    const rules = clockRules();
    if (rules.enabled && rules.requireZone && (await loadZones(db, true)).length === 0) {
      await setSchoolSetting(db, currentTenant('zone').tid, 'STAFF_CLOCK_ENABLED', '0');
    }
    await recordAudit(db, actorOf(req), 'STAFF_CLOCK_ZONE_DELETED', 'attendance_zone', before.id, before);
    return res.json({ success: true, message: 'Zone removed', clockEnabled: clockRules().enabled });
  } catch (err) {
    return fail(res, err);
  }
});

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

const DEVICE_COLS = `id, user_id, user_name, google_email, form_factor, label, browser, os, model, status, registered_at,
  approved_at, approved_by, last_used_at, revoked_at, revoked_by, revoke_reason, ip_last`;

router.get('/devices', authorizePermission('STAFF_DEVICES_MANAGE'), async (req: any, res) => {
  try {
    const status = String(req.query.status || '');
    const db = getDb();
    const rows = ['pending', 'active', 'revoked', 'replaced', 'declined'].includes(status)
      ? await db.all(`SELECT ${DEVICE_COLS} FROM attendance_devices WHERE status = ? ORDER BY registered_at DESC LIMIT 500`, status)
      : await db.all(`SELECT ${DEVICE_COLS} FROM attendance_devices ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'active' THEN 1 ELSE 2 END, registered_at DESC LIMIT 500`);
    // How long ago each person last replaced a device on their own (for the approval card).
    return res.json({ success: true, data: rows });
  } catch (err) {
    return fail(res, err);
  }
});

router.post('/devices/:id/:action(approve|decline|revoke)', authorizePermission('STAFF_DEVICES_MANAGE'), async (req: any, res) => {
  try {
    const db = getDb();
    const device = await db.get(`SELECT * FROM attendance_devices WHERE id = ?`, Number(req.params.id));
    if (!device) throw new ClockError(404, 'NOT_FOUND', 'That device no longer exists.');
    const action = req.params.action as 'approve' | 'decline' | 'revoke';
    const nowIso = new Date(clockNow()).toISOString();
    const actor = actorOf(req);
    const reason = String(req.body?.reason ?? '').trim().slice(0, 300);

    if (action === 'approve') {
      if (device.status !== 'pending') throw new ClockError(409, 'NOT_PENDING', 'This device is not waiting for approval.');
      await db.run(
        `UPDATE attendance_devices SET status = 'replaced', revoked_at = ?, revoked_by = ?, revoke_reason = 'replaced_on_approval' WHERE user_id = ? AND status = 'active'`,
        nowIso, actor.id, device.user_id
      );
      await db.run(`UPDATE attendance_devices SET status = 'active', approved_at = ?, approved_by = ? WHERE id = ?`, nowIso, actor.id, device.id);
    } else if (action === 'decline') {
      if (device.status !== 'pending') throw new ClockError(409, 'NOT_PENDING', 'This device is not waiting for approval.');
      await db.run(`UPDATE attendance_devices SET status = 'declined', revoked_at = ?, revoked_by = ?, revoke_reason = ? WHERE id = ?`, nowIso, actor.id, reason || 'declined', device.id);
    } else {
      if (device.status !== 'active' && device.status !== 'pending') throw new ClockError(409, 'NOT_ACTIVE', 'This device is already removed.');
      if (!reason) throw new ClockError(400, 'REASON_REQUIRED', 'Say why you are removing this device.');
      await db.run(`UPDATE attendance_devices SET status = 'revoked', revoked_at = ?, revoked_by = ?, revoke_reason = ? WHERE id = ?`, nowIso, actor.id, reason, device.id);
    }
    await recordAudit(db, actor, `STAFF_CLOCK_DEVICE_${action.toUpperCase()}`, 'attendance_device', device.id, { user: device.user_name, label: device.label, reason: reason || undefined }, { required: true });
    const updated = await db.get(`SELECT ${DEVICE_COLS} FROM attendance_devices WHERE id = ?`, device.id);
    const verb = action === 'approve' ? 'approved' : action === 'decline' ? 'declined' : 'removed';
    return res.json({ success: true, message: `Device ${verb}`, data: updated });
  } catch (err) {
    return fail(res, err);
  }
});

// ---------------------------------------------------------------------------
// The day
// ---------------------------------------------------------------------------

const FLAG_TEXT: Record<string, string> = {
  suspicious_accuracy: 'Location precision looks made up',
  no_jitter: 'Location did not move between readings',
  stale_fix: 'Location reading was old',
  impossible_travel: 'Moved impossibly fast since the last tap',
  twin_punch: 'Same spot and time as another check-in',
  clock_skew: 'Device clock is wrong',
  non_school_day: 'Not a school day',
  on_school_network: 'On the school network',
};

function bucketsFor(rows: Array<{ clock_in: string | null }>, opens: string, lateAfter: number) {
  const ins = rows.map((r) => timeToMinutesOf(r.clock_in)).filter((m): m is number => m != null);
  const lateEnd = lateAfter + 60;
  let start = Math.max(timeToMinutes(opens), Math.min(lateAfter - 120, ...ins.map((m) => Math.floor(m / 15) * 15)));
  start = Math.floor(start / 15) * 15;
  const end = Math.max(lateEnd, ...ins.map((m) => Math.floor(m / 15) * 15 + 15));
  const out: Array<{ from: string; to: string; onTime: number; late: number }> = [];
  for (let m = start; m < Math.min(end, start + 15 * 24); m += 15) {
    const label = (x: number) => `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`;
    const inBucket = ins.filter((v) => v >= m && v < m + 15);
    out.push({ from: label(m), to: label(m + 15), onTime: inBucket.filter((v) => v <= lateAfter).length, late: inBucket.filter((v) => v > lateAfter).length });
  }
  return out;
}

function timeToMinutesOf(value: unknown): number | null {
  const label = safeClockLabel(value);
  return label ? timeToMinutes(label) : null;
}

/** The MIS staff list, per school, kept 60 s: the dashboard refreshes often and the
 *  MIS call (every active user) is the slow part of the overview. */
const rosterCache = new Map<number, { at: number; roster: Array<{ id: string; name: string; role?: string }> }>();
const ROSTER_TTL_MS = 60_000;

router.get('/overview', authorizePermission('STAFF_ATTENDANCE_VIEW_ALL'), async (req: any, res) => {
  try {
    const db = getDb();
    const today = schoolDateString(new Date(clockNow()));
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || '')) ? String(req.query.date) : today;
    const rules = clockRules();
    const lateAfter = staffLateCutoffMinutes();

    const records = await db.all<any[]>(`SELECT * FROM staff_attendance WHERE date = ? ORDER BY clock_in`, date);
    const devices = await db.all<any[]>(`SELECT ${DEVICE_COLS} FROM attendance_devices WHERE status IN ('active','pending')`);
    const activeByUser = new Map(devices.filter((d) => d.status === 'active').map((d) => [String(d.user_id), d]));

    // Everyone who should be here: the MIS staff list (needs the viewer's MIS token and
    // MANAGE_USERS there), else the people Tendo already knows as staff.
    let roster: Array<{ id: string; name: string; role?: string }> = [];
    let rosterSource: 'mis' | 'local' = 'local';
    const misToken = (req as AuthenticatedRequest).user?.misToken;
    const tid = currentTenant('overview').tid;
    const cached = rosterCache.get(tid);
    if (cached && Date.now() - cached.at < ROSTER_TTL_MS) {
      roster = cached.roster;
      rosterSource = 'mis';
    } else if (misToken) {
      try {
        roster = (await loadStaffRoster(misToken)).map((s: any) => ({ id: String(s.id), name: s.name, role: s.role || s.user_type || undefined }));
        rosterSource = 'mis';
        if (roster.length) rosterCache.set(tid, { at: Date.now(), roster });
      } catch {
        roster = [];
      }
    }
    if (roster.length === 0) {
      roster = (await db.all<any[]>(`SELECT id, name, role FROM users WHERE role IN ('teacher','admin') AND COALESCE(status,'active') <> 'inactive'`)).map((u) => ({ id: String(u.id), name: u.name, role: u.role }));
      rosterSource = 'local';
    }
    const roleOf = new Map((await db.all<any[]>(`SELECT id, role FROM users`)).map((u) => [String(u.id), u.role]));
    const people = new Map<string, { id: string; name: string; role: string | null }>();
    for (const p of roster) people.set(p.id, { id: p.id, name: p.name, role: p.role ?? roleOf.get(p.id) ?? null });
    for (const r of records) if (!people.has(String(r.staff_id))) people.set(String(r.staff_id), { id: String(r.staff_id), name: r.staff_name, role: roleOf.get(String(r.staff_id)) ?? null });

    const recordByUser = new Map(records.map((r) => [String(r.staff_id), r]));
    const rows = [...people.values()].map((p) => {
      const r = recordByUser.get(p.id);
      const d = activeByUser.get(p.id);
      const flags: string[] = r?.flags ? JSON.parse(r.flags) : [];
      return {
        recordId: r?.id ?? null,
        userId: p.id,
        name: p.name,
        role: p.role === 'admin' ? 'Administrator' : p.role === 'teacher' ? 'Teacher' : 'Staff',
        checkIn: safeClockLabel(r?.clock_in),
        checkOut: safeClockLabel(r?.clock_out),
        status: r ? (r.review_state === 'invalid' ? 'invalid' : r.status) : 'not_in',
        outStatus: r?.out_status ?? null,
        distance: r?.in_distance_m ?? null,
        source: r?.source ?? null,
        device: d ? d.label : null,
        flags,
        needsReview: r ? needsReview(r.flags, r.review_state) : false,
        reviewState: r?.review_state ?? null,
      };
    });
    rows.sort((a, b) => (a.checkIn ?? '99') .localeCompare(b.checkIn ?? '99') || a.name.localeCompare(b.name));

    const valid = records.filter((r) => r.review_state !== 'invalid');
    const lateMinutes = valid.filter((r) => r.status === 'late').map((r) => timeToMinutesOf(r.clock_in)).filter((m): m is number => m != null).map((m) => m - lateAfter).sort((a, b) => a - b);
    const review = records
      .filter((r) => needsReview(r.flags, r.review_state))
      .map((r) => {
        const flags: string[] = JSON.parse(r.flags || '[]');
        const main = flags.map((f) => f.replace(/^out:/, '')).filter((f) => FLAG_TEXT[f] && f !== 'on_school_network');
        return {
          recordId: r.id,
          userId: String(r.staff_id),
          name: r.staff_name,
          at: safeClockLabel(r.clock_in),
          flags: main,
          flagText: main.map((f) => FLAG_TEXT[f]),
          distance: r.in_distance_m,
          accuracy: r.in_accuracy_m,
        };
      });
    const pending = devices.filter((d) => d.status === 'pending');
    const unregistered = [...people.values()].filter((p) => !activeByUser.has(p.id)).map((p) => ({ id: p.id, name: p.name }));

    // Missing check-outs: today once the check-out window has opened, and the last 7 days.
    const outOpen = date !== today || schoolMinutesOfDay(new Date(clockNow())) >= timeToMinutes(rules.earlyLeaveBefore);
    const noCheckoutToday = outOpen
      ? valid.filter((r) => r.clock_in && !r.clock_out).map((r) => ({ userId: String(r.staff_id), name: r.staff_name, date: r.date, checkIn: safeClockLabel(r.clock_in), autoClosed: r.out_status === 'auto_closed' }))
      : [];
    const recentNoCheckout = (await db.all<any[]>(
      `SELECT staff_id, staff_name, date, clock_in, out_status FROM staff_attendance
        WHERE date >= ? AND date < ? AND clock_in IS NOT NULL AND clock_out IS NULL AND COALESCE(review_state,'') <> 'invalid'
        ORDER BY date DESC, staff_name`,
      addDays(date, -7), date
    )).map((r) => ({ userId: String(r.staff_id), name: r.staff_name, date: r.date, checkIn: safeClockLabel(r.clock_in), autoClosed: r.out_status === 'auto_closed' }));

    // What still stops staff from checking in, for the setup-health strip.
    const zones = await loadZones(db, true);
    const health = {
      google: !!config.googleClientId,
      zones: zones.filter((z: any) => z.center_lat != null).length,
      enabled: !!rules.enabled,
      tested: (rules.setupDone ?? []).includes('tested'),
      shared: (rules.setupDone ?? []).includes('shared'),
      unregistered: unregistered.length,
      staff: people.size,
    };

    return res.json({
      success: true,
      data: {
        date,
        isToday: date === today,
        serverNow: new Date(clockNow()).toISOString(),
        rosterSource,
        rules: { lateAfter: rules.lateAfter, earlyLeaveBefore: rules.earlyLeaveBefore, opens: rules.opens, enabled: rules.enabled },
        kpis: {
          staff: people.size,
          checkedIn: valid.length,
          onTime: valid.filter((r) => r.status === 'present').length,
          late: valid.filter((r) => r.status === 'late').length,
          notIn: Math.max(0, people.size - valid.length),
          checkedOut: valid.filter((r) => r.clock_out).length,
          earlyLeave: valid.filter((r) => r.out_status === 'early').length,
          needsReview: review.length,
          medianLateMinutes: lateMinutes.length ? lateMinutes[Math.floor(lateMinutes.length / 2)] : null,
        },
        arrivals: bucketsFor(valid, rules.opens, lateAfter),
        rows,
        review,
        phones: { registered: activeByUser.size, staff: people.size, pending, unregistered },
        missing: { checkoutOpen: outOpen, noCheckoutToday, recentNoCheckout },
        health,
      },
    });
  } catch (err) {
    return fail(res, err);
  }
});

const ReviewBody = z.object({ decision: z.enum(['accepted', 'invalid']), note: z.string().max(500).optional() });

router.post('/attendance/:id/review', authorizePermission('STAFF_DEVICES_MANAGE'), async (req: any, res) => {
  try {
    const b = ReviewBody.parse(req.body ?? {});
    if (b.decision === 'invalid' && !b.note?.trim()) throw new ClockError(400, 'REASON_REQUIRED', 'Say why this check-in is invalid.');
    const db = getDb();
    const row = await db.get(`SELECT * FROM staff_attendance WHERE id = ?`, Number(req.params.id));
    if (!row) throw new ClockError(404, 'NOT_FOUND', 'That record no longer exists.');
    const actor = actorOf(req);
    await db.run(
      `UPDATE staff_attendance SET review_state = ?, review_note = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?`,
      b.decision, b.note?.trim() || null, actor.id, new Date(clockNow()).toISOString(), row.id
    );
    await recordAudit(db, actor, 'STAFF_CLOCK_RECORD_REVIEWED', 'staff_attendance', row.id, { staff: row.staff_name, date: row.date, decision: b.decision, note: b.note }, { required: true });
    return res.json({ success: true, message: b.decision === 'accepted' ? 'Check-in accepted' : 'Marked invalid' });
  } catch (err) {
    return fail(res, err);
  }
});

// ---------------------------------------------------------------------------
// Staff QR cards (no smartphone) + scanning them
// ---------------------------------------------------------------------------

const CardsBody = z.object({
  people: z.array(z.object({ id: z.string().min(1).max(40), name: z.string().trim().min(1).max(120) })).min(1, 'Choose at least one person.').max(200),
});

router.get('/cards', authorizePermission('STAFF_DEVICES_MANAGE'), async (_req, res) => {
  try {
    const rows = await getDb().all(
      `SELECT id, user_id, user_name, status, issued_by, issued_at, last_used_at FROM staff_clock_cards WHERE status = 'active' ORDER BY user_name`
    );
    return res.json({ success: true, data: rows });
  } catch (err) {
    return fail(res, err);
  }
});

/** Issue (or replace) cards; the codes are returned once, for printing. */
router.post('/cards', authorizePermission('STAFF_DEVICES_MANAGE'), async (req: any, res) => {
  try {
    const b = CardsBody.parse(req.body ?? {});
    const db = getDb();
    const actor = actorOf(req);
    const cards = await issueCards(db, b.people, actor.id);
    await recordAudit(db, actor, 'STAFF_CLOCK_CARDS_ISSUED', 'staff_clock_card', null, { people: b.people.map((p) => p.name) }, { required: true });
    const tenant = currentTenant('cards');
    return res.status(201).json({ success: true, message: cards.length === 1 ? 'Card ready to print' : `${cards.length} cards ready to print`, data: { school: tenant.name, cards } });
  } catch (err) {
    return fail(res, err);
  }
});

router.post('/cards/:id/revoke', authorizePermission('STAFF_DEVICES_MANAGE'), async (req: any, res) => {
  try {
    const db = getDb();
    const card = await db.get(`SELECT * FROM staff_clock_cards WHERE id = ?`, Number(req.params.id));
    if (!card) throw new ClockError(404, 'NOT_FOUND', 'That card no longer exists.');
    if (card.status !== 'active') throw new ClockError(409, 'NOT_ACTIVE', 'This card is already cancelled.');
    await db.run(`UPDATE staff_clock_cards SET status = 'revoked', revoked_at = ?, revoked_by = ? WHERE id = ?`, new Date(clockNow()).toISOString(), actorOf(req).id, card.id);
    await recordAudit(db, actorOf(req), 'STAFF_CLOCK_CARD_REVOKED', 'staff_clock_card', card.id, { user: card.user_name }, { required: true });
    return res.json({ success: true, message: 'Card cancelled' });
  } catch (err) {
    return fail(res, err);
  }
});

/** A colleague holding STAFF_CLOCK_SCAN scans a card on their own device, at school. */
router.post('/scan', authorizePermission('STAFF_CLOCK_SCAN'), async (req: any, res) => {
  try {
    const actor = actorOf(req);
    const result = await scanCard(
      getDb(),
      { code: req.body?.code, position: req.body?.position, samples: req.body?.samples, scannerId: actor.id, scannerName: actor.name },
      { ip: (req.ip || '').replace(/^::ffff:/, '') || null, userAgent: req.get('User-Agent') || null }
    );
    return res.json({ success: true, message: result.action === 'check_in' ? `${result.person.name} checked in` : `${result.person.name} checked out`, data: result });
  } catch (err) {
    if (err instanceof ClockError) return res.status(err.status).json({ success: false, code: err.code, message: err.message, ...err.extra });
    return fail(res, err);
  }
});

// ---------------------------------------------------------------------------
// "Use my phone's GPS" while setting up on a computer (setup tests only)
// ---------------------------------------------------------------------------

router.post('/pair', authorizePermission('STAFF_ATTENDANCE_ZONES_MANAGE'), (req: any, res) => {
  const tenant = currentTenant('pair');
  const p = createPairing(tenant.tid, actorOf(req).id);
  return res.json({ success: true, data: { ...p, url: `${config.appPublicUrl}/c/${tenant.slug}/pair/${p.code}` } });
});

router.get('/pair/:code', authorizePermission('STAFF_ATTENDANCE_ZONES_MANAGE'), (req: any, res) => {
  const r = readPairing(currentTenant('pair').tid, req.params.code, actorOf(req).id);
  if (!r) return res.status(404).json({ success: false, code: 'PAIR_EXPIRED', message: 'This phone link expired. Make a new one.' });
  return res.json({ success: true, data: r });
});

/** CSV of a date range (Excel opens it). */
router.get('/export', authorizePermission('STAFF_ATTENDANCE_VIEW_ALL'), async (req: any, res) => {
  try {
    const today = schoolDateString(new Date(clockNow()));
    const from = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.from || '')) ? String(req.query.from) : today;
    const to = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.to || '')) ? String(req.query.to) : from;
    const rows = await getDb().all<any[]>(`SELECT * FROM staff_attendance WHERE date BETWEEN ? AND ? ORDER BY date, staff_name`, from, to);
    const esc = (v: unknown) => {
      const s = v == null ? '' : String(v);
      return /[",\n]/.test(s) || /^[=+\-@]/.test(s) ? `"${s.replace(/"/g, '""').replace(/^([=+\-@])/, "'$1")}"` : s;
    };
    const header = ['Date', 'Staff', 'Check-in', 'Status', 'Check-out', 'Check-out status', 'Distance (m)', 'Source', 'Review', 'Flags'];
    const lines = rows.map((r) => [
      r.date, r.staff_name, safeClockLabel(r.clock_in) ?? '', r.status, safeClockLabel(r.clock_out) ?? '',
      r.out_status ?? '', r.in_distance_m != null ? Math.round(r.in_distance_m) : '', r.source ?? '', r.review_state ?? '',
      (r.flags ? JSON.parse(r.flags) : []).join(' '),
    ].map(esc).join(','));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="staff-attendance-${from}${to !== from ? `-to-${to}` : ''}.csv"`);
    return res.send('﻿' + [header.join(','), ...lines].join('\r\n'));
  } catch (err) {
    return fail(res, err);
  }
});

export default router;
