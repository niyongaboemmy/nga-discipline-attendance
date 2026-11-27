// Real-browser check of Staff attendance reports (/staff/clock/reports) against a
// mocked API: the ways in, every period, the headline numbers, the nine reports,
// the preview window, and real PDF / Excel downloads (opened and checked).
// Invented people only.
//
//   cd client && npm run build && npm i --no-save playwright
//   node e2e-clock/reports.mjs        # OUT=<dir>, CHROME=<path>, ONLY=<name-theme>

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const OUT = process.env.OUT || path.resolve('e2e-clock/out');
const PORT = Number(process.env.PORT || 4797);
const BASE = `http://localhost:${PORT}`;
mkdirSync(OUT, { recursive: true });
const require = createRequire(import.meta.url);

const PERMS = ['STAFF_ATTENDANCE_CLOCK', 'STAFF_ATTENDANCE_VIEW_OWN', 'STAFF_ATTENDANCE_VIEW_ALL', 'STAFF_ATTENDANCE_ZONES_MANAGE', 'STAFF_DEVICES_MANAGE', 'STAFF_CLOCK_SCAN', 'REPORTS_VIEW', 'USERS_VIEW'];
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const TOKEN = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ id: '900', name: 'Test Leader', role: 'admin', tid: 1, tslug: 'demo', exp: 4102444800 })}.sig`;
// A small logo, so the documents are made with an image in the header.
const LOGO = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 40 40"><circle cx="20" cy="20" r="18" fill="#1d4ed8"/><path d="M12 26 20 12l8 14z" fill="#fff"/></svg>').toString('base64')}`;

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exitCode = 1;
  throw new Error(msg);
}
const check = (cond, msg) => { if (!cond) fail(msg); };

