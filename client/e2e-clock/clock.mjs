// Real-browser walk-through of the staff clock page (/c/<school>) against a mocked
// API and a stand-in Google button: every screen of the flow on a phone, a small
// phone and a tablet (landscape + portrait), light and dark, with screenshots.
//
//   cd client && npm run build && npm i --no-save playwright
//   node e2e-clock/clock.mjs            # OUT=<dir> for screenshots, CHROME=<path> for a browser
//
// Exits non-zero on the first failed expectation.

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const OUT = process.env.OUT || path.resolve('e2e-clock/out');
const PORT = Number(process.env.PORT || 4791);
const BASE = `http://localhost:${PORT}`;
mkdirSync(OUT, { recursive: true });

const PHONE_UA = 'Mozilla/5.0 (Linux; Android 13; TECNO KI5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';
const TABLET_UA = 'Mozilla/5.0 (Linux; Android 14; SM-X210) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const SCHOOL = { lat: -1.95362, lng: 30.10441 };
const INSIDE = { latitude: -1.95326, longitude: 30.10441, accuracy: 18 };
const FAR = { latitude: -1.94282, longitude: 30.10441, accuracy: 15 };

const VIEWPORTS = [
  { name: 'phone', width: 390, height: 844, ua: PHONE_UA, mobile: true },
  { name: 'phone-320', width: 320, height: 640, ua: PHONE_UA, mobile: true },
  { name: 'tablet-land', width: 1194, height: 834, ua: TABLET_UA, mobile: false },
  { name: 'tablet-port', width: 834, height: 1194, ua: TABLET_UA, mobile: false },
];

const GIS_STUB = `
window.google = { accounts: { id: {
  _cb: null,
  initialize(o) { this._cb = o.callback; },
  disableAutoSelect() {},
  renderButton(el, o) {
    el.innerHTML = '';
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = 'Continue with Google';
    b.setAttribute('data-testid', 'gis');
    b.style.cssText = 'height:44px;border-radius:999px;border:1px solid #dadce0;background:' + (o.theme === 'filled_black' ? '#131314;color:#e3e3e3' : '#fff;color:#1f1f1f') + ';font:500 15px Roboto,Arial,sans-serif;width:' + o.width + 'px';
    b.onclick = () => this._cb({ credential: 'fake.google.credential' });
    el.appendChild(b);
  },
} } };`;

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exitCode = 1;
  throw new Error(msg);
}
async function expectText(page, text, label) {
  try {
    await page.getByText(text, { exact: false }).first().waitFor({ timeout: 6000 });
  } catch {
    await page.screenshot({ path: path.join(OUT, `FAILED-${label.replace(/\W+/g, '-')}.png`) }).catch(() => {});
    fail(`${label}: "${text}" not visible`);
  }
}

