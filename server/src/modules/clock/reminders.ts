import type { Database } from 'sqlite';
import fs from 'fs';
import path from 'path';
import webpush from 'web-push';
import { config } from '../../config.js';
import { schoolDateString, schoolMinutesOfDay } from '../../shared/schoolTime.js';
import { numberSetting } from '../../tenancy/settings.js';
import { clockNow, clockReady, isHoliday, type DeviceRow } from './clock.service.js';
import { loadPlanBook, type DayRule } from './workPlan.js';

/**
 * Check-in / check-out reminders: a notification on the person's own phone, timed
 * from THEIR day (their own working week, or the school's hours):
 *
 *   in_soon   N minutes before their start, not checked in yet
 *   in_now    at their start, still not checked in
 *   out_soon  N minutes before their end, checked in and not out
 *   out_late  30 minutes after their end, still not checked out
 *
 * N is the school's STAFF_CLOCK_REMIND_MINUTES (0 turns reminders off). Nothing is
 * sent on a day off, a school holiday, or once the tap is done. Each kind goes out
 * once per person and day. The phone asks for the reminders itself on the check-in
 * page (Web Push); the subscription belongs to the registered device.
 */

export type ReminderKind = 'in_soon' | 'in_now' | 'out_soon' | 'out_late';

/** How long after its moment a reminder is still worth sending (the server was busy or down). */
const GRACE = { in_soon: 0, in_now: 45, out_soon: 0, out_late: 90 } as const;
const OUT_LATE_AFTER = 30;

/** The reminders due right now for one person (pure). */
export function dueReminders(input: { nowMin: number; rule: DayRule; lead: number; checkedIn: boolean; checkedOut: boolean }): ReminderKind[] {
  const { nowMin, rule, lead, checkedIn, checkedOut } = input;
  if (lead <= 0 || !rule.works || rule.lateAfter == null || rule.earlyBefore == null) return [];
  const start = rule.lateAfter;
  const end = rule.earlyBefore;
  const out: ReminderKind[] = [];
  if (!checkedIn) {
    if (nowMin >= start - lead && nowMin < start + GRACE.in_soon) out.push('in_soon');
    else if (nowMin >= start && nowMin < start + GRACE.in_now) out.push('in_now');
  } else if (!checkedOut) {
    if (nowMin >= end - lead && nowMin < end + GRACE.out_soon) out.push('out_soon');
    else if (nowMin >= end + OUT_LATE_AFTER && nowMin < end + OUT_LATE_AFTER + GRACE.out_late) out.push('out_late');
  }
  return out;
}

type Lang = 'en' | 'rw' | 'fr';
const TEXT: Record<Lang, Record<ReminderKind, [string, string]>> = {
  en: {
    in_soon: ['Check in soon', 'Your day starts at {start}. Check in when you reach school.'],
    in_now: ['You have not checked in', 'It is {start}. Check in now if you are at school.'],
    out_soon: ['Remember to check out', 'Your day ends at {end}. Check out when you leave.'],
    out_late: ['You have not checked out', 'Your day ended at {end}. Check out before you leave school.'],
  },
  rw: {
    in_soon: ['Iyandikishe vuba', 'Umunsi wawe utangira {start}. Iyandikishe ugeze ku ishuri.'],
    in_now: ['Ntabwo uriyandikisha', 'Ni {start}. Iyandikishe ubu niba uri ku ishuri.'],
    out_soon: ['Wibuke kwandika ko utashye', 'Umunsi wawe urangira {end}. Andika ko utashye ugiye.'],
    out_late: ['Ntabwo wanditse ko utashye', 'Umunsi wawe warangiye {end}. Andika ko utashye mbere yo kuva ku ishuri.'],
  },
  fr: {
    in_soon: ['Pointez bientôt', 'Votre journée commence à {start}. Pointez en arrivant à l’école.'],
    in_now: ['Vous n’avez pas pointé', 'Il est {start}. Pointez maintenant si vous êtes à l’école.'],
    out_soon: ['Pensez à pointer la sortie', 'Votre journée finit à {end}. Pointez en partant.'],
    out_late: ['Sortie non pointée', 'Votre journée a fini à {end}. Pointez la sortie avant de quitter l’école.'],
  },
};

