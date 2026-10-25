import { Router, Response } from 'express';
import { z } from 'zod';
import { getDb } from '../../database.js';
import { authMiddleware, AuthenticatedRequest } from '../../middleware/auth.js';
import { authorizePermission } from '../../middleware/authorize.js';
import { validateBody, DATE_RE } from '../../shared/validation.js';
import { recordAudit } from '../../shared/audit.js';
import { schoolDateString, schoolLocalToUtc } from '../../shared/schoolTime.js';
import {
  CardError, assignCard, registerCard, setCardStatus, unassignCard, updateCardLabel,
} from './cards.service.js';
import { GRACE_MINUTES, dayStartFor, isSchoolDay, lessonsFor } from './timetable.service.js';
import { lastRosterSync, schoolYearForDate, syncRosterFromMis } from './roster.service.js';
import { ingestScan, OUTCOME_MESSAGES } from './ingest.service.js';
import { SCAN_OUTCOMES, UNRESOLVED_CARD_OUTCOMES } from './engine.js';
import { enqueue, rfidEvents } from './workQueue.js';
import { bridgeStatus } from './supabase.bridge.js';
import { INACTIVE_IDS_SQL, misStatusIsActive } from '../../services/activeStudents.js';

/** Card management, scan log, scanners, roster cache and check-in sessions.
 *  Mounted at /api/rfid. */
const router = Router();
router.use(authMiddleware);

const actorOf = (req: any) => {
  const u = (req as AuthenticatedRequest).user!;
  return { id: u.id, name: u.name };
};

function sendError(res: Response, err: unknown, fallback: string) {
  if (err instanceof CardError) {
    return res.status(err.status).json({ success: false, code: err.code, message: err.message, data: err.data ?? null });
  }
  console.error(fallback, err);
  return res.status(500).json({ success: false, message: fallback });
}

const intParam = (v: unknown) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};
const clampLimit = (v: unknown, def = 50, max = 500) => Math.min(Math.max(parseInt(String(v), 10) || def, 1), max);
const clampOffset = (v: unknown) => Math.max(parseInt(String(v), 10) || 0, 0);

// ───────────────────────────── Cards ─────────────────────────────

router.get('/cards', authorizePermission('RFID_CARDS_VIEW'), async (req: any, res: Response) => {
  const db = getDb();
  const { status, search } = req.query;
  // `scanned=1`: only cards the reader has actually picked up.
  const scannedOnly = req.query.scanned === '1';
  const base = scannedOnly ? ' WHERE c.first_seen_at IS NOT NULL' : ' WHERE 1=1';
  let where = base;
  const params: any[] = [];
  if (status === 'blocked') {
    where += ` AND c.status IN ('disabled','lost','retired')`;
  } else if (status && status !== 'all') {
    where += ' AND c.status = ?'; params.push(String(status));
  }
  if (search) {
    const s = `%${String(search).trim()}%`;
    where += ' AND (c.uid LIKE ? OR c.label LIKE ? OR a.student_name LIKE ? OR a.student_id LIKE ?)';
    params.push(s.toUpperCase(), s, s, s);
  }
  const limit = clampLimit(req.query.limit);
  const offset = clampOffset(req.query.offset);
  try {
    const from = `FROM rfid_cards c LEFT JOIN rfid_card_assignments a ON a.card_id = c.id AND a.ended_at IS NULL`;
    const total = await db.get(`SELECT COUNT(*) AS n ${from}${where}`, ...params);
    const rows = await db.all(
      `SELECT c.*, a.student_id, a.student_name, a.assigned_at, a.assigned_by_name,
              e.name AS class_name,
              (SELECT COUNT(*) FROM rfid_scan_events s WHERE s.card_id = c.id) AS taps
         ${from}
         LEFT JOIN roster_enrolments en ON en.student_id = a.student_id AND en.status = 'ACTIVE'
              AND en.academic_year_id = (SELECT MAX(academic_year_id) FROM roster_enrolments x WHERE x.student_id = a.student_id AND x.status = 'ACTIVE')
         LEFT JOIN roster_class_groups e ON e.class_id = en.class_id
        ${where}
        GROUP BY c.id
        ORDER BY (c.status = 'unassigned') DESC, COALESCE(c.last_seen_at, c.created_at) DESC
        LIMIT ? OFFSET ?`,
      ...params, limit, offset
    );
    const counts = await db.get(
      `SELECT COUNT(*) AS total,
              SUM(status = 'active') AS active,
              SUM(status = 'unassigned') AS unassigned,
              SUM(status IN ('disabled','lost','retired')) AS blocked
         FROM rfid_cards c${base}`
    );
    return res.json({
      success: true,
      total: total.n,
      counts: { total: counts.total ?? 0, active: counts.active ?? 0, unassigned: counts.unassigned ?? 0, blocked: counts.blocked ?? 0 },
      data: rows.map((r: any) => ({
        id: r.id, uid: r.uid, label: r.label, status: r.status, statusReason: r.status_reason,
        firstSeenAt: r.first_seen_at, lastSeenAt: r.last_seen_at, createdAt: r.created_at, taps: r.taps,
        holder: r.student_id ? {
          studentId: r.student_id, studentName: r.student_name, className: r.class_name ?? null,
          assignedAt: r.assigned_at, assignedByName: r.assigned_by_name,
        } : null,
      })),
    });
  } catch (err) {
    return sendError(res, err, 'Could not load cards.');
  }
});

