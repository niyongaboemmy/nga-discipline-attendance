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
  const st = { registered: !!opts.registered, deviceStatus: opts.deviceStatus || 'active', checkIn: opts.checkIn || null, checkOut: null, now: '2026-11-24T05:42:00.000Z', revoked: !!opts.revoked };
  const person = { name: opts.name || 'Grace Mukamana', firstName: (opts.name || 'Grace Mukamana').split(' ')[0], initials: 'GM', role: 'Teacher' };
  const day = () => ({
    serverNow: st.now, schoolDate: '2026-11-24', timezone: 'Africa/Kigali', schoolDay: true,
    next: st.checkOut ? 'done' : st.checkIn ? 'check_out' : 'check_in', checkoutOpensAt: null, opensAt: '05:00',
    today: st.checkIn ? { checkIn: st.checkIn, checkOut: st.checkOut, status: 'present', outStatus: st.checkOut ? 'on_time' : null, minutesAtSchool: st.checkOut ? 508 : 0 } : null,
    week: [
      { date: '2026-11-23', isToday: false, future: false, checkIn: '07:35', checkOut: '16:05', status: 'present' },
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
      return route.fulfill(ok({ school: { name: 'New Generation Academy', slug: 'nga' }, open: true, googleClientId: 'test.apps.googleusercontent.com', serverNow: st.now, schoolDate: '2026-11-24', timezone: 'Africa/Kigali',
        rules: { opens: '05:00', lateAfter: '08:30', earlyLeaveBefore: '16:00', minShiftMinutes: 60, maxAccuracy: 100, requireZone: true },
        zones: [{ id: 1, name: 'Main campus', kind: 'circle', lat: SCHOOL.lat, lng: SCHOOL.lng, radius: 150 }] }));
    }
    if (p === '/register') {
      if (!body.confirm) return route.fulfill(ok({ preview: true, deviceStatus: st.deviceStatus, replaces: false, person, email: opts.email || 'grace.mukamana@gmail.com' }));
      st.registered = true;
      return route.fulfill(ok({ deviceToken: 'tok_' + 'x'.repeat(40), deviceStatus: st.deviceStatus, replaced: false, person, email: 'grace.mukamana@gmail.com' }));
    }
    if (st.revoked) return route.fulfill(err(401, 'DEVICE_REVOKED', 'removed'));
    if (p === '/me') {
      return route.fulfill(ok({ ...day(), school: { name: 'New Generation Academy', slug: 'nga' }, open: true, person, email: 'grace.mukamana@gmail.com',
        device: { status: st.deviceStatus, label: 'Samsung A15 · Chrome', formFactor: 'phone', registeredAt: '2026-11-24T05:40:00.000Z' },
        rules: { lateAfter: '08:30', earlyLeaveBefore: '16:00', minShiftMinutes: 60 } }));
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
  await expectText(page, 'Lost or changed your', `${tag} help`);
  await page.waitForTimeout(300);
  await shot(page, `${tag}-09-help`);
  await ctx.close();
}

async function edgeStates(browser, vp, theme) {
  const tag = `${vp.name}-${theme}`;
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
  const server = mockServer({ name: 'Jean-Baptiste-Emmanuel Nshimiyimana Habyarimana', email: 'jb.nshimiyimana.habyarimana.teacher@gmail.com' });
  const { ctx, page } = await newPage(browser, vp, 'light', { server });
  await page.goto(`${BASE}/c/nga`);
  await page.getByTestId('gis').click();
  await expectText(page, 'jb.nshimiyimana.habyarimana.teacher@gmail.com', `${vp.name} long email`);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  if (overflow) fail(`${vp.name}: page scrolls sideways with a long name`);
  await shot(page, `${vp.name}-12-long-name-confirm`);
  await page.getByRole('button', { name: /Yes, this is my/ }).click();
  await expectText(page, 'Good morning, Jean-Baptiste-Emmanuel', `${vp.name} long greeting`);
  await page.waitForTimeout(300);
  if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)) fail(`${vp.name}: daily screen scrolls sideways`);
  await shot(page, `${vp.name}-13-long-name-ready`);
  await ctx.close();
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
    for (const vp of VIEWPORTS) {
      for (const theme of ['light', 'dark']) {
        await fullFlow(browser, vp, theme);
        await edgeStates(browser, vp, theme);
      }
      await longName(browser, vp);
      console.log(`ok ${vp.name}`);
    }
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