// ---- the mocked period: 14 invented people, weekdays, a few late / absent / early -------
const TODAY = '2026-11-26';
const NAMES = ['One Alpha', 'Two Bravo', 'Three Charlie', 'Four Delta', 'Five Echo', 'Six Foxtrot With A Very Long Name Indeed', 'Seven Golf', 'Eight Hotel', 'Nine India', 'Ten Juliet', 'Eleven Kilo', 'Twelve Lima', 'Thirteen Mike', 'Fourteen November'];
const add = (d, n) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const dow = (d) => new Date(`${d}T12:00:00Z`).getUTCDay();
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);
function period(from, to, preset) {
  if (to > TODAY) to = TODAY;
  const entries = [];
  const days = [];
  for (let d = from; d <= to; d = add(d, 1)) {
    const today = d === TODAY;
    const day = { date: d, kind: 'off', today, expected: 0, present: 0, onTime: 0, late: 0, absent: 0, notIn: 0, earlyLeave: 0, noCheckout: 0, rate: null };
    if (dow(d) !== 0 && dow(d) !== 6) {
      day.kind = 'school';
      NAMES.forEach((_, i) => {
        const seed = (Number(d.slice(8)) * 7 + i * 13) % 23;
        const id = String(i + 1);
        const base = { date: d, userId: id, start: '07:30', end: '16:00', own: i === 5, expectedMinutes: 510, invalid: false, extra: false };
        if (seed === 3 || (today && i > 8)) { entries.push({ ...base, status: today ? 'not_in' : 'absent', in: null, out: null, lateBy: 0, earlyBy: 0, outState: null, minutes: null, source: null, flags: [], needsReview: false, distance: null }); today ? (day.notIn += 1) : (day.absent += 1); return; }
        const late = seed === 5 || seed === 11;
        const inM = late ? 450 + 8 + seed * 2 : 425 + (seed % 20);
        const early = seed === 7;
        const noOut = !today && seed === 9;
        const outM = today || noOut ? null : early ? 890 : 962 + (seed % 12);
        entries.push({ ...base, status: late ? 'late' : 'on_time', in: hhmm(inM), out: outM ? hhmm(outM) : null, lateBy: late ? inM - 450 : 0, earlyBy: early ? 70 : 0, outState: today ? 'open' : noOut ? 'missing' : early ? 'early' : 'on_time', minutes: outM ? outM - inM : null, source: i === 9 ? 'card' : 'device', flags: seed === 13 ? ['weak_location'] : [], needsReview: seed === 13, distance: 20 + seed });
        late ? (day.late += 1) : (day.onTime += 1);
        if (early) day.earlyLeave += 1;
        if (noOut) day.noCheckout += 1;
      });
      day.present = day.onTime + day.late;
      day.expected = day.present + day.absent;
      day.rate = pct(day.present, day.expected);
    }
    days.push(day);
  }
  const persons = NAMES.map((n, i) => {
    const mine = entries.filter((e) => e.userId === String(i + 1));
    const came = mine.filter((e) => e.in);
    const late = came.filter((e) => e.status === 'late');
    const hrs = came.filter((e) => e.minutes != null);
    const absent = mine.filter((e) => e.status === 'absent').length;
    const avg = (l) => (l.length ? hhmm(Math.round(l.reduce((a, b) => a + b, 0) / l.length)) : null);
    const m = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
    return { userId: String(i + 1), name: `Person ${n}`, role: i % 5 === 0 ? 'Administrator' : 'Teacher', own: i === 5, expectedDays: came.length + absent, present: came.length, onTime: came.length - late.length, late: late.length, absent,
      earlyLeave: came.filter((e) => e.outState === 'early').length, noCheckout: came.filter((e) => e.outState === 'missing').length, extraDays: 0, lateMinutes: late.reduce((a, e) => a + e.lateBy, 0),
      minutesWorked: hrs.reduce((a, e) => a + e.minutes, 0), daysWithHours: hrs.length, expectedMinutes: hrs.length * 510, avgIn: avg(came.map((e) => m(e.in))), avgOut: avg(came.filter((e) => e.out).map((e) => m(e.out))),
      rate: pct(came.length, came.length + absent), punctuality: pct(came.length - late.length, came.length), longestAbsence: absent ? 1 : 0 };
  });
  const school = days.filter((d) => d.kind === 'school');
  const came = entries.filter((e) => e.in);
  const late = came.filter((e) => e.status === 'late');
  const hrs = came.filter((e) => e.minutes != null);
  const present = came.length;
  const absent = school.reduce((a, d) => a + d.absent, 0);
  const worked = hrs.reduce((a, e) => a + e.minutes, 0);
  const kpis = { staff: NAMES.length, schoolDays: school.length, expected: present + absent, present, onTime: present - late.length, late: late.length, absent, notInToday: school.filter((d) => d.today).reduce((a, d) => a + d.notIn, 0),
    rate: pct(present, present + absent), punctuality: pct(present - late.length, present), earlyLeave: came.filter((e) => e.outState === 'early').length, noCheckout: came.filter((e) => e.outState === 'missing').length,
    avgIn: present ? '07:18' : null, avgLateMinutes: late.length ? Math.round(late.reduce((a, e) => a + e.lateBy, 0) / late.length) : null, minutesWorked: worked, avgMinutesPerDay: hrs.length ? Math.round(worked / hrs.length) : null,
    needsReview: came.filter((e) => e.needsReview).length, invalid: 0, cardCheckIns: came.filter((e) => e.source === 'card').length, perfect: persons.filter((p) => p.expectedDays && !p.absent && !p.late).length };
  return { from, to, today: TODAY, trackingFrom: '2026-09-07', preset, kpis, days, persons, entries };
}
function reportsData(q) {
  const preset = q.get('preset');
  const named = { today: [TODAY, TODAY], yesterday: [add(TODAY, -1), add(TODAY, -1)], week: ['2026-11-23', TODAY], month: ['2026-11-01', TODAY], term: ['2026-09-07', TODAY] }[preset];
  const [from, to] = named ?? [q.get('from') ?? TODAY, q.get('to') ?? q.get('from') ?? TODAY];
  const span = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1;
  const prev = period(add(from, -span), add(from, -1), 'custom');
  return { ...period(from, to, named ? preset : 'custom'), previous: { from: prev.from, to: prev.to, kpis: prev.kpis }, term: { name: 'Term 1', start: '2026-09-07', end: '2026-12-11' }, rosterSource: 'mis',
    rules: { lateAfter: '07:30', earlyLeaveBefore: '16:00', enabled: true }, serverNow: '2026-11-26T08:00:00.000Z' };
}