router.get('/cards/:id', authorizePermission('RFID_CARDS_VIEW'), async (req: any, res: Response) => {
  const id = intParam(req.params.id);
  if (!id) return res.status(400).json({ success: false, message: 'Invalid card id.' });
  const db = getDb();
  try {
    const card = await db.get(`SELECT * FROM rfid_cards WHERE id = ?`, id);
    if (!card) return res.status(404).json({ success: false, message: 'Card not found.' });
    const assignments = await db.all(
      `SELECT * FROM rfid_card_assignments WHERE card_id = ? ORDER BY assigned_at DESC`, id
    );
    const open = assignments.find((a: any) => a.ended_at == null) ?? null;
    const holderClass = open ? await db.get(
      `SELECT c.name FROM roster_enrolments e LEFT JOIN roster_class_groups c ON c.class_id = e.class_id
        WHERE e.student_id = ? AND e.status = 'ACTIVE' ORDER BY e.academic_year_id DESC LIMIT 1`,
      open.student_id
    ) : null;
    const dayStart = schoolLocalToUtc(schoolDateString(), '00:00').toISOString();
    const stats = await db.get(
      `SELECT COUNT(*) AS taps, SUM(effective_at >= ?) AS taps_today FROM rfid_scan_events WHERE card_id = ?`,
      dayStart, id
    );
    const scans = await db.all(
      `SELECT s.id, s.effective_at, s.outcome, s.detail, s.student_name, s.class_name, s.source, d.name AS device_name
         FROM rfid_scan_events s LEFT JOIN rfid_devices d ON d.id = s.device_id
        WHERE s.card_id = ? ORDER BY s.effective_at DESC, s.id DESC LIMIT 50`,
      id
    );
    return res.json({
      success: true,
      data: {
        id: card.id, uid: card.uid, label: card.label, status: card.status, statusReason: card.status_reason,
        firstSeenAt: card.first_seen_at, lastSeenAt: card.last_seen_at, createdAt: card.created_at,
        taps: stats?.taps ?? 0, tapsToday: stats?.taps_today ?? 0,
        holder: open ? {
          studentId: open.student_id, studentName: open.student_name, className: holderClass?.name ?? null,
          assignedAt: open.assigned_at, assignedByName: open.assigned_by_name,
        } : null,
        assignments: assignments.map((a: any) => ({
          id: a.id, studentId: a.student_id, studentName: a.student_name,
          assignedAt: a.assigned_at, assignedByName: a.assigned_by_name,
          endedAt: a.ended_at, endReason: a.end_reason,
        })),
        recentScans: scans.map((s: any) => ({
          id: s.id, at: s.effective_at, outcome: s.outcome, detail: s.detail,
          message: OUTCOME_MESSAGES[s.outcome as keyof typeof OUTCOME_MESSAGES] ?? s.outcome,
          studentName: s.student_name, className: s.class_name, deviceName: s.device_name, source: s.source,
        })),
      },
    });
  } catch (err) {
    return sendError(res, err, 'Could not load this card.');
  }
});