/** A mocked /api/clock/nga backend with just enough state. */
function mockServer(opts = {}) {
  const st = { tap: 'waiting', tapError: null, registered: !!opts.registered, deviceStatus: opts.deviceStatus || 'active', checkIn: opts.checkIn || null, checkOut: null, now: '2026-11-24T05:42:00.000Z', revoked: !!opts.revoked };
  const person = { name: opts.name || 'Grace Mukamana', firstName: (opts.name || 'Grace Mukamana').split(' ')[0], initials: 'GM', role: 'Teacher' };
  const day = () => ({
    serverNow: st.now, schoolDate: '2026-11-24', timezone: 'Africa/Kigali', schoolDay: true,
    next: opts.dayOff ? 'closed' : st.checkOut ? 'done' : st.checkIn ? 'check_out' : 'check_in', checkoutOpensAt: null, opensAt: '05:00',
    dayOff: !!opts.dayOff, dayOffClosed: !!opts.dayOff, nextDay: opts.dayOff ? { date: '2026-11-26', start: '10:00' } : null,
    myWeek: { own: !!opts.dayOff, days: Object.fromEntries(['0', '1', '2', '3', '4', '5', '6'].map((d) => [d, { works: opts.dayOff ? d === '4' || d === '1' : d !== '0' && d !== '6', start: opts.dayOff ? '10:00' : '08:30', end: opts.dayOff ? '14:00' : '16:00' }])) },
    missedOut: opts.missed && !st.claimed ? { date: '2026-11-23', checkIn: '07:35' } : null,
    today: st.checkIn ? { checkIn: st.checkIn, checkOut: st.checkOut, status: 'present', outStatus: st.checkOut ? 'on_time' : null, minutesAtSchool: st.checkOut ? 508 : 0 } : null,
    week: [
      { date: '2026-11-23', isToday: false, future: false, checkIn: opts.fresh ? null : '07:35', checkOut: opts.fresh ? null : '16:05', status: opts.fresh ? null : 'present' },
      { date: '2026-11-24', isToday: true, future: false, checkIn: st.checkIn, checkOut: st.checkOut, status: st.checkIn ? 'present' : null },
      { date: '2026-11-25', isToday: false, future: true, checkIn: null, checkOut: null, status: null },
      { date: '2026-11-26', isToday: false, future: true, checkIn: null, checkOut: null, status: null },
      { date: '2026-11-27', isToday: false, future: true, checkIn: null, checkOut: null, status: null },
    ],
  });
  const ok = (data) => ({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data }) });
  const err = (status, code, message, extra = {}) => ({ status, contentType: 'application/json', body: JSON.stringify({ success: false, code, message, ...extra }) });
  return async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    const p = u.pathname.replace('/api/clock/nga', '');
    const body = req.postData() ? JSON.parse(req.postData()) : {};
    if (p === '/bootstrap') {
      return route.fulfill(ok({ school: { name: 'New Generation Academy', slug: 'nga', logoUrl: 'https://mis.example/logo.svg' }, open: true, googleClientId: 'test.apps.googleusercontent.com', serverNow: st.now, schoolDate: '2026-11-24', timezone: 'Africa/Kigali', profileUrl: 'https://mis.example/profile#staff-attendance',
        rules: { opens: '05:00', lateAfter: '08:30', earlyLeaveBefore: '16:00', minShiftMinutes: 60, maxAccuracy: 100, requireZone: true, weakMaxAccuracy: opts.weak ? 500 : 0 },
        zones: [{ id: 1, name: 'Main campus', kind: 'circle', lat: SCHOOL.lat, lng: SCHOOL.lng, radius: 150 }], pushKey: opts.push ? 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U' : null }));
    }
    if (p === '/register') {
      if (opts.noAccount) return route.fulfill(err(404, 'NO_ACCOUNT', 'No staff account', { email: 'grace.phone@gmail.com' }));
      if (!body.confirm) return route.fulfill(ok({ preview: true, deviceStatus: st.deviceStatus, replaces: false, person, email: opts.email || 'grace.mukamana@gmail.com' }));
      st.registered = true;
      return route.fulfill(ok({ deviceToken: 'tok_' + 'x'.repeat(40), deviceStatus: st.deviceStatus, replaced: false, person, email: 'grace.mukamana@gmail.com' }));
    }
    if (st.revoked) return route.fulfill(err(401, 'DEVICE_REVOKED', 'removed'));
    if (p === '/me') {
      return route.fulfill(ok({ ...day(), school: { name: 'New Generation Academy', slug: 'nga' }, open: true, person, email: 'grace.mukamana@gmail.com',
        device: { status: st.deviceStatus, label: opts.formFactor === 'desktop' ? 'MacBook · Chrome' : 'Samsung A15 · Chrome', formFactor: opts.formFactor || 'phone', registeredAt: '2026-11-24T05:40:00.000Z' },
        rules: opts.own ? { lateAfter: '10:00', earlyLeaveBefore: '14:00', minShiftMinutes: 60, own: true } : { lateAfter: '08:30', earlyLeaveBefore: '16:00', minShiftMinutes: 60 } }));
    }
    if (p === '/missed-checkout') { st.claimed = body.time; return route.fulfill(ok(day())); }
    if (p === '/calendar') {
      // One month of the person's days: weekdays 08:30-16:00 (or Mon + Thu 10:00-14:00 with own hours), the 18th closed.
      const month = u.searchParams.get('month') || '2026-11';
      const days = [];
      const sum = { workDays: 0, worked: 0, late: 0, absent: 0, daysOff: 0, plannedMinutes: 0, left: 0 };
      for (let d = new Date(`${month}-01T12:00:00Z`); d.toISOString().slice(0, 7) === month; d.setUTCDate(d.getUTCDate() + 1)) {
        const date = d.toISOString().slice(0, 10);
        const wd = d.getUTCDay();
        const closed = date === '2026-11-18';
        const works = !closed && (opts.dayOff ? wd === 1 || wd === 4 : wd !== 0 && wd !== 6);
        const past = date < '2026-11-24';
        const n = d.getUTCDate();
        const kind = closed ? 'closed' : !works ? 'off' : date === '2026-11-24' ? (st.checkIn ? 'on_time' : 'today') : !past ? 'planned' : n === 5 ? 'absent' : n % 6 === 0 ? 'late' : 'on_time';
        const came = kind === 'on_time' || kind === 'late';
        days.push({ date, kind, start: works ? (opts.dayOff ? '10:00' : '08:30') : null, end: works ? (opts.dayOff ? '14:00' : '16:00') : null,
          in: came ? (kind === 'late' ? '08:47' : date === '2026-11-24' ? st.checkIn : '07:3' + (n % 10)) : null, out: came && past && n !== 23 ? '16:1' + (n % 10) : null, early: false, noOut: came && n === 23, own: !!opts.dayOff });
        if (works) { sum.workDays++; sum.plannedMinutes += opts.dayOff ? 240 : 450; if (!past && !came) sum.left++; } else sum.daysOff++;
        if (came) sum.worked++;
        if (kind === 'late') sum.late++;
        if (kind === 'absent') sum.absent++;
      }
      return route.fulfill(ok({ month, today: '2026-11-24', min: '2025-11', max: '2027-05', days, summary: sum }));
    }
    if (p === '/challenge') return route.fulfill(ok({ nonce: 'n' + Math.random().toString(36).slice(2), expiresIn: 60, serverNow: st.now }));
    if (p === '/punch') {
      const d = Math.abs(body.position.lat - SCHOOL.lat) * 111195;
      if (d > 200) return route.fulfill(err(403, 'OUTSIDE_ZONE', 'outside', { distance: Math.round(d), outsideBy: Math.round(d - 150) }));
      if (!body.signature || body.signature.length < 80) return route.fulfill(err(401, 'BAD_SIGNATURE', 'bad sig'));
      if (!st.checkIn) {
        st.checkIn = '07:42';
        return route.fulfill(ok({ action: 'check_in', at: '07:42', status: 'present', distance: 40, zone: 'Main campus', flags: [], state: day() }));
      }
      st.checkOut = '16:10';
      st.now = '2026-11-24T14:10:00.000Z';
      return route.fulfill(ok({ action: 'check_out', at: '16:10', status: 'on_time', distance: 35, zone: 'Main campus', flags: [], state: day() }));
    }
    // Check in from a computer with a phone (QR code).
    if (p === '/phone-tap' && req.method() === 'POST') {
      if (!body.signature || body.signature.length < 80) return route.fulfill(err(401, 'BAD_SIGNATURE', 'bad sig'));
      st.tap = 'waiting';
      return route.fulfill(ok({ code: 'ptapcode12345678', url: `${BASE}/c/nga/tap/ptapcode12345678`, expiresIn: 120 }));
    }
    if (p === '/phone-tap/ptapcode12345678') {
      return route.fulfill(ok({ state: st.tap, expiresIn: 100, error: st.tapError,
        result: st.tap === 'done' ? { action: 'check_in', at: '07:42', status: 'present', distance: 40, zone: 'Main campus', flags: ['phone_location'] } : null,
        dayState: st.tap === 'done' ? day() : null }));
    }
    if (p === '/tap/ptapcode12345678' && req.method() === 'GET') {
      if (st.tap === 'done') return route.fulfill(err(404, 'TAP_EXPIRED', 'This code expired. Show a new one on the computer.'));
      st.tap = 'locating';
      return route.fulfill(ok({ school: { name: 'New Generation Academy', slug: 'nga' }, firstName: person.firstName, next: st.checkIn ? 'check_out' : 'check_in', expiresIn: 110 }));
    }
    if (p === '/tap/ptapcode12345678') {
      if (body.position.accuracy > 100) {
        st.tap = 'failed';
        st.tapError = { code: 'LOW_ACCURACY', message: 'not precise', data: { accuracy: Math.round(body.position.accuracy) } };
        return route.fulfill(err(422, 'LOW_ACCURACY', 'not precise', { accuracy: Math.round(body.position.accuracy) }));
      }
      st.tap = 'done';
      st.checkIn = '07:42';
      return route.fulfill(ok({ action: 'check_in', at: '07:42', status: 'present', distance: 40, zone: 'Main campus', flags: ['phone_location'] }));
    }
    return route.fulfill(err(404, 'NOPE', 'not mocked'));
  };
}

async function newPage(browser, vp, theme, { geo = INSIDE, grant = true, server } = {}) {
  const ctx = await browser.newContext({
    viewport: { width: vp.width, height: vp.height }, userAgent: vp.ua, isMobile: vp.mobile, hasTouch: true,
    colorScheme: theme, timezoneId: 'America/Los_Angeles', locale: 'en-GB', deviceScaleFactor: 2,
    geolocation: geo, permissions: grant ? ['geolocation'] : [],
  });
  await ctx.route('https://accounts.google.com/gsi/client', (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body: GIS_STUB }));
  await ctx.route('https://mis.example/logo.svg', (r) => r.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><circle cx="20" cy="20" r="18" fill="#1d4ed8"/><path d="M12 26 20 12l8 14z" fill="#fff"/></svg>' }));
  await ctx.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  await ctx.route('**/api/clock/nga/**', server ?? mockServer());
  if (!grant) {
    // A real first visit reports "prompt" (not asked yet); headless Chromium says "denied".
    await ctx.addInitScript(() => {
      const orig = navigator.permissions.query.bind(navigator.permissions);
      navigator.permissions.query = (d) => (d && d.name === 'geolocation' && !window.__geoGranted ? Promise.resolve({ state: 'prompt' }) : orig(d));
    });
  }
  const page = await ctx.newPage();
  page.on('pageerror', (e) => fail(`page error: ${e.message}`));
  return { ctx, page };
}

const shot = (page, name) => page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: false });

