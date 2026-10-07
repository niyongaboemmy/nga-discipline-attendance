// Contract with NGA Desktop (nga-desktop src-tauri/src/bridge.js WATCHERS): if this fails,
// update the desktop watcher in the same release.
//
// The desktop app intercepts the web app's own `GET /api/notifications` poll
// (NotificationCenter, every 30 s) and turns new rows into OS notifications. It reads
// `json.data[]` and, on each item, `id`, `title`, `message`, `link`, `read` (truthy = read)
// and `created_at`. Renaming any of those or moving the route silently stops desktop
// notifications for Tendo — this test pins that shape.
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { Database } from 'sqlite';
import { setupTestDb, createTestUser, authHeader } from './testUtils.js';
import { config } from '../config.js';
import { app } from '../app.js';
import { schoolDateString, dayOfWeekFor } from '../shared/schoolTime.js';

// Copied verbatim from bridge.js WATCHERS.tendo[0].match.
const TENDO_WATCHER_MATCH = /\/api\/notifications\/?(\?|$)/;
// The exact request the web app makes (client/src/api/notifications.ts).
const WATCHED_PATH = '/api/notifications';

const USER_ID = 'desktop-contract-teacher';
const today = schoolDateString();

// The route reconciles schedule-derived notifications from MIS on every read;
// answer with one already-finished lesson so the engine writes a real
// `register_missing` row alongside the hand-inserted ones.
function mockMis() {
  const slot = {
    slot_id: 77, subject_id: 9, subject_name: 'Physics', class_group_id: 'cg-contract',
    class_group_name: 'Grade 10C', day_of_week: dayOfWeekFor(today), start_time: '00:01:00', end_time: '00:45:00',
    location: 'Lab',
  };
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
    if (String(url).includes('/calendar/my-calendar')) {
      return new Response(JSON.stringify({ data: { slots: [slot], upcoming: [], term_id: 1 } }), { status: 200 });
    }
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  }));
}

describe('NGA Desktop watcher contract: Tendo notifications', () => {
  let db: Database;
  let token: string;

  beforeAll(async () => {
    db = await setupTestDb();
    await createTestUser(db, { id: USER_ID, name: 'Desk Top', email: 'desktop@contract.test', roleLevel: 'TEACHER' });
    token = jwt.sign(
      { id: USER_ID, name: 'Desk Top', email: 'desktop@contract.test', role: 'teacher', misToken: 'x', academicTermId: 1 },
      config.jwtSecret, { expiresIn: '1h' }
    );
    await db.run(`INSERT INTO subjects (id, name) VALUES (9, 'Physics')`);
    await db.run(
      `INSERT INTO notifications (user_id, type, title, message, link, severity, read)
       VALUES (?, 'excuse_decided', 'Unread contract notification', 'Message the desktop shows', '/excuses', 'info', 0)`,
      USER_ID
    );
    await db.run(
      `INSERT INTO notifications (user_id, type, title, message, link, severity, read)
       VALUES ('all', 'system', 'Read contract broadcast', 'Already seen', NULL, 'info', 1)`
    );
  });
  afterEach(() => vi.unstubAllGlobals());
  afterAll(async () => {
    await db.run(`DELETE FROM notifications WHERE user_id IN (?, 'all')`, USER_ID);
    await db.run(`DELETE FROM users WHERE id = ?`, USER_ID);
  });

  it('the path the web app polls is the one the watcher matches', () => {
    expect(TENDO_WATCHER_MATCH.test(WATCHED_PATH)).toBe(true);
    expect(TENDO_WATCHER_MATCH.test('http://localhost:5173/api/notifications?x=1')).toBe(true);
    // Sibling endpoints must NOT be picked up as notification lists.
    expect(TENDO_WATCHER_MATCH.test('/api/notifications/read-all')).toBe(false);
  });

  it('returns json.data[] items with the fields the watcher reads', async () => {
    mockMis();
    const res = await request(app).get(WATCHED_PATH).set(authHeader(token));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);

    const items = res.body.data as any[];
    // Hand-inserted personal + broadcast rows, plus the engine-generated nudge.
    expect(items.find((n) => n.title === 'Unread contract notification')).toBeTruthy();
    expect(items.find((n) => n.title === 'Read contract broadcast')).toBeTruthy();
    expect(items.find((n) => n.type === 'register_missing')).toBeTruthy();

    for (const n of items) {
      expect(typeof n.id).toBe('number');
      expect(Number.isFinite(n.id)).toBe(true);
      expect(typeof n.title).toBe('string');
      expect(n.title.length).toBeGreaterThan(0);
      expect(typeof n.message).toBe('string');
      expect('link' in n).toBe(true);
      expect(n.link === null || typeof n.link === 'string').toBe(true);
      // "boolean-ish": the watcher computes unread as !read.
      expect('read' in n).toBe(true);
      expect([0, 1, true, false]).toContain(n.read);
      expect(n.created_at).toBeTruthy();
      expect(Number.isFinite(Date.parse(n.created_at))).toBe(true);
    }

    const unread = items.find((n) => n.title === 'Unread contract notification');
    expect(!unread.read).toBe(true);
    expect(unread.message).toBe('Message the desktop shows');
    expect(unread.link).toBe('/excuses');
    expect(!items.find((n) => n.title === 'Read contract broadcast').read).toBe(false);
    const nudge = items.find((n) => n.type === 'register_missing');
    expect(typeof nudge.link).toBe('string');
    expect(!nudge.read).toBe(true);
  });

  it("the bridge's pick() logic yields usable desktop notifications from the response", async () => {
    mockMis();
    const res = await request(app).get(WATCHED_PATH).set(authHeader(token));
    const str = (v: unknown) => (v == null ? '' : String(v));
    // Mirror of WATCHERS.tendo[0].pick in bridge.js.
    const picked = ((res.body && res.body.data) || []).map((n: any) => ({
      id: 'n' + n.id, title: str(n.title), body: str(n.message), link: n.link, unread: !n.read, at: Date.parse(n.created_at),
    }));
    expect(picked.length).toBeGreaterThanOrEqual(3);
    for (const p of picked) {
      expect(p.id).toMatch(/^n\d+$/);
      expect(p.title).not.toBe('');
      expect(p.body).not.toBe('');
      expect(Number.isFinite(p.at)).toBe(true);
    }
    expect(picked.find((p: any) => p.title === 'Unread contract notification').unread).toBe(true);
    expect(picked.find((p: any) => p.title === 'Read contract broadcast').unread).toBe(false);
  });
});