const registerSchema = z.object({
  uid: z.string().min(1).max(64),
  label: z.string().trim().max(60).optional().transform((v) => v || null),
});
router.post('/cards', authorizePermission('RFID_CARDS_MANAGE'), validateBody(registerSchema), async (req: any, res: Response) => {
  try {
    const id = await enqueue(() => registerCard(getDb(), actorOf(req), req.body.uid, req.body.label));
    return res.status(201).json({ success: true, data: { id }, message: 'Card registered.' });
  } catch (err) {
    return sendError(res, err, 'Could not register the card.');
  }
});

const labelSchema = z.object({ label: z.string().trim().max(60).nullable().transform((v) => v || null) });
router.put('/cards/:id', authorizePermission('RFID_CARDS_MANAGE'), validateBody(labelSchema), async (req: any, res: Response) => {
  const id = intParam(req.params.id);
  if (!id) return res.status(400).json({ success: false, message: 'Invalid card id.' });
  try {
    await enqueue(() => updateCardLabel(getDb(), actorOf(req), id, req.body.label));
    return res.json({ success: true, message: 'Card updated.' });
  } catch (err) {
    return sendError(res, err, 'Could not update the card.');
  }
});

const assignSchema = z.object({
  studentId: z.string().min(1).max(64),
  studentName: z.string().max(160).optional(),
  reassign: z.boolean().optional().default(false),
  replaceExisting: z.boolean().optional().default(false),
});
router.post('/cards/:id/assign', authorizePermission('RFID_CARDS_MANAGE'), validateBody(assignSchema), async (req: any, res: Response) => {
  const id = intParam(req.params.id);
  if (!id) return res.status(400).json({ success: false, message: 'Invalid card id.' });
  const { studentId, studentName, reassign, replaceExisting } = req.body;
  try {
    await enqueue(() => assignCard(getDb(), actorOf(req), id, studentId, studentName ?? null, { reassign, replaceExisting }));
    return res.json({ success: true, message: 'Card assigned.' });
  } catch (err) {
    return sendError(res, err, 'Could not assign the card.');
  }
});

const unassignSchema = z.object({ reason: z.string().trim().min(1).max(200) });
router.post('/cards/:id/unassign', authorizePermission('RFID_CARDS_MANAGE'), validateBody(unassignSchema), async (req: any, res: Response) => {
  const id = intParam(req.params.id);
  if (!id) return res.status(400).json({ success: false, message: 'Invalid card id.' });
  try {
    await enqueue(() => unassignCard(getDb(), actorOf(req), id, req.body.reason));
    return res.json({ success: true, message: 'Card unassigned.' });
  } catch (err) {
    return sendError(res, err, 'Could not unassign the card.');
  }
});

const statusSchema = z.object({
  status: z.enum(['disabled', 'lost', 'retired', 'unassigned']),
  reason: z.string().trim().max(200).optional().transform((v) => v || null),
});
router.post('/cards/:id/status', authorizePermission('RFID_CARDS_MANAGE'), validateBody(statusSchema), async (req: any, res: Response) => {
  const id = intParam(req.params.id);
  if (!id) return res.status(400).json({ success: false, message: 'Invalid card id.' });
  try {
    await enqueue(() => setCardStatus(getDb(), actorOf(req), id, req.body.status, req.body.reason));
    return res.json({ success: true, message: req.body.status === 'unassigned' ? 'Card re-enabled.' : `Card marked ${req.body.status}.` });
  } catch (err) {
    return sendError(res, err, 'Could not change the card status.');
  }
});

// ───────────────────────────── Roster ─────────────────────────────

/** Student picker for card assignment, from the local roster cache. Active
 *  students only; `include_inactive=1` adds disabled ones (each row carries
 *  its MIS `status` and `inactive`) for callers who can manage cards. */