async function fullFlow(browser, vp, theme) {
  const tag = `${vp.name}-${theme}`;
  const { ctx, page } = await newPage(browser, vp, theme, { grant: false });
  await page.goto(`${BASE}/c/nga`);
  await expectText(page, 'Staff attendance', `${tag} welcome`);
  await page.getByTestId('gis').waitFor();
  await shot(page, `${tag}-01-welcome`);

  await page.getByTestId('gis').click();
  await expectText(page, vp.name.startsWith('tablet') ? 'Is this your tablet?' : 'Is this your phone?', `${tag} confirm`);
  await expectText(page, 'grace.mukamana@gmail.com', `${tag} confirm email`);
  await shot(page, `${tag}-02-confirm`);

  await page.getByRole('button', { name: /Yes, this is my/ }).click();
  await expectText(page, 'It confirms you are at school', `${tag} location primer`);
  await shot(page, `${tag}-03-location`);

  await ctx.grantPermissions(['geolocation']);
  await page.evaluate(() => { window.__geoGranted = true; });
  await page.getByRole('button', { name: 'Allow location' }).click();
  await expectText(page, 'At school', `${tag} ready chip`);
  await expectText(page, '07:42', `${tag} school clock`);
  await expectText(page, 'Good morning, Grace', `${tag} greeting`);
  await page.waitForTimeout(400);
  await shot(page, `${tag}-04-ready`);

  await page.getByRole('button', { name: /^Check in\./ }).click();
  await expectText(page, 'On time', `${tag} success`);
  await shot(page, `${tag}-05-success`);

  await page.getByRole('button', { name: 'OK' }).click();
  await expectText(page, 'In since 07:42', `${tag} checked in`);
  await page.waitForTimeout(300);
  await shot(page, `${tag}-06-checked-in`);

  await page.getByRole('button', { name: /^Check out\./ }).click();
  await expectText(page, 'Check out now?', `${tag} confirm out`);
  await page.waitForTimeout(400);
  await shot(page, `${tag}-07-confirm-out`);
  await page.getByRole('dialog').getByRole('button', { name: 'Check out' }).click();
  await expectText(page, 'Done for today', `${tag} done`);
  await expectText(page, 'In 07:42 · Out 16:10', `${tag} done times`);
  await page.waitForTimeout(2800); // let the toast go
  await shot(page, `${tag}-08-done`);

  await page.getByRole('button', { name: 'Help' }).click();
  await expectText(page, 'New, lost or shared phone', `${tag} help`);
  await page.getByRole('button', { name: 'New, lost or shared phone' }).click();
  await expectText(page, 'The office removes the old phone', `${tag} help device steps`);
  await page.waitForTimeout(300);
  await shot(page, `${tag}-09-help`);
  await ctx.close();
}

