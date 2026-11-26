import { Router, type Response } from 'express';
import { z } from 'zod';
import { config } from '../../config.js';
import { getDb } from '../../database.js';
import { authMiddleware, type AuthenticatedRequest } from '../../middleware/auth.js';
import { authorizePermission } from '../../middleware/authorize.js';
import { recordAudit } from '../../shared/audit.js';
import { addDays, dayOfWeekFor, safeClockLabel, schoolDateString, schoolMinutesOfDay, timeToMinutes } from '../../shared/schoolTime.js';
import { schoolDays, setSchoolSetting, staffLateCutoffMinutes, type SchoolSettingKey } from '../../tenancy/settings.js';
import { currentTenant } from '../../tenancy/index.js';
import { fullName, loadStaffRoster } from '../../routes/mis.js';
import { ClockError, clockNow, clockRules, isHoliday, issueCards, loadZones, needsReview, scanCard } from './clock.service.js';
import { haversine, validCidrList } from './geofence.js';
import { createPairing, readPairing } from './pairing.js';
import { buildReport, reportStaff } from './clockReport.js';
import { loadPlanBook, parseWeekPlan, sameWeek, savePlan, schoolWeek, type DayRule, type PlanBook } from './workPlan.js';

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
  weakLocation: z.enum(['review', 'refuse']).optional(),
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
      ['weakLocation', 'STAFF_CLOCK_WEAK_LOCATION', String],
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
    /** [lng, lat] corners (GeoJSON order), 3 to 200, the outline of the school's walls */
    polygon: z.array(z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)])).min(3, 'An outline needs at least 3 corners.').max(200).optional(),
    active: z.boolean().default(true),
  })
  .refine((z0) => (z0.kind === 'circle' ? z0.lat !== undefined && z0.lng !== undefined && z0.radius !== undefined : !!z0.polygon), 'Place the zone on the map first.')
  // An outline is a school, not a district: every corner within 3 km of its first one.
  .refine((z0) => !z0.polygon || z0.polygon.every(([lng, lat]) => haversine({ lat, lng }, { lat: z0.polygon![0][1], lng: z0.polygon![0][0] }) <= 3000), 'The outline is too big. Trace the school grounds only.');

