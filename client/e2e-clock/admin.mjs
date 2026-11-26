// Real-browser check of the staff clock admin pages (Tendo -> Staff Clock) against a
// mocked API: dashboard, school zone (Leaflet), phones & cards (QR print sheet),
// card scanner, poster -- desktop and phone, light and dark, with screenshots.
//
//   cd client && npm run build && npm i --no-save playwright
//   node e2e-clock/admin.mjs           # OUT=<dir>, CHROME=<path>

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const OUT = process.env.OUT || path.resolve('e2e-clock/out');
const PORT = Number(process.env.PORT || 4792);
const BASE = `http://localhost:${PORT}`;
mkdirSync(OUT, { recursive: true });

const PERMS = ['STAFF_ATTENDANCE_CLOCK', 'STAFF_ATTENDANCE_VIEW_OWN', 'STAFF_ATTENDANCE_VIEW_ALL', 'STAFF_ATTENDANCE_ZONES_MANAGE', 'STAFF_DEVICES_MANAGE', 'STAFF_CLOCK_SCAN', 'REPORTS_VIEW', 'USERS_VIEW'];
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const TOKEN = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ id: '900', name: 'Admin Office', role: 'admin', tid: 1, tslug: 'nga', exp: 4102444800 })}.sig`;

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exitCode = 1;
  throw new Error(msg);
}
async function expectText(page, text, label) {
  try {
    await page.getByText(text, { exact: false }).filter({ visible: true }).first().waitFor({ timeout: 8000 });
  } catch {
    await page.screenshot({ path: path.join(OUT, `FAILED-admin-${label.replace(/\W+/g, '-')}.png`) }).catch(() => {});
    fail(`${label}: "${text}" not visible`);
  }
}

const people = [
  ['101', 'Grace Mukamana', 'Teacher', '07:42', 'present', null, 40, 'Tecno Spark 10 · Chrome'],
  ['102', 'Jean Bosco Niyonzima', 'Teacher', '07:51', 'present', null, 12, 'Infinix Hot 30 · Chrome', true],
  ['103', 'Claudine Uwase', 'Teacher', '08:02', 'present', null, 65, 'iPhone 11 · Safari', true],
  ['104', 'Marie-Claire Nyirabagenzi Uwimana Mukeshimana', 'Teacher', '07:15', 'present', null, 22, 'Samsung A14 · Chrome'],
  ['105', 'Emmanuel Nkurunziza', 'Teacher', '08:44', 'late', null, 58, 'Tecno Camon 20 · Chrome'],
  ['106', 'Diane Umutoni', 'Teacher', '08:51', 'late', null, 31, 'iPhone 12 · Safari'],
  ['107', 'Olivier Mugisha', 'Teacher', null, 'not_in', null, null, null],
  ['108', 'Solange Iradukunda', 'Staff', '07:05', 'present', null, 18, null, false, 'card'],
  ['109', 'Fabrice Ndayisaba', 'Teacher', '07:28', 'present', null, 47, 'Tecno Spark 20 · Chrome'],
  ['110', 'Patrick Habimana', 'Teacher', null, 'not_in', null, null, null],
];
const OVERVIEW = {
  date: '2026-11-24', isToday: true, serverNow: '2026-11-24T08:15:00.000Z', rosterSource: 'mis',
  rules: { lateAfter: '08:30', earlyLeaveBefore: '16:00', opens: '05:00', enabled: true },
  ownPlans: 2,
  now: { at: '10:15', expectedToday: 9, shouldBeHere: 9, here: 8, notHere: 1, startsLater: 0, left: 0, leftEarly: 0, missed: 0, dayOff: 1, late: 2 },
  kpis: { staff: 9, checkedIn: 8, onTime: 6, late: 2, notIn: 1, dayOff: 1, checkedOut: 0, earlyLeave: 0, needsReview: 2, medianLateMinutes: 14 },
  arrivals: [['06:30', 0, 0], ['06:45', 0, 0], ['07:00', 1, 0], ['07:15', 2, 0], ['07:30', 1, 0], ['07:45', 2, 0], ['08:00', 1, 0], ['08:15', 0, 0], ['08:30', 0, 0], ['08:45', 0, 2], ['09:00', 0, 0], ['09:15', 0, 0]]
    .map(([from, onTime, late]) => ({ from, to: from, onTime, late })),
  rows: people.map(([userId, name, role, checkIn, status, checkOut, distance, device, review, source]) => ({
    recordId: checkIn ? Number(userId) : null, userId, name, role, checkIn, checkOut, status: userId === '110' ? 'day_off' : status, expected: userId !== '110',
    plan: userId === '110' ? { own: true, works: false, start: null, end: null } : userId === '109' ? { own: true, works: true, start: '07:00', end: '13:00' } : { own: false, works: true, start: '08:30', end: '16:00' },
    moment: userId === '110' ? 'day_off' : userId === '107' ? 'due_now' : 'here', reminders: userId === '107',
    outStatus: null, distance, source: source ?? (checkIn ? 'device' : null), device, flags: [], needsReview: !!review, reviewState: null,
  })),
  review: [
    { recordId: 102, userId: '102', name: 'Jean Bosco Niyonzima', at: '07:51', flags: ['twin_punch'], flagText: ['Same spot and time as another check-in'], distance: 12, accuracy: 9 },
    { recordId: 103, userId: '103', name: 'Claudine Uwase', at: '08:02', flags: ['no_jitter'], flagText: ['Location did not move between readings'], distance: 65, accuracy: 5 },
  ],
  phones: {
    registered: 7, staff: 10,
    pending: [{ id: 31, user_id: '110', user_name: 'Patrick Habimana', google_email: 'patrick@gmail.com', form_factor: 'phone', label: 'Samsung A15 · Chrome', status: 'pending', registered_at: '2026-11-24T05:40:00Z', approved_at: null, last_used_at: null, revoked_at: null, revoke_reason: null }],
    unregistered: [{ id: '107', name: 'Olivier Mugisha' }, { id: '108', name: 'Solange Iradukunda' }, { id: '110', name: 'Patrick Habimana' }],
  },
  missing: {
    checkoutOpen: true,
    noCheckoutToday: [{ userId: '102', name: 'Jean Bosco Niyonzima', date: '2026-11-24', checkIn: '07:51', autoClosed: false }],
    recentNoCheckout: [
      { userId: '104', name: 'Eric Habyarimana', date: '2026-11-21', checkIn: '07:30', autoClosed: true },
      { userId: '105', name: 'Diane Mukeshimana', date: '2026-11-20', checkIn: '07:12', autoClosed: true },
    ],
  },
  health: { google: true, zones: 1, enabled: true, tested: false, shared: false, unregistered: 3, staff: 10 },
};
/** The term so far, as the report endpoint answers it: numbers per calendar day, no names. */
function report() {
  const today = '2026-11-24', from = '2026-09-07', staff = 10;
  const days = [];
  for (let d = new Date('2026-09-01T12:00:00Z'); d <= new Date('2026-11-30T12:00:00Z'); d.setUTCDate(d.getUTCDate() + 1)) {
    const date = d.toISOString().slice(0, 10);
    const wd = d.getUTCDay();
    const n = Math.round((d - new Date('2026-09-01T12:00:00Z')) / 86400000);
    const kind = date > today ? 'future' : wd === 0 || wd === 6 ? 'off' : date < from ? 'untracked' : 'school';
    const absent = kind !== 'school' ? 0 : date === today ? 2 : date === '2026-10-07' ? 4 : n % 7 === 0 ? 2 : n % 3 === 0 ? 1 : 0;
    const late = kind !== 'school' ? 0 : date === today ? 2 : n % 4 === 1 ? 2 : n % 5 === 0 ? 1 : 0;
    days.push({ date, kind, onTime: kind === 'school' ? staff - absent - late : 0, late, absent, staff: kind === 'school' ? staff : 0, today: date === today });
  }
  const school = days.filter((d) => d.kind === 'school' && d.date >= from);
  const sum = (list) => { const t = { schoolDays: list.length, onTime: 0, late: 0, absent: 0, staffDays: 0 }; for (const d of list) { t.onTime += d.onTime; t.late += d.late; t.absent += d.absent; t.staffDays += d.staff; } return { ...t, rate: t.staffDays ? Math.round(((t.onTime + t.late) / t.staffDays) * 1000) / 10 : null }; };
  const monday = (date) => { const d = new Date(`${date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); };
  const weeks = [...new Set(school.map((d) => monday(d.date)))].map((start, i) => { const t = sum(school.filter((d) => monday(d.date) === start)); return { start, rate: t.rate, late: t.late, prevRate: 84 + (i % 4) * 1.5 }; });
  return {
    today, from, to: today, trackingFrom: from, staff, countedDays: school.length - 1, lateAfter: '08:30', term: { name: 'Term 1', start: from, end: '2026-12-18' }, rosterSource: 'mis', days,
    totals: { ...sum(school), prevRate: 86.2 }, weeks,
    weekdays: [1, 2, 3, 4, 5].map((dow) => ({ dow, rate: sum(school.filter((d) => new Date(`${d.date}T12:00:00Z`).getUTCDay() === dow)).rate })),
    arrivals: [['06:30', 4, 0], ['06:45', 18, 0], ['07:00', 61, 0], ['07:15', 120, 0], ['07:30', 142, 0], ['07:45', 96, 0], ['08:00', 51, 0], ['08:15', 22, 0], ['08:30', 3, 14], ['08:45', 0, 31], ['09:00', 0, 12], ['09:15', 0, 4]].map(([f, onTime, late]) => ({ from: f, to: f, onTime, late })),
    groups: [
      { key: 'conversation', label: 'Need a conversation', rule: 'Absent 6 days or more, or late 11 days or more', count: 2 },
      { key: 'often_late', label: 'Often late', rule: 'Late on 9 days or more', count: 3 },
      { key: 'rarely_absent', label: 'Rarely absent', rule: 'Absent 2 days or fewer', count: 4 },
      { key: 'on_time', label: 'On time 90% of days', rule: 'On time at least nine days in ten they came', count: 5 },
    ],
  };
}
const REPORT = report();
const reportStaff = (group) => ({ from: REPORT.from, to: REPORT.to, schoolDays: REPORT.countedDays, people: people.slice(group ? 4 : 2, group ? 7 : 9).map(([userId, name], i) => ({ userId, name, schoolDays: 55, attended: 55 - i, late: 3 + i, absent: i, rate: 100 - i * 2, punctuality: 90 - i })) });
/** Working weeks: the school's, and the own plans saved during the run (PUT .../plan). */
const SCHOOL_WEEK = Object.fromEntries(['0', '1', '2', '3', '4', '5', '6'].map((d) => [d, { works: d !== '0' && d !== '6', start: '08:30', end: '16:00' }]));
const PLANS = new Map();
/** people whose forgotten check-out the office has saved during the run */
const FIXED = new Set();
/** people whose device the office signed out during the run */
const SIGNED_OUT = new Set();
const planOf = (id) => {
  const own = PLANS.get(id);
  return { own: !!own, days: own?.days ?? SCHOOL_WEEK, school: SCHOOL_WEEK, effectiveFrom: own ? '2026-11-24' : null, note: own?.note ?? null, updatedByName: own ? 'Admin Office' : null, updatedAt: own ? '2026-11-24T08:16:00Z' : null, upcoming: null, versions: [] };
};
/** A year of days for one person: mostly on time, some late, a few absences, weekends off. */
function history(id) {
  const days = [];
  const end = new Date('2026-11-24T12:00:00Z');
  const sum = { schoolDays: 0, attended: 0, onTime: 0, late: 0, absent: 0, noOut: 0, early: 0 };
  for (let i = 364; i >= 0; i--) {
    const d = new Date(end); d.setUTCDate(end.getUTCDate() - i);
    const date = d.toISOString().slice(0, 10);
    const wd = d.getUTCDay();
    const seed = (i * 7 + Number(id)) % 23;
    let kind = wd === 0 || wd === 6 ? 'off' : i > 300 ? 'untracked' : i === 0 ? 'today' : seed === 3 ? 'absent' : seed % 6 === 1 ? 'late' : 'on_time';
    const att = kind === 'on_time' || kind === 'late';
    const din = att ? (kind === 'late' ? '08:4' + (seed % 10) : '07:' + String(10 + seed).padStart(2, '0')) : null;
    const noOut = att && seed === 11;
    const early = att && seed === 13;
    // The day before today: this person forgot to check out and said when they left.
    const forgot = i === 1 && id === '109' && !FIXED.has(id);
    const fixed = i === 1 && id === '109' && FIXED.has(id);
    if (forgot || fixed) kind = 'on_time';
    const att2 = kind === 'on_time' || kind === 'late';
    days.push({ date, kind, in: att2 ? din ?? '07:20' : null, out: fixed ? '16:20' : att && !noOut && !forgot ? (early ? '14:10' : '16:3' + (seed % 10)) : null, early, noOut: forgot || (noOut && !fixed), minutes: att && !noOut && !forgot ? 520 : null, card: false,
      recordId: forgot ? 9109 : null, claim: forgot ? '16:20' : null, manualOut: fixed });
    if (kind !== 'off' && kind !== 'untracked' && kind !== 'today') sum.schoolDays++;
    if (att) { sum.attended++; kind === 'late' ? sum.late++ : sum.onTime++; }
    if (kind === 'absent') sum.absent++;
    if (noOut) sum.noOut++;
    if (early) sum.early++;
  }
  return { person: { id, name: people.find((p) => p[0] === id)?.[1] ?? 'Staff', role: 'Teacher' }, from: days[0].date, to: '2026-11-24', today: '2026-11-24', trackingFrom: days[64].date,
    rules: { lateAfter: '08:30', earlyLeaveBefore: '16:00' }, plan: planOf(id), days,
    device: SIGNED_OUT.has(id) ? null : { id: 700 + Number(id), label: 'Tecno Spark 20 · Chrome', form_factor: 'phone', google_email: 'staff.member@gmail.com', status: 'active', registered_at: '2026-11-03T06:00:00Z', last_used_at: '2026-11-24T05:28:00Z', reminders: 1 },
    card: false,
    summary: { ...sum, rate: Math.round((sum.attended / sum.schoolDays) * 100), punctuality: Math.round((sum.onTime / sum.attended) * 100), avgIn: '07:24', streak: 6, bestStreak: 19 } };
}
const DEVICES = [
  OVERVIEW.phones.pending[0],
  ...people.filter((p) => p[7]).map(([id, name, , , , , , label], i) => ({ id: i + 1, user_id: id, user_name: name, google_email: `${name.split(' ')[0].toLowerCase()}@gmail.com`, form_factor: i === 2 ? 'tablet' : 'phone', label, status: 'active', registered_at: '2026-11-03T06:00:00Z', approved_at: null, last_used_at: '2026-11-24T05:42:00Z', revoked_at: null, revoke_reason: null })),
  { id: 40, user_id: '110', user_name: 'Patrick Habimana', google_email: 'patrick@gmail.com', form_factor: 'phone', label: 'Tecno Pop 7 · Chrome', status: 'replaced', registered_at: '2026-11-03T06:00:00Z', approved_at: null, last_used_at: '2026-11-13T06:00:00Z', revoked_at: '2026-11-24T05:40:00Z', revoke_reason: 'replaced_by_owner' },
];
const CONFIG = {
  rules: { enabled: true, requireZone: true, maxAccuracy: 100, allowance: 50, opens: '05:00', lateAfter: '08:30', earlyLeaveBefore: '16:00', minShiftMinutes: 60, autoCloseAt: '23:59', selfReplaceDays: 30, googleDomains: '', schoolNetworks: '', nonSchoolDays: 'allow_flag', allowUnassignedStaff: true },
  zones: [
    { id: 1, name: 'Main campus', kind: 'circle', center_lat: -1.95362, center_lng: 30.10441, radius_m: 150, active: 1 },
    { id: 2, name: 'Sports ground and parking area near the market road', kind: 'circle', center_lat: -1.95391, center_lng: 30.10662, radius_m: 70, active: 1 },
  ],
  link: { slug: 'nga', url: 'https://tendo.amashuri.com/c/nga', display: 'tendo.amashuri.com/c/nga' },
  school: { name: 'New Generation Academy', slug: 'nga', timezone: 'Africa/Kigali' },
  googleConfigured: true,
};