async function edgeStates(browser, vp, theme) {
  const tag = `${vp.name}-${theme}`;
  // A Gmail the school does not know: say how to add it, with a shortcut to the Amashuri profile.
  {
    const { ctx, page } = await newPage(browser, vp, theme, { grant: false, server: mockServer({ noAccount: true }) });
    await page.goto(`${BASE}/c/nga`);
    await page.getByTestId('gis').click();
    await page.getByTestId('no-account').waitFor();
    await expectText(page, 'grace.phone@gmail.com', `${tag} no account email`);
    await expectText(page, 'Not recognised', `${tag} no account chip`);
    if (!(await page.locator('.ck-logo-img img').first().evaluate((i) => i.complete && i.naturalWidth > 0))) fail(`${tag} school logo`);
    const link = page.getByRole('link', { name: 'Open my Amashuri profile' });
    if ((await link.getAttribute('href')) !== 'https://mis.example/profile#staff-attendance') fail(`${tag} profile link href`);
    await shot(page, `${tag}-no-account`);
    // Need help? opens the troubleshooter on the Gmail topic; another topic expands on tap.
    await page.getByRole('button', { name: 'Need help?' }).click();
    await expectText(page, 'What is happening?', `${tag} help pick`);
    await expectText(page, 'Type your Gmail in “Staff attendance”', `${tag} help gmail steps`);
    await page.getByRole('button', { name: 'Location is blocked' }).click();
    await expectText(page, 'Allow location for this site', `${tag} help location steps`);
    await shot(page, `${tag}-help`);
    await ctx.close();
  }
  // Registered device, far from school.
  {
    const { ctx, page } = await newPage(browser, vp, theme, { geo: FAR, server: mockServer({ registered: true }) });
    await page.goto(`${BASE}/c/nga`);
    await page.evaluate(async () => {
      // Seed a stored device the way the page does after registration.
      const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
      const full = await crypto.subtle.exportKey('jwk', keys.publicKey);
      await new Promise((res, rej) => {
        const r = indexedDB.open('tendo-clock', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('kv');
        r.onsuccess = () => {
          const tx = r.result.transaction('kv', 'readwrite');
          tx.objectStore('kv').put({ slug: 'nga', keys, publicJwk: { kty: full.kty, crv: full.crv, x: full.x, y: full.y }, token: 'tok_' + 'x'.repeat(40), registeredAt: new Date().toISOString() }, 'device:nga');
          tx.oncomplete = res;
          tx.onerror = rej;
        };
      });
      localStorage.setItem('tendo.clock.locPrimed', '1');
    });
    await page.reload();
    await expectText(page, 'from school', `${tag} outside`);
    await page.waitForTimeout(300);
    await shot(page, `${tag}-10-outside`);
    await ctx.close();
  }
  // Waiting for approval.
  {
    const { ctx, page } = await newPage(browser, vp, theme, { server: mockServer({ deviceStatus: 'pending' }) });
    await page.goto(`${BASE}/c/nga`);
    await page.getByTestId('gis').click();
    await page.getByRole('button', { name: /Yes, this is my/ }).click();
    await expectText(page, 'Waiting for your school', `${tag} pending`);
    await shot(page, `${tag}-11-pending`);
    await ctx.close();
  }
}

async function longName(browser, vp) {
  const server = mockServer({ fresh: true, name: 'Jean-Baptiste-Emmanuel Nshimiyimana Habyarimana', email: 'jb.nshimiyimana.habyarimana.teacher@gmail.com' });
  const { ctx, page } = await newPage(browser, vp, 'light', { server });
  await page.goto(`${BASE}/c/nga`);
  await page.getByTestId('gis').click();
  await expectText(page, 'jb.nshimiyimana.habyarimana.teacher@gmail.com', `${vp.name} long email`);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  if (overflow) fail(`${vp.name}: page scrolls sideways with a long name`);
  await shot(page, `${vp.name}-12-long-name-confirm`);
  await page.getByRole('button', { name: /Yes, this is my/ }).click();
  await expectText(page, 'Good morning, Jean-Baptiste-Emmanuel', `${vp.name} long greeting`);
  // A brand-new staff member gets the first-day guide.
  await expectText(page, 'How it works', `${vp.name} first-day guide`);
  await page.waitForTimeout(300);
  if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)) fail(`${vp.name}: daily screen scrolls sideways`);
  await shot(page, `${vp.name}-13-long-name-ready`);
  await page.getByRole('button', { name: 'Got it' }).click();
  if (await page.getByText('How it works').count()) fail(`${vp.name}: guide did not close`);
  await ctx.close();
}

