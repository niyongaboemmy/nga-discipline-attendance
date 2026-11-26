// Real-browser check of the staff member's own card (Tendo -> Staff Attendance):
// the check-in state, Copy link, and "my week in one line" (one capsule per day,
// hover / tap for the day) against a mocked API: desktop light + dark, phone.
//
//   cd client && npm run build && npm i --no-save playwright
//   node e2e-clock/home.mjs            # OUT=<dir>, CHROME=<path>

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const OUT = process.env.OUT || path.resolve('e2e-clock/out');
const PORT = Number(process.env.PORT || 4793);
const BASE = `http://localhost:${PORT}`;
mkdirSync(OUT, { recursive: true });

const PERMS = ['STAFF_ATTENDANCE_CLOCK', 'STAFF_ATTENDANCE_VIEW_OWN'];
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const TOKEN = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ id: '300', name: 'Sample Teacher', role: 'teacher', tid: 1, tslug: 'nga', exp: 4102444800 })}.sig`;

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exitCode = 1;
  throw new Error(msg);
}

// Thursday 26 Nov 2026, 10:20: Mon on time, Tue late, Wed absent, today in since 07:50, Fri to come.
const day = (date, kind, extra = {}) => ({ date, kind, start: '08:30', end: '16:00', in: null, out: null, early: false, noOut: false, own: false, ...extra });
const WEEK = {
  today: '2026-11-26', nowMinutes: 620, own: false,
  days: [
    day('2026-11-23', 'on_time', { in: '07:42', out: '16:10' }),
    day('2026-11-24', 'late', { in: '08:51', out: '15:20', early: true }),
    day('2026-11-25', 'absent'),
    day('2026-11-26', 'on_time', { in: '07:50' }),
    day('2026-11-27', 'planned'),
    day('2026-11-28', 'off', { start: null, end: null }),
    day('2026-11-29', 'off', { start: null, end: null }),
  ],
  summary: { workDays: 5, worked: 3, late: 1, absent: 1, daysOff: 2, plannedMinutes: 2250, left: 1 },
  month: { workDays: 19, worked: 17, late: 2, absent: 2 },
  device: { id: 9, label: 'Tecno Spark 20 · Chrome', form_factor: 'phone', google_email: 'sample.teacher@gmail.com', status: 'active', registered_at: '2026-11-03T06:00:00Z', last_used_at: '2026-11-26T05:50:00Z' },
};

async function run(browser, { name, width, height, theme, mobile = false }) {
  const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: theme, deviceScaleFactor: 2, isMobile: mobile, hasTouch: mobile, permissions: ['clipboard-read', 'clipboard-write'] });
  await ctx.addInitScript(([token, perms, theme]) => {
    localStorage.setItem('sso_token', token);
    localStorage.setItem('sso_user', JSON.stringify({ id: '300', name: 'Sample Teacher', email: 'teacher@school.rw', role: 'teacher', tid: 1, tenantSlug: 'nga' }));
    localStorage.setItem('sso_permissions', '[]');
    localStorage.setItem('sso_role_permissions', JSON.stringify(perms));
    localStorage.setItem('theme', theme);
    localStorage.setItem('nga.install.dismissed', String(Date.now()));
  }, [TOKEN, PERMS, theme]);
  await ctx.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  await ctx.route('**/api/**', (route) => {
    const p = new URL(route.request().url()).pathname;
    const ok = (data) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data }) });
    if (p === '/api/sso/verify-mis') return route.fulfill({ status: 200, contentType: 'application/json', body: '{"success":true}' });
    if (p === '/api/roles-permissions/me') return ok({ permissionKeys: PERMS });
    if (p === '/api/staff/clock/my-device/signout') return route.fulfill({ status: 200, contentType: 'application/json', body: '{"success":true,"message":"Device signed out"}' });
    if (p === '/api/staff/clock/my-week') return ok(WEEK);
    if (p === '/api/staff/attendance/me') return ok([{ date: new Date().toLocaleDateString('en-CA'), clock_in: new Date(new Date().setHours(7, 50, 0, 0)).toISOString(), clock_out: null }]);
    return ok([]);
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => fail(`page error: ${e.message}`));
  await page.goto(`${BASE}/staff/attendance`);
  const line = page.getByTestId('my-week-line');
  await line.waitFor({ timeout: 15000 });
  // Tendo offers to install itself a moment after the page opens.
  const notNow = page.getByRole('button', { name: 'Not now' });
  await notNow.waitFor({ timeout: 4000 }).then(() => notNow.click()).catch(() => undefined);
  await page.locator('[aria-labelledby="nga-install-title"]').waitFor({ state: 'detached', timeout: 4000 }).catch(() => undefined);
  if ((await line.locator('.wl-day').count()) !== 7) fail(`${name}: the week should show seven days`);
  for (const [cls, n] of [['k-late', 1], ['k-absent', 1], ['k-off', 2], ['is-today', 1]]) {
    if ((await line.locator(`.wl-day.${cls}`).count()) !== n) fail(`${name}: expected ${n} .${cls}`);
  }
  for (const text of ['of 5 days this week', '1 late', '1 absent', '17/19']) {
    if (!(await line.getByText(text, { exact: false }).first().isVisible())) fail(`${name}: "${text}" not visible`);
  }
  // One line: the seven capsules share a row; on a wide screen the numbers sit beside them.
  const tops = await line.locator('.wl-day').evaluateAll((els) => [...new Set(els.map((e) => Math.round(e.getBoundingClientRect().top)))]);
  if (tops.length !== 1) fail(`${name}: the days wrapped onto ${tops.length} rows`);
  if (width >= 1200) {
    const [a, b] = await Promise.all([line.locator('.wl-days').boundingBox(), line.locator('.wl-sum').boundingBox()]);
    if (Math.abs(a.y + a.height / 2 - (b.y + b.height / 2)) > 30) fail(`${name}: the week and its numbers are not on one line`);
  }
  // No time is cut short, even on a narrow phone.
  const cut = await line.locator('.wl-time').evaluateAll((els) => els.filter((e) => e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflow !== 'visible').length);
  const wide = await line.locator('.wl-day').evaluateAll((els) => els.filter((e) => e.scrollWidth > e.clientWidth + 1).length);
  if (cut || wide) fail(`${name}: ${cut + wide} day times do not fit their capsule`);
  // A day shows itself on tap (pinned) and closes on Escape.
  await line.locator('.wl-day.k-late').click();
  const pop = page.getByTestId('week-pop');
  await pop.waitFor();
  for (const text of ['Tuesday 24 Nov', 'Late', 'Expected 08:30 – 16:00', 'In 08:51 · out 15:20', '6h 29 at school · left early']) {
    if (!(await pop.getByText(text, { exact: false }).first().isVisible())) fail(`${name}: day detail lacks "${text}"`);
  }
  const box = await pop.boundingBox();
  if (box.x < 0 || box.x + box.width > width + 1) fail(`${name}: the day detail leaves the screen`);
  if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)) fail(`${name}: the page scrolls sideways`);
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(OUT, `home-${name}.png`) });
  await page.keyboard.press('Escape');
  if (await page.getByTestId('week-pop').count()) fail(`${name}: Escape did not close the day detail`);
  // Copy link (the desktop app cannot open the link).
  await page.getByTestId('clock-copy-link').click();
  await page.getByText('Check-in link copied').first().waitFor({ timeout: 5000 }).catch(() => fail(`${name}: no "link copied" message`));
  // My check-in device: sign it out from my account.
  for (const b of await page.locator('.toast-close').all()) await b.click().catch(() => {});
  const dev = page.getByTestId('my-device');
  if (!(await dev.getByText('Tecno Spark 20 · Chrome').isVisible())) fail(`${name}: my device is not shown`);
  await page.getByTestId('my-device-signout').click();
  await page.getByTestId('my-device-signout-yes').click();
  await page.getByText('Device signed out').first().waitFor({ timeout: 5000 }).catch(() => fail(`${name}: no "signed out" message`));
  if (await page.getByTestId('my-device').count()) fail(`${name}: the device row stayed after signing out`);
  await ctx.close();
  console.log(`ok ${name}`);
}

/** Staff Attendance as an administrator: a person in "All staff logs" opens their window (history, hours, device). */
async function adminList(browser) {
  const perms = [...PERMS, 'STAFF_ATTENDANCE_VIEW_ALL', 'STAFF_DEVICES_MANAGE'];
  const token = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ id: '900', name: 'Admin Office', role: 'admin', tid: 1, tslug: 'nga', exp: 4102444800 })}.sig`;
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark', deviceScaleFactor: 2 });
  await ctx.addInitScript(([tk, ps]) => {
    localStorage.setItem('sso_token', tk);
    localStorage.setItem('sso_user', JSON.stringify({ id: '900', name: 'Admin Office', email: 'admin@school.rw', role: 'admin', tid: 1, tenantSlug: 'nga' }));
    localStorage.setItem('sso_permissions', '[]');
    localStorage.setItem('sso_role_permissions', JSON.stringify(ps));
    localStorage.setItem('theme', 'dark');
  }, [token, perms]);
  await ctx.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  const days = Array.from({ length: 30 }, (_, i) => { const d = new Date(Date.UTC(2026, 9, 28 + i, 12)); const date = d.toISOString().slice(0, 10); const off = [0, 6].includes(d.getUTCDay()); return { date, kind: off ? 'off' : date === '2026-11-26' ? 'on_time' : 'absent', in: date === '2026-11-26' ? '11:26' : null, out: null, early: false, noOut: false, minutes: null, card: false, start: off ? null : '08:30', end: off ? null : '16:00', extra: false, recordId: null, claim: null, manualOut: false }; });
  await ctx.route('**/api/**', (route) => {
    const p = new URL(route.request().url()).pathname;
    const ok = (data) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data }) });
    if (p === '/api/sso/verify-mis') return route.fulfill({ status: 200, contentType: 'application/json', body: '{"success":true}' });
    if (p === '/api/roles-permissions/me') return ok({ permissionKeys: perms });
    if (p === '/api/staff/attendance') return ok([
      { id: 1, staff_id: '14', staff_name: 'Sample Person One', date: '2026-11-26', clock_in: '2026-11-26T09:26:00.000Z', clock_out: null, status: 'present', staff_type: 'teacher' },
      { id: 2, staff_id: '13', staff_name: 'Sample Person Two', date: '2026-11-26', clock_in: '2026-11-26T09:16:00.000Z', clock_out: null, status: 'present', staff_type: 'teacher' },
    ]);
    if (/^\/api\/staff\/clock\/people\/[^/]+\/history$/.test(p)) return ok({ person: { id: p.split('/')[5], name: p.split('/')[5] === '14' ? 'Sample Person One' : 'Sample Person Two', role: 'Teacher' }, from: days[0].date, to: '2026-11-26', today: '2026-11-26', trackingFrom: '2026-11-24', rules: { lateAfter: '08:30', earlyLeaveBefore: '16:00' }, days, device: null, card: false, summary: { schoolDays: 3, attended: 1, onTime: 1, late: 0, absent: 2, noOut: 0, early: 0, rate: 33, punctuality: 100, avgIn: '11:26', streak: 1, bestStreak: 1 } });
    return ok(p === '/api/staff/clock/overview' ? null : []);
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => fail(`admin list page error: ${e.message}`));
  await page.goto(`${BASE}/staff/attendance`);
  const row = page.locator('tr[data-person="14"]');
  await row.waitFor({ timeout: 15000 });
  const notNow = page.getByRole('button', { name: 'Not now' });
  await notNow.waitFor({ timeout: 4000 }).then(() => notNow.click()).catch(() => undefined);
  await page.locator('[aria-labelledby="nga-install-title"]').waitFor({ state: 'detached', timeout: 4000 }).catch(() => undefined);
  await row.click();
  const modal = page.getByTestId('staff-history');
  await modal.waitFor({ timeout: 8000 }).catch(() => fail('admin list: a click on a person did not open their window'));
  if (!(await modal.getByText('Sample Person One').first().isVisible())) fail('admin list: the window is not that person');
  if (!(await modal.getByText('1 / 2').isVisible())) fail('admin list: cannot step through the people of the list');
  await page.keyboard.press('ArrowRight');
  await modal.getByText('Sample Person Two').first().waitFor({ timeout: 5000 }).catch(() => fail('admin list: the arrow key did not step to the next person'));
  await page.getByTestId('tab-device').click();
  await page.getByText('No phone or browser is signed in').waitFor({ timeout: 5000 }).catch(() => fail('admin list: the Device tab is missing'));
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, 'home-admin-list-person.png') });
  await page.keyboard.press('Escape');
  if (await page.getByTestId('staff-history').count()) fail('admin list: Escape did not close the window');
  await ctx.close();
  console.log('ok admin list opens a person');
}

async function main() {
  const preview = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'ignore' });
  try {
    for (let i = 0; i < 40; i++) {
      try { if ((await fetch(`${BASE}/`)).ok) break; } catch { /* not yet */ }
      await new Promise((r) => setTimeout(r, 250));
    }
    const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
    await run(browser, { name: 'desktop-light', width: 1440, height: 900, theme: 'light' });
    await run(browser, { name: 'desktop-dark', width: 1440, height: 900, theme: 'dark' });
    await run(browser, { name: 'tablet-light', width: 834, height: 1112, theme: 'light' });
    await run(browser, { name: 'phone-dark', width: 360, height: 740, theme: 'dark', mobile: true });
    await adminList(browser);
    await browser.close();
    console.log(`Home card passed. Screenshots in ${OUT}`);
  } finally {
    preview.kill();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