router.get('/students', authorizePermission('RFID_CARDS_VIEW'), async (req: any, res: Response) => {
  const db = getDb();
  const search = String(req.query.search ?? '').trim();
  const wantsInactive = ['1', 'true'].includes(String(req.query.include_inactive ?? '').toLowerCase());
  const includeInactive = wantsInactive && !!(req as AuthenticatedRequest).user?.permissions?.has('RFID_CARDS_MANAGE');
  try {
    const rows = await db.all(
      `SELECT s.student_id, s.name, s.mis_status, c.name AS class_name,
              (SELECT rc.label || '|' || rc.uid FROM rfid_card_assignments a JOIN rfid_cards rc ON rc.id = a.card_id
                WHERE a.student_id = s.student_id AND a.ended_at IS NULL) AS card
         FROM roster_students s
         LEFT JOIN roster_enrolments e ON e.student_id = s.student_id AND e.status = 'ACTIVE'
              AND e.academic_year_id = (SELECT MAX(academic_year_id) FROM roster_enrolments x WHERE x.student_id = s.student_id AND x.status = 'ACTIVE')
         LEFT JOIN roster_class_groups c ON c.class_id = e.class_id
        WHERE ${includeInactive ? `s.mis_status IS NOT 'REMOVED'` : `s.student_id NOT IN (${INACTIVE_IDS_SQL})`}
          AND (? = '' OR s.name LIKE ? OR s.student_id = ?)
        GROUP BY s.student_id
        ORDER BY s.name LIMIT 30`,
      search, `%${search}%`, search
    );
    return res.json({
      success: true,
      data: rows.map((r: any) => {
        const [label, uid] = r.card ? String(r.card).split('|') : [null, null];
        return {
          id: r.student_id, name: r.name, status: r.mis_status, className: r.class_name ?? null,
          inactive: misStatusIsActive(r.mis_status) === false,
          card: r.card ? { label: label || null, uid } : null,
        };
      }),
    });
  } catch (err) {
    return sendError(res, err, 'Could not search students.');
  }
});

router.get('/roster/status', authorizePermission('RFID_CARDS_VIEW'), async (_req: any, res: Response) => {
  try {
    return res.json({ success: true, data: await lastRosterSync(getDb()) });
  } catch (err) {
    return sendError(res, err, 'Could not load the roster status.');
  }
});

router.post('/roster/sync', authorizePermission('RFID_CARDS_MANAGE'), async (req: any, res: Response) => {
  const db = getDb();
  try {
    const result = await enqueue(() => syncRosterFromMis(db, { triggeredBy: actorOf(req).id }));
    await recordAudit(db, actorOf(req), 'rfid.roster.sync', 'roster', null, result);
    return res.json({
      success: true, data: result,
      message: `Synced ${result.students} students, ${result.enrolments} class enrolments and ${result.slots ?? 'the existing'} timetable lessons.`,
    });
  } catch (err) {
    console.error('Roster sync failed:', err);
    return res.status(502).json({ success: false, message: (err as Error).message || 'Could not sync the roster from the MIS.' });
  }
});

// ───────────────────────────── Scans ─────────────────────────────

router.get('/scans', authorizePermission('RFID_SCANS_VIEW'), async (req: any, res: Response) => {
  const db = getDb();
  const { outcome, date, search } = req.query;
  let where = ' WHERE 1=1';
  const params: any[] = [];
  if (outcome === 'unresolved') {
    where += ` AND s.outcome IN (${UNRESOLVED_CARD_OUTCOMES.map(() => '?').join(',')})`;
    params.push(...UNRESOLVED_CARD_OUTCOMES);
  } else if (outcome === 'problems') {
    where += ` AND s.outcome NOT LIKE 'recorded_%' AND s.outcome NOT IN ('already_recorded','debounced')`;
  } else if (outcome && (SCAN_OUTCOMES as readonly string[]).includes(String(outcome))) {
    where += ' AND s.outcome = ?'; params.push(String(outcome));
  }
  if (date && DATE_RE.test(String(date))) {
    // Instants are stored as ISO strings, so bound by the school day's own
    // UTC start/end (never SQLite datetime(), whose format sorts differently).
    const start = schoolLocalToUtc(String(date), '00:00');
    where += ' AND s.effective_at >= ? AND s.effective_at < ?';
    params.push(start.toISOString(), new Date(start.getTime() + 24 * 3600_000).toISOString());
  }
  if (req.query.cardId) { where += ' AND s.card_id = ?'; params.push(Number(req.query.cardId)); }
  if (search) {
    const s = `%${String(search).trim()}%`;
    where += ' AND (s.uid LIKE ? OR s.student_name LIKE ? OR s.class_name LIKE ?)';
    params.push(s.toUpperCase(), s, s);
  }
  const limit = clampLimit(req.query.limit, 100);
  const offset = clampOffset(req.query.offset);
  try {
    const total = await db.get(`SELECT COUNT(*) AS n FROM rfid_scan_events s${where}`, ...params);
    const rows = await db.all(
      `SELECT s.*, d.name AS device_name, c.label AS card_label, c.status AS card_status
         FROM rfid_scan_events s
         LEFT JOIN rfid_devices d ON d.id = s.device_id
         LEFT JOIN rfid_cards c ON c.id = s.card_id
        ${where}
        ORDER BY s.effective_at DESC, s.id DESC LIMIT ? OFFSET ?`,
      ...params, limit, offset
    );
    return res.json({
      success: true,
      total: total.n,
      data: rows.map((s: any) => ({
        id: s.id, at: s.effective_at, receivedAt: s.received_at, deviceTs: s.device_ts, timeSource: s.time_source,
        source: s.source, uid: s.uid, uidRaw: s.uid_raw, cardId: s.card_id, cardLabel: s.card_label, cardStatus: s.card_status,
        outcome: s.outcome, message: OUTCOME_MESSAGES[s.outcome as keyof typeof OUTCOME_MESSAGES] ?? s.outcome,
        detail: s.detail, studentId: s.student_id, studentName: s.student_name,
        classId: s.class_id, className: s.class_name, deviceName: s.device_name,
      })),
    });
  } catch (err) {
    return sendError(res, err, 'Could not load scans.');
  }
});