async function context(browser, { width, height, theme, mobile = false }) {
  const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: theme, deviceScaleFactor: 2, isMobile: mobile, hasTouch: mobile, geolocation: { latitude: -1.95326, longitude: 30.10441, accuracy: 15 }, permissions: ['geolocation', 'camera'] });
  await ctx.addInitScript(([token, perms, theme]) => {
    localStorage.setItem('sso_token', token);
    localStorage.setItem('sso_user', JSON.stringify({ id: '900', name: 'Admin Office', email: 'admin@school.rw', role: 'admin', tid: 1, tenantSlug: 'nga' }));
    localStorage.setItem('sso_permissions', '[]');
    localStorage.setItem('sso_role_permissions', JSON.stringify(perms));
    localStorage.setItem('theme', theme);
  }, [TOKEN, PERMS, theme]);
  await ctx.route('https://nominatim.openstreetmap.org/**', (r) => {
    const q = new URL(r.request().url()).searchParams;
    globalThis.__lastSearch = Object.fromEntries(q.entries());
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([
      { lat: '-1.9500', lon: '30.0600', name: 'New Generation Academy', display_name: 'New Generation Academy, KN 5 Rd, Kigali, Rwanda' },
      { lat: '-2.6000', lon: '29.7400', name: 'New Generation School', display_name: 'New Generation School, Huye, Southern Province, Rwanda' },
    ]) });
  });
  await ctx.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  const pairReadings = [];
  await ctx.route('**/api/**', (route) => {
    const u = new URL(route.request().url());
    const p = u.pathname;
    const ok = (data) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data }) });
    if (p === '/api/sso/verify-mis') return route.fulfill({ status: 200, contentType: 'application/json', body: '{"success":true}' });
    if (p === '/api/roles-permissions/me') return ok({ permissionKeys: PERMS });
    if (p === '/api/staff/clock/overview') { const d = u.searchParams.get('date'); return ok(d && d !== OVERVIEW.date ? { ...OVERVIEW, date: d, isToday: false } : OVERVIEW); }
    { const m = p.match(/^\/api\/staff\/clock\/people\/([^/]+)\/plan$/);
      if (m && route.request().method() === 'PUT') {
        const body = route.request().postDataJSON();
        if (body.days) PLANS.set(m[1], body); else PLANS.delete(m[1]);
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, message: body.days ? 'Own hours saved, from today' : "Back to the school's hours, from today", data: { plan: planOf(m[1]), rejudged: 0 } }) });
      } }
    if (p === '/api/staff/clock/attendance/9109/checkout') {
      FIXED.add('109');
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, message: `Check-out saved: ${route.request().postDataJSON().time}`, data: { outStatus: 'on_time' } }) });
    }
    if (p === '/api/staff/clock/nudge') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, message: 'Reminder sent to 1 person', data: { sent: 1, noReminders: 0, already: 0, notNeeded: 0 } }) });
    if (p === '/api/staff/clock/report') return ok(REPORT);
    if (p === '/api/staff/clock/document-brand') { globalThis.__docBrandCalls = (globalThis.__docBrandCalls || 0) + 1; return ok({ name: 'New Generation Academy', logo: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR4nGNkYPhfzwAEjAwM/xkYGAAZBgP+oSDdTQAAAABJRU5ErkJggg==' }); }
    if (p === '/api/staff/clock/report/staff') return ok(reportStaff(u.searchParams.get('group')));
    { const m = p.match(/^\/api\/staff\/clock\/people\/([^/]+)\/history$/); if (m) return ok(history(m[1])); }
    if (p === '/api/staff/clock/config') return ok(CONFIG);
    if (p === '/api/staff/clock/devices') return ok(DEVICES);
    if (p === '/api/staff/clock/cards') return ok([{ id: 1, user_id: '108', user_name: 'Solange Iradukunda', issued_at: '2026-11-20T08:00:00Z', last_used_at: '2026-11-24T05:05:00Z' }]);
    if (p === '/api/staff/clock/cards' || (p.endsWith('/cards') && route.request().method() === 'POST')) return ok({ school: 'New Generation Academy', cards: [] });
    if (p === '/api/staff/clock/scan') return ok({ action: 'check_in', at: '07:10', status: 'present', distance: 30, person: { name: 'Solange Iradukunda', firstName: 'Solange', initials: 'SI' }, checkIn: '07:10', checkOut: null });
    { const m = p.match(/^\/api\/staff\/clock\/devices\/(\d+)\/revoke$/); if (m && Number(m[1]) > 700) { SIGNED_OUT.add(String(Number(m[1]) - 700)); return ok({}); } }
    if (p.startsWith('/api/staff/clock/devices/')) return ok({});
    // Phone-GPS pairing: the computer makes a code, the phone posts a reading to it.
    if (p === '/api/staff/clock/pair' && route.request().method() === 'POST') return ok({ code: 'TESTPAIRCODE1234', url: `${BASE}/c/nga/pair/TESTPAIRCODE1234`, expiresIn: 600 });
    if (p === '/api/staff/clock/pair/TESTPAIRCODE1234') return ok({ readings: pairReadings, expiresIn: 590 });
    if (p === '/api/clock/nga/pair/TESTPAIRCODE1234') {
      if (route.request().method() === 'POST') {
        const pos = route.request().postDataJSON().position;
        pairReadings.push({ lat: pos.lat, lng: pos.lng, accuracy: pos.accuracy, at: Date.now() });
        return ok({ received: true });
      }
      return ok({ school: { name: 'New Generation Academy' } });
    }
    return ok([]);
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => fail(`page error: ${e.message}`));
  return { ctx, page };
}

async function dismissInstall(page) {
  const notNow = page.getByRole('button', { name: /Not now/i });
  try {
    await notNow.waitFor({ state: 'visible', timeout: 2500 });
    await notNow.click();
  } catch { /* no prompt */ }
}

async function run(browser, vp) {
  const tag = `admin-${vp.name}-${vp.theme}`;
  const { ctx, page } = await context(browser, vp);
  const shot = async (n) => {
    // The app's own install prompt covers the page: dismiss it like a person would.
    const notNow = page.getByRole('button', { name: /Not now/i });
    if (await notNow.isVisible().catch(() => false)) await notNow.click();
    await page.screenshot({ path: path.join(OUT, `${tag}-${n}.png`), fullPage: true });
  };

  await page.goto(`${BASE}/staff/clock`);
  await dismissInstall(page);
  await expectText(page, 'Staff attendance', `${tag} dashboard`);
  await expectText(page, 'When staff arrive', `${tag} arrivals`);
  await expectText(page, 'New phone waiting', `${tag} pending phone`);
  // Check-in is on: the setup checklist stays on its own tab, not the dashboard; the staff list moved to Staff.
  await page.waitForTimeout(300);
  if (await page.getByText('Set up staff check-in').count()) fail(`${tag}: setup card still on the dashboard with check-in on`);
  if (await page.locator('#sc-staff-list').count()) fail(`${tag}: staff list still on the dashboard`);
  if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)) fail(`${tag}: dashboard scrolls sideways`);
  // Right now: who should be here, who is; a number opens its list; "not here" can be reminded.
  const board = page.getByTestId('now-board');
  await board.waitFor();
  await expectText(page, '8 of 9', `${tag} here of who should be here`);
  await expectText(page, 'not here yet', `${tag} not here tile`);
  await shot('00-right-now');
  await board.locator('[data-now="notHere"]').click();
  await expectText(page, 'Should be here at 10:15', `${tag} not-here list`);
  if ((await page.locator('.sc-sheet .sc-item').count()) !== 1) fail(`${tag}: the not-here list should hold one person`);
  await page.getByTestId('sheet-action').click();
  await expectText(page, 'Reminder sent to 1 person', `${tag} nudge toast`);
  await shot('00b-not-here-sheet');
  for (const b of await page.locator('.toast-close').all()) await b.click().catch(() => {});
  await page.keyboard.press('Escape');
  await board.locator('[data-now="dayOff"]').click();
  await expectText(page, 'Day off today', `${tag} day-off list`);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  if (await page.locator('.sc-sheet').count()) fail(`${tag}: the list did not close`);
  // First look is today: 8 of 10 in. The page shows numbers; names open in a window on request.
  if ((await page.getByTestId('scr-headline').innerText()).trim() !== '80%') fail(`${tag}: headline is not today's rate`);
  await expectText(page, '8 of 10 staff checked in', `${tag} today headline`);
  await expectText(page, 'The term on the calendar', `${tag} term calendar`);
  await expectText(page, 'Need a conversation', `${tag} staff groups`);
  for (const name of ['Olivier Mugisha', 'Emmanuel Nkurunziza', 'Grace Mukamana']) {
    if (await page.getByText(name).count()) fail(`${tag}: "${name}" is listed on the dashboard`);
  }
  await shot('01-dashboard');
  // Attention strip: only what needs fixing, each a tap to the fix.
  // One short line each; the phone waiting for approval is the warning, and comes first.
  if ((await page.locator('.sc-attn-item').first().getAttribute('data-attn')) !== 'pending') fail(`${tag}: the waiting phone is not the first reminder`);
  await expectText(page, 'phone waiting', `${tag} waiting phone reminder`);
  if (!(await page.locator('[data-attn="pending"] .sc-attn-pulse').count())) fail(`${tag}: the waiting phone does not pulse`);
  for (const it of await page.locator('.sc-attn-item').all()) {
    const box = await it.boundingBox();
    if (box && box.height > 48) fail(`${tag}: a reminder wraps onto two lines`);
  }
  await page.locator('[data-attn="tested"]').waitFor();
  await page.locator('[data-attn="phones"]').waitFor();
  await page.locator('[data-attn="review"]').waitFor();
  // "See all staff" opens the day's staff in a window: every status, filters, search, downloads.
  await page.getByTestId('see-day-staff').click();
  const rep = page.getByTestId('day-report');
  await rep.waitFor();
  if ((await rep.locator('tbody tr').count()) !== 10) fail(`${tag}: the day window should list all 10 staff`);
  await rep.getByRole('tab', { name: /Late/ }).click();
  if ((await rep.locator('tbody tr').count()) !== 2) fail(`${tag}: the Late filter should show 2 staff`);
  await rep.getByText('08:44').locator('visible=true').first().waitFor().catch(async () => { await rep.getByText(/In 08:44/).locator('visible=true').first().waitFor(); });
  await rep.getByRole('tab', { name: /Not in yet/ }).click();
  await rep.getByText('Olivier Mugisha').locator('visible=true').first().waitFor();
  await rep.getByRole('tab', { name: /Everyone/ }).click();
  await rep.getByPlaceholder('Search staff').fill('emman');
  if ((await rep.locator('tbody tr').count()) !== 1) fail(`${tag}: search should narrow the day window to 1`);
  await rep.getByPlaceholder('Search staff').fill('');
  await shot('01a-day-window');
  // Downloads: a real PDF and a real Excel file, named after the day.
  {
    const fs = await import('node:fs');
    const [pdf] = await Promise.all([page.waitForEvent('download'), rep.getByTestId('day-pdf').click()]);
    if (!/^staff-attendance-2026-11-24\.pdf$/.test(pdf.suggestedFilename())) fail(`${tag}: PDF name ${pdf.suggestedFilename()}`);
    if (fs.readFileSync(await pdf.path()).subarray(0, 4).toString() !== '%PDF') fail(`${tag}: the PDF download is not a PDF`);
    // Chrome holds a second automatic download from the same tab for a permission prompt:
    // the Excel file is checked from a fresh tab.
    const p2 = await ctx.newPage();
    await p2.goto(`${BASE}/staff/clock`);
    await dismissInstall(p2);
    await p2.getByTestId('see-day-staff').click();
    const rep2 = p2.getByTestId('day-report');
    await rep2.waitFor();
    const [xl] = await Promise.all([p2.waitForEvent('download'), rep2.getByTestId('day-xlsx').click()]);
    if (!/\.xlsx$/.test(xl.suggestedFilename())) fail(`${tag}: Excel name ${xl.suggestedFilename()}`);
    if (fs.readFileSync(await xl.path()).subarray(0, 2).toString() !== 'PK') fail(`${tag}: the Excel download is not an .xlsx`);
    await p2.close();
    if (globalThis.__docBrandCalls < 1) fail(`${tag}: the documents logo was not asked for`);
  }
  // A row opens the history ON TOP of the window; arrows step through the rows.
  await rep.locator('tbody tr, .sc-list .sc-item').locator('visible=true').first().click();
  const hist = page.getByTestId('staff-history');
  await hist.waitFor();
  {
    const box = await hist.boundingBox();
    const onTop = await page.evaluate(([x, y]) => !!document.elementFromPoint(x, y)?.closest('[data-testid="staff-history"]'), [box.x + box.width / 2, box.y + 40]);
    if (!onTop) fail(`${tag}: the history opened behind the day window`);
  }
  await expectText(page, '1 / 10', `${tag} history position`);
  const firstName = (await hist.locator('.sh-who b').innerText()).trim();
  await page.keyboard.press('ArrowRight');
  await expectText(page, '2 / 10', `${tag} history next with arrow key`);
  if ((await hist.locator('.sh-who b').innerText()).trim() === firstName) fail(`${tag}: arrow key did not move to the next person`);
  await hist.getByRole('button', { name: /^Previous:/ }).click();
  await expectText(page, '1 / 10', `${tag} history previous button`);
  await page.keyboard.press('Escape');
  if (await page.getByTestId('staff-history').count()) fail(`${tag}: history did not close`);
  if (!(await page.getByTestId('day-report').count())) fail(`${tag}: Escape closed the day window with the history`);
  // The window steps to the previous school day.
  await rep.getByRole('button', { name: 'Previous school day' }).click();
  await rep.getByText('Monday, 23 November 2026').waitFor();
  await page.keyboard.press('Escape');
  if (await page.getByTestId('day-report').count()) fail(`${tag}: the day window did not close`);
  // A day on the calendar opens in the day panel; the date field and the arrows follow.
  await page.getByRole('button', { name: /^Wed,? 7 Oct · 60% in/ }).first().click();
  await expectText(page, '7 October 2026', `${tag} picked day`);
  await page.getByRole('button', { name: 'Next school day' }).click();
  await expectText(page, '8 October 2026', `${tag} next school day`);
  // Whole term: the average, and the staff of the period only when asked.
  await page.getByRole('group', { name: 'Period' }).getByRole('button', { name: 'Whole term' }).click();
  await expectText(page, 'average over 57 school days', `${tag} term headline`);
  await page.getByRole('button', { name: 'View late or absent staff' }).click();
  await page.locator('.sc-sheet').getByText('Claudine Uwase').first().waitFor();
  await page.keyboard.press('Escape');
  // A range of dates: From / to fields, days outside it dimmed.
  await page.getByRole('group', { name: 'Period' }).getByRole('button', { name: 'Date range' }).click();
  await page.locator('.sc-head-actions input.scr-date').nth(0).fill('2026-10-05');
  await page.locator('.sc-head-actions input.scr-date').nth(1).fill('2026-10-16');
  await expectText(page, 'average over 10 school days', `${tag} range headline`);
  if ((await page.locator('button.scr-day.is-out').count()) < 20) fail(`${tag}: days outside the range are not dimmed`);
  await shot('01b-range');
  // A group shows a count; "View staff" lists it.
  await page.locator('.scr-group').filter({ hasText: 'Often late' }).getByRole('button', { name: 'View staff' }).click();
  await page.locator('.sc-sheet').getByText('Emmanuel Nkurunziza').first().waitFor();
  await page.keyboard.press('Escape');
  // Custom date, then back to today.
  await page.getByRole('group', { name: 'Period' }).getByRole('button', { name: 'Custom date' }).click();
  await page.locator('.sc-head-actions input.scr-date').first().fill('2026-10-10');
  await expectText(page, 'No school day on that date', `${tag} weekend date`);
  await page.getByRole('group', { name: 'Period' }).getByRole('button', { name: 'Today' }).click();
  await expectText(page, '8 of 10 staff checked in', `${tag} back to today`);
  await page.locator('[data-kpi="noOut"]').click();
  await page.locator('.sc-sheet').getByText('In at 07:51').first().waitFor();
  await page.keyboard.press('Escape');
  await page.locator('[data-kpi="recent"]').click();
  await page.locator('.sc-sheet').getByText('Eric Habyarimana').first().waitFor();
  await expectText(page, 'Saturday 21 Nov', `${tag} missed grouped by day`);
  await shot('01c-missed-sheet');
  // A person in a list opens their history ON TOP of the list; Escape closes the history first.
  await page.getByRole('button', { name: /Eric Habyarimana/ }).first().click();
  await page.getByTestId('staff-history').waitFor();
  {
    const box = await page.getByTestId('staff-history').boundingBox();
    const onTop = await page.evaluate(([x, y]) => !!document.elementFromPoint(x, y)?.closest('[data-testid="staff-history"]'), [box.x + box.width / 2, box.y + 40]);
    if (!onTop) fail(`${tag}: the history opened behind the list`);
  }
  await expectText(page, '1 / 2', `${tag} history steps through the sheet list`);
  await page.keyboard.press('Escape');
  if (await page.getByTestId('staff-history').count()) fail(`${tag}: Escape did not close the history`);
  if (!(await page.locator('.sc-sheet').count())) fail(`${tag}: Escape closed the list together with the history`);
  await page.keyboard.press('Escape');
  // "Unusual check-ins" goes to the Staff tab's review list.
  await page.locator('[data-attn="review"]').click();
  await page.waitForURL(/\/staff\/clock\/people\?tab=review$/);
  await expectText(page, 'Same spot and time as another check-in', `${tag} review`);
  await shot('02-review');
  // Staff tab: everyone; a row opens the history modal (year grid + calendar).
  await page.getByRole('tab', { name: /Everyone/ }).click();
  await expectText(page, 'Fabrice Ndayisaba', `${tag} staff list`);
  await shot('02b-staff');
  FIXED.clear();
  SIGNED_OUT.clear();
  await page.getByText('Fabrice Ndayisaba').locator('visible=true').first().click();
  const modal = page.getByTestId('staff-history');
  await modal.waitFor();
  await expectText(page, 'Last 12 months', `${tag} year grid`);
  await expectText(page, 'day streak', `${tag} streak`);
  await expectText(page, 'November 2026', `${tag} month calendar`);
  if ((await modal.locator('.sh-year .sh-cell.k-on').count()) < 100) fail(`${tag}: year grid has too few on-time days`);
  await modal.locator('.sh-year .sh-cell.k-late').first().hover();
  await page.locator('.sh-tip').waitFor();
  await modal.locator('.sh-year .sh-cell.k-late').first().click();
  await expectText(page, 'after 08:30', `${tag} late day detail`);
  await page.waitForTimeout(400);
  if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)) fail(`${tag}: history modal scrolls sideways`);
  await shot('02c-history');
  await modal.getByRole('button', { name: 'Previous month' }).click();

  // Yesterday Fabrice forgot to check out and said 16:20: the office confirms it from the day.
  await modal.locator('.sh-year button[aria-label*="23 Nov 2026"]').click();
  await expectText(page, 'says they left at 16:20', `${tag} forgotten check-out claim`);
  await shot('02f-forgot-checkout');
  await page.getByTestId('fix-out').getByRole('button', { name: 'Confirm' }).click();
  await expectText(page, 'Check-out saved: 16:20', `${tag} check-out saved toast`);
  await expectText(page, 'check-out entered by the office', `${tag} manual check-out tag`);
  if (await page.getByTestId('fix-out').count()) fail(`${tag}: the check-out form is still shown after saving`);

  // Working hours: by default the school's; Wednesday off + a later Monday start makes it an own plan.
  await page.getByTestId('tab-hours').click();
  await expectText(page, "Follows the school's hours", `${tag} default hours`);
  if (!(await page.getByTestId('plan-save').isDisabled())) fail(`${tag}: Save hours is enabled with nothing changed`);
  await page.getByRole('switch', { name: /Wednesday/ }).click();
  await page.getByLabel('Monday starts').fill('10:00');
  await expectText(page, 'School: 08:30 – 16:00', `${tag} school hint on a changed day`);
  await page.getByLabel('Monday ends').fill('09:00');
  await expectText(page, 'End must be after start', `${tag} time validation`);
  if (!(await page.getByTestId('plan-save').isDisabled())) fail(`${tag}: Save hours is enabled with a wrong time`);
  await page.getByLabel('Monday ends').fill('14:00');
  await page.getByLabel('Note').fill('Part time');
  await page.waitForTimeout(200);
  if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)) fail(`${tag}: working hours scroll sideways`);
  await shot('02d-hours-edit');
  await page.getByTestId('plan-save').click();
  await expectText(page, 'Own hours saved', `${tag} hours saved toast`);
  await expectText(page, 'Own hours', `${tag} own hours state`);
  await expectText(page, '4 days a week', `${tag} own week summary`);
  await shot('02e-hours-own');
  await page.getByTestId('plan-reset').click();
  await page.getByTestId('plan-reset-yes').click();
  await expectText(page, "Back to the school's hours", `${tag} hours reset toast`);
  await expectText(page, "Follows the school's hours", `${tag} back to school hours`);

  // Device: the check-in page has no sign-out, so the office signs a person's phone out from here.
  await page.getByTestId('tab-device').click();
  await expectText(page, 'Tecno Spark 20 · Chrome', `${tag} device shown`);
  await expectText(page, 'Signed in', `${tag} device state`);
  await page.waitForTimeout(200);
  if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)) fail(`${tag}: device tab scrolls sideways`);
  await shot('02g-device');
  await page.getByTestId('device-signout').click();
  await page.getByTestId('device-signout-yes').click();
  await expectText(page, 'Device signed out', `${tag} sign-out toast`);
  await expectText(page, 'No phone or browser is signed in', `${tag} no device after sign-out`);
  for (const b of await page.locator('.toast-close').all()) await b.click().catch(() => {});
  await modal.getByRole('button', { name: 'Close' }).click();
  if (await page.getByTestId('staff-history').count()) fail(`${tag}: history did not close`);

  // No request storm: an idle zone page must not keep refetching (it once looped forever).
  {
    let calls = 0;
    const count = (r) => { if (/\/api\/staff\/clock\/(config|overview)/.test(r.url())) calls += 1; };
    await page.goto(`${BASE}/staff/clock/zone`);
    await expectText(page, 'School areas', `${tag} zone loaded`);
    await page.waitForTimeout(500);
    page.on('request', count);
    await page.waitForTimeout(4000);
    page.off('request', count);
    if (calls > 2) fail(`${tag}: idle zone page made ${calls} config/overview requests in 4 s`);
  }

  // The setup step links straight to the rules: the Rules drawer opens over the map.
  await page.goto(`${BASE}/staff/clock/zone#zone-rules`);
  await expectText(page, 'Check-in rules', `${tag} zone rules drawer`);
  // The rules explain themselves: a picture of the day, a plain line under each rule, and a tip on the "i".
  await expectText(page, 'Closed before', `${tag} rules day picture`);
  await expectText(page, 'Earliest check-in.', `${tag} rule help line`);
  await page.getByRole('button', { name: 'About Check-in opens' }).click();
  // The tip floats: opening it must not move the rules under it.
  const lateTop0 = await page.locator('[data-rule="lateAfter"]').evaluate((el) => el.getBoundingClientRect().top);
  await expectText(page, 'nobody can check in before this time', `${tag} rule tooltip`);
  {
    const lateTop1 = await page.locator('[data-rule="lateAfter"]').evaluate((el) => el.getBoundingClientRect().top);
    // (measured before the click below, so compare after closing and reopening)
    await page.keyboard.press('Escape');
    const closedTop = await page.locator('[data-rule="lateAfter"]').evaluate((el) => el.getBoundingClientRect().top);
    if (Math.abs(lateTop1 - closedTop) > 1) fail(`${tag}: the rule tip pushes the rules down (${Math.round(lateTop1 - closedTop)} px)`);
    void lateTop0;
    await page.getByRole('button', { name: 'About Check-in opens' }).click();
  }
  {
    const fit = await page.locator('#zone-rules .zc-drawer-body').evaluate((el) => el.scrollWidth <= el.clientWidth + 1 && [...el.querySelectorAll('.zr-label b, .zr-seg-pick button')].every((n) => n.scrollWidth <= n.clientWidth + 1));
    if (!fit) fail(`${tag}: a rule label or choice is cut off in the rules drawer`);
  }
  await page.waitForTimeout(250);
  await shot('03r-rules');
  await page.keyboard.press('Escape');
  if (await page.locator('.zr-tip').count()) fail(`${tag}: Escape did not close the rule tip`);
  await expectText(page, 'Edge tolerance', `${tag} edge tolerance rule`);
  await page.waitForTimeout(1500);
  if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)) fail(`${tag}: zone page scrolls sideways`);
  if (vp.name === 'desktop') {
    // The page fits the window: the map never scrolls away.
    if (await page.evaluate(() => document.documentElement.scrollHeight > window.innerHeight + 2)) fail(`${tag}: zone page scrolls vertically`);
    const mb = await page.locator('#zone-map').boundingBox();
    if (!mb || mb.y + mb.height > page.viewportSize().height + 1) fail(`${tag}: map taller than the window (${JSON.stringify(mb)})`);
  }
  await shot('03-zone');
  await page.getByRole('button', { name: 'Close rules' }).click();

  // The list: the selected area is spotlighted and editable.
  await expectText(page, 'Main campus', `${tag} area list`);
  await page.getByRole('button', { name: 'Satellite' }).click();
  await page.getByRole('button', { name: 'Test here' }).click();
  await expectText(page, 'inside Main campus', `${tag} zone test`);
  await page.waitForTimeout(1200);
  await shot('04-zone-satellite-test');
  await page.getByRole('button', { name: 'Map', exact: true }).click();
  // − / + change the radius by 10 m and mark the area Edited.
  await page.getByRole('button', { name: '10 m larger' }).click();
  await expectText(page, '160 m', `${tag} radius stepper`);
  await expectText(page, 'Edited', `${tag} edited tag`);

  // Finding a place only moves the map, then offers to move the area or add one there.
  await page.getByPlaceholder('Go to a place or paste coordinates').fill('new generation academy');
  await page.getByRole('button', { name: 'Go', exact: true }).click();
  await expectText(page, 'Go to…', `${tag} search results`);
  if (globalThis.__lastSearch?.countrycodes !== 'rw') fail(`${tag}: search not biased to Rwanda (${JSON.stringify(globalThis.__lastSearch)})`);
  await shot('04b-zone-search-results');
  await page.getByRole('option', { name: /New Generation Academy/ }).first().click();
  await page.locator('.zc-found-card').waitFor();
  if ((await page.getByText('-1.95000, 30.06000').count()) !== 0) fail(`${tag}: searching moved the area by itself`);
  await page.getByRole('button', { name: /Move “Main campus” here/ }).click();
  await expectText(page, '-1.95000, 30.06000', `${tag} area moved by "Move here"`);
  if (await page.locator('.zc-save').getByRole('button', { name: 'Save' }).isDisabled()) fail(`${tag}: Save not enabled after moving the area`);

  // Adding is its own mode: banner + draft row, then a map click drops the new area.
  await page.getByTestId('add-area').click();
  await expectText(page, 'Click the map or search a place to drop the new area', `${tag} adding banner`);
  await expectText(page, 'click the map', `${tag} draft row`);
  await shot('04c-zone-adding');
  const box = await page.locator('.sc-map-el').boundingBox();
  await page.mouse.click(box.x + box.width * 0.62, box.y + box.height * (vp.name === 'phone' ? 0.42 : 0.55));
  await expectText(page, 'Area 3', `${tag} new area added`);
  await expectText(page, 'New area, not saved yet', `${tag} new tag`);
  // Remove asks first.
  await page.getByRole('button', { name: 'Remove Area 3' }).click();
  await page.locator('.zc-confirm').getByRole('button', { name: 'Yes' }).click();
  await page.waitForTimeout(300);
  if (await page.locator('.zc-row', { hasText: 'Area 3' }).count()) fail(`${tag}: area not removed`);
  await expectText(page, 'Unsaved changes', `${tag} save bar dirty`);

  // Outline: Main campus becomes 8 corners on its circle, then is traced as the 4 walls.
  await page.locator('.zc-row', { hasText: 'Main campus' }).click();
  await page.getByTestId('shape-outline').click();
  await expectText(page, '8 corners', `${tag} outline from circle`);
  if ((await page.locator('.zc-vertex').count()) !== 8) fail(`${tag}: expected 8 draggable corners, got ${await page.locator('.zc-vertex').count()}`);
  if ((await page.locator('.zc-mid').count()) !== 8) fail(`${tag}: expected 8 add-corner handles`);
  await page.getByTestId('trace-walls').click();
  await expectText(page, 'Click each corner of the school walls', `${tag} trace banner`);
  const mb = await page.locator('.sc-map-el').boundingBox();
  const fy = vp.name === 'phone' ? 0.42 : 0.5;
  for (const [fx, dy] of [[0.5, -0.08], [0.72, -0.08], [0.72, 0.1], [0.5, 0.1]]) {
    await page.mouse.click(mb.x + mb.width * fx, mb.y + mb.height * (fy + dy));
    await page.waitForTimeout(120);
  }
  await expectText(page, '4 corners · click the first one or Done', `${tag} trace count`);
  await shot('04f-zone-trace');
  await page.getByTestId('trace-banner').getByRole('button', { name: 'Done' }).click();
  await expectText(page, 'Outline drawn', `${tag} outline done`);
  if ((await page.locator('.zc-vertex').count()) !== 4) fail(`${tag}: traced outline should have 4 corners`);
  await page.waitForTimeout(400);
  await shot('04g-zone-outline');
  const saved = page.waitForRequest((r) => /\/api\/staff\/clock\/zones\/1$/.test(r.url()) && r.method() === 'PUT');
  await page.locator('.zc-save').getByRole('button', { name: 'Save' }).click();
  const body = (await saved).postDataJSON();
  if (body.kind !== 'polygon' || !Array.isArray(body.polygon) || body.polygon.length !== 4) fail(`${tag}: outline not saved as 4 corners (${JSON.stringify(body)})`);
  if (Math.abs(body.polygon[0][0]) < Math.abs(body.polygon[0][1])) fail(`${tag}: corners not sent as [lng, lat]`);
  await expectText(page, 'Saved', `${tag} outline saved`);

  // Share drawer: the staff link.
  await page.getByRole('button', { name: 'Share', exact: true }).click();
  await expectText(page, 'tendo.amashuri.com/c/nga', `${tag} share drawer`);
  await page.screenshot({ path: path.join(OUT, `${tag}-04e-zone-share.png`) });
  await expectText(page, 'All saved', `${tag} nothing left unsaved`);

  // The old clock card is gone; the staff link is shown instead.
  await page.goto(`${BASE}/staff/attendance`);
  await expectText(page, 'Check in and out with your phone', `${tag} staff link card`);
  if (await page.getByText('Shift duty clock').count()) fail(`${tag}: old Shift duty clock still shown`);
  await shot('04d-staff-attendance');

  // Easy to find: Settings links to it; Staff Attendance has a settings button.
  if (vp.name === 'desktop') {
    if (!(await page.getByRole('link', { name: 'Staff Check-in' }).first().isVisible())) fail(`${tag}: sidebar lacks Staff Check-in`);
    await page.getByRole('link', { name: 'Staff check-in settings' }).click();
    await page.waitForURL(/\/staff\/clock\/zone$/);
  }
  await page.goto(`${BASE}/settings`);
  await page.getByRole('link', { name: 'Open staff check-in settings' }).click();
  await page.waitForURL(/\/staff\/clock\/zone$/);
  await expectText(page, 'Zone & settings', `${tag} settings -> zone`);

  // The setup guide, step by step.
  await page.goto(`${BASE}/staff/clock/setup?step=google`);
  await expectText(page, 'Google sign-in is set up for Tendo', `${tag} guide google`);
  if (vp.name === 'phone') {
    if (!(await page.locator('.sc-guide-strip').isVisible())) fail(`${tag}: phone strip missing`);
  } else if (!(await page.locator('.sc-guide-rail').isVisible())) fail(`${tag}: rail missing`);
  await page.screenshot({ path: path.join(OUT, `${tag}-g1-google.png`) });
  const nextBtn = () => page.locator('.sc-guide-nav').getByRole('button', { name: /Next/ });
  await nextBtn().click();
  await expectText(page, 'Check-in only works inside this area', `${tag} guide zone`);
  await page.waitForTimeout(1200);
  await page.screenshot({ path: path.join(OUT, `${tag}-g2-zone.png`) });
  await nextBtn().click();
  await expectText(page, 'Check-out opens after', `${tag} guide times`);
  await page.screenshot({ path: path.join(OUT, `${tag}-g3-times.png`) });
  await page.getByRole('button', { name: 'Save times and continue' }).click();
  await expectText(page, 'Go where staff arrive', `${tag} guide test`);
  await page.getByRole('button', { name: 'Test from where I stand' }).click();
  await expectText(page, 'You are inside Main campus', `${tag} guide test result`);
  await page.screenshot({ path: path.join(OUT, `${tag}-g4-test.png`) });
  if (vp.name === 'desktop') {
    // A laptop (no GPS): ±194 m from Wi-Fi -> explained, confirmable, or finish on a phone.
    await ctx.setGeolocation({ latitude: -1.95326, longitude: 30.10441, accuracy: 194 });
    await page.getByRole('button', { name: 'Test from where I stand' }).click();
    await expectText(page, 'This computer has no GPS', `${tag} laptop explanation`);
    await expectText(page, 'Probably inside', `${tag} laptop best guess`);
    await page.getByRole('button', { name: 'Use my phone’s GPS' }).click();
    await page.locator('.sc-phone-qr img').waitFor();
    await expectText(page, 'Waiting for your phone', `${tag} pair waiting`);
    await page.screenshot({ path: path.join(OUT, `${tag}-g4b-laptop-test.png`) });
    // The "phone" opens the QR link and shares a precise GPS reading.
    await ctx.setGeolocation({ latitude: -1.95326, longitude: 30.10441, accuracy: 8 });
    const phone = await ctx.newPage();
    await phone.setViewportSize({ width: 390, height: 844 });
    await phone.goto(`${BASE}/c/nga/pair/TESTPAIRCODE1234`);
    await expectText(phone, 'New Generation Academy', `${tag} pair phone school`);
    await phone.getByRole('button', { name: /Share my location/ }).click();
    await expectText(phone, 'Location sent', `${tag} pair phone sent`);
    await phone.screenshot({ path: path.join(OUT, `${tag}-g4c-pair-phone.png`) });
    await phone.close();
    await expectText(page, 'From your phone', `${tag} pair result`);
    await expectText(page, 'You are inside Main campus (precision ± 8 m)', `${tag} pair precise`);
    await page.screenshot({ path: path.join(OUT, `${tag}-g4d-pair-result.png`) });
    await ctx.setGeolocation({ latitude: -1.95326, longitude: 30.10441, accuracy: 15 });
  }
  await nextBtn().click();
  await expectText(page, 'Staff check-in is on', `${tag} guide open`);
  await page.screenshot({ path: path.join(OUT, `${tag}-g5-open.png`) });
  await nextBtn().click();
  await expectText(page, 'Copy message', `${tag} guide share`);
  await page.locator('.sc-guide-qr img').waitFor();
  await page.screenshot({ path: path.join(OUT, `${tag}-g6-share.png`) });
  await nextBtn().click();
  await expectText(page, 'staff have registered a phone', `${tag} guide phones`);
  await expectText(page, 'Olivier Mugisha', `${tag} guide unregistered list`);
  await page.screenshot({ path: path.join(OUT, `${tag}-g7-phones.png`) });
  await page.getByRole('button', { name: /Finish/ }).click();
  await page.waitForURL(/\/staff\/clock$/);

  await page.goto(`${BASE}/staff/clock/devices`);
  await expectText(page, 'Staff QR cards', `${tag} devices`);
  await expectText(page, 'Waiting approval', `${tag} device pending`);
  await shot('05-devices');

  await page.goto(`${BASE}/staff/clock/scan`);
  await expectText(page, 'Scan a staff card', `${tag} scan`);
  await page.getByRole('button', { name: 'Start camera' }).click().catch(() => {});
  await page.getByLabel(/Card code/).fill('TC1-ABCDEFGHJKLMNPQRSTUV');
  await page.getByRole('button', { name: 'Record' }).click();
  await expectText(page, 'Solange Iradukunda', `${tag} scan result`);
  await page.waitForTimeout(500);
  await shot('06-scan');

  await page.goto(`${BASE}/staff/clock/poster`);
  await expectText(page, 'Check in and out with your own phone', `${tag} poster`);
  const ink = await page.locator('.sc-poster h1').evaluate((el) => getComputedStyle(el).color);
  if (ink !== 'rgb(17, 24, 39)') fail(`${tag}: poster title colour ${ink}`);
  await page.waitForTimeout(500);
  await shot('07-poster');
  await ctx.close();
}

async function main() {
  const preview = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'ignore' });
  try {
    for (let i = 0; i < 40; i++) {
      try { if ((await fetch(`${BASE}/`)).ok) break; } catch { /* not yet */ }
      await new Promise((r) => setTimeout(r, 250));
    }
    const browser = await chromium.launch({
      ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}),
      args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
    });
    for (const vp of [
      { name: 'desktop', width: 1440, height: 900, theme: 'light' },
      { name: 'desktop', width: 1440, height: 900, theme: 'dark' },
      { name: 'phone', width: 390, height: 844, theme: 'light', mobile: true },
    ]) {
      await run(browser, vp);
      console.log(`ok ${vp.name}-${vp.theme}`);
    }
    await browser.close();
    console.log(`All admin screens passed. Screenshots in ${OUT}`);
  } finally {
    preview.kill();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