export function reminderText(kind: ReminderKind, lang: string, rule: { start: string | null; end: string | null }): { title: string; body: string } {
  const [title, body] = (TEXT[(['en', 'rw', 'fr'].includes(lang) ? lang : 'en') as Lang])[kind];
  return { title, body: body.replace('{start}', rule.start ?? '').replace('{end}', rule.end ?? '') };
}

// ---------------------------------------------------------------------------
// Web Push keys + sending
// ---------------------------------------------------------------------------

interface VapidKeys { publicKey: string; privateKey: string }
let vapidCache: VapidKeys | null = null;

/**
 * The server's Web Push keys: VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY when set, else a
 * pair made once and kept beside the database (outside the git tree, so a deploy
 * never replaces it; replacing it would silently end every phone's reminders).
 */
export function vapidKeys(): VapidKeys | null {
  if (vapidCache) return vapidCache;
  const pub = (process.env.VAPID_PUBLIC_KEY || '').trim();
  const priv = (process.env.VAPID_PRIVATE_KEY || '').trim();
  if (pub && priv) return (vapidCache = { publicKey: pub, privateKey: priv });
  if (process.env.NODE_ENV === 'test') return (vapidCache = webpush.generateVAPIDKeys());
  try {
    const dir = (process.env.TENDO_DATA_DIR || '').trim() || path.dirname(config.databasePath);
    const file = path.join(dir, 'clock-vapid.json');
    if (fs.existsSync(file)) {
      const k = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (k?.publicKey && k?.privateKey) return (vapidCache = { publicKey: k.publicKey, privateKey: k.privateKey });
    }
    const made = webpush.generateVAPIDKeys();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(made), { mode: 0o600 });
    return (vapidCache = made);
  } catch (err) {
    console.error('[clock] reminders are off: could not read or make the push keys:', (err as Error).message);
    return null;
  }
}

export interface PushSub { endpoint: string; p256dh: string; auth: string }
export interface PushPayload { title: string; body: string; url: string; tag: string }
/** Resolves 'ok', or 'gone' when the phone dropped the subscription. Throws on other failures. */
export type PushSender = (sub: PushSub, payload: PushPayload) => Promise<'ok' | 'gone'>;

const realSender: PushSender = async (sub, payload) => {
  const keys = vapidKeys();
  if (!keys) throw new Error('no push keys');
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(payload),
      { TTL: 30 * 60, urgency: 'high', vapidDetails: { subject: `${config.appPublicUrl.startsWith('https') ? config.appPublicUrl : 'https://tendo.amashuri.com'}`, publicKey: keys.publicKey, privateKey: keys.privateKey } }
    );
    return 'ok';
  } catch (err: any) {
    if (err?.statusCode === 404 || err?.statusCode === 410) return 'gone';
    throw err;
  }
};
let sender: PushSender = realSender;
/** Test hook: capture pushes instead of sending them (null restores). */
export function __setPushSender(fn: PushSender | null): void {
  sender = fn ?? realSender;
}

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

const PUSH_HOSTS = /(^|\.)(googleapis\.com|push\.apple\.com|mozilla\.com|mozaws\.net|windows\.com|microsoft\.com)$/i;

/** A browser push subscription from untrusted input (only the known push services, https). */
export function parseSubscription(raw: any): PushSub | null {
  const endpoint = String(raw?.endpoint ?? '');
  const p256dh = String(raw?.keys?.p256dh ?? '');
  const auth = String(raw?.keys?.auth ?? '');
  if (endpoint.length > 1000 || p256dh.length < 20 || p256dh.length > 200 || auth.length < 8 || auth.length > 100) return null;
  try {
    const u = new URL(endpoint);
    if (u.protocol !== 'https:' || !PUSH_HOSTS.test(u.hostname)) return null;
  } catch {
    return null;
  }
  return { endpoint, p256dh, auth };
}