router.post('/zones', authorizePermission('STAFF_ATTENDANCE_ZONES_MANAGE'), async (req: any, res) => {
  try {
    const b = ZoneBody.parse(req.body ?? {});
    const db = getDb();
    const r = await db.run(
      `INSERT INTO attendance_zones (name, kind, center_lat, center_lng, radius_m, polygon_geojson, active, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      b.name, b.kind, b.lat ?? null, b.lng ?? null, b.kind === 'polygon' ? null : b.radius ?? null, b.polygon ? JSON.stringify({ type: 'Polygon', coordinates: [b.polygon] }) : null,
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
      b.name, b.kind, b.lat ?? null, b.lng ?? null, b.kind === 'polygon' ? null : b.radius ?? null,
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
  non_school_day: 'Not a working day for them',
  on_school_network: 'On the school network',
  weak_location: 'Imprecise location on their own network: check they were at school',
  phone_location: 'Used a phone’s location (QR code on a computer)',
};

function bucketsFor(rows: Array<{ clock_in: string | null; status?: string }>, opens: string, lateAfter: number) {
  // Late is what was recorded for the person (their own hours), not the school's cut-off.
  const timed = rows.map((r) => ({ m: timeToMinutesOf(r.clock_in), late: r.status === 'late' })).filter((x): x is { m: number; late: boolean } => x.m != null);
  const ins = timed.map((x) => x.m);
  const lateEnd = lateAfter + 60;
  let start = Math.max(timeToMinutes(opens), Math.min(lateAfter - 120, ...ins.map((m) => Math.floor(m / 15) * 15)));
  start = Math.floor(start / 15) * 15;
  const end = Math.max(lateEnd, ...ins.map((m) => Math.floor(m / 15) * 15 + 15));
  const out: Array<{ from: string; to: string; onTime: number; late: number }> = [];
  for (let m = start; m < Math.min(end, start + 15 * 24); m += 15) {
    const label = (x: number) => `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`;
    const inBucket = timed.filter((x) => x.m >= m && x.m < m + 15);
    out.push({ from: label(m), to: label(m + 15), onTime: inBucket.filter((x) => !x.late).length, late: inBucket.filter((x) => x.late).length });
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

/** Everyone who should be here: the MIS staff list (needs the viewer's MIS token and
 *  MANAGE_USERS there), else the people Tendo already knows as staff. */
async function staffRoster(req: any, db: ReturnType<typeof getDb>, site: string): Promise<{ roster: Array<{ id: string; name: string; role?: string }>; rosterSource: 'mis' | 'local' }> {
  let roster: Array<{ id: string; name: string; role?: string }> = [];
  let rosterSource: 'mis' | 'local' = 'local';
  const misToken = (req as AuthenticatedRequest).user?.misToken;
  const tid = currentTenant(site).tid;
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
  return { roster, rosterSource };
}

router.get('/overview', authorizePermission('STAFF_ATTENDANCE_VIEW_ALL'), async (req: any, res) => {
  try {
    const db = getDb();
    const today = schoolDateString(new Date(clockNow()));
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || '')) ? String(req.query.date) : today;
    const rules = clockRules();
    const lateAfter = staffLateCutoffMinutes();
    // Who is expected today and until when: each person's own week, or the school's rules.
    const book = await loadPlanBook(db);
    const holiday = await isHoliday(db, date);
    const nowMin = schoolMinutesOfDay(new Date(clockNow()));

    const records = await db.all<any[]>(`SELECT * FROM staff_attendance WHERE date = ? ORDER BY clock_in`, date);
    const devices = await db.all<any[]>(`SELECT ${DEVICE_COLS} FROM attendance_devices WHERE status IN ('active','pending')`);
    const activeByUser = new Map(devices.filter((d) => d.status === 'active').map((d) => [String(d.user_id), d]));

    const { roster, rosterSource } = await staffRoster(req, db, 'overview');
    const roleOf = new Map((await db.all<any[]>(`SELECT id, role FROM users`)).map((u) => [String(u.id), u.role]));
    const people = new Map<string, { id: string; name: string; role: string | null }>();
    for (const p of roster) people.set(p.id, { id: p.id, name: p.name, role: p.role ?? roleOf.get(p.id) ?? null });
    for (const r of records) if (!people.has(String(r.staff_id))) people.set(String(r.staff_id), { id: String(r.staff_id), name: r.staff_name, role: roleOf.get(String(r.staff_id)) ?? null });

    const recordByUser = new Map(records.map((r) => [String(r.staff_id), r]));
    const ruleOf = new Map<string, DayRule>([...people.keys()].map((id) => [id, book.dayFor(id, date)]));
    const expected = (id: string) => !holiday && !!ruleOf.get(id)?.works;
    const rows = [...people.values()].map((p) => {
      const r = recordByUser.get(p.id);
      const d = activeByUser.get(p.id);
      const flags: string[] = r?.flags ? JSON.parse(r.flags) : [];
      const rule = ruleOf.get(p.id)!;
      return {
        recordId: r?.id ?? null,
        userId: p.id,
        name: p.name,
        role: p.role === 'admin' ? 'Administrator' : p.role === 'teacher' ? 'Teacher' : 'Staff',
        checkIn: safeClockLabel(r?.clock_in),
        checkOut: safeClockLabel(r?.clock_out),
        // Nobody is "not in" on a day they are not expected.
        status: r ? (r.review_state === 'invalid' ? 'invalid' : r.status) : expected(p.id) ? 'not_in' : 'day_off',
        expected: expected(p.id),
        plan: { own: rule.own, works: rule.works, start: rule.start, end: rule.end },
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
    const lateMinutes = valid.filter((r) => r.status === 'late')
      .map((r) => { const m = timeToMinutesOf(r.clock_in); const cut = ruleOf.get(String(r.staff_id))?.lateAfter ?? lateAfter; return m == null ? null : m - cut; })
      .filter((m): m is number => m != null && m > 0).sort((a, b) => a - b);
    // Counted today: the people expected, plus anyone who came on a day off.
    const counted = [...people.keys()].filter((id) => expected(id) || (recordByUser.has(id) && recordByUser.get(id).review_state !== 'invalid'));
    const notIn = [...people.keys()].filter((id) => expected(id) && !valid.some((r) => String(r.staff_id) === id)).length;
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
    // Each person's check-out is "missing" once their own end time has passed.
    const endOf = (id: string) => ruleOf.get(id)?.earlyBefore ?? timeToMinutes(rules.earlyLeaveBefore);
    const outOpen = date !== today || nowMin >= Math.min(timeToMinutes(rules.earlyLeaveBefore), ...valid.filter((r) => r.clock_in && !r.clock_out).map((r) => endOf(String(r.staff_id))));
    const noCheckoutToday = outOpen
      ? valid.filter((r) => r.clock_in && !r.clock_out && (date !== today || nowMin >= endOf(String(r.staff_id)))).map((r) => ({ userId: String(r.staff_id), name: r.staff_name, date: r.date, checkIn: safeClockLabel(r.clock_in), autoClosed: r.out_status === 'auto_closed' }))
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
      zones: zones.filter((z: any) => z.center_lat != null || (z.kind === 'polygon' && z.polygon_geojson)).length,
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
        ownPlans: book.ownCount(people.keys(), date),
        holiday,
        kpis: {
          staff: counted.length,
          checkedIn: valid.length,
          onTime: valid.filter((r) => r.status === 'present').length,
          late: valid.filter((r) => r.status === 'late').length,
          notIn,
          dayOff: people.size - counted.length,
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

// ---------------------------------------------------------------------------
// A period: the term (or any dates) as calendar days, weeks, weekdays and groups.
// ---------------------------------------------------------------------------

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const monthStart = (d: string) => `${d.slice(0, 7)}-01`;
const monthEnd = (d: string) => addDays(monthStart(addDays(monthStart(d), 32)), -1);

/** The term the school is in today (the local copy of the MIS term calendar), if its dates are set. */
async function currentTerm(db: ReturnType<typeof getDb>, today: string): Promise<{ name: string; start: string; end: string } | null> {
  try {
    const t = await db.get<{ name: string; start_date: string | null; end_date: string | null }>(
      `SELECT name, start_date, end_date FROM academic_terms
        WHERE start_date IS NOT NULL AND end_date IS NOT NULL AND substr(start_date, 1, 10) <= ? AND substr(end_date, 1, 10) >= ?
        ORDER BY is_current DESC, start_date DESC LIMIT 1`, today, today);
    return t?.start_date && t.end_date ? { name: t.name, start: String(t.start_date).slice(0, 10), end: String(t.end_date).slice(0, 10) } : null;
  } catch {
    return null;
  }
}

async function loadReport(req: any) {
  const db = getDb();
  const today = schoolDateString(new Date(clockNow()));
  const term = await currentTerm(db, today);
  const q = (k: string) => (ISO_DATE.test(String(req.query[k] || '')) ? String(req.query[k]) : null);
  // Default: the current term so far, else the last 90 days.
  let to = q('to') ?? today;
  if (to > today) to = today;
  let from = q('from') ?? (term ? term.start : addDays(today, -89));
  if (from > to) from = to;
  if (from < addDays(to, -370)) from = addDays(to, -370);

  // The calendars show whole months.
  const calFrom = monthStart(from);
  const calTo = monthEnd(to);
  const spanDays = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1;
  const loadFrom = addDays(calFrom, -(spanDays + 14));

  const lateAfter = staffLateCutoffMinutes();
  const rows = await db.all<any[]>(
    `SELECT staff_id, staff_name, date, clock_in, status FROM staff_attendance
      WHERE date >= ? AND date <= ? AND clock_in IS NOT NULL AND COALESCE(review_state,'') <> 'invalid'`, loadFrom, calTo);
  const first = await db.get<{ d: string | null }>(`SELECT MIN(date) AS d FROM staff_attendance WHERE source IN ('device','card')`);
  let offDays = new Set<string>();
  try {
    offDays = new Set((await db.all<{ session_date: string }[]>(`SELECT session_date FROM rfid_days_off WHERE session_date >= ? AND session_date <= ?`, loadFrom, calTo)).map((r) => r.session_date));
  } catch { /* no days-off table */ }
  const { roster, rosterSource } = await staffRoster(req, db, 'report');
  const book = await loadPlanBook(db);

  const report = buildReport({
    from, to, calFrom, calTo, today,
    trackingFrom: first?.d && first.d <= today ? first.d : today,
    weekdays: schoolDays(),
    offDays,
    roster: roster.map((p) => ({ id: p.id, name: fullName(...String(p.name).split(/\s+/)) || p.name })),
    records: rows.map((r) => ({ staffId: String(r.staff_id), name: r.staff_name, date: String(r.date), inMinutes: timeToMinutesOf(r.clock_in), late: r.status === 'late' })),
    lateAfter,
    opens: timeToMinutes(clockRules().opens),
    expects: (id, date) => book.dayFor(id, date).works,
  });
  return { report: { ...report, ownPlans: book.ownCount(roster.map((p) => p.id), today) }, term, rosterSource };
}

router.get('/report', authorizePermission('STAFF_ATTENDANCE_VIEW_ALL'), async (req: any, res) => {
  try {
    const { report, term, rosterSource } = await loadReport(req);
    // Names are never part of the report: a group's staff are asked for on their own.
    const { persons: _persons, ...data } = report;
    return res.json({ success: true, data: { ...data, term, rosterSource } });
  } catch (err) {
    return fail(res, err);
  }
});

router.get('/report/staff', authorizePermission('STAFF_ATTENDANCE_VIEW_ALL'), async (req: any, res) => {
  try {
    const { report } = await loadReport(req);
    const group = typeof req.query.group === 'string' ? req.query.group : undefined;
    return res.json({ success: true, data: { from: report.from, to: report.to, schoolDays: report.countedDays, people: reportStaff(report.persons, report.countedDays, group) } });
  } catch (err) {
    return fail(res, err);
  }
});

// ---------------------------------------------------------------------------
// One person's history: every day over a period, for the year grid + calendar.
// ---------------------------------------------------------------------------

type DayKind = 'on_time' | 'late' | 'absent' | 'invalid' | 'off' | 'today' | 'future' | 'untracked';

router.get('/people/:id/history', authorizePermission('STAFF_ATTENDANCE_VIEW_ALL'), async (req: any, res) => {
  try {
    const db = getDb();
    const id = String(req.params.id || '').slice(0, 64);
    const today = schoolDateString(new Date(clockNow()));
    const to = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.to || '')) && String(req.query.to) <= today ? String(req.query.to) : today;
    const days = Math.min(371, Math.max(7, Number(req.query.days) || 365));
    const from = addDays(to, -(days - 1));
    const rules = clockRules();
    const lateAfter = staffLateCutoffMinutes();

    const records = await db.all<any[]>(
      `SELECT date, clock_in, clock_out, status, out_status, review_state, source, flags, staff_name FROM staff_attendance WHERE staff_id = ? AND date >= ? AND date <= ? ORDER BY date`,
      id, from, to
    );
    // Before the school's first staff check-in there is nothing to count as absent.
    const first = await db.get<{ d: string | null }>(`SELECT MIN(date) AS d FROM staff_attendance WHERE source IN ('device','card')`);
    const trackingFrom = first?.d && first.d <= today ? first.d : today;
    let offDays = new Set<string>();
    try {
      offDays = new Set((await db.all<{ session_date: string }[]>(`SELECT session_date FROM rfid_days_off WHERE session_date >= ? AND session_date <= ?`, from, to)).map((r) => r.session_date));
    } catch { /* no days-off table */ }
    const book = await loadPlanBook(db, id);
    const byDate = new Map(records.map((r) => [String(r.date), r]));

    const user = await db.get<{ name: string; role: string | null }>(`SELECT name, role FROM users WHERE id = ?`, id);
    const cachedRoster = rosterCache.get(currentTenant('history').tid)?.roster.find((p) => p.id === id);
    const rawName = cachedRoster?.name || user?.name || records[records.length - 1]?.staff_name || 'Staff member';
    const name = fullName(...String(rawName).split(/\s+/)) || 'Staff member';

    const out: Array<{ date: string; kind: DayKind; in: string | null; out: string | null; early: boolean; noOut: boolean; minutes: number | null; card: boolean; start: string | null; end: string | null; extra: boolean }> = [];
    const sum = { schoolDays: 0, attended: 0, onTime: 0, late: 0, absent: 0, noOut: 0, early: 0 };
    const inMinutes: number[] = [];
    for (let d = from; d <= to; d = addDays(d, 1)) {
      const r = byDate.get(d);
      // Expected that day: their own week (as it was on that date) or the school's rules.
      const rule = book.dayFor(id, d);
      const schoolDay = rule.works && !offDays.has(d);
      let kind: DayKind;
      if (r && r.review_state === 'invalid') kind = 'invalid';
      else if (r && r.clock_in) kind = r.status === 'late' ? 'late' : 'on_time';
      else if (!schoolDay) kind = 'off';
      else if (d < trackingFrom) kind = 'untracked';
      else if (d === today) kind = 'today';
      else kind = 'absent';
      const inLabel = r ? safeClockLabel(r.clock_in) : null;
      const outLabel = r ? safeClockLabel(r.clock_out) : null;
      const noOut = !!r?.clock_in && !r?.clock_out && d < today;
      const early = r?.out_status === 'early';
      const minutes = r?.clock_in && r?.clock_out ? Math.max(0, Math.round((Date.parse(r.clock_out) - Date.parse(r.clock_in)) / 60000)) : null;
      // Came on a day they were not expected: it counts for them, never against.
      const extra = !schoolDay && (kind === 'on_time' || kind === 'late');
      out.push({ date: d, kind, in: inLabel, out: outLabel, early, noOut, minutes, card: r?.source === 'card', start: schoolDay ? rule.start : null, end: schoolDay ? rule.end : null, extra });
      if (schoolDay && d >= trackingFrom && d < today) sum.schoolDays += 1;
      else if (schoolDay && d === today && r?.clock_in) sum.schoolDays += 1;
      else if (extra || (schoolDay && d < trackingFrom && (kind === 'on_time' || kind === 'late'))) sum.schoolDays += 1;
      if (kind === 'on_time' || kind === 'late') {
        sum.attended += 1;
        if (kind === 'on_time') sum.onTime += 1; else sum.late += 1;
        const m = timeToMinutes(inLabel);
        if (inLabel) inMinutes.push(m);
      }
      if (kind === 'absent') sum.absent += 1;
      if (noOut) sum.noOut += 1;
      if (early) sum.early += 1;
    }
    // Streaks: consecutive school days on time (today counts once checked in).
    let streak = 0;
    let best = 0;
    let run = 0;
    for (const day of out) {
      if (day.kind === 'off' || day.kind === 'untracked' || day.kind === 'future' || (day.kind === 'today')) continue;
      run = day.kind === 'on_time' ? run + 1 : 0;
      best = Math.max(best, run);
    }
    for (let i = out.length - 1; i >= 0; i--) {
      const k = out[i].kind;
      if (k === 'off' || k === 'today' || k === 'untracked') continue;
      if (k === 'on_time') streak += 1; else break;
    }
    const avg = inMinutes.length ? Math.round(inMinutes.reduce((a, b) => a + b, 0) / inMinutes.length) : null;
    const hhmm = (m: number | null) => (m == null ? null : `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
    return res.json({
      success: true,
      data: {
        person: { id, name, role: cachedRoster?.role ?? user?.role ?? null },
        from, to, today, trackingFrom,
        rules: { lateAfter: hhmm(lateAfter), earlyLeaveBefore: rules.earlyLeaveBefore },
        plan: planView(book, id, today),
        days: out,
        summary: {
          ...sum,
          rate: sum.schoolDays ? Math.round((sum.attended / sum.schoolDays) * 100) : null,
          punctuality: sum.attended ? Math.round((sum.onTime / sum.attended) * 100) : null,
          avgIn: hhmm(avg),
          streak,
          bestStreak: best,
        },
      },
    });
  } catch (err) {
    return fail(res, err);
  }
});

// ---------------------------------------------------------------------------
// A person's own working week (workPlan.ts). No plan = the school's rules.
// ---------------------------------------------------------------------------

function planView(book: PlanBook, id: string, today: string) {
  const current = book.versionFor(id, today);
  const next = book.upcoming(id, today);
  const meta = (v: NonNullable<typeof current>) => ({ effectiveFrom: v.effectiveFrom, note: v.note, updatedByName: v.updatedByName, updatedAt: v.updatedAt });
  return {
    own: !!current,
    days: book.weekFor(id, today),
    school: schoolWeek(book.school),
    ...(current ? meta(current) : { effectiveFrom: null, note: null, updatedByName: null, updatedAt: null }),
    /** a change already saved for a later day */
    upcoming: next ? { effectiveFrom: next.effectiveFrom, days: next.days, note: next.note } : null,
    versions: book.history(id).map((v) => ({ effectiveFrom: v.effectiveFrom, own: !!v.days, updatedByName: v.updatedByName, updatedAt: v.updatedAt })).reverse(),
  };
}

const PlanBody = z.object({
  /** the seven days; null = follow the school's rules again */
  days: z.unknown().nullable(),
  effectiveFrom: z.string().regex(ISO_DATE, 'Choose the day the hours start.').optional(),
  note: z.string().max(200, 'Keep the note under 200 characters.').optional(),
});

router.get('/people/:id/plan', authorizePermission('STAFF_ATTENDANCE_VIEW_ALL', 'STAFF_ATTENDANCE_ZONES_MANAGE'), async (req: any, res) => {
  try {
    const id = String(req.params.id || '').slice(0, 64);
    const today = schoolDateString(new Date(clockNow()));
    return res.json({ success: true, data: planView(await loadPlanBook(getDb(), id), id, today) });
  } catch (err) {
    return fail(res, err);
  }
});

router.put('/people/:id/plan', authorizePermission('STAFF_ATTENDANCE_ZONES_MANAGE'), async (req: any, res) => {
  try {
    const b = PlanBody.parse(req.body ?? {});
    const db = getDb();
    const id = String(req.params.id || '').slice(0, 64);
    if (!id) throw new ClockError(400, 'INVALID', 'Choose a staff member.');
    const today = schoolDateString(new Date(clockNow()));
    const from = b.effectiveFrom ?? today;
    if (from < addDays(today, -370) || from > addDays(today, 370)) throw new ClockError(400, 'INVALID', 'Choose a start day within a year of today.');

    const before = await loadPlanBook(db, id);
    let days = null as ReturnType<typeof schoolWeek> | null;
    if (b.days !== null) {
      const parsed = parseWeekPlan(b.days);
      if ('error' in parsed) throw new ClockError(400, 'INVALID', parsed.error);
      // The same week as the school's rules is not an own plan.
      days = sameWeek(parsed.days, schoolWeek(before.school)) ? null : parsed.days;
    }
    const actor = actorOf(req);
    const { rejudged } = await savePlan(db, { userId: id, effectiveFrom: from, days, note: b.note, by: actor, nowIso: new Date(clockNow()).toISOString() });
    const after = await loadPlanBook(db, id);
    const person = (await db.get<{ name: string }>(`SELECT name FROM users WHERE id = ?`, id))?.name ?? id;
    await recordAudit(db, actor, days ? 'STAFF_CLOCK_PLAN_SAVED' : 'STAFF_CLOCK_PLAN_REMOVED', 'staff_work_plan', null,
      { staff: person, staffId: id, effectiveFrom: from, days, note: b.note, rejudged }, { previousValue: before.weekFor(id, from), newValue: after.weekFor(id, from) });
    const when = from === today ? 'from today' : `from ${from}`;
    return res.json({
      success: true,
      message: days ? `Own hours saved, ${when}` : `Back to the school's hours, ${when}`,
      data: { plan: planView(after, id, today), rejudged },
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
    const book = await loadPlanBook(getDb());
    const hoursOf = (r: any) => { const d = book.dayFor(String(r.staff_id), String(r.date)); return d.works ? `${d.start}-${d.end}${d.own ? ' (own)' : ''}` : d.own ? 'Day off (own)' : ''; };
    const esc = (v: unknown) => {
      const s = v == null ? '' : String(v);
      return /[",\n]/.test(s) || /^[=+\-@]/.test(s) ? `"${s.replace(/"/g, '""').replace(/^([=+\-@])/, "'$1")}"` : s;
    };
    const header = ['Date', 'Staff', 'Check-in', 'Status', 'Check-out', 'Check-out status', 'Distance (m)', 'Source', 'Review', 'Flags', 'Expected hours'];
    const lines = rows.map((r) => [
      r.date, r.staff_name, safeClockLabel(r.clock_in) ?? '', r.status, safeClockLabel(r.clock_out) ?? '',
      r.out_status ?? '', r.in_distance_m != null ? Math.round(r.in_distance_m) : '', r.source ?? '', r.review_state ?? '',
      (r.flags ? JSON.parse(r.flags) : []).join(' '), hoursOf(r),
    ].map(esc).join(','));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="staff-attendance-${from}${to !== from ? `-to-${to}` : ''}.csv"`);
    return res.send('﻿' + [header.join(','), ...lines].join('\r\n'));
  } catch (err) {
    return fail(res, err);
  }
});

export default router;
