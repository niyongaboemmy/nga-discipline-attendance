// End-to-end with the REAL Tendo server (no API mocks for the clock): the built page
// in a real browser signs taps with its own non-extractable WebCrypto key, the server
// verifies them, applies the zone and the school clock, and writes staff_attendance.
// Google enrolment is the one step that cannot run offline, so the device row is
// seeded with the browser's public key; everything after that is the real path.
//
//   cd client && npm run build && npm i --no-save playwright
//   node e2e-clock/integration.mjs        # CHROME=<path>, OUT=<dir>

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { createHash, randomBytes, createHmac } from 'node:crypto';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const SERVER_DIR = path.resolve('../server');
const sqlite3 = require(path.join(SERVER_DIR, 'node_modules/sqlite3'));
const OUT = process.env.OUT || path.resolve('e2e-clock/out');
mkdirSync(OUT, { recursive: true });
const API_PORT = 5199;
const WEB_PORT = 4793;
const JWT_SECRET = 'integration-secret';
const DATA = mkdtempSync(path.join(os.tmpdir(), 'tendo-clock-it-'));
const DB_FILE = path.join(DATA, 'attendance.db');
const ZONE = { lat: -1.95362, lng: 30.10441 };

const fail = (m) => { console.error(`FAIL: ${m}`); process.exitCode = 1; throw new Error(m); };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function jwt(payload) {
  const h = b64({ alg: 'HS256', typ: 'JWT' });
  const p = b64({ iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600, ...payload });
  return `${h}.${p}.${createHmac('sha256', JWT_SECRET).update(`${h}.${p}`).digest('base64url')}`;
}
function sql(run, params = []) {
  return new Promise((res, rej) => {
    const db = new sqlite3.Database(DB_FILE);
    db.all(run, params, (err, rows) => { db.close(); err ? rej(err) : res(rows); });
  });
}
async function waitFor(url, tries = 80) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url); if (r.status < 500) return; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  fail(`${url} never came up`);
}
async function api(method, p, body, token) {
  const r = await fetch(`http://localhost:${API_PORT}${p}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => null);
  if (!r.ok) fail(`${method} ${p} -> ${r.status} ${JSON.stringify(j)}`);
  return j;
}

async function main() {
  const env = { ...process.env, PORT: String(API_PORT), DATABASE_PATH: DB_FILE, JWT_SECRET, GOOGLE_CLIENT_ID: 'it.apps.googleusercontent.com', NODE_ENV: 'development', CORS_ORIGINS: `http://localhost:${WEB_PORT}` };
  const server = spawn('npx', ['tsx', 'src/index.ts'], { cwd: SERVER_DIR, env, stdio: ['ignore', 'ignore', 'pipe'] });
  let serverErr = '';
  server.stderr.on('data', (d) => { serverErr += d; });
  const web = spawn('npx', ['vite', 'preview', '--port', String(WEB_PORT), '--strictPort'], { env: { ...process.env, TENDO_API_PROXY_TARGET: `http://localhost:${API_PORT}` }, stdio: 'ignore' });
  try {
    await waitFor(`http://localhost:${API_PORT}/health`);
    await waitFor(`http://localhost:${WEB_PORT}/c/nga`);

    // A school admin (local account) sets the zone and opens the clock through the real API.
    const role = (await sql(`SELECT id FROM roles WHERE level = 'ADMIN' AND is_system = 1`))[0];
    await sql(`INSERT INTO users (id, name, email, role, role_id, status) VALUES ('900', 'Admin Office', 'admin@school.rw', 'admin', ?, 'active')`, [role.id]);
    const admin = jwt({ id: '900', name: 'Admin Office', email: 'admin@school.rw', role: 'admin', tid: 1, tslug: 'nga' });
    await api('POST', '/api/staff/clock/zones', { name: 'Main campus', lat: ZONE.lat, lng: ZONE.lng, radius: 150 }, admin);
    await api('PUT', '/api/staff/clock/config', { enabled: true, opens: '00:00', minShiftMinutes: 0, lateAfter: '23:59' }, admin);

    const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2,
      userAgent: 'Mozilla/5.0 (Linux; Android 13; TECNO KI5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
      geolocation: { latitude: -1.95326, longitude: 30.10441, accuracy: 14 }, permissions: ['geolocation'],
    });
    await ctx.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
    const page = await ctx.newPage();
    page.on('pageerror', (e) => fail(`page error: ${e.message}`));
    await page.goto(`http://localhost:${WEB_PORT}/c/nga`);
    await page.getByText('Staff attendance').first().waitFor();

    // The page's own key (as it makes it on registration), then the device row.
    const token = randomBytes(32).toString('base64url');
    const jwk = await page.evaluate(async (tok) => {
      const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
      const full = await crypto.subtle.exportKey('jwk', keys.publicKey);
      const pub = { kty: full.kty, crv: full.crv, x: full.x, y: full.y };
      await new Promise((res, rej) => {
        const r = indexedDB.open('tendo-clock', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('kv');
        r.onsuccess = () => {
          const tx = r.result.transaction('kv', 'readwrite');
          tx.objectStore('kv').put({ slug: 'nga', keys, publicJwk: pub, token: tok, registeredAt: new Date().toISOString() }, 'device:nga');
          tx.objectStore('kv').put(crypto.randomUUID(), 'install');
          tx.oncomplete = res; tx.onerror = rej;
        };
      });
      localStorage.setItem('tendo.clock.locPrimed', '1');
      return pub;
    }, token);
    const thumb = createHash('sha256').update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })).digest('base64url');
    const teacherRole = (await sql(`SELECT id FROM roles WHERE level = 'TEACHER' AND is_system = 1`))[0];
    await sql(`INSERT INTO users (id, name, email, role, role_id, status) VALUES ('101', 'Grace Mukamana', 'grace@gmail.com', 'teacher', ?, 'active')`, [teacherRole.id]);
    await sql(
      `INSERT INTO attendance_devices (user_id, user_name, google_sub, google_email, key_thumbprint, public_key_jwk, token_hash, install_uuid, form_factor, label, status, registered_at)
       VALUES ('101', 'Grace Mukamana', 'sub-grace', 'grace@gmail.com', ?, ?, ?, ?, 'phone', 'TECNO KI5 · Chrome', 'active', ?)`,
      [thumb, JSON.stringify(jwk), createHash('sha256').update(token).digest('hex'), randomBytes(16).toString('hex').replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5'), new Date().toISOString()]
    );

    await page.reload();
    await page.getByText('At school').first().waitFor({ timeout: 15000 });
    await page.screenshot({ path: path.join(OUT, 'integration-01-ready.png') });
    await page.getByRole('button', { name: /^Check in\./ }).click();
    await page.getByText('Have a good day, Grace').waitFor({ timeout: 15000 });
    await page.screenshot({ path: path.join(OUT, 'integration-02-success.png') });
    let row = (await sql(`SELECT * FROM staff_attendance WHERE staff_id = '101'`))[0];
    if (!row || row.source !== 'device' || row.in_device_id == null || row.in_distance_m > 60) fail(`check-in row wrong: ${JSON.stringify(row)}`);
    console.log(`check-in recorded: ${row.date} ${row.clock_in} ${row.status}, ${Math.round(row.in_distance_m)} m from the centre`);

    await page.getByRole('button', { name: 'OK' }).click();
    await page.getByRole('button', { name: /^Check out\./ }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Check out' }).click();
    await page.getByText('Done for today').first().waitFor({ timeout: 15000 });
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(OUT, 'integration-03-done.png') });
    row = (await sql(`SELECT * FROM staff_attendance WHERE staff_id = '101'`))[0];
    if (!row.clock_out || !row.out_status) fail(`check-out row wrong: ${JSON.stringify(row)}`);
    console.log(`check-out recorded: ${row.clock_out} (${row.out_status})`);

    // Far from school: the real server refuses and logs it.
    await sql(`DELETE FROM staff_attendance WHERE staff_id = '101'`);
    await ctx.setGeolocation({ latitude: -1.94282, longitude: 30.10441, accuracy: 12 });
    await page.reload();
    await page.getByText('from school').first().waitFor({ timeout: 15000 });
    const refused = await fetch(`http://localhost:${API_PORT}/api/clock/nga/me`, { headers: { 'X-Clock-Device': token } }).then((r) => r.json());
    if (refused?.data?.next !== 'check_in') fail('state after reset should be check_in');
    console.log('outside the zone: page shows the distance, no record');

    // The dashboard sees the day.
    const ov = await api('GET', `/api/staff/clock/overview?date=${row.date}`, null, admin);
    console.log(`overview: ${ov.data.kpis.staff} staff, ${ov.data.phones.registered} phone registered`);
    const events = await sql(`SELECT kind, reason FROM attendance_events ORDER BY id`);
    console.log(`events: ${events.map((e) => e.kind + (e.reason ? `(${e.reason})` : '')).join(', ')}`);
    await browser.close();
    console.log('Integration passed.');
  } catch (e) {
    if (serverErr) console.error(serverErr.split('\n').slice(-15).join('\n'));
    throw e;
  } finally {
    server.kill();
    web.kill();
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