/** A laptop (no GPS, ± 266 m): the QR panel opens by itself; a phone scans it and the check-in lands on the laptop. */
async function phoneTapFlow(browser, theme) {
  const tag = `laptop-${theme}`;
  const laptop = { name: 'laptop', width: 1280, height: 800, ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36', mobile: false };
  const server = mockServer({ formFactor: 'desktop', name: 'Tuyishimire Aline' });
  const { ctx, page } = await newPage(browser, laptop, theme, { server, geo: { ...INSIDE, accuracy: 266 } });
  await page.goto(`${BASE}/c/nga`);
  await page.getByTestId('gis').click();
  await page.getByRole('button', { name: /Yes, this is my/ }).click();
  const allow = page.getByRole('button', { name: 'Allow location' });
  if (await allow.isVisible().catch(() => false)) await allow.click();
  await expectText(page, 'Scan to check in', `${tag} QR panel opens on a vague computer location`);
  await page.locator('.ck-ptap-qr img').waitFor();
  await expectText(page, 'Any phone camera', `${tag} QR hint`);
  await page.waitForTimeout(400);
  await shot(page, `${tag}-20-phone-qr`);

  // Hide -> the offer pill; open again.
  await page.getByRole('button', { name: 'Hide' }).click();
  await page.getByTestId('use-phone').waitFor();
  await shot(page, `${tag}-21-use-phone-offer`);
  await page.getByTestId('use-phone').click();
  await page.locator('.ck-ptap-qr img').waitFor();

  // The phone: a vague reading first (try again), then a good one.
  const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, userAgent: PHONE_UA, isMobile: true, hasTouch: true, colorScheme: theme, locale: 'en-GB', deviceScaleFactor: 2, geolocation: { ...INSIDE, accuracy: 300 }, permissions: ['geolocation'] });
  await phoneCtx.route('**/api/clock/nga/**', server);
  const phone = await phoneCtx.newPage();
  phone.on('pageerror', (e) => fail(`phone page error: ${e.message}`));
  await phone.goto(`${BASE}/c/nga/tap/ptapcode12345678`);
  await expectText(phone, 'Tuyishimire', `${tag} phone shows whose tap`);
  // The phone gives GPS up to 20 s to settle before it reports a vague reading.
  await phone.getByText('Location is not precise').first().waitFor({ timeout: 30000 });
  await expectText(page, 'Phone location not precise', `${tag} laptop sees the phone's problem`);
  await shot(phone, `${tag}-22-phone-vague`);
  await shot(page, `${tag}-23-laptop-phone-vague`);
  await phoneCtx.setGeolocation({ ...INSIDE, accuracy: 12 });
  await phone.getByRole('button', { name: 'Try again' }).click();
  await expectText(phone, 'Check-in saved · 07:42', `${tag} phone saved`);
  await expectText(phone, 'You can close this page', `${tag} phone done lead`);
  await shot(phone, `${tag}-24-phone-done`);
  await expectText(page, 'On time', `${tag} laptop success`);
  await shot(page, `${tag}-25-laptop-success`);
  // The used code is refused on a second scan.
  await phone.goto(`${BASE}/c/nga/tap/ptapcode12345678`);
  await expectText(phone, 'Code expired', `${tag} used code`);
  await phoneCtx.close();
  await ctx.close();
}