export async function saveSubscription(db: Database, device: DeviceRow, sub: PushSub, lang: string): Promise<void> {
  const nowIso = new Date(clockNow()).toISOString();
  // One subscription per device: a browser that re-subscribes replaces its old one.
  await db.run(`DELETE FROM staff_clock_push WHERE device_id = ? OR endpoint = ?`, device.id, sub.endpoint);
  await db.run(
    `INSERT INTO staff_clock_push (user_id, device_id, endpoint, p256dh, auth, lang, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    device.user_id, device.id, sub.endpoint, sub.p256dh, sub.auth, ['en', 'rw', 'fr'].includes(lang) ? lang : 'en', nowIso
  );
}

export async function removeSubscription(db: Database, deviceId: number): Promise<void> {
  await db.run(`DELETE FROM staff_clock_push WHERE device_id = ?`, deviceId);
}

export async function hasSubscription(db: Database, deviceId: number): Promise<boolean> {
  return !!(await db.get(`SELECT 1 FROM staff_clock_push WHERE device_id = ?`, deviceId));
}

/** Send one notification to a device now (the "Send a test" button). */
export async function sendTest(db: Database, device: DeviceRow, slug: string): Promise<boolean> {
  const s = await db.get<any>(`SELECT * FROM staff_clock_push WHERE device_id = ?`, device.id);
  if (!s) return false;
  const text: Record<string, [string, string]> = {
    en: ['Reminders are on', 'This is how your check-in and check-out reminders arrive.'],
    rw: ['Kwibutswa birakora', 'Uku ni ko uzajya wibutswa kwiyandikisha no gutaha.'],
    fr: ['Rappels activés', 'Vos rappels de pointage arriveront ainsi.'],
  };
  const [title, body] = text[s.lang] ?? text.en;
  const r = await sender({ endpoint: s.endpoint, p256dh: s.p256dh, auth: s.auth }, { title, body, url: `/c/${slug}`, tag: 'clock-test' });
  if (r === 'gone') await db.run(`DELETE FROM staff_clock_push WHERE id = ?`, s.id);
  return r === 'ok';
}

// ---------------------------------------------------------------------------
// The minute tick (one school, inside its tenant context)
// ---------------------------------------------------------------------------

export const remindLead = (): number => Math.max(0, Math.min(120, numberSetting('STAFF_CLOCK_REMIND_MINUTES') || 0));

export async function runReminders(db: Database, slug: string): Promise<number> {
  const lead = remindLead();
  if (lead <= 0 || !(await clockReady(db))) return 0;
  const subs = await db.all<any[]>(
    `SELECT p.* FROM staff_clock_push p JOIN attendance_devices d ON d.id = p.device_id AND d.status = 'active'`
  );
  if (!subs.length) return 0;
  const now = new Date(clockNow());
  const today = schoolDateString(now);
  if (await isHoliday(db, today)) return 0;
  const nowMin = schoolMinutesOfDay(now);
  const book = await loadPlanBook(db);
  const rows = new Map((await db.all<any[]>(`SELECT staff_id, clock_in, clock_out FROM staff_attendance WHERE date = ?`, today)).map((r) => [String(r.staff_id), r]));
  let sent = 0;
  for (const s of subs) {
    const userId = String(s.user_id);
    const rule = book.dayFor(userId, today);
    const row = rows.get(userId);
    for (const kind of dueReminders({ nowMin, rule, lead, checkedIn: !!row?.clock_in, checkedOut: !!row?.clock_out })) {
      // Claim it first: one reminder of a kind per person and day, even with two ticks at once.
      const claim = await db.run(`INSERT OR IGNORE INTO staff_clock_reminders (user_id, date, kind, sent_at) VALUES (?, ?, ?, ?)`, userId, today, kind, now.toISOString());
      if (!claim.changes) continue;
      try {
        const text = reminderText(kind, s.lang, rule);
        const r = await sender({ endpoint: s.endpoint, p256dh: s.p256dh, auth: s.auth }, { ...text, url: `/c/${slug}`, tag: kind.startsWith('in') ? 'clock-in' : 'clock-out' });
        if (r === 'gone') await db.run(`DELETE FROM staff_clock_push WHERE id = ?`, s.id);
        else {
          sent += 1;
          await db.run(`UPDATE staff_clock_push SET last_ok_at = ? WHERE id = ?`, now.toISOString(), s.id);
        }
      } catch (err) {
        console.error('[clock] reminder not sent:', (err as Error).message);
      }
    }
  }
  // Keep the sent log short.
  if (nowMin % 60 === 0) await db.run(`DELETE FROM staff_clock_reminders WHERE date < date(?, '-14 day')`, today);
  return sent;
}