async function context(browser, { width, height, theme, mobile = false }) {
  const state = { asked: [] };
  const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: theme, deviceScaleFactor: 2, isMobile: mobile, hasTouch: mobile, acceptDownloads: true });
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
    const ok = (data) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data }) });
    if (p === '/api/sso/verify-mis') return route.fulfill({ status: 200, contentType: 'application/json', body: '{"success":true}' });
    if (p === '/api/roles-permissions/me') return ok({ permissionKeys: PERMS });
    if (p === '/api/staff/clock/reports/data') { state.asked.push(u.search); return ok(reportsData(u.searchParams)); }
    if (p === '/api/staff/clock/document-brand') return ok({ name: 'Demo School', logo: LOGO });
    // The document letterhead (header and footer on every PDF page) reads the school's branding.
    if (p === '/api/sso/branding') return ok({ tid: 1, name: 'Demo School', logoUrl: null, documentsLogoUrl: LOGO, documentsFooterUrl: LOGO, documentsFooterText: 'PO Box 1, Demo Town' });
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

/** Clicks a download button and returns the saved file's path. */
async function grab(page, locator, name) {
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), locator.click()]);
  const file = path.join(OUT, name ?? dl.suggestedFilename());
  await dl.saveAs(file);
  return { file, suggested: dl.suggestedFilename() };
}