/** A phone on its own network (mobile data): GPS only reaches ± 240 m. The page waits for it, then lets
 *  the person check in with a "Weak GPS" notice (the school reviews it). Their own hours show too. */
async function weakGpsFlow(browser, theme) {
  const tag = `own-network-${theme}`;
  const vp = VIEWPORTS[0];
  const server = mockServer({ weak: true, own: true });
  const { ctx, page } = await newPage(browser, vp, theme, { server, geo: { ...INSIDE, accuracy: 240 } });
  await page.goto(`${BASE}/c/nga`);
  await page.getByTestId('gis').click();
  await page.getByRole('button', { name: /Yes, this is my/ }).click();
  const allow = page.getByRole('button', { name: 'Allow location' });
  if (await allow.isVisible().catch(() => false)) await allow.click();
  await expectText(page, 'GPS is settling', `${tag} waits for GPS instead of giving up`);
  await shot(page, `${tag}-30-gps-settling`);
  await page.getByText('Weak GPS (± 240 m)').waitFor({ timeout: 30000 });
  await expectText(page, 'Your school will confirm this one', `${tag} weak notice`);
  await shot(page, `${tag}-31-weak-ready`);
  await page.getByRole('button', { name: /Check in/ }).first().click();
  await expectText(page, 'On time', `${tag} checked in on a weak reading`);
  await shot(page, `${tag}-32-weak-checked-in`);
  await ctx.close();
}