/** Cards tapped that nobody holds, newest first, one row per card. */
router.get('/scans/unresolved', authorizePermission('RFID_SCANS_VIEW'), async (_req: any, res: Response) => {
  const db = getDb();
  try {
    const rows = await db.all(
      `SELECT c.id AS card_id, c.uid, c.label, c.status, COUNT(s.id) AS scans, MAX(s.effective_at) AS last_scan_at,
              (SELECT d.name FROM rfid_scan_events s2 LEFT JOIN rfid_devices d ON d.id = s2.device_id
                WHERE s2.card_id = c.id ORDER BY s2.effective_at DESC LIMIT 1) AS last_device
         FROM rfid_cards c JOIN rfid_scan_events s ON s.card_id = c.id
        WHERE c.status = 'unassigned'
        GROUP BY c.id
        ORDER BY last_scan_at DESC LIMIT 200`
    );
    return res.json({
      success: true,
      data: rows.map((r: any) => ({
        cardId: r.card_id, uid: r.uid, label: r.label, scans: r.scans, lastScanAt: r.last_scan_at, lastDevice: r.last_device,
      })),
    });
  } catch (err) {
    return sendError(res, err, 'Could not load unregistered cards.');
  }
});

/** Enter a tap by hand: typing the UID printed on a card, or testing a
 *  session without hardware. Goes through exactly the same engine. */
const manualScanSchema = z.object({ uid: z.string().min(1).max(64), deviceCode: z.string().max(64).optional() });
router.post('/scans', authorizePermission('RFID_CARDS_MANAGE'), validateBody(manualScanSchema), async (req: any, res: Response) => {
  const db = getDb();
  try {
    const result = await ingestScan(db, {
      source: 'manual_entry', uid: req.body.uid, deviceCode: req.body.deviceCode ?? null, recordedBy: actorOf(req).id,
    });
    await recordAudit(db, actorOf(req), 'rfid.scan.manual', 'rfid_scan_event', result.scanId, { uid: req.body.uid, outcome: result.outcome });
    return res.json({ success: true, data: result, message: result.message });
  } catch (err) {
    return sendError(res, err, 'Could not record the scan.');
  }
});

// ───────────────────────────── Scanners ─────────────────────────────

/** Health of the ESP → Supabase → Tendo feed. Never returns the key. */
router.get('/bridge/status', authorizePermission('RFID_CARDS_VIEW'), async (_req: any, res: Response) => {
  try {
    return res.json({ success: true, data: await bridgeStatus(getDb()) });
  } catch (err) {
    return sendError(res, err, 'Could not load the scanner feed status.');
  }
});

router.get('/devices', authorizePermission('RFID_CARDS_VIEW'), async (_req: any, res: Response) => {
  const db = getDb();
  try {
    const rows = await db.all(
      `SELECT d.*, (SELECT COUNT(*) FROM rfid_scan_events s WHERE s.device_id = d.id AND s.effective_at >= ?) AS scans_24h
         FROM rfid_devices d ORDER BY COALESCE(d.last_seen_at, d.created_at) DESC`,
      new Date(Date.now() - 24 * 3600_000).toISOString()
    );
    return res.json({
      success: true,
      data: rows.map((d: any) => ({
        id: d.id, code: d.code, name: d.name, location: d.location, status: d.status,
        lastSeenAt: d.last_seen_at, clockSkewMs: d.last_clock_skew_ms, scans24h: d.scans_24h, createdAt: d.created_at,
      })),
    });
  } catch (err) {
    return sendError(res, err, 'Could not load scanners.');
  }
});

