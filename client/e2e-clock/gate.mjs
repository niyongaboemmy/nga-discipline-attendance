// Real-browser check of the Gate view (/staff/clock/gate) against a mocked API:
// the ways in (dashboard button, tab), the phone layout (dark, tabs, bottom sheet),
// the desktop layout (three columns, filters, side panel), reminders, confirming a
// check-in, Leaving mode. Invented people only.
//
//   cd client && npm run build && npm i --no-save playwright
//   node e2e-clock/gate.mjs           # OUT=<dir>, CHROME=<path>

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const OUT = process.env.OUT || path.resolve('e2e-clock/out');
const PORT = Number(process.env.PORT || 4794);
const BASE = `http://localhost:${PORT}`;
mkdirSync(OUT, { recursive: true });

const PERMS = ['STAFF_ATTENDANCE_CLOCK', 'STAFF_ATTENDANCE_VIEW_OWN', 'STAFF_ATTENDANCE_VIEW_ALL', 'STAFF_ATTENDANCE_ZONES_MANAGE', 'STAFF_DEVICES_MANAGE', 'STAFF_CLOCK_SCAN', 'REPORTS_VIEW', 'USERS_VIEW'];
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const TOKEN = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ id: '900', name: 'Test Leader', role: 'admin', tid: 1, tslug: 'demo', exp: 4102444800 })}.sig`;

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exitCode = 1;
  throw new Error(msg);
}
const check = (cond, msg) => { if (!cond) fail(msg); };

const SCHOOL = { own: false, works: true, start: '07:30', end: '16:00' };
const own = (start, end) => ({ own: true, works: true, start, end });
// 07:24 at the gate: 2 late, 3 due at 07:30 (one without reminders), 2 later, 7 in (one late, one by card, one to check), 1 day off.
const base = [
  ['1', 'Person One Alpha', null, 'not_in', own('07:00', '15:00'), 'due_now', true],
  ['2', 'Person Two Bravo', null, 'not_in', own('07:15', '16:00'), 'due_now', true],
  ['3', 'Person Three Charlie', null, 'not_in', SCHOOL, 'due_later', true],
  ['4', 'Person Four Delta', null, 'not_in', SCHOOL, 'due_later', true],
  ['5', 'Person Five Echo', null, 'not_in', SCHOOL, 'due_later', false],
  ['6', 'Person Six Foxtrot With A Very Long Name Indeed', null, 'not_in', own('09:00', '13:00'), 'due_later', true],
  ['7', 'Person Seven Golf', null, 'not_in', own('12:00', '20:00'), 'due_later', true],
  ['8', 'Person Eight Hotel', '07:23', 'present', SCHOOL, 'here', true],
  ['9', 'Person Nine India', '07:21', 'present', SCHOOL, 'here', true],
  ['10', 'Person Ten Juliet', '07:19', 'present', SCHOOL, 'here', true, 'card'],
  ['11', 'Person Eleven Kilo', '07:17', 'present', SCHOOL, 'here', true, 'device', true],
  ['12', 'Person Twelve Lima', '07:12', 'present', SCHOOL, 'here', true],
  ['13', 'Person Thirteen Mike', '07:08', 'late', own('07:00', '16:00'), 'here', true],
  ['14', 'Person Fourteen November', '06:58', 'present', SCHOOL, 'here', true],
  ['15', 'Person Fifteen Oscar', null, 'day_off', { own: true, works: false, start: null, end: null }, 'day_off', true],
];
function overview(state) {
  const rows = base.map(([userId, name, checkIn, status, plan, moment, reminders, source, review]) => {
    const scanned = state.arrived.has(userId);
    const out = state.leaving && checkIn ? (userId === '14' ? ['16:02', 'on_time'] : userId === '13' ? ['14:40', 'early'] : null) : null;
    return {
      recordId: checkIn || scanned ? Number(userId) : null, userId, name, role: 'Teacher', checkIn: scanned ? '07:24' : checkIn, checkOut: out?.[0] ?? null,
      status: scanned ? 'present' : status, expected: status !== 'day_off', plan,
      moment: scanned ? 'here' : state.leaving ? (out ? (out[1] === 'early' ? 'left_early' : 'left') : checkIn ? 'here' : status === 'day_off' ? 'day_off' : 'missed') : moment,
      reminders, outStatus: out?.[1] ?? null, distance: checkIn ? 30 : null, source: source ?? (checkIn ? 'device' : null), device: null, flags: review ? ['weak_location'] : [],
      needsReview: !!review && !state.confirmed, reviewState: review && state.confirmed ? 'accepted' : null,
    };
  });
  return {
    date: '2026-11-26', isToday: true, serverNow: '2026-11-26T05:24:00.000Z', rosterSource: 'mis',
    rules: { lateAfter: '07:30', earlyLeaveBefore: '16:00', opens: '05:00', enabled: true }, ownPlans: 5, holiday: false,
    now: { at: state.leaving ? '16:10' : '07:24', expectedToday: 14, shouldBeHere: 9, here: 7, notHere: 2, startsLater: 5, left: 0, leftEarly: 0, missed: 0, dayOff: 1, late: 1 },
    kpis: { staff: 14, checkedIn: 7, onTime: 6, late: 1, notIn: 7, dayOff: 1, checkedOut: 0, earlyLeave: 0, needsReview: state.confirmed ? 0 : 1, medianLateMinutes: 8 },
    arrivals: [], rows,
    review: state.confirmed ? [] : [{ recordId: 11, userId: '11', name: 'Person Eleven Kilo', at: '07:17', flags: ['weak_location'], flagText: ['Imprecise location, off the school network'], distance: 80, accuracy: 240 }],
    phones: { registered: 12, staff: 15, pending: [], unregistered: [] },
    missing: { checkoutOpen: false, noCheckoutToday: [], recentNoCheckout: [] },
    health: { google: true, zones: 1, enabled: true, tested: true, shared: true, unregistered: 0, staff: 15 },
  };
}

async function context(browser, { width, height, theme, mobile = false }) {
  const state = { arrived: new Set(), confirmed: false, leaving: false, nudges: [] };
  const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: theme, deviceScaleFactor: 2, isMobile: mobile, hasTouch: mobile });
  await ctx.addInitScript(([token, perms, theme]) => {
    localStorage.setItem('sso_token', token);
    localStorage.setItem('sso_user', JSON.stringify({ id: '900', name: 'Test Leader', email: 'leader@school.example', role: 'admin', tid: 1, tenantSlug: 'demo' }));
    localStorage.setItem('sso_permissions', '[]');
    localStorage.setItem('sso_role_permissions', JSON.stringify(perms));
    localStorage.setItem('theme', theme);
  }, [TOKEN, PERMS, theme]);
  await ctx.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  await ctx.route('**/api/**', (route) => {
    const u = new URL(route.request().url());
    const p = u.pathname;
    const ok = (data, message) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, message, data }) });
    if (p === '/api/sso/verify-mis') return route.fulfill({ status: 200, contentType: 'application/json', body: '{"success":true}' });
    if (p === '/api/roles-permissions/me') return ok({ permissionKeys: PERMS });
    if (p === '/api/staff/clock/overview') return ok(overview(state));
    if (p === '/api/staff/clock/nudge') {
      const body = route.request().postDataJSON();
      state.nudges.push(body);
      return ok({ sent: body.userIds.length, noReminders: 0, already: 0, notNeeded: 0 }, 'Reminder sent');
    }
    if (p === '/api/staff/clock/attendance/11/review') { state.confirmed = true; return ok({}); }
    if (p === '/api/staff/clock/config') return ok({
      rules: { enabled: true, requireZone: true, maxAccuracy: 100, allowance: 50, opens: '05:00', lateAfter: '07:30', earlyLeaveBefore: '16:00', minShiftMinutes: 60, autoCloseAt: '23:59', selfReplaceDays: 30, googleDomains: '', schoolNetworks: '', nonSchoolDays: 'refuse', allowUnassignedStaff: false, setupDone: ['rules', 'tested', 'shared'] },
      zones: [{ id: 1, name: 'Campus', kind: 'circle', center_lat: -1.95, center_lng: 30.1, radius_m: 150, active: 1 }],
      link: { slug: 'demo', url: 'https://tendo.example/c/demo', display: 'tendo.example/c/demo' }, school: { name: 'Demo School', slug: 'demo', timezone: 'Africa/Kigali' }, googleConfigured: true,
    });
    if (p === '/api/staff/clock/report') {
      const days = [];
      for (let d = new Date('2026-11-01T12:00:00Z'); d <= new Date('2026-11-30T12:00:00Z'); d.setUTCDate(d.getUTCDate() + 1)) {
        const date = d.toISOString().slice(0, 10);
        const kind = date > '2026-11-26' ? 'future' : [0, 6].includes(d.getUTCDay()) ? 'off' : 'school';
        days.push({ date, kind, onTime: kind === 'school' ? 12 : 0, late: kind === 'school' ? 1 : 0, absent: kind === 'school' ? 1 : 0, staff: kind === 'school' ? 14 : 0, today: date === '2026-11-26' });
      }
      const n = days.filter((x) => x.kind === 'school').length;
      return ok({ today: '2026-11-26', from: '2026-11-02', to: '2026-11-26', trackingFrom: '2026-11-02', staff: 14, countedDays: n - 1, lateAfter: '07:30', term: null, rosterSource: 'mis', days,
        totals: { schoolDays: n, onTime: 12 * n, late: n, absent: n, staffDays: 14 * n, rate: 92.9, prevRate: null }, weeks: [{ start: '2026-11-23', rate: 92.9, late: 4, prevRate: null }],
        weekdays: [1, 2, 3, 4, 5].map((dow) => ({ dow, rate: 92.9 })), arrivals: [], groups: [] });
    }
    return ok([]);
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => fail(`page error: ${e.message}`));
  return { ctx, page, state };
}

async function quiet(page) {
  const notNow = page.getByRole('button', { name: /Not now/i });
  if (await notNow.isVisible().catch(() => false)) await notNow.click();
  for (const b of await page.locator('.toast-close').all()) await b.click().catch(() => {});
}
const texts = (page, sel) => page.locator(sel).allTextContents();
const visible = (page, sel) => page.locator(sel).first().isVisible();

async function run(browser, vp) {
  const tag = `gate-${vp.name}-${vp.theme}`;
  const { ctx, page, state } = await context(browser, vp);
  const shot = async (n) => { await quiet(page); await page.screenshot({ path: path.join(OUT, `${tag}-${n}.png`) }); };
  const phone = vp.width < 900;

  // The way in: the dashboard's "Right now" card.
  await page.goto(`${BASE}/staff/clock`);
  await page.getByRole('button', { name: /Not now/i }).click({ timeout: 2500 }).catch(() => {});
  await page.getByTestId('open-gate').waitFor({ timeout: 8000 });
  check(await page.locator('.sc-tab', { hasText: 'Gate view' }).count() === 1, `${tag}: no Gate view tab`);
  await shot('0-dashboard');
  await page.getByTestId('open-gate').click();
  await page.getByTestId('gate-waiting').waitFor({ timeout: 8000 });
  check(page.url().endsWith('/staff/clock/gate'), `${tag}: wrong address ${page.url()}`);

  // The picture at 07:24.
  check((await page.locator('.gt-ring-text').innerText()).replace(/\s+/g, ' ') === '7 of 14 here', `${tag}: ring says "${await page.locator('.gt-ring-text').innerText()}"`);
  const next = (await page.getByTestId('gate-next').innerText()).replace(/\s+/g, ' ');
  check(next.includes('Start 07:30 · 3 people') && next.includes('Late in 6 min'), `${tag}: headline "${next}"`);
  const tags = await texts(page, '[data-testid="gate-waiting"] .gt-tag');
  check(JSON.stringify(tags) === JSON.stringify(['24 min late', '9 min late', 'in 6 min', 'in 6 min', 'in 6 min', 'at 09:00', 'at 12:00']), `${tag}: waiting order ${JSON.stringify(tags)}`);
  // No sideways scrolling, nothing wider than the window; the long name is clipped, not wrapped.
  const over = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, w: window.innerWidth, tall: [...document.querySelectorAll('.gt-row')].map((r) => r.getBoundingClientRect().height) }));
  check(over.sw <= over.w, `${tag}: page is wider than the window (${over.sw} > ${over.w})`);
  // A person's row keeps room around the photo (and its ring) and before the edge.
  const pad = await page.evaluate(() => [...document.querySelectorAll('[data-testid="gate-waiting"] .gt-row')].map((r) => { const b = r.getBoundingClientRect(); const a = r.querySelector('.gt-av').getBoundingClientRect(); const t = r.querySelector('.gt-tag').getBoundingClientRect(); const last = (r.querySelector('.gt-bell, .gt-sent') || r.querySelector('.gt-tag')).getBoundingClientRect(); return { left: Math.round(a.left - b.left), right: Math.round(b.right - last.right), top: Math.round(a.top - b.top), tag: Math.round(t.left - r.querySelector('.gt-row-text').getBoundingClientRect().right) }; }));
  check(pad.every((x) => x.left >= 8 && x.right >= 8 && x.top >= 8 && x.tag >= 8), `${tag}: a row is cramped ${JSON.stringify(pad)}`);
  check(Math.max(...over.tall) <= 72, `${tag}: a row grew taller (${Math.max(...over.tall)})`);
  await shot('1-gate');

  if (phone) {
    // Dark, one list at a time, actions inside the window.
    const bg = await page.evaluate(() => getComputedStyle(document.querySelector('.gt')).backgroundColor);
    check(bg === 'rgb(3, 7, 18)', `${tag}: phone is not dark (${bg})`);
    check(!(await visible(page, '[data-testid="gate-events"]')), `${tag}: arrivals shown next to the expected list`);
    const act = await page.getByTestId('gate-remind-all').boundingBox();
    check(act && act.y + act.height <= vp.height, `${tag}: Remind button is below the window`);
    const targets = await page.evaluate(() => [...document.querySelectorAll('.gt-bell, .gt-tabs button, .gt-mode button, .gt-back, .gt-icon')].filter((e) => e.getBoundingClientRect().width > 0).map((e) => { const b = e.getBoundingClientRect(); return [e.className, Math.round(b.width), Math.round(b.height)]; }).filter(([, w, h]) => h < 36 || w < 36));
    check(targets.length === 0, `${tag}: small touch targets ${JSON.stringify(targets)}`);
    await page.getByTestId('gate-tab-events').click();
    check((await texts(page, '[data-testid="gate-events"] .gt-event-at'))[0] === '07:23', `${tag}: newest arrival is not first`);
    check(!(await visible(page, '[data-testid="gate-waiting"]')), `${tag}: expected list still shown`);
    await shot('2-arrived');
    await page.getByTestId('gate-tab-check').click();
    await page.getByTestId('gate-confirm').waitFor();
    await shot('3-check');
  } else {
    check(await visible(page, '[data-testid="gate-events"]') && await visible(page, '[data-testid="gate-checks"]'), `${tag}: desktop does not show all three columns`);
    await page.locator('.gt-chips button', { hasText: 'Late 2' }).click();
    check((await page.locator('[data-testid="gate-waiting"] .gt-row').count()) === 2, `${tag}: Late filter`);
    await page.locator('.gt-chips button', { hasText: 'All 7' }).click();
  }

  // Confirm the check-in that waits for a yes.
  await page.getByTestId('gate-confirm').click();
  await page.getByText('Nothing to check', { exact: false }).first().waitFor({ state: phone ? 'visible' : 'attached', timeout: 5000 });
  check(state.confirmed, `${tag}: review was not sent`);
  await quiet(page);
  if (phone) await page.locator('.gt-tabs button').first().click();

  // One person: details, remind.
  await page.locator('.gt-row-main').first().click();
  await page.getByTestId('gate-sheet').waitFor();
  check((await page.getByTestId('gate-sheet').innerText()).includes('24 min late'), `${tag}: person sheet has no status`);
  const sb = await page.getByTestId('gate-sheet').boundingBox();
  check(sb.x >= 0 && sb.x + sb.width <= vp.width + 1 && sb.y + sb.height <= vp.height + 1, `${tag}: sheet leaves the window ${JSON.stringify(sb)}`);
  await shot('4-person');
  await page.getByRole('button', { name: 'Remind now' }).click();
  await page.getByTestId('gate-sheet').waitFor({ state: 'detached' });
  check(JSON.stringify(state.nudges.at(-1)) === JSON.stringify({ kind: 'in', userIds: ['1'] }), `${tag}: nudge body ${JSON.stringify(state.nudges.at(-1))}`);
  await page.getByText('Reminded just now').first().waitFor();
  await quiet(page);

  // Remind all: the late and the about-to-be-late with reminders on, minus the one already reminded.
  check((await page.getByTestId('gate-remind-all').innerText()).trim() === 'Remind all 3', `${tag}: remind-all label "${await page.getByTestId('gate-remind-all').innerText()}"`);
  await page.getByTestId('gate-remind-all').click();
  await page.getByTestId('gate-send').waitFor();
  check((await page.getByTestId('gate-sheet').innerText()).includes('1 person has reminders off'), `${tag}: no word about reminders off`);
  await shot('5-remind-all');
  await page.getByTestId('gate-send').click();
  await page.getByTestId('gate-sheet').waitFor({ state: 'detached' });
  check(JSON.stringify([...state.nudges.at(-1).userIds].sort()) === JSON.stringify(['2', '3', '4']), `${tag}: remind-all ids ${JSON.stringify(state.nudges.at(-1))}`);
  await page.getByTestId('gate-remind-all').getByText('All reminded').waitFor();
  await quiet(page);

  // Leaving: who is still inside at 16:10, who left.
  state.leaving = true;
  await page.getByTestId('gate-leaving').click();
  await page.reload();
  await page.getByTestId('gate-waiting').waitFor();
  await page.getByTestId('gate-leaving').click();
  await page.getByText('5 still inside').first().waitFor({ timeout: 5000 });
  check((await page.locator('.gt-ring-text').innerText()).replace(/\s+/g, ' ') === '2 of 7 left', `${tag}: leaving ring "${await page.locator('.gt-ring-text').innerText()}"`);
  check((await texts(page, '[data-testid="gate-waiting"] .gt-tag'))[0] === '10 min over', `${tag}: leaving order`);
  await shot('6-leaving');

  // Back to the dashboard.
  await page.getByTestId('gate-back').click();
  await page.getByTestId('open-gate').waitFor({ timeout: 8000 });
  await ctx.close();
}

async function main() {
  const preview = spawn('node', ['node_modules/vite/bin/vite.js', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'ignore' });
  try {
    for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE)).ok) break; } catch { /* not up yet */ } await new Promise((r) => setTimeout(r, 250)); }
    const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
    for (const vp of [
      { name: 'phone', width: 390, height: 780, theme: 'light', mobile: true },
      { name: 'small', width: 360, height: 640, theme: 'light', mobile: true },
      { name: 'tablet', width: 820, height: 1180, theme: 'light', mobile: true },
      { name: 'desktop', width: 1440, height: 900, theme: 'light' },
      { name: 'desktop', width: 1440, height: 900, theme: 'dark' },
    ]) {
      if (process.env.ONLY && !`${vp.name}-${vp.theme}`.includes(process.env.ONLY)) continue; // ONLY=desktop-dark for one size
      await run(browser, vp);
      console.log(`ok ${vp.name}-${vp.theme}`);
    }
    await browser.close();
    console.log(`Gate view passed. Screenshots in ${OUT}`);
  } finally {
    preview.kill();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