/** Yesterday has no check-out: the page asks when the person left; and it offers reminders. */
async function extrasFlow(browser, theme) {
  const tag = `extras-${theme}`;
  const vp = VIEWPORTS[0];
  const server = mockServer({ missed: true, push: true });
  const { ctx, page } = await newPage(browser, vp, theme, { server });
  // Headless Chromium starts with notifications denied (the card would say "blocked").
  await ctx.grantPermissions(['geolocation', 'notifications']);
  await page.goto(`${BASE}/c/nga`);
  await page.getByTestId('gis').click();
  await page.getByRole('button', { name: /Yes, this is my/ }).click();
  const allow = page.getByRole('button', { name: 'Allow location' });
  if (await allow.isVisible().catch(() => false)) await allow.click();
  // The page stays small: three short buttons; each opens a popup.
  if (await page.getByTestId('my-calendar').count()) fail(`${tag}: the calendar is shown on the page itself`);
  await page.getByTestId('quick-reminders').click();
  await expectText(page, 'Remind me', `${tag} reminders popup`);
  await expectText(page, '15 minutes before', `${tag} reminders lead`);
  await shot(page, `${tag}-39-reminders-popup`);
  await page.keyboard.press('Escape');
  if (await page.getByTestId('ck-sheet').count()) fail(`${tag}: Escape did not close the popup`);
  await page.getByTestId('quick-missed').click();
  await expectText(page, 'You did not check out', `${tag} missed check-out popup`);
  const card = page.getByTestId('missed-out');
  await card.getByLabel('What time did you leave?').fill('07:00');
  await expectText(page, 'Enter a time after 07:35', `${tag} time before the check-in refused`);
  if (!(await card.getByRole('button', { name: 'Send' }).isDisabled())) fail(`${tag}: Send is enabled with a time before the check-in`);
  await card.getByLabel('What time did you leave?').fill('16:20');
  await page.waitForTimeout(200);
  if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)) fail(`${tag}: extras scroll sideways`);
  await shot(page, `${tag}-40-missed-and-reminders`);
  await card.getByRole('button', { name: 'Send' }).click();
  await expectText(page, 'Your school will confirm the time', `${tag} claim sent`);
  if (await page.getByTestId('ck-sheet').count()) fail(`${tag}: the popup stayed open after sending`);
  if (await page.getByTestId('quick-missed').count()) fail(`${tag}: the forgotten check-out button is still shown after sending`);
  await shot(page, `${tag}-40b-minimal-page`);

  // My calendar (popup): the month with expected hours, days off, the school closed, what was recorded.
  await page.getByTestId('quick-calendar').click();
  const calendar = page.getByTestId('my-calendar');
  await calendar.waitFor();
  await expectText(page, '20 working days', `${tag} calendar summary`);
  if ((await calendar.locator('.ck-cal-cell.k-off').count()) !== 9) fail(`${tag}: the calendar should show 9 days off in November`);
  if ((await calendar.locator('.ck-cal-cell.k-closed').count()) !== 1) fail(`${tag}: the closed day is missing`);
  if ((await calendar.locator('.ck-cal-cell.is-today').count()) !== 1) fail(`${tag}: today is not marked`);
  await expectText(page, 'At school 08:30 – 16:00', `${tag} today's expected hours`);
  await calendar.locator('.ck-cal-cell.k-absent').first().click();
  await expectText(page, 'Absent', `${tag} absent day detail`);
  await calendar.locator('.ck-cal-cell.k-closed').first().click();
  await expectText(page, 'School closed', `${tag} closed day detail`);
  await page.waitForTimeout(200);
  if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)) fail(`${tag}: calendar scrolls sideways`);
  await shot(page, `${tag}-41-my-calendar`);
  // A short phone (360 x 640): the month and the picked day's detail fit without scrolling the popup.
  await page.setViewportSize({ width: 360, height: 640 });
  await page.waitForTimeout(250);
  {
    const fits = await page.evaluate(() => {
      const body = document.querySelector('.ck-pop-body');
      const day = document.querySelector('.ck-cal-day');
      return !!body && !!day && body.scrollHeight <= body.clientHeight + 1 && day.getBoundingClientRect().bottom <= window.innerHeight;
    });
    if (!fits) fail(`${tag}: the calendar popup does not fit a 360 x 640 phone`);
    if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)) fail(`${tag}: calendar scrolls sideways on a short phone`);
  }
  await shot(page, `${tag}-41c-my-calendar-short-phone`);
  await page.setViewportSize({ width: vp.width, height: vp.height });
  await calendar.getByRole('button', { name: 'Next month' }).click();
  await expectText(page, 'December 2026', `${tag} next month`);
  await page.getByTestId('cal-weekly').click();
  if ((await calendar.locator('.ck-hours li').count()) !== 7) fail(`${tag}: the weekly hours should list seven days`);
  if ((await calendar.locator('.ck-hours li.off').count()) !== 2) fail(`${tag}: Saturday and Sunday should be days off`);
  await shot(page, `${tag}-41b-weekly-hours`);
  await ctx.close();

  // A day off (own hours: Monday and Thursday): check-in is closed and says when the next day is.
  const off = await newPage(browser, vp, theme, { server: mockServer({ dayOff: true }) });
  await off.page.goto(`${BASE}/c/nga`);
  await off.page.getByTestId('gis').click();
  await off.page.getByRole('button', { name: /Yes, this is my/ }).click();
  const allow2 = off.page.getByRole('button', { name: 'Allow location' });
  if (await allow2.isVisible().catch(() => false)) await allow2.click();
  await expectText(off.page, 'Today is your day off', `${tag} day off chip`);
  await expectText(off.page, 'Your next day is Thursday 26 November, from 10:00', `${tag} next working day`);
  if (!(await off.page.locator('.ck-big').isDisabled())) fail(`${tag}: the check-in button is enabled on a day off`);
  await shot(off.page, `${tag}-42-day-off`);
  await off.ctx.close();
}

async function main() {
  const preview = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'ignore' });
  try {
    for (let i = 0; i < 40; i++) {
      try {
        const r = await fetch(`${BASE}/c/nga`);
        if (r.ok) break;
      } catch { /* not yet */ }
      await new Promise((r) => setTimeout(r, 250));
    }
    const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
    for (const vp of process.env.ONLY_EXTRAS ? [] : VIEWPORTS) {
      for (const theme of ['light', 'dark']) {
        await fullFlow(browser, vp, theme);
        await edgeStates(browser, vp, theme);
      }
      await longName(browser, vp);
      console.log(`ok ${vp.name}`);
    }
    for (const theme of ['light', 'dark']) await extrasFlow(browser, theme);
    console.log('ok missed check-out + reminders card');
    for (const theme of ['light', 'dark']) await weakGpsFlow(browser, theme);
    console.log('ok own network, weak GPS');
    for (const theme of ['light', 'dark']) await phoneTapFlow(browser, theme);
    console.log('ok laptop + phone QR');
    await browser.close();
    console.log(`All clock screens passed. Screenshots in ${OUT}`);
  } finally {
    preview.kill();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