const deviceSchema = z.object({
  name: z.string().trim().min(1).max(80),
  location: z.string().trim().max(120).optional().transform((v) => v || null),
  status: z.enum(['active', 'disabled']),
});
router.put('/devices/:id', authorizePermission('RFID_CARDS_MANAGE'), validateBody(deviceSchema), async (req: any, res: Response) => {
  const id = intParam(req.params.id);
  if (!id) return res.status(400).json({ success: false, message: 'Invalid scanner id.' });
  const db = getDb();
  try {
    const before = await db.get(`SELECT * FROM rfid_devices WHERE id = ?`, id);
    if (!before) return res.status(404).json({ success: false, message: 'Scanner not found.' });
    await db.run(`UPDATE rfid_devices SET name = ?, location = ?, status = ? WHERE id = ?`,
      req.body.name, req.body.location, req.body.status, id);
    await recordAudit(db, actorOf(req), 'rfid.device.update', 'rfid_device', id, { code: before.code },
      { previousValue: { name: before.name, location: before.location, status: before.status }, newValue: req.body });
    return res.json({ success: true, message: 'Scanner updated.' });
  } catch (err) {
    return sendError(res, err, 'Could not update the scanner.');
  }
});

// ───────────────────────────── Today ─────────────────────────────

/**
 * Card attendance at a glance for one day: each class that has card holders,
 * where its timetable is right now, and its morning register so far.
 */
router.get('/today', authorizePermission('RFID_CARDS_VIEW'), async (req: any, res: Response) => {
  const date = String(req.query.date || schoolDateString());
  if (!DATE_RE.test(date)) return res.status(400).json({ success: false, message: 'date must be YYYY-MM-DD.' });
  const db = getDb();
  try {
    const school = await isSchoolDay(db, date);
    const { yearId } = await schoolYearForDate(db, date);
    const year = yearId ?? (await db.get(`SELECT MAX(academic_year_id) AS y FROM roster_enrolments WHERE status = 'ACTIVE'`))?.y;
    const classes = year == null ? [] : await db.all(
      `SELECT e.class_id, COALESCE(c.name, 'Class ' || e.class_id) AS class_name, COUNT(DISTINCT a.student_id) AS card_holders
         FROM rfid_card_assignments a
         JOIN roster_enrolments e ON e.student_id = a.student_id AND e.status = 'ACTIVE' AND e.academic_year_id = ?
         LEFT JOIN roster_class_groups c ON c.class_id = e.class_id
        WHERE a.ended_at IS NULL
        GROUP BY e.class_id ORDER BY class_name`,
      year
    );
    const now = Date.now();
    const data = [];
    for (const c of classes) {
      const lessons = await lessonsFor(db, c.class_id, date);
      const current = lessons.find((l) => now >= l.start && now < l.end) ?? null;
      const next = lessons.find((l) => l.start > now) ?? null;
      const counts = await db.all(
        `SELECT status, COUNT(*) AS n FROM attendance_records
          WHERE class_id = ? AND session_date = ? AND session_type = 'homeroom' GROUP BY status`,
        c.class_id, date
      );
      const tapped = await db.get(
        `SELECT COUNT(DISTINCT student_id) AS n FROM rfid_scan_events
          WHERE class_id = ? AND outcome LIKE 'recorded_%' AND effective_at >= ? AND effective_at < ?`,
        c.class_id, new Date(dayStartFor(date)).toISOString(), new Date(dayStartFor(date) + 24 * 3600_000).toISOString()
      );
      const lessonApi = (l: typeof lessons[number] | null) => l && ({
        subjectName: l.subjectName, start: new Date(l.start).toISOString(), end: new Date(l.end).toISOString(),
      });
      data.push({
        classId: c.class_id,
        className: c.class_name,
        cardHolders: c.card_holders,
        tappedToday: tapped?.n ?? 0,
        lessonsToday: lessons.length,
        firstLessonAt: lessons[0] ? new Date(lessons[0].start).toISOString() : null,
        lastLessonEnd: lessons.length ? new Date(Math.max(...lessons.map((l) => l.end))).toISOString() : null,
        currentLesson: lessonApi(current),
        nextLesson: lessonApi(next),
        morning: Object.fromEntries(['present', 'late', 'absent', 'excused'].map((s) => [s, counts.find((r: any) => r.status === s)?.n ?? 0])),
      });
    }
    return res.json({
      success: true,
      data: { date, schoolOpen: school.open, closedReason: school.reason, graceMinutes: GRACE_MINUTES, classes: data },
    });
  } catch (err) {
    return sendError(res, err, 'Could not load today’s card attendance.');
  }
});

