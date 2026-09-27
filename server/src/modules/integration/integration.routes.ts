import { Router, Request, Response, NextFunction } from 'express';
import { getDb } from '../../database.js';
import { misBearerAuth, IntegrationRequest } from '../../middleware/misBearerAuth.js';
import { DATE_RE } from '../../shared/validation.js';
import { addDays, schoolDateString } from '../../shared/schoolTime.js';
import { buildHomeSummary, emptyHomeSummary, LensHint, LessonHint } from './homeSummary.service.js';

/**
 * Server-to-server endpoints for the NGA Central MIS, authenticated with the
 * signed-in user's own MIS token (middleware/misBearerAuth.ts) rather than
 * this app's session JWT. Mounted at /api/integration (see app.ts).
 */
const router = Router();

// ---------------------------------------------------------------------------
// Rate limit: per MIS user, after authentication (so it cannot be spent on
// someone else's behalf). Same sliding-window shape as routes/sso.ts.
// ---------------------------------------------------------------------------
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 30;
const hits = new Map<number, number[]>();

function rateLimit(req: Request, res: Response, next: NextFunction) {
  const userId = (req as IntegrationRequest).misUserId;
  if (userId == null) return next();
  const now = Date.now();
  const recent = (hits.get(userId) || []).filter((t) => now - t < RATE_WINDOW_MS);
  recent.push(now);
  hits.set(userId, recent);
  if (hits.size > 10_000) {
    for (const [key, times] of hits) if (times.every((t) => now - t >= RATE_WINDOW_MS)) hits.delete(key);
  }
  if (recent.length > RATE_MAX) {
    res.setHeader('Retry-After', String(Math.ceil(RATE_WINDOW_MS / 1000)));
    return res.status(429).json({ success: false, code: 'RATE_LIMITED', message: 'Too many requests. Try again in a minute.' });
  }
  return next();
}

router.use(misBearerAuth, rateLimit);

// ---------------------------------------------------------------------------
// Body. Nothing in it is ever a 400: an unreadable `date` means today, and
// `lenses` and `lessons` are hints from MIS: an entry that cannot be read is
// dropped, oversized arrays are truncated, and one bad entry never costs the
// user the whole summary. `tz` is ignored -- the school TZ is authoritative.
// ---------------------------------------------------------------------------
const MAX_LESSONS = 50;
const MAX_LENSES = 50;
const MAX_LENS_CLASSES = 1000;
/** How far from today (school-local) a summary may be asked for. */
const DATE_WINDOW_DAYS = 14;

const isObject = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, max: number): string | null => {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t && t.length <= max ? t : null;
};
const positiveInt = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};
/** A real calendar day (rejects 2026-02-31). */
const calendarDate = (v: unknown): string | null =>
  typeof v === 'string' && DATE_RE.test(v) && addDays(v, 0) === v ? v : null;
/** "8:00" / "08:00" / "08:00:00" -> "08:00"; out-of-range or garbage -> null. */
export function normaliseTime(v: unknown): string | null {
  const m = typeof v === 'string' ? /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(v.trim()) : null;
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  return `${m[1].padStart(2, '0')}:${m[2]}`;
}

function readLenses(raw: unknown): LensHint[] {
  if (!Array.isArray(raw)) return [];
  const out: LensHint[] = [];
  for (const l of raw) {
    if (out.length >= MAX_LENSES) break;
    if (!isObject(l)) continue;
    const key = text(l.key, 80);
    const type = text(l.type, 40)?.toUpperCase();
    if (!key || !type) continue;
    // Only an explicit null means "every class"; a missing list contains
    // nothing (except on SCHOOL, which is whole-school by definition).
    let ids: number[] | null;
    if (l.class_group_ids === null || (l.class_group_ids === undefined && type === 'SCHOOL')) ids = null;
    else if (Array.isArray(l.class_group_ids)) {
      ids = [...new Set(l.class_group_ids.map(positiveInt).filter((n): n is number => n != null))].slice(0, MAX_LENS_CLASSES);
    } else ids = [];
    out.push({ key, type, class_group_ids: ids });
  }
  return out;
}

function readLessons(raw: unknown): LessonHint[] {
  if (!Array.isArray(raw)) return [];
  const out: LessonHint[] = [];
  const seen = new Set<string>();
  for (const l of raw) {
    if (out.length >= MAX_LESSONS) break;
    if (!isObject(l)) continue;
    const lessonKey = text(l.lesson_key, 80);
    const classGroupId = positiveInt(l.class_group_id);
    const subjectId = positiveInt(l.subject_id);
    const date = l.date == null ? undefined : calendarDate(l.date);
    if (!lessonKey || classGroupId == null || subjectId == null || date === null || seen.has(lessonKey)) continue;
    seen.add(lessonKey);
    out.push({
      lesson_key: lessonKey,
      class_group_id: classGroupId,
      subject_id: subjectId,
      date,
      // '' = unknown start: never counts as started today.
      start_time: normaliseTime(l.start_time) ?? '',
      end_time: normaliseTime(l.end_time) ?? undefined,
      subject_name: text(l.subject_name, 160),
      class_group_name: text(l.class_group_name, 160),
    });
  }
  return out;
}

// POST /api/integration/home-summary (GET with no body works too) -- this
// user's Discipline & Attendance slice of the MIS Home page. Read-only.
async function homeSummary(req: any, res: Response) {
  const r = req as IntegrationRequest;
  if (r.homeProvisioned === false || !r.user) return res.json(emptyHomeSummary(false));

  const body = req.method === 'GET' || !isObject(req.body) ? {} : req.body;
  // Lenient like the other satellites: an unreadable date, or one further than
  // DATE_WINDOW_DAYS from today, is read as today (the default) -- never a 400.
  const today = schoolDateString();
  const asked = calendarDate(body.date);
  const date = asked && asked >= addDays(today, -DATE_WINDOW_DAYS) && asked <= addDays(today, DATE_WINDOW_DAYS)
    ? asked
    : undefined;

  try {
    const summary = await buildHomeSummary(r, getDb(), {
      date,
      lenses: readLenses(body.lenses),
      lessons: readLessons(body.lessons),
    });
    return res.json(summary);
  } catch (error) {
    console.error('Error building home summary:', (error as Error).message);
    return res.status(500).json({ success: false, message: 'Could not build the home summary.' });
  }
}

router.post('/home-summary', homeSummary);
router.get('/home-summary', homeSummary);

/**
 * JSON errors for /api/integration/* (mounted after the router in app.ts, so
 * it also catches a malformed JSON body from express.json). Express's default
 * handler would answer with an HTML stack trace outside production.
 */
export function integrationErrorHandler(err: any, _req: Request, res: Response, next: NextFunction) {
  if (res.headersSent) return next(err);
  if (err?.type === 'entity.parse.failed' || err?.type === 'entity.too.large') {
    const status = err.type === 'entity.too.large' ? 413 : 400;
    return res.status(status).json({ success: false, code: 'BAD_BODY', message: 'The request body could not be read.' });
  }
  console.error('Integration request failed:', (err as Error)?.message ?? err);
  return res.status(500).json({ success: false, message: 'Something went wrong.' });
}

/** Test hook. */
export function __resetIntegrationRateLimit() {
  hits.clear();
}

export default router;
