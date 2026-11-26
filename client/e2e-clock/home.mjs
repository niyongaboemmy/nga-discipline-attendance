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
  await ctx.close();
  console.log(`ok ${name}`);
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
