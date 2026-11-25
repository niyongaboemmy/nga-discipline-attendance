import type { Database } from 'sqlite';
import { addDays, dayOfWeekFor, schoolDateString, schoolMinutesOfDay, timeToMinutes, weekStartFor, schoolClockLabel } from '../../shared/schoolTime.js';
import { schoolDays, schoolSetting, schoolTimezone, numberSetting, staffLateCutoffMinutes } from '../../tenancy/settings.js';
import { resolveAcademicPeriodForDate } from '../../utils/academicPeriod.js';
import { cleanJwk, consumeNonce, hashDeviceToken, issueNonce, jwkThumbprint, newDeviceToken, punchMessage, verifyDeviceSignature, type EcJwk } from './deviceAuth.js';
import { judge, onSchoolNetwork, plausibilityFlags, validFix, type ClockFlag, type Fix, type Zone } from './geofence.js';

/**
 * The staff attendance clock (STAFF_ATTENDANCE_CLOCK_PLAN.md §4-§7): device rules,
 * the one-tap check-in / check-out and the person's own state. Routes live in
 * clock.routes.ts (public page) and clockAdmin.routes.ts (school admin).
 *
 * Time: only the server clock counts. "Today", "late" and "early" are computed in
 * the school's timezone; the device's own time is recorded (skew) and never used.
 */

let nowFn: () => number = () => Date.now();
export const clockNow = () => nowFn();
/** Test hook: a fixed server clock (null restores Date.now). */
export function __setClockNow(fn: (() => number) | null): void {
  nowFn = fn ?? (() => Date.now());
}