async function run(browser, vp) {
  const tag = `reports-${vp.name}-${vp.theme}`;
  const { ctx, page, state } = await context(browser, vp);
  const shot = async (n) => { await quiet(page); await page.waitForTimeout(250); await page.screenshot({ path: path.join(OUT, `${tag}-${n}.png`), fullPage: n.endsWith('full') }); };
  const sentence = () => page.getByTestId('rp-sentence').innerText();
  const settle = async (text) => { await page.waitForFunction((t) => document.querySelector('[data-testid="rp-sentence"]')?.textContent?.includes(t) && !document.querySelector('.rp-stale'), text, { timeout: 15000 }).catch(() => fail(`${tag}: the period never became "${text}"`)); };

  await page.goto(`${BASE}/staff/clock/reports`);
  await page.getByTestId('rp-summary').waitFor({ timeout: 20000 });
  await quiet(page);
  // Today is the default period.
  check((await page.locator('.rp-mode[aria-pressed="true"]').innerText()) === 'Today', `${tag}: Today is not the default period`);
  check((await sentence()).includes('Thursday, 26 November 2026'), `${tag}: the period sentence does not name today`);
  check(state.asked[0] === '?preset=today', `${tag}: the first request was ${state.asked[0]}`);
  check((await page.locator('.rp-kpi').count()) === 10, `${tag}: expected 10 headline numbers`);
  check((await page.locator('.rp-report').count()) === 9, `${tag}: expected 9 reports`);
  check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${tag}: the page scrolls sideways`);
  // The tab is there (the way in from the dashboard's tabs).
  check(await page.locator('.sc-tab.active', { hasText: 'Reports' }).isVisible(), `${tag}: no active Reports tab`);
  await shot('01-today-full');

  // Every period: the request, then the sentence.
  for (const [mode, ask, text] of [['yesterday', '?preset=yesterday', 'Wednesday, 25 November 2026'], ['week', '?preset=week', '23 Nov 2026 to 26 Nov 2026'], ['month', '?preset=month', '1 Nov 2026 to 26 Nov 2026'], ['term', '?preset=term', '7 Sept 2026 to 26 Nov 2026']]) {
    await page.locator(`.rp-mode[data-mode="${mode}"]`).click();
    // en-GB writes September as "Sept" in some engines and "Sep" in others.
    await settle(text.split(' 2026')[0].replace('Sept', 'Sep'));
    const s = (await sentence()).replace('Sept', 'Sep');
    check(s.includes(text.replace('Sept', 'Sep')), `${tag}: ${mode} shows "${s}"`);
    check(state.asked.at(-1) === ask, `${tag}: ${mode} asked ${state.asked.at(-1)}`);
  }
  await shot('02-term-full');
  check((await page.locator('.rp-bar').count()) > 40, `${tag}: the term has no day bars`);

  // A date, then a range.
  await page.locator('.rp-mode[data-mode="date"]').click();
  await page.getByTestId('rp-date').fill('2026-11-20');
  await settle('Friday, 20 November 2026');
  check(state.asked.at(-1) === '?from=2026-11-20&to=2026-11-20', `${tag}: a date asked ${state.asked.at(-1)}`);
  await page.locator('.rp-mode[data-mode="range"]').click();
  await page.getByTestId('rp-from').fill('2026-11-09');
  await page.getByTestId('rp-to').fill('2026-11-20');
  await settle('9 Nov 2026 to 20 Nov 2026');
  check(state.asked.at(-1) === '?from=2026-11-09&to=2026-11-20', `${tag}: a range asked ${state.asked.at(-1)}`);
  // A start after the end pulls the end along (never an upside-down period).
  await page.getByTestId('rp-from').fill('2026-11-24');
  await settle('Tuesday, 24 November 2026');
  await page.getByTestId('rp-from').fill('2026-11-09');
  await page.getByTestId('rp-to').fill('2026-11-20');
  await settle('9 Nov 2026 to 20 Nov 2026');
  await shot('03-range');

  // A headline number opens the report behind it.
  await page.locator('.rp-kpi[data-kpi="late"] .rp-kpi-main').click();
  const win = page.getByTestId('rp-preview');
  await win.waitFor();
  check((await win.locator('h2').innerText()) === 'Late arrivals', `${tag}: the Late number did not open Late arrivals`);
  const lateRows = await win.locator('tbody tr').count();
  check(lateRows > 3, `${tag}: Late arrivals lists ${lateRows} lines`);
  await win.getByPlaceholder('Search this report').fill('Person Two');
  await page.waitForTimeout(450); // the window's opening animation overshoots for a moment
  const found = await win.locator('tbody tr').count();
  check(found > 0 && found < lateRows, `${tag}: searching the report did not narrow it (${found} of ${lateRows})`);
  { const box = await page.evaluate(() => { const d = document.querySelector('[data-testid="rp-preview"]').getBoundingClientRect(); return { l: Math.round(d.left), r: Math.round(d.right), w: window.innerWidth, wide: [...document.querySelectorAll('[data-testid="rp-preview"] *')].filter((e) => e.getBoundingClientRect().right > window.innerWidth + 1 && !e.closest('.rp-table-wrap')).slice(0, 4).map((e) => e.className) }; }); check(box.l >= 0 && box.r <= box.w + 1, `${tag}: the preview window leaves the screen ${JSON.stringify(box)}`); }
  await shot('04-preview-late');
  await page.keyboard.press('Escape');
  check((await page.getByTestId('rp-preview').count()) === 0, `${tag}: Escape did not close the preview`);

  // Look at the register from its card.
  await page.locator('.rp-report[data-report="register"] [data-act="preview"]').click();
  await win.waitFor();
  check((await win.locator('thead th').count()) === 11, `${tag}: the register should have 11 columns`);
  await shot('05-preview-register');
  await win.getByRole('button', { name: 'Close' }).click();

  if (vp.downloads) {
    const ExcelJS = require('exceljs');
    // One report as PDF.
    const a = await grab(page, page.locator('.rp-report[data-report="late"] [data-act="pdf"]'));
    check(a.suggested === 'staff-attendance-late-2026-11-09-to-2026-11-20.pdf', `${tag}: PDF named ${a.suggested}`);
    const pdf = readFileSync(a.file);
    check(pdf.subarray(0, 5).toString() === '%PDF-' && pdf.length > 8000, `${tag}: the PDF is not a PDF (${pdf.length} bytes)`);
    check(pdf.includes('/Subtype /Image'), `${tag}: the PDF has no letterhead image`);
    await page.getByText('Late arrivals (PDF) downloaded').waitFor({ timeout: 5000 }).catch(() => fail(`${tag}: no toast after the PDF`));
    // One report as Excel, opened and read back.
    const b = await grab(page, page.locator('.rp-report[data-report="staff"] [data-act="xlsx"]'));
    check(b.suggested === 'staff-attendance-staff-2026-11-09-to-2026-11-20.xlsx', `${tag}: Excel named ${b.suggested}`);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(b.file);
    const ws = wb.worksheets[0];
    check(ws.name === 'Staff summary', `${tag}: sheet named ${ws.name}`);
    check(String(ws.getCell(1, 2).value) === 'Demo School', `${tag}: the sheet is not headed with the school (${ws.getCell(1, 2).value})`);
    check(String(ws.getCell(7, 1).value) === 'Staff' && ws.rowCount === 7 + 14, `${tag}: the staff sheet has ${ws.rowCount} rows`);
    check(wb.model.media?.length === 1, `${tag}: the workbook has no logo`);
    // The headline numbers: PDF and Excel.
    const c = await grab(page, page.getByTestId('rp-summary-pdf'));
    check(c.suggested === 'staff-attendance-summary-2026-11-09-to-2026-11-20.pdf' && statSync(c.file).size > 8000, `${tag}: summary PDF ${c.suggested}`);
    const d = await grab(page, page.getByTestId('rp-summary-xlsx'));
    const wb2 = new ExcelJS.Workbook();
    await wb2.xlsx.readFile(d.file);
    check(wb2.worksheets.map((w) => w.name).join('|') === 'Attendance summary|Day by day', `${tag}: summary workbook sheets: ${wb2.worksheets.map((w) => w.name)}`);
    check(String(wb2.worksheets[0].getCell(10, 1).value) === 'Attendance', `${tag}: the summary sheet's third measure is ${wb2.worksheets[0].getCell(10, 1).value}`);
    // The details behind one number.
    const e = await grab(page, page.locator('.rp-kpi[data-kpi="absent"] [data-act="kpi-xlsx"]'));
    check(e.suggested === 'staff-attendance-absent-2026-11-09-to-2026-11-20.xlsx', `${tag}: KPI details named ${e.suggested}`);
    // Everything in one workbook.
    const f = await grab(page, page.getByTestId('rp-all-xlsx'));
    const wb3 = new ExcelJS.Workbook();
    await wb3.xlsx.readFile(f.file);
    check(wb3.worksheets.length === 9, `${tag}: "All reports" has ${wb3.worksheets.length} sheets`);
    check(f.suggested === 'staff-attendance-all-2026-11-09-to-2026-11-20.xlsx', `${tag}: all reports named ${f.suggested}`);
    // From inside the preview window.
    await page.locator('.rp-report[data-report="hours"] [data-act="preview"]').click();
    const g = await grab(page, page.getByTestId('rp-preview-pdf'));
    check(g.suggested === 'staff-attendance-hours-2026-11-09-to-2026-11-20.pdf', `${tag}: preview PDF named ${g.suggested}`);
    await page.keyboard.press('Escape');
  }

  // Idle: the page must not keep asking the server.
  const before = state.asked.length;
  await page.waitForTimeout(1500);
  check(state.asked.length === before, `${tag}: ${state.asked.length - before} requests while idle`);
  await ctx.close();
}

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900, theme: 'light', downloads: true },
  { name: 'desktop', width: 1440, height: 900, theme: 'dark' },
  { name: 'tablet', width: 834, height: 1112, theme: 'light' },
  { name: 'phone', width: 390, height: 844, theme: 'light', mobile: true },
  { name: 'phone', width: 360, height: 740, theme: 'dark', mobile: true },
];

async function main() {
  const preview = spawn('node', ['node_modules/vite/bin/vite.js', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'ignore' });
  try {
    for (let i = 0; i < 40; i++) {
      try { if ((await fetch(`${BASE}/`)).ok) break; } catch { /* not yet */ }
      await new Promise((r) => setTimeout(r, 250));
    }
    const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
    for (const vp of VIEWPORTS) {
      if (process.env.ONLY && process.env.ONLY !== `${vp.name}-${vp.theme}`) continue;
      await run(browser, vp);
      console.log(`ok ${vp.name}-${vp.theme}`);
    }
    await browser.close();
    console.log(`Staff attendance reports passed. Screenshots and files in ${OUT}`);
  } finally {
    preview.kill();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