// ───────────────────────────── Days off ─────────────────────────────

router.get('/days-off', authorizePermission('RFID_CARDS_VIEW'), async (_req: any, res: Response) => {
  try {
    const rows = await getDb().all(
      `SELECT session_date, reason, created_at FROM rfid_days_off WHERE session_date >= ? ORDER BY session_date LIMIT 60`,
      schoolDateString()
    );
    return res.json({ success: true, data: rows.map((r: any) => ({ date: r.session_date, reason: r.reason, createdAt: r.created_at })) });
  } catch (err) {
    return sendError(res, err, 'Could not load days off.');
  }
});

const dayOffSchema = z.object({
  date: z.string().regex(DATE_RE, 'Expected YYYY-MM-DD.'),
  reason: z.string().trim().min(1, 'Give a reason, e.g. Public holiday.').max(120),
});
router.post('/days-off', authorizePermission('RFID_CARDS_MANAGE'), validateBody(dayOffSchema), async (req: any, res: Response) => {
  const { date, reason } = req.body;
  if (date < schoolDateString()) {
    return res.status(400).json({ success: false, message: 'Only today or a future date can be marked as a day off.' });
  }
  const db = getDb();
  try {
    await enqueue(() => db.run(
      `INSERT INTO rfid_days_off (session_date, reason, created_by, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(session_date) DO UPDATE SET reason = excluded.reason`,
      date, reason, actorOf(req).id, new Date().toISOString()
    ));
    await recordAudit(db, actorOf(req), 'rfid.dayoff.create', 'rfid_day_off', date, { reason });
    const closedAlready = await db.get(`SELECT COUNT(*) AS n FROM rfid_closed_registers WHERE session_date = ? AND absent > 0`, date);
    return res.json({
      success: true,
      message: closedAlready?.n
        ? 'Day off saved. Lessons that already ended today kept their absences; correct them in the registers if needed.'
        : 'Day off saved. No one will be marked absent by card attendance that day.',
    });
  } catch (err) {
    return sendError(res, err, 'Could not save the day off.');
  }
});

router.delete('/days-off/:date', authorizePermission('RFID_CARDS_MANAGE'), async (req: any, res: Response) => {
  const date = String(req.params.date);
  if (!DATE_RE.test(date)) return res.status(400).json({ success: false, message: 'Invalid date.' });
  const db = getDb();
  try {
    await enqueue(() => db.run(`DELETE FROM rfid_days_off WHERE session_date = ?`, date));
    await recordAudit(db, actorOf(req), 'rfid.dayoff.remove', 'rfid_day_off', date, {});
    return res.json({ success: true, message: 'Day off removed.' });
  } catch (err) {
    return sendError(res, err, 'Could not remove the day off.');
  }
});

// ───────────────────────────── Live stream ─────────────────────────────

/**
 * Server-Sent Events over a plain authenticated GET. The client reads it with
 * fetch() streaming so the bearer token travels in a header, never the URL.
 * Staff without RFID_SCANS_VIEW only see scans that resolved to a student.
 */
router.get('/stream', authorizePermission('RFID_SCANS_VIEW', 'ATTENDANCE_VIEW_ALL'), (req: any, res: Response) => {
  const canSeeRaw = (req as AuthenticatedRequest).user!.permissions.has('RFID_SCANS_VIEW');
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // nginx: don't buffer this response
  res.flushHeaders?.();
  res.write(`event: ready\ndata: {}\n\n`);

  const onEvent = (evt: any) => {
    if (evt.type === 'scan' && !canSeeRaw && !evt.studentId) return;
    res.write(`event: ${evt.type}\ndata: ${JSON.stringify(evt)}\n\n`);
  };
  rfidEvents.on('event', onEvent);
  const heartbeat = setInterval(() => res.write(`: ping\n\n`), 25_000);
  req.on('close', () => {
    clearInterval(heartbeat);
    rfidEvents.off('event', onEvent);
  });
});

export default router;