export class ClockError extends Error {
  constructor(public status: number, public code: string, message: string, public extra: Record<string, unknown> = {}) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Settings & zones
// ---------------------------------------------------------------------------

export interface ClockRules {
  enabled: boolean;
  requireZone: boolean;
  maxAccuracy: number;
  allowance: number;
  opens: string;
  lateAfter: string;
  earlyLeaveBefore: string;
  minShiftMinutes: number;
  autoCloseAt: string;
  selfReplaceDays: number;
  googleDomains: string;
  schoolNetworks: string;
  nonSchoolDays: 'allow_flag' | 'refuse';
  allowUnassignedStaff: boolean;
  retentionDays: number;
}

const hhmm = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

export function clockRules(): ClockRules {
  return {
    enabled: schoolSetting('STAFF_CLOCK_ENABLED') === '1',
    requireZone: schoolSetting('STAFF_CLOCK_REQUIRE_ZONE') !== '0',
    maxAccuracy: numberSetting('STAFF_CLOCK_MAX_ACCURACY_M'),
    allowance: numberSetting('STAFF_CLOCK_ACCURACY_ALLOWANCE_M'),
    opens: schoolSetting('STAFF_CLOCK_OPENS'),
    lateAfter: hhmm(staffLateCutoffMinutes()),
    earlyLeaveBefore: schoolSetting('STAFF_EARLY_LEAVE_BEFORE'),
    minShiftMinutes: numberSetting('STAFF_MIN_SHIFT_MINUTES'),
    autoCloseAt: schoolSetting('STAFF_AUTO_CLOSE_AT'),
    selfReplaceDays: numberSetting('STAFF_DEVICE_SELF_REPLACE_DAYS'),
    googleDomains: schoolSetting('STAFF_CLOCK_GOOGLE_DOMAINS'),
    schoolNetworks: schoolSetting('STAFF_CLOCK_SCHOOL_NETWORKS'),
    nonSchoolDays: schoolSetting('STAFF_CLOCK_NON_SCHOOL_DAYS') === 'refuse' ? 'refuse' : 'allow_flag',
    allowUnassignedStaff: schoolSetting('STAFF_CLOCK_ALLOW_UNASSIGNED_STAFF') !== '0',
    retentionDays: numberSetting('STAFF_CLOCK_RETENTION_DAYS'),
  };
}

export async function loadZones(db: Database, activeOnly = false): Promise<Zone[]> {
  return db.all<Zone[]>(`SELECT * FROM attendance_zones ${activeOnly ? 'WHERE active = 1' : ''} ORDER BY id`);
}

/** The page is usable: switched on, and (when the zone is required) at least one active zone. */
export async function clockReady(db: Database, rules = clockRules()): Promise<boolean> {
  if (!rules.enabled) return false;
  if (!rules.requireZone) return true;
  return (await loadZones(db, true)).length > 0;
}

export async function isSchoolDay(db: Database, date: string): Promise<boolean> {
  if (!schoolDays().has(dayOfWeekFor(date))) return false;
  try {
    const off = await db.get(`SELECT 1 FROM rfid_days_off WHERE session_date = ?`, date);
    return !off;
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export async function logEvent(
  db: Database,
  e: {
    kind: string;
    reason?: string | null;
    userId?: string | null;
    deviceId?: number | null;
    fix?: Fix | null;
    distance?: number | null;
    ip?: string | null;
    userAgent?: string | null;
    clientTime?: string | null;
    flags?: string[] | null;
  }
): Promise<void> {
  const now = clockNow();
  await db.run(
    `INSERT INTO attendance_events (occurred_at, school_date, user_id, device_id, kind, reason, lat, lng, accuracy_m, distance_m, ip, user_agent, client_time, flags)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    new Date(now).toISOString(),
    schoolDateString(new Date(now)),
    e.userId ?? null,
    e.deviceId ?? null,
    e.kind,
    e.reason ?? null,
    e.fix?.lat ?? null,
    e.fix?.lng ?? null,
    e.fix?.accuracy ?? null,
    e.distance ?? null,
    e.ip ?? null,
    e.userAgent ? String(e.userAgent).slice(0, 400) : null,
    e.clientTime ? String(e.clientTime).slice(0, 40) : null,
    e.flags && e.flags.length ? JSON.stringify(e.flags) : null
  );
}

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

export interface DeviceRow {
  id: number;
  user_id: string;
  user_name: string;
  google_sub: string;
  google_email: string;
  key_thumbprint: string;
  public_key_jwk: string;
  token_hash: string;
  install_uuid: string;
  nga_did: string | null;
  form_factor: 'phone' | 'tablet' | 'desktop';
  label: string | null;
  browser: string | null;
  os: string | null;
  model: string | null;
  user_agent: string | null;
  ip_first: string | null;
  ip_last: string | null;
  status: 'pending' | 'active' | 'revoked' | 'replaced' | 'declined';
  registered_at: string;
  approved_at: string | null;
  approved_by: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
  revoked_by: string | null;
  revoke_reason: string | null;
}

export interface DeviceInfo {
  browser?: string;
  os?: string;
  model?: string;
  formFactor?: string;
}

const clip = (v: unknown, n: number) => (v == null || v === '' ? null : String(v).slice(0, n));
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function deviceLabel(info: DeviceInfo): string {
  const left = info.model || info.os || 'Device';
  return info.browser ? `${left} · ${info.browser}` : left;
}

export async function deviceByToken(db: Database, token: string | undefined | null): Promise<DeviceRow | null> {
  if (!token || token.length < 20 || token.length > 200) return null;
  return (await db.get<DeviceRow>(`SELECT * FROM attendance_devices WHERE token_hash = ?`, hashDeviceToken(token))) ?? null;
}

/** First name, initials and a short role label for the page. */
export function personView(name: string, roleLabel?: string | null) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  return {
    name: String(name || '').trim(),
    firstName: words[0] || '',
    initials: words.slice(0, 2).map((w) => w[0]!.toUpperCase()).join(''),
    role: roleLabel || null,
  };
}

export function roleLabelOf(userType: string | null | undefined, roles: string[] = []): string {
  const t = String(userType || '').toUpperCase();
  if (t === 'TEACHER' || roles.includes('TEACHER')) return 'Teacher';
  if (t === 'ADMIN' || roles.some((r) => /ADMIN/.test(r))) return 'Administrator';
  return 'Staff';
}

export interface RegisterInput {
  userId: string;
  userName: string;
  google: { sub: string; email: string };
  jwk: unknown;
  installUuid: unknown;
  ngaDid?: unknown;
  device: DeviceInfo;
  userAgent?: string | null;
  ip?: string | null;
  /** Check everything and say what would happen, write nothing (the confirm screen). */
  dryRun?: boolean;
}

export interface RegisterResult {
  deviceToken: string;
  status: 'active' | 'pending';
  deviceId: number;
  replaced: boolean;
}

/**
 * Register this device for this person (plan §4.3):
 *  - one active device per person, one person per device (key, install id or shared NGA device id);
 *  - the same physical device re-keying (storage cleared) silently replaces itself;
 *  - a different device replaces the old one by itself once per STAFF_DEVICE_SELF_REPLACE_DAYS,
 *    otherwise it waits for an admin (pending) while the old one keeps working.
 */
export async function registerDevice(db: Database, input: RegisterInput): Promise<RegisterResult> {
  const jwk = cleanJwk(input.jwk);
  if (!jwk) throw new ClockError(400, 'BAD_KEY', 'This browser could not create a device key. Update the browser and try again.');
  const installUuid = String(input.installUuid || '');
  if (!UUID_RE.test(installUuid)) throw new ClockError(400, 'BAD_DEVICE', 'This browser sent an invalid device id.');
  const ngaDid = clip(input.ngaDid, 64);
  const thumb = jwkThumbprint(jwk);
  const rules = clockRules();
  const nowIso = new Date(clockNow()).toISOString();

  // One person per device.
  const holder = await db.get<DeviceRow>(
    `SELECT * FROM attendance_devices
      WHERE status IN ('active','pending') AND user_id <> ?
        AND (key_thumbprint = ? OR install_uuid = ? OR (? IS NOT NULL AND nga_did = ?))
      LIMIT 1`,
    input.userId, thumb, installUuid, ngaDid, ngaDid
  );
  if (holder) {
    if (!input.dryRun) await logEvent(db, { kind: 'refused', reason: 'device_taken', userId: input.userId, ip: input.ip, userAgent: input.userAgent });
    throw new ClockError(409, 'DEVICE_TAKEN', 'This device is already registered to another staff member. Each person checks in with their own phone or tablet.');
  }

  const token = newDeviceToken();
  const tokenHash = hashDeviceToken(token);
  const formFactor = ['phone', 'tablet', 'desktop'].includes(String(input.device.formFactor)) ? String(input.device.formFactor) : 'phone';
  const info = {
    browser: clip(input.device.browser, 60),
    os: clip(input.device.os, 60),
    model: clip(input.device.model, 80),
  };

  // The same key registering again (e.g. the token was lost): rotate the token.
  const sameKey = await db.get<DeviceRow>(
    `SELECT * FROM attendance_devices WHERE user_id = ? AND key_thumbprint = ? AND status IN ('active','pending')`,
    input.userId, thumb
  );
  if (sameKey) {
    if (input.dryRun) return { deviceToken: '', status: sameKey.status === 'pending' ? 'pending' : 'active', deviceId: sameKey.id, replaced: false };
    await db.run(`UPDATE attendance_devices SET token_hash = ?, ip_last = ?, last_used_at = ? WHERE id = ?`, tokenHash, input.ip ?? null, nowIso, sameKey.id);
    await logEvent(db, { kind: 'reregister', reason: 'same_key', userId: input.userId, deviceId: sameKey.id, ip: input.ip, userAgent: input.userAgent });
    return { deviceToken: token, status: sameKey.status === 'pending' ? 'pending' : 'active', deviceId: sameKey.id, replaced: false };
  }

  const active = await db.get<DeviceRow>(`SELECT * FROM attendance_devices WHERE user_id = ? AND status = 'active'`, input.userId);
  let status: 'active' | 'pending' = 'active';
  let replaces: DeviceRow | null = null;
  let reason = 'first';

  if (active) {
    const sameDevice =
      active.install_uuid === installUuid ||
      (!!ngaDid && active.nga_did === ngaDid) ||
      (!!input.userAgent && active.user_agent === input.userAgent && (active.model ?? '') === (info.model ?? ''));
    if (sameDevice) {
      replaces = active;
      reason = 'rekey';
    } else {
      const windowStart = new Date(clockNow() - rules.selfReplaceDays * 86_400_000).toISOString();
      const recent = await db.get(
        `SELECT 1 FROM attendance_events WHERE user_id = ? AND kind = 'register' AND reason = 'replace' AND occurred_at >= ? LIMIT 1`,
        input.userId, windowStart
      );
      if (recent) {
        status = 'pending';
        reason = 'pending_approval';
      } else {
        replaces = active;
        reason = 'replace';
      }
    }
  }

  if (input.dryRun) return { deviceToken: '', status, deviceId: 0, replaced: !!replaces && reason === 'replace' };

  // A pending request from this person for another device is superseded.
  await db.run(
    `UPDATE attendance_devices SET status = 'declined', revoked_at = ?, revoke_reason = 'superseded' WHERE user_id = ? AND status = 'pending'`,
    nowIso, input.userId
  );

  if (replaces) {
    await db.run(
      `UPDATE attendance_devices SET status = 'replaced', revoked_at = ?, revoke_reason = ? WHERE id = ?`,
      nowIso, reason === 'rekey' ? 'same_device_rekey' : 'replaced_by_owner', replaces.id
    );
  }

  const result = await db.run(
    `INSERT INTO attendance_devices
      (user_id, user_name, google_sub, google_email, key_thumbprint, public_key_jwk, token_hash, install_uuid, nga_did,
       form_factor, label, browser, os, model, user_agent, ip_first, ip_last, status, registered_at, approved_at, approved_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    input.userId, input.userName, input.google.sub, input.google.email, thumb, JSON.stringify(jwk), tokenHash, installUuid, ngaDid,
    formFactor, deviceLabel({ ...info, model: info.model ?? undefined, os: info.os ?? undefined, browser: info.browser ?? undefined }),
    info.browser, info.os, info.model, clip(input.userAgent, 400), input.ip ?? null, input.ip ?? null,
    status, nowIso, status === 'active' ? nowIso : null, status === 'active' ? 'self' : null
  );
  const deviceId = Number(result.lastID);
  await logEvent(db, { kind: 'register', reason, userId: input.userId, deviceId, ip: input.ip, userAgent: input.userAgent });
  return { deviceToken: token, status, deviceId, replaced: !!replaces && reason === 'replace' };
}

/** The device behind a token, refusing removed devices and inactive people. */
export async function requireDevice(db: Database, token: string | undefined | null, opts: { allowPending?: boolean } = {}): Promise<DeviceRow> {
  const device = await deviceByToken(db, token);
  if (!device) throw new ClockError(401, 'DEVICE_UNKNOWN', 'This device is not registered. Register it again.');
  if (device.status === 'revoked' || device.status === 'replaced' || device.status === 'declined') {
    throw new ClockError(401, 'DEVICE_REVOKED', 'Your school removed this device from your account.', { deviceStatus: device.status });
  }
  const user = await db.get<{ status: string | null }>(`SELECT status FROM users WHERE id = ?`, device.user_id);
  if (user?.status === 'inactive') {
    await db.run(`UPDATE attendance_devices SET status = 'revoked', revoked_at = ?, revoke_reason = 'account_inactive' WHERE id = ?`, new Date(clockNow()).toISOString(), device.id);
    throw new ClockError(401, 'DEVICE_REVOKED', 'This account is no longer active.', { deviceStatus: 'revoked' });
  }
  if (device.status === 'pending' && !opts.allowPending) {
    throw new ClockError(403, 'DEVICE_PENDING', 'Your school still has to approve this device.');
  }
  return device;
}

export function challengeFor(tid: number, device: DeviceRow): { nonce: string; expiresIn: number } {
  return { nonce: issueNonce(`t${tid}:d${device.id}`, clockNow()), expiresIn: 60 };
}

// ---------------------------------------------------------------------------
// The person's day
// ---------------------------------------------------------------------------

export interface StaffDayRow {
  id: number;
  staff_id: string;
  date: string;
  clock_in: string | null;
  clock_out: string | null;
  status: 'present' | 'late' | 'absent';
  out_status: string | null;
  in_distance_m: number | null;
  flags: string | null;
  review_state: string | null;
}

export type NextAction = 'check_in' | 'check_out' | 'done' | 'closed';

export async function personState(db: Database, device: DeviceRow) {
  const now = new Date(clockNow());
  const today = schoolDateString(now);
  const minutes = schoolMinutesOfDay(now);
  const rules = clockRules();
  const row = await db.get<StaffDayRow>(`SELECT * FROM staff_attendance WHERE staff_id = ? AND date = ?`, device.user_id, today);
  const weekStart = weekStartFor(today);
  const weekDates = [0, 1, 2, 3, 4, 5, 6].map((i) => addDays(weekStart, i)).filter((d) => schoolDays().has(dayOfWeekFor(d)));
  const weekRows = await db.all<StaffDayRow[]>(
    `SELECT * FROM staff_attendance WHERE staff_id = ? AND date >= ? AND date <= ?`,
    device.user_id, weekStart, addDays(weekStart, 6)
  );
  const byDate = new Map(weekRows.map((r) => [r.date, r]));
  const schoolDay = await isSchoolDay(db, today);

  let next: NextAction;
  let checkoutOpensAt: string | null = null;
  if (!row) {
    next = minutes < timeToMinutes(rules.opens) || (!schoolDay && rules.nonSchoolDays === 'refuse') ? 'closed' : 'check_in';
  } else if (!row.clock_out) {
    next = 'check_out';
    const inAt = Date.parse(row.clock_in!);
    const opensAt = inAt + rules.minShiftMinutes * 60_000;
    if (opensAt > now.getTime()) checkoutOpensAt = schoolClockLabel(new Date(opensAt));
  } else {
    next = 'done';
  }

  const label = (iso: string | null) => (iso ? schoolClockLabel(iso) : null);
  return {
    serverNow: now.toISOString(),
    schoolDate: today,
    timezone: schoolTimezone(),
    schoolDay,
    next,
    checkoutOpensAt,
    opensAt: rules.opens,
    today: row
      ? {
          checkIn: label(row.clock_in),
          checkOut: label(row.clock_out),
          status: row.status,
          outStatus: row.out_status,
          minutesAtSchool: row.clock_in ? Math.max(0, Math.round(((row.clock_out ? Date.parse(row.clock_out) : now.getTime()) - Date.parse(row.clock_in)) / 60000)) : 0,
        }
      : null,
    week: weekDates.map((d) => {
      const r = byDate.get(d);
      return {
        date: d,
        isToday: d === today,
        future: d > today,
        checkIn: r ? label(r.clock_in) : null,
        checkOut: r ? label(r.clock_out) : null,
        status: r?.status ?? null,
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// The tap
// ---------------------------------------------------------------------------

export interface PunchInput {
  nonce: unknown;
  signature: unknown;
  position: unknown;
  samples?: unknown;
  clientTime?: unknown;
}

export interface PunchResult {
  action: 'check_in' | 'check_out';
  at: string;
  status: string;
  distance: number | null;
  zone: string | null;
  flags: ClockFlag[];
}

const REVIEW_FLAGS = new Set(['suspicious_accuracy', 'no_jitter', 'stale_fix', 'impossible_travel', 'twin_punch']);

export function needsReview(flags: string | null, reviewState: string | null): boolean {
  if (reviewState) return false;
  try {
    const list: string[] = JSON.parse(flags || '[]');
    return list.some((f) => REVIEW_FLAGS.has(f.replace(/^out:/, '')));
  } catch {
    return false;
  }
}

export async function punch(
  db: Database,
  tid: number,
  device: DeviceRow,
  body: PunchInput,
  ctx: { ip: string | null; userAgent: string | null }
): Promise<PunchResult> {
  const rules = clockRules();
  const nowMs = clockNow();
  const now = new Date(nowMs);
  const nowIso = now.toISOString();
  const fix = validFix(body.position);
  const refuse = async (status: number, code: string, message: string, reason: string, extra: Record<string, unknown> = {}, distance: number | null = null) => {
    await logEvent(db, { kind: 'refused', reason, userId: device.user_id, deviceId: device.id, fix, distance, ip: ctx.ip, userAgent: ctx.userAgent, clientTime: clip(body.clientTime, 40) });
    throw new ClockError(status, code, message, extra);
  };

  if (!(await clockReady(db, rules))) await refuse(403, 'CLOCK_OFF', 'Staff attendance is not open for this school yet.', 'clock_off');
  if (!fix) await refuse(400, 'NO_LOCATION', 'Your location is needed to check in.', 'no_location');

  const jwk = JSON.parse(device.public_key_jwk) as EcJwk;
  if (!consumeNonce(`t${tid}:d${device.id}`, String(body.nonce || ''), nowMs)) {
    await refuse(401, 'BAD_CHALLENGE', 'That took too long. Tap again.', 'bad_nonce');
  }
  if (!verifyDeviceSignature(jwk, punchMessage(String(body.nonce), { lat: (body.position as any).lat, lng: (body.position as any).lng, accuracy: (body.position as any).accuracy }), String(body.signature || ''))) {
    await refuse(401, 'BAD_SIGNATURE', 'This device could not prove it is yours. Register it again.', 'bad_signature');
  }

  const today = schoolDateString(now);
  const minutes = schoolMinutesOfDay(now);
  const schoolDay = await isSchoolDay(db, today);
  if (!schoolDay && rules.nonSchoolDays === 'refuse') await refuse(403, 'NOT_SCHOOL_DAY', 'Attendance is closed today.', 'non_school_day');

  const row = await db.get<StaffDayRow & { in_lat: number | null; in_lng: number | null }>(
    `SELECT * FROM staff_attendance WHERE staff_id = ? AND date = ?`, device.user_id, today
  );
  if (row?.clock_out) await refuse(409, 'ALREADY_DONE', 'You have already checked in and out today.', 'already_done');
  const action: 'check_in' | 'check_out' = row ? 'check_out' : 'check_in';

  if (action === 'check_in' && minutes < timeToMinutes(rules.opens)) {
    await refuse(403, 'NOT_OPEN', `Check-in opens at ${rules.opens}.`, 'not_open', { opensAt: rules.opens });
  }
  if (action === 'check_out') {
    const opensAt = Date.parse(row!.clock_in!) + rules.minShiftMinutes * 60_000;
    if (opensAt > nowMs) {
      await refuse(409, 'TOO_SOON', `Check-out opens at ${schoolClockLabel(new Date(opensAt))}.`, 'too_soon', { checkoutOpensAt: schoolClockLabel(new Date(opensAt)) });
    }
  }

  // The zone.
  const zones = await loadZones(db, true);
  const network = onSchoolNetwork(ctx.ip, rules.schoolNetworks);
  const verdict = judge(fix!, zones, { maxAccuracy: rules.maxAccuracy, allowance: rules.allowance });
  if (rules.requireZone && !network) {
    if (!verdict.preciseEnough) {
      await refuse(422, 'LOW_ACCURACY', 'Your location is not precise enough.', 'low_accuracy', { accuracy: Math.round(fix!.accuracy) }, verdict.distance);
    }
    if (!verdict.inside) {
      await refuse(403, 'OUTSIDE_ZONE', 'You are not inside the school zone.', 'outside_zone', { distance: verdict.distance, outsideBy: Math.round(verdict.outsideBy) }, verdict.distance);
    }
  }

  // Flags.
  const samples = (Array.isArray(body.samples) ? body.samples : []).slice(0, 10).map(validFix).filter((s): s is Fix => !!s);
  const clientMs = Date.parse(String(body.clientTime || ''));
  const skew = Number.isFinite(clientMs) ? clientMs - nowMs : null;
  const lastFix = await db.get<{ lat: number; lng: number; occurred_at: string }>(
    `SELECT lat, lng, occurred_at FROM attendance_events WHERE device_id = ? AND lat IS NOT NULL AND kind IN ('check_in','check_out') ORDER BY id DESC LIMIT 1`,
    device.id
  );
  const flags = plausibilityFlags({
    fix: fix!,
    samples,
    serverNow: nowMs,
    clientSkewMs: skew,
    last: lastFix ? { lat: lastFix.lat, lng: lastFix.lng, at: Date.parse(lastFix.occurred_at) } : null,
  });
  if (!schoolDay) flags.push('non_school_day');
  if (network) flags.push('on_school_network');
  if (action === 'check_in') {
    const twins = await db.all<{ clock_in: string; in_lat: number; in_lng: number }[]>(
      `SELECT clock_in, in_lat, in_lng FROM staff_attendance WHERE date = ? AND staff_id <> ? AND in_ip = ? AND in_lat IS NOT NULL`,
      today, device.user_id, ctx.ip ?? ''
    );
    if (twins.some((t) => Math.abs(Date.parse(t.clock_in) - nowMs) <= 60_000 && Math.abs(t.in_lat - fix!.lat) < 0.00001 && Math.abs(t.in_lng - fix!.lng) < 0.00001)) {
      flags.push('twin_punch');
    }
  }

  const distance = verdict.distance;
  const zoneId = verdict.inside ? verdict.zoneId : null;
  let status: string;

  if (action === 'check_in') {
    status = minutes > staffLateCutoffMinutes() ? 'late' : 'present';
    const { academicYearId, academicTermId } = await resolveAcademicPeriodForDate(db, today);
    const hasSubjects = await db.get(
      `SELECT 1 FROM class_subject_assignments WHERE teacher_id = ? AND (academic_term_id = ? OR academic_term_id IS NULL) LIMIT 1`,
      device.user_id, academicTermId ?? null
    );
    try {
      await db.run(
        `INSERT INTO staff_attendance
          (staff_id, staff_name, date, clock_in, status, academic_year_id, academic_term_id, staff_type, source,
           in_device_id, in_lat, in_lng, in_accuracy_m, in_distance_m, in_zone_id, in_ip, flags, client_skew_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'device', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        device.user_id, device.user_name, today, nowIso, status, academicYearId ?? null, academicTermId ?? null,
        hasSubjects ? 'teacher' : 'other', device.id, fix!.lat, fix!.lng, fix!.accuracy, distance, zoneId, ctx.ip ?? null,
        flags.length ? JSON.stringify(flags) : null, skew
      );
    } catch (err: any) {
      if (String(err?.message || '').includes('UNIQUE')) {
        throw new ClockError(409, 'ALREADY_IN', 'You are already checked in today.');
      }
      throw err;
    }
  } else {
    status = minutes < timeToMinutes(rules.earlyLeaveBefore) ? 'early' : 'on_time';
    const merged = [...JSON.parse(row!.flags || '[]'), ...flags.map((f) => `out:${f}`)];
    const res = await db.run(
      `UPDATE staff_attendance SET clock_out = ?, out_status = ?, out_device_id = ?, out_lat = ?, out_lng = ?, out_accuracy_m = ?,
              out_distance_m = ?, out_zone_id = ?, out_ip = ?, flags = ?
        WHERE id = ? AND clock_out IS NULL`,
      nowIso, status, device.id, fix!.lat, fix!.lng, fix!.accuracy, distance, zoneId, ctx.ip ?? null,
      merged.length ? JSON.stringify(merged) : null, row!.id
    );
    if (!res.changes) throw new ClockError(409, 'ALREADY_DONE', 'You have already checked out today.');
  }

  await db.run(`UPDATE attendance_devices SET last_used_at = ?, ip_last = ? WHERE id = ?`, nowIso, ctx.ip ?? null, device.id);
  await logEvent(db, { kind: action, userId: device.user_id, deviceId: device.id, fix, distance, ip: ctx.ip, userAgent: ctx.userAgent, clientTime: clip(body.clientTime, 40), flags });
  return { action, at: schoolClockLabel(now), status, distance, zone: verdict.inside ? verdict.zoneName : null, flags };
}

// ---------------------------------------------------------------------------
// Background: close open days, blank old coordinates
// ---------------------------------------------------------------------------

/** Days left open (no check-out) get out_status 'auto_closed' once the school's auto-close time passes. */
export async function autoCloseOpenDays(db: Database): Promise<number> {
  const now = new Date(clockNow());
  const today = schoolDateString(now);
  const pastClose = schoolMinutesOfDay(now) >= timeToMinutes(clockRules().autoCloseAt);
  const res = await db.run(
    `UPDATE staff_attendance SET out_status = 'auto_closed'
      WHERE clock_in IS NOT NULL AND clock_out IS NULL AND out_status IS NULL AND (date < ? ${pastClose ? 'OR date = ?' : ''})`,
    ...(pastClose ? [today, today] : [today])
  );
  return res.changes ?? 0;
}

export async function blankOldCoordinates(db: Database): Promise<void> {
  const days = clockRules().retentionDays;
  if (!Number.isFinite(days) || days <= 0) return;
  const cutoff = addDays(schoolDateString(new Date(clockNow())), -days);
  await db.run(
    `UPDATE staff_attendance SET in_lat = NULL, in_lng = NULL, out_lat = NULL, out_lng = NULL WHERE date < ? AND (in_lat IS NOT NULL OR out_lat IS NOT NULL)`,
    cutoff
  );
  await db.run(`UPDATE attendance_events SET lat = NULL, lng = NULL WHERE school_date < ? AND lat IS NOT NULL`, cutoff);
}
