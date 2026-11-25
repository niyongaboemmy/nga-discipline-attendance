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
  kpis: { staff: 10, checkedIn: 8, onTime: 6, late: 2, notIn: 2, checkedOut: 0, earlyLeave: 0, needsReview: 2, medianLateMinutes: 14 },
  arrivals: [['06:30', 0, 0], ['06:45', 0, 0], ['07:00', 1, 0], ['07:15', 2, 0], ['07:30', 1, 0], ['07:45', 2, 0], ['08:00', 1, 0], ['08:15', 0, 0], ['08:30', 0, 0], ['08:45', 0, 2], ['09:00', 0, 0], ['09:15', 0, 0]]
    .map(([from, onTime, late]) => ({ from, to: from, onTime, late })),
  rows: people.map(([userId, name, role, checkIn, status, checkOut, distance, device, review, source]) => ({
    recordId: checkIn ? Number(userId) : null, userId, name, role, checkIn, checkOut, status, outStatus: null, distance, source: source ?? (checkIn ? 'device' : null), device, flags: [], needsReview: !!review, reviewState: null,
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
};
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
  await ctx.route('**/api/**', (route) => {
    const u = new URL(route.request().url());
    const p = u.pathname;
    const ok = (data) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data }) });
    if (p === '/api/sso/verify-mis') return route.fulfill({ status: 200, contentType: 'application/json', body: '{"success":true}' });
    if (p === '/api/roles-permissions/me') return ok({ permissionKeys: PERMS });
    if (p === '/api/staff/clock/overview') return ok(OVERVIEW);
    if (p === '/api/staff/clock/config') return ok(CONFIG);
    if (p === '/api/staff/clock/devices') return ok(DEVICES);
    if (p === '/api/staff/clock/cards') return ok([{ id: 1, user_id: '108', user_name: 'Solange Iradukunda', issued_at: '2026-11-20T08:00:00Z', last_used_at: '2026-11-24T05:05:00Z' }]);
    if (p === '/api/staff/clock/cards' || (p.endsWith('/cards') && route.request().method() === 'POST')) return ok({ school: 'New Generation Academy', cards: [] });
    if (p === '/api/staff/clock/scan') return ok({ action: 'check_in', at: '07:10', status: 'present', distance: 30, person: { name: 'Solange Iradukunda', firstName: 'Solange', initials: 'SI' }, checkIn: '07:10', checkOut: null });
    if (p.startsWith('/api/staff/clock/devices/')) return ok({});
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
  await expectText(page, 'Arrivals', `${tag} arrivals`);
  await expectText(page, 'New phone waiting', `${tag} pending phone`);
  if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)) fail(`${tag}: dashboard scrolls sideways`);
  await shot('01-dashboard');
  await page.getByRole('tab', { name: /Needs review/ }).click();
  await expectText(page, 'Same spot and time as another check-in', `${tag} review`);
  await shot('02-review');

  await page.goto(`${BASE}/staff/clock/zone`);
  await expectText(page, 'Check-in rules', `${tag} zone rules`);
  await page.waitForTimeout(1500);
  if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)) fail(`${tag}: zone page scrolls sideways`);
  await shot('03-zone');
  await page.getByRole('button', { name: 'Satellite' }).click();
  await page.getByRole('button', { name: 'Test from where I stand' }).click();
  await expectText(page, 'inside Main campus', `${tag} zone test`);
  await page.waitForTimeout(1500);
  await shot('04-zone-satellite-test');

  // Search -> pick a result -> the selected zone's pin moves there (Save becomes possible).
  await expectText(page, 'Staff check-in link for New Generation Academy', `${tag} link banner`);
  await page.getByPlaceholder('Search a place or paste coordinates').fill('new generation academy');
  await page.getByRole('button', { name: 'Find' }).click();
  await expectText(page, 'Choose the right place', `${tag} search results`);
  if (globalThis.__lastSearch?.countrycodes !== 'rw') fail(`${tag}: search not biased to Rwanda (${JSON.stringify(globalThis.__lastSearch)})`);
  await shot('04b-zone-search-results');
  await page.getByRole('option', { name: /New Generation Academy/ }).click();
  await expectText(page, '-1.95000, 30.06000', `${tag} pin moved by search`);
  if (await page.getByRole('button', { name: 'Save changes' }).isDisabled()) fail(`${tag}: Save not enabled after moving the pin`);
  // Coordinates pasted also place the pin; a map click moves it again.
  await page.getByPlaceholder('Search a place or paste coordinates').fill('-1.95111, 30.06222');
  await page.getByRole('button', { name: 'Find' }).click();
  await expectText(page, '-1.95111, 30.06222', `${tag} pin moved by coordinates`);
  const box = await page.locator('.sc-map-el').boundingBox();
  await page.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.6);
  await page.waitForTimeout(300);
  const moved = await page.getByText('-1.95111, 30.06222').count();
  if (moved !== 0) fail(`${tag}: a map click did not move the pin`);
  await shot('04c-zone-after-click');

  // The old clock card is gone; the staff link is shown instead.
  await page.goto(`${BASE}/staff/attendance`);
  await expectText(page, 'Check in with your phone', `${tag} staff link card`);
  if (await page.getByText('Shift duty clock').count()) fail(`${tag}: old Shift duty clock still shown`);
  await shot('04d-staff-attendance');

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
