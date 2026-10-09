import type { Database } from 'sqlite';
import { config } from '../../config.js';
import { AuthenticatedRequest } from '../../middleware/auth.js';
import { accessMode, accessScope, decideAny, requestSnapshot, studentTarget } from '../../access/policy.js';
import { resolveStudentClassGroups } from '../../access/students.js';
import { CohortRow, decide, Depth, suppressSmallCohorts } from '../../vendor/nga-access/index.js';
import { fetchClassTeacherClasses } from '../../services/misClient.js';
import { deepLink } from '../attendance/schedule.routes.js';
import { getStudentTermBalance, listTermBalances } from '../discipline/ledger.service.js';
import { CONDUCT_FLAG_THRESHOLD } from '../../routes/discipline.js';
import { excuseCoversRowSql } from '../../routes/attendance.js';
import { resolveAcademicPeriodForDate } from '../../utils/academicPeriod.js';
import {
  addDays,
  dayOfWeekFor,
  schoolDateString,
  schoolMinutesOfDay,
  timeToMinutes,
  weekStartFor,
} from '../../shared/schoolTime.js';
import {
  ATTENDED_SQL_CASE,
  ATTENDANCE_MIN_SESSIONS,
  ATTENDANCE_WARN_THRESHOLD,
  attendanceRate,
} from '../../shared/attendancePolicy.js';

/**
 * The Discipline & Attendance slice of the MIS Home page (contract:
 * HOME_OVERVIEW_IMPLEMENTATION_PLAN.md §6/§9, one HomeSummary per request).
 *
 * Read-only by construction: plain SELECTs, the in-memory access snapshot,
 * and MIS reads with the user's own token. In particular it never calls the
 * notification generator (generateForUser) and never goes through
 * accessCheck/authorizePermission, whose shadow mode records disagreements
 * in access_shadow_diffs -- the verdicts below mirror those guards without
 * the bookkeeping:
 *
 *   off/shadow  the legacy local permission keys decide; class-level signals
 *               cover the classes the viewer is Class Teacher of (the MIS
 *               UserGrade assignment -- the same rule as the dashboard's
 *               `/reports/overview?scope=me` and the homeroom gate)
 *   enforce     the v2 snapshot decides (accessScope / decide); no snapshot
 *               means nothing is shown
 *
 * Lens hints from MIS only choose each item's label, never what is counted.
 */

export type Tier = 'blocking' | 'slipping' | 'tidy';
type ItemDepth = 'summary' | 'detail' | 'write';

export interface AttentionItem {
  id: string;
  source: 'attendance';
  kind: string;
  tier: Tier;
  lens: string;
  via: number[];
  depth: ItemDepth;
  count: number;
  title: string;
  entities: string[];
  why: string;
  cta: { label: string; href: string; external: true };
  due_at?: string | null;
  waiting_since?: string | null;
}

export interface GlanceTile {
  id: string;
  source: 'attendance';
  lens: string;
  label: string;
  value: string | null;
  suppressed?: boolean;
  hint?: string;
  status?: 'good' | 'warning' | 'critical';
  href?: string;
}

export interface UpdateItem {
  id: string;
  source: 'attendance';
  kind: string;
  title: string;
  body?: string | null;
  severity: 'info' | 'success' | 'warning' | 'critical';
  created_at: string;
  read: boolean;
  href?: string | null;
}

export interface TodayMark {
  lesson_key: string;
  status: 'done' | 'missing' | 'upcoming' | 'not_yours';
  href?: string;
}

export interface HomeSummary {
  version: 1;
  source: 'attendance';
  generated_at: string;
  provisioned: boolean;
  items: AttentionItem[];
  tiles: GlanceTile[];
  updates: UpdateItem[];
  today_marks: TodayMark[];
  app_url: string;
}

export interface LensHint {
  key: string;
  type: string;
  class_group_ids?: number[] | null;
}

export interface LessonHint {
  lesson_key: string;
  class_group_id: number;
  subject_id: number;
  date?: string;
  start_time: string;
  end_time?: string;
  subject_name?: string | null;
  class_group_name?: string | null;
}

export interface HomeSummaryInput {
  date?: string;
  lenses?: LensHint[];
  lessons?: LessonHint[];
}

/** When the morning (homeroom) register is due, school-local. */
const HOMEROOM_START_TIME = process.env.HOMEROOM_START_TIME || '08:00';
/** School days, MIS convention 0=Sunday .. 6=Saturday. */
const SCHOOL_DAYS = new Set(
  (process.env.SCHOOL_DAYS || '1,2,3,4,5').split(',').map((d) => Number(d.trim())).filter(Number.isInteger)
);
/** Conduct balance below this is flagged to the student (S-08). */
const CONDUCT_FLAG_BELOW = 70;
/** A pending excuse older than this blocks (C-02). */
const EXCUSE_BLOCKING_MS = 48 * 60 * 60 * 1000;
/** A demerit waiting for review longer than this blocks (D-01). */
const DISCIPLINE_REVIEW_BLOCKING_MS = 72 * 60 * 60 * 1000;
/** Major incidents this recent are listed (D-03), in days. */
const MAJOR_INCIDENT_WINDOW_DAYS = 7;
/** A major incident logged this recently makes D-03 slipping. */
const MAJOR_INCIDENT_FRESH_MS = 24 * 60 * 60 * 1000;
/** A rejected excuse stays on the student's Home this long (S-09). */
const REJECTED_EXCUSE_DAYS = 14;
/** Notification kinds Home derives itself from today_marks / T-01 / C-01. */
const HOME_DERIVED_KINDS = ['register_missing', 'homeroom_missing', 'lesson_soon'];
const MAX_ENTITIES = 8;
const MAX_TILES = 3;
const MAX_UPDATES = 10;

export function emptyHomeSummary(provisioned: boolean): HomeSummary {
  return {
    version: 1,
    source: 'attendance',
    generated_at: new Date().toISOString(),
    provisioned,
    items: [],
    tiles: [],
    updates: [],
    today_marks: [],
    app_url: config.appPublicUrl,
  };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
const appHref = (path: string) => `${config.appPublicUrl}${path.startsWith('/') ? path : `/${path}`}`;
const hhmm = (t: string | null | undefined) => String(t ?? '').slice(0, 5);

/** SQLite CURRENT_TIMESTAMP ("YYYY-MM-DD HH:MM:SS", UTC) -> ISO. */
function sqliteUtcToIso(v: string | null | undefined): string | null {
  if (!v) return null;
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(v) ? v : `${v.replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** School-local date + HH:MM -> ISO instant (offset read from the school TZ). */
export function schoolLocalToIso(date: string, time: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const minutes = timeToMinutes(time);
  const guess = Date.UTC(y, m - 1, d, 0, minutes);
  const at = new Date(guess);
  const localDate = schoolDateString(at);
  const dayDiff = Math.round((Date.parse(`${localDate}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / 86_400_000);
  const offsetMin = dayDiff * 1440 + schoolMinutesOfDay(at) - minutes;
  return new Date(guess - offsetMin * 60_000).toISOString();
}

const LENS_RANK: Record<string, number> = { CLASS_GROUP: 4, GRADE: 3, PROGRAM: 2, DEPARTMENT: 2, SCHOOL: 1 };

/** Width of a lens for tie-breaks at the same rank: null (every class) is widest. */
const lensWidth = (l: LensHint) => l.class_group_ids == null ? Infinity : l.class_group_ids.length;

/** Most specific hinted structural lens containing the class; SELF when none.
 *  Specific = higher rank (CLASS_GROUP > GRADE > PROGRAM/DEPARTMENT > SCHOOL),
 *  then, at the same rank, the narrower class list (an explicit list beats null). */
export function lensForClass(lenses: LensHint[], classId: string | number | null | undefined): string {
  const id = classId == null || classId === '' ? NaN : Number(classId);
  let best: LensHint | null = null;
  for (const l of lenses) {
    const rank = LENS_RANK[l.type];
    if (!rank) continue;
    // null = "every class" on SCHOOL only; a listless narrower hint names none.
    const contains = l.class_group_ids == null ? l.type === 'SCHOOL' : l.class_group_ids.includes(id);
    if (!contains) continue;
    const bestRank = best ? LENS_RANK[best.type] : 0;
    if (!best || rank > bestRank || (rank === bestRank && lensWidth(l) < lensWidth(best))) best = l;
  }
  return best?.key ?? 'SELF';
}

const teachingLens = (lenses: LensHint[]) => lenses.find((l) => l.type === 'TEACHING')?.key ?? 'SELF';
const schoolLens = (lenses: LensHint[]) => lenses.find((l) => l.type === 'SCHOOL')?.key ?? 'SELF';

function groupBy<T>(rows: T[], keyOf: (r: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows) {
    const k = keyOf(r);
    const list = out.get(k);
    if (list) list.push(r);
    else out.set(k, [r]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Access (mirrors authorizePermission / accessCheck without shadow writes)
// ---------------------------------------------------------------------------

interface Ctx {
  req: AuthenticatedRequest;
  db: Database;
  userId: string;
  date: string;
  today: string;
  /** School-local minutes "now" on `date`: past day -> end of day, future -> -1. */
  nowMin: number;
  lenses: LensHint[];
  lessons: LessonHint[];
  academicYearId?: number;
  academicTermId?: number;
  enforce: boolean;
  leadClasses: () => Promise<Array<{ id: string; name: string }>>;
  /** isSchoolDay(date), read once per request. */
  schoolDay: () => Promise<boolean>;
  /** The DISCIPLINE_VIEW_ALL student scope, resolved once per request. */
  disciplineScope?: Promise<StudentScope | null>;
  /** D-01 + D-03 candidate demerits, read in one query. */
  demerits?: Promise<any[]>;
}

/** "Holds the capability anywhere" -- the route guards' test. */
async function holds(ctx: Ctx, caps: string[]): Promise<boolean> {
  if (!ctx.enforce) return caps.some((c) => ctx.req.user!.permissions.has(c));
  return decideAny(await requestSnapshot(ctx.req), caps).allowed;
}

/** May the viewer mark this register? Same verdict as POST /attendance/mark
 *  (authorizePermission + requireAccess on the register's class/subject). */
async function mayMark(ctx: Ctx, classGroupId: number, subjectId: number | null): Promise<boolean> {
  if (!ctx.enforce) return ctx.req.user!.permissions.has('ATTENDANCE_MARK');
  return decide(await requestSnapshot(ctx.req), 'ATTENDANCE_MARK', { classGroupId, subjectId }).allowed;
}

interface ClassScope {
  /** Every class (a school-wide grant). */
  all: boolean;
  classIds: Set<string>;
  depthOf: (classId: string) => Depth | null;
}
const NO_CLASSES: ClassScope = { all: false, classIds: new Set(), depthOf: () => null };

/**
 * Which classes a class-level signal covers for `cap` at `minDepth`, and at
 * what depth. Legacy: the key held -> the viewer's Class Teacher classes, at
 * detail (legacy grants carry no depth). Enforce: the v2 scope's class groups.
 */
async function classScope(ctx: Ctx, cap: string, minDepth: Depth | null): Promise<ClassScope> {
  if (!ctx.enforce) {
    if (!ctx.req.user!.permissions.has(cap)) return NO_CLASSES;
    const lead = await ctx.leadClasses();
    return { all: false, classIds: new Set(lead.map((c) => c.id)), depthOf: () => 'detail' };
  }
  const s = await accessScope(ctx.req, cap, minDepth);
  const snapshot = await requestSnapshot(ctx.req);
  const depthOf = (classId: string) => decide(snapshot, cap, { classGroupId: Number(classId) }).depth;
  if (s.unrestricted) return { all: true, classIds: new Set(), depthOf };
  if (!s.scope) return NO_CLASSES;
  return { all: false, classIds: new Set((s.scope.class_groups ?? []).map(String)), depthOf };
}

const hasClasses = (s: ClassScope) => s.all || s.classIds.size > 0;
const inScope = (s: ClassScope, classId: string | null | undefined) =>
  classId != null && (s.all || s.classIds.has(String(classId)));
const isDetail = (d: Depth | null) => d === 'detail' || d === 'sensitive';

/** SQL fragment restricting a text class_id column to the scope. */
function classFilter(s: ClassScope, column: string): { sql: string; params: any[] } {
  if (s.all) return { sql: '', params: [] };
  return { sql: ` AND ${column} IN (SELECT value FROM json_each(?))`, params: [JSON.stringify([...s.classIds])] };
}

function termFilter(ctx: Ctx, column = 'academic_term_id'): { sql: string; params: any[] } {
  return ctx.academicTermId != null
    ? { sql: ` AND (${column} = ? OR ${column} IS NULL)`, params: [ctx.academicTermId] }
    : { sql: '', params: [] };
}

/** Is `date` a school day? Configured weekdays, and inside a known term when
 *  the term calendar has been synced. */
async function isSchoolDay(db: Database, date: string): Promise<boolean> {
  if (!SCHOOL_DAYS.has(dayOfWeekFor(date))) return false;
  const terms = await db.get(
    `SELECT COUNT(*) AS n,
            SUM(CASE WHEN date(?) BETWEEN date(start_date) AND date(end_date) THEN 1 ELSE 0 END) AS covering
       FROM academic_terms WHERE start_date IS NOT NULL AND end_date IS NOT NULL`,
    date
  );
  return !terms?.n || (terms.covering ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// TEACHING: today_marks, T-01, T-02, "Registers today"
// ---------------------------------------------------------------------------

interface MarkedLesson extends LessonHint {
  date: string;
  mine: boolean;
  status: TodayMark['status'];
  link: string;
}

async function evaluateLessons(ctx: Ctx): Promise<MarkedLesson[]> {
  if (ctx.lessons.length === 0) return [];
  const lessons = ctx.lessons.map((l) => ({ ...l, date: l.date ?? ctx.date, start_time: hhmm(l.start_time) }));

  const recorded = new Set<string>();
  const rows = await ctx.db.all(
    `SELECT DISTINCT class_id, subject_id, session_date FROM attendance_records
      WHERE session_type = 'subject'
        AND session_date IN (SELECT value FROM json_each(?))
        AND class_id IN (SELECT value FROM json_each(?))`,
    JSON.stringify([...new Set(lessons.map((l) => l.date))]),
    JSON.stringify([...new Set(lessons.map((l) => String(l.class_group_id)))])
  );
  for (const r of rows) recorded.add(`${r.class_id}|${r.subject_id}|${r.session_date}`);

  const out: MarkedLesson[] = [];
  for (const l of lessons) {
    const mine = await mayMark(ctx, l.class_group_id, l.subject_id);
    const link = deepLink('subject', String(l.class_group_id), l.date, l.start_time, l.subject_id);
    let status: TodayMark['status'];
    if (!mine) status = 'not_yours';
    else if (recorded.has(`${l.class_group_id}|${l.subject_id}|${l.date}`)) status = 'done';
    else {
      // School-local "now"; an unknown start time ('') never counts as started today.
      const started = l.date < ctx.today
        || (l.date === ctx.today && l.start_time !== '' && timeToMinutes(l.start_time) <= schoolMinutesOfDay());
      status = started ? 'missing' : 'upcoming';
    }
    out.push({ ...l, mine, status, link });
  }
  return out;
}

async function lessonLabels(ctx: Ctx, lessons: MarkedLesson[]): Promise<(l: MarkedLesson) => string> {
  const subjectIds = [...new Set(lessons.filter((l) => !l.subject_name).map((l) => l.subject_id))];
  const classIds = [...new Set(lessons.filter((l) => !l.class_group_name).map((l) => String(l.class_group_id)))];
  const subjects = new Map<number, string>();
  const classes = new Map<string, string>();
  if (subjectIds.length) {
    for (const s of await ctx.db.all('SELECT id, name FROM subjects WHERE id IN (SELECT value FROM json_each(?))', JSON.stringify(subjectIds))) {
      subjects.set(Number(s.id), s.name);
    }
  }
  if (classIds.length) {
    for (const c of await ctx.db.all(
      `SELECT class_id, MAX(class_name) AS class_name FROM attendance_records
        WHERE class_id IN (SELECT value FROM json_each(?)) GROUP BY class_id`,
      JSON.stringify(classIds)
    )) classes.set(String(c.class_id), c.class_name);
  }
  return (l) =>
    `${l.subject_name || subjects.get(l.subject_id) || 'Lesson'} · ${l.class_group_name || classes.get(String(l.class_group_id)) || `Class ${l.class_group_id}`}${l.start_time ? ` (${l.start_time})` : ''}`;
}

async function teachingSignals(ctx: Ctx, marked: MarkedLesson[]): Promise<{ items: AttentionItem[]; tiles: GlanceTile[] }> {
  const items: AttentionItem[] = [];
  const tiles: GlanceTile[] = [];
  const lens = teachingLens(ctx.lenses);
  const mine = marked.filter((l) => l.mine);
  if (mine.length === 0) return { items, tiles };
  const label = await lessonLabels(ctx, mine);
  const byStart = (a: MarkedLesson, b: MarkedLesson) => `${a.date} ${a.start_time}`.localeCompare(`${b.date} ${b.start_time}`);

  // T-01: registers not taken for lessons that have started today.
  const missingToday = mine.filter((l) => l.status === 'missing' && l.date === ctx.today).sort(byStart);
  if (missingToday.length) {
    items.push({
      id: `attendance:T-01:${lens}`,
      source: 'attendance',
      kind: 'T-01',
      tier: 'blocking',
      lens,
      via: [],
      depth: 'write',
      count: missingToday.length,
      title: `${missingToday.length} ${plural(missingToday.length, 'register', 'registers')} not taken for lessons that have started`,
      entities: missingToday.slice(0, MAX_ENTITIES).map(label),
      why: 'Absences stay unrecorded, so parents and class teachers are not told and excuses cannot be matched.',
      cta: { label: 'Take register', href: appHref(missingToday[0].link), external: true },
      waiting_since: schoolLocalToIso(missingToday[0].date, missingToday[0].start_time),
    });
  }

  // T-02: earlier this week -- only from lessons MIS supplied for past days
  // (this app keeps no timetable of its own).
  const weekStart = weekStartFor(ctx.today);
  const missingEarlier = mine
    .filter((l) => l.status === 'missing' && l.date < ctx.today && l.date >= weekStart)
    .sort(byStart);
  if (missingEarlier.length) {
    items.push({
      id: `attendance:T-02:${lens}`,
      source: 'attendance',
      kind: 'T-02',
      tier: 'blocking',
      lens,
      via: [],
      depth: 'write',
      count: missingEarlier.length,
      title: `${missingEarlier.length} ${plural(missingEarlier.length, 'register', 'registers')} missing from earlier this week`,
      entities: missingEarlier.slice(0, MAX_ENTITIES).map((l) => `${label(l)} ${l.date.slice(5)}`),
      why: 'The longer a register waits, the less reliable the catch-up record becomes.',
      cta: { label: 'Catch up', href: appHref(missingEarlier[0].link), external: true },
      waiting_since: schoolLocalToIso(missingEarlier[0].date, missingEarlier[0].start_time),
    });
  }

  const todays = mine.filter((l) => l.date === ctx.today);
  if (todays.length) {
    const done = todays.filter((l) => l.status === 'done').length;
    const missing = todays.filter((l) => l.status === 'missing').length;
    tiles.push({
      id: 'attendance:tile:registers-today',
      source: 'attendance',
      lens,
      label: 'Registers today',
      value: `${done}/${todays.length}`,
      hint: missing ? `${missing} overdue` : done === todays.length ? 'All taken' : 'On track',
      status: missing ? 'critical' : 'good',
      href: appHref('/attendance?view=day'),
    });
  }
  return { items, tiles };
}

// ---------------------------------------------------------------------------
// CLASS_GROUP: C-01 .. C-04, "Present today"
// ---------------------------------------------------------------------------

/** C-01: morning register not taken in a class the viewer is Class Teacher of. */
async function homeroomMissing(ctx: Ctx): Promise<AttentionItem[]> {
  if (ctx.date !== ctx.today || ctx.nowMin < timeToMinutes(HOMEROOM_START_TIME)) return [];
  if (!(await holds(ctx, ['ATTENDANCE_MARK']))) return [];
  if (!(await ctx.schoolDay())) return [];

  const lead = await ctx.leadClasses();
  const markable: Array<{ id: string; name: string }> = [];
  for (const c of lead) {
    // Whole-class register: only whole-class scopes cover it (no anySubject).
    if (!ctx.enforce || (await mayMark(ctx, Number(c.id), null))) markable.push(c);
  }
  if (markable.length === 0) return [];

  const taken = new Set(
    (await ctx.db.all(
      `SELECT DISTINCT class_id FROM attendance_records
        WHERE session_type = 'homeroom' AND session_date = ? AND class_id IN (SELECT value FROM json_each(?))`,
      ctx.date, JSON.stringify(markable.map((c) => c.id))
    )).map((r: any) => String(r.class_id))
  );
  const missing = markable.filter((c) => !taken.has(c.id));

  return [...groupBy(missing, (c) => lensForClass(ctx.lenses, c.id))].map(([lens, classes]) => ({
    id: `attendance:C-01:${lens}`,
    source: 'attendance' as const,
    kind: 'C-01',
    tier: 'blocking' as Tier,
    lens,
    via: [],
    depth: 'write' as ItemDepth,
    count: classes.length,
    title: classes.length === 1
      ? `Morning register not taken for ${classes[0].name}`
      : `Morning register not taken for ${classes.length} classes`,
    entities: classes.slice(0, MAX_ENTITIES).map((c) => c.name),
    why: 'Nobody knows who is in school today until the morning register is taken.',
    cta: { label: 'Take register', href: appHref(deepLink('homeroom', classes[0].id, ctx.date, HOMEROOM_START_TIME, null)), external: true },
    waiting_since: schoolLocalToIso(ctx.date, HOMEROOM_START_TIME),
  }));
}

/**
 * Excuse rows (selected through excuseClassFilter) narrowed to the
 * reviewer's scope, each with its class group `cg`. Older excuses carry only
 * a class name: resolve the student's class group (local registers, then MIS)
 * before deciding whether it is in scope. A school-wide reviewer covers every
 * row already -- no lookups (they would be one MIS call per student).
 */
async function excusesInScope(ctx: Ctx, scope: ClassScope, rows: any[]): Promise<any[]> {
  const unresolved = scope.all ? [] : rows.filter((r: any) => !r.class_id).map((r: any) => String(r.student_id));
  const resolved = unresolved.length
    ? await resolveStudentClassGroups(ctx.db, unresolved, {
        misToken: ctx.req.user?.misToken,
        academicYearId: ctx.academicYearId ?? null,
      })
    : new Map<string, number | null>();
  return rows
    .map((r: any) => ({ ...r, cg: r.class_id ? String(r.class_id) : resolved.get(String(r.student_id))?.toString() ?? null }))
    .filter((r: any) => scope.all || inScope(scope, r.cg));
}

/** Excuse rows of the scope's classes, plus class-less (older) rows to resolve. */
function excuseClassFilter(scope: ClassScope, column = 'class_id'): { sql: string; params: any[] } {
  return scope.all ? { sql: '', params: [] } : {
    sql: ` AND (${column} IN (SELECT value FROM json_each(?)) OR ${column} IS NULL)`,
    params: [JSON.stringify([...scope.classIds])],
  };
}

/** C-02: excuses waiting for review, for the viewer's classes. */
async function excusesPending(ctx: Ctx): Promise<AttentionItem[]> {
  const scope = await classScope(ctx, 'EXCUSES_REVIEW', null);
  if (!hasClasses(scope)) return [];
  const term = termFilter(ctx);
  const cls = excuseClassFilter(scope);
  const rows = await ctx.db.all(
    `SELECT id, student_id, student_name, class_id, class_name, session_date, created_at
       FROM excuse_requests
      WHERE status = 'pending'${term.sql}${cls.sql}
      ORDER BY created_at ASC`,
    ...term.params, ...cls.params
  );
  if (rows.length === 0) return [];
  const withClass = await excusesInScope(ctx, scope, rows);

  return [...groupBy(withClass, (r: any) => lensForClass(ctx.lenses, r.cg))].map(([lens, list]) => {
    const oldest = sqliteUtcToIso(list[0].created_at);
    const waitedMs = oldest ? Date.now() - Date.parse(oldest) : 0;
    return {
      id: `attendance:C-02:${lens}`,
      source: 'attendance' as const,
      kind: 'C-02',
      tier: (waitedMs > EXCUSE_BLOCKING_MS ? 'blocking' : 'slipping') as Tier,
      lens,
      via: [],
      depth: 'write' as ItemDepth,
      count: list.length,
      title: `${list.length} ${plural(list.length, 'excuse', 'excuses')} waiting for review`,
      entities: list.slice(0, MAX_ENTITIES).map((r: any) => `${r.student_name} · ${r.class_name} (${String(r.session_date).slice(5)})`),
      why: 'Until someone decides, these students stay marked absent and hear nothing back.',
      cta: { label: 'Review excuses', href: appHref('/excuses/review'), external: true },
      waiting_since: oldest,
    };
  });
}

/**
 * C-05: approved excuses whose absence was never moved to `excused` -- the
 * register was (re)taken after the decision, so the covered rows (the
 * excuseTargetClause match of routes/attendance.ts) still read `absent`.
 * Same reviewer scope as C-02.
 */
async function approvedNotReconciled(ctx: Ctx): Promise<AttentionItem[]> {
  const scope = await classScope(ctx, 'EXCUSES_REVIEW', null);
  if (!hasClasses(scope)) return [];
  const term = termFilter(ctx, 'e.academic_term_id');
  const cls = excuseClassFilter(scope, 'e.class_id');
  const rows = await ctx.db.all(
    `SELECT e.id, e.student_id, e.student_name, e.class_id, e.class_name, e.session_date, e.updated_at
       FROM excuse_requests e
      WHERE e.status = 'approved'${term.sql}${cls.sql}
        AND EXISTS (SELECT 1 FROM attendance_records ar
                     WHERE ar.status = 'absent' AND ${excuseCoversRowSql('e', 'ar')})
      ORDER BY e.updated_at ASC, e.id ASC`,
    ...term.params, ...cls.params
  );
  if (rows.length === 0) return [];
  const inScopeRows = await excusesInScope(ctx, scope, rows);

  return [...groupBy(inScopeRows, (r: any) => lensForClass(ctx.lenses, r.cg))].map(([lens, list]) => {
    const students = new Set(list.map((r: any) => String(r.student_id)));
    const search = students.size === 1 ? `?search=${encodeURIComponent(String(list[0].student_id))}` : '';
    return {
      id: `attendance:C-05:${lens}`,
      source: 'attendance' as const,
      kind: 'C-05',
      tier: 'slipping' as Tier,
      lens,
      via: [],
      depth: 'write' as ItemDepth,
      count: list.length,
      title: `${list.length} approved ${plural(list.length, 'excuse is', 'excuses are')} still marked absent`,
      entities: list.slice(0, MAX_ENTITIES).map((r: any) => `${r.student_name} · ${r.class_name} (${String(r.session_date).slice(5)})`),
      why: 'The excuse was accepted, but the register still counts these absences against the student.',
      cta: { label: 'Fix registers', href: appHref(`/attendance/records${search}`), external: true },
      waiting_since: sqliteUtcToIso(list[0].updated_at),
    };
  });
}

/** C-03: students below the attendance threshold this term (the dashboard's
 *  at-risk rule: homeroom rate, present + late + excused). */
async function belowThreshold(ctx: Ctx): Promise<AttentionItem[]> {
  const scope = await classScope(ctx, 'ATTENDANCE_VIEW_ALL', 'summary');
  if (!hasClasses(scope)) return [];
  const term = termFilter(ctx);
  const cls = classFilter(scope, 'class_id');
  const rows = await ctx.db.all(
    `SELECT class_id, MAX(class_name) AS class_name, student_id, MAX(student_name) AS student_name,
            SUM(${ATTENDED_SQL_CASE}) AS attended, COUNT(*) AS total
       FROM attendance_records
      WHERE session_type = 'homeroom'${term.sql}${cls.sql}
      GROUP BY class_id, student_id`,
    ...term.params, ...cls.params
  );

  const items: AttentionItem[] = [];
  for (const [lens, list] of groupBy(rows, (r: any) => lensForClass(ctx.lenses, r.class_id))) {
    const atRisk = list
      .filter((r: any) => r.total > 0 && attendanceRate(r.attended, r.total) < ATTENDANCE_WARN_THRESHOLD)
      .map((r: any) => ({ ...r, rate: attendanceRate(r.attended, r.total) }))
      .sort((a: any, b: any) => a.rate - b.rate);
    if (atRisk.length === 0) continue;
    // Names only where every class in the lens is readable at detail.
    const detail = [...new Set(list.map((r: any) => String(r.class_id)))].every((c) => isDetail(scope.depthOf(c)));
    if (!detail) {
      const [cohort] = suppressSmallCohorts<CohortRow>([{ n: new Set(list.map((r: any) => r.student_id)).size, value: atRisk.length }]);
      if (cohort.suppressed) continue;
    }
    const classIds = [...new Set(atRisk.map((r: any) => String(r.class_id)))];
    items.push({
      id: `attendance:C-03:${lens}`,
      source: 'attendance',
      kind: 'C-03',
      tier: 'slipping',
      lens,
      via: [],
      depth: detail ? 'detail' : 'summary',
      count: atRisk.length,
      title: `${atRisk.length} ${plural(atRisk.length, 'student', 'students')} below ${ATTENDANCE_WARN_THRESHOLD}% attendance this term`,
      entities: detail ? atRisk.slice(0, MAX_ENTITIES).map((r: any) => `${r.student_name} · ${r.rate}%`) : [],
      why: 'Each missed day makes the gap harder to close before the term ends.',
      cta: {
        label: 'See attendance',
        href: appHref(classIds.length === 1 ? `/attendance/report?classId=${encodeURIComponent(classIds[0])}` : '/dashboard'),
        external: true,
      },
    });
  }
  return items;
}

/** C-04: absent today with no excuse filed (detail depth only -- it names students). */
async function absentWithoutNotice(ctx: Ctx): Promise<AttentionItem[]> {
  const scope = await classScope(ctx, 'ATTENDANCE_VIEW_ALL', 'detail');
  if (!hasClasses(scope)) return [];
  const cls = classFilter(scope, 'ar.class_id');
  const rows = await ctx.db.all(
    `SELECT ar.class_id, MAX(ar.class_name) AS class_name, ar.student_id, MAX(ar.student_name) AS student_name
       FROM attendance_records ar
      WHERE ar.session_date = ? AND ar.status = 'absent'${cls.sql}
        AND NOT EXISTS (
          SELECT 1 FROM excuse_requests e
           WHERE e.student_id = ar.student_id AND e.session_date = ar.session_date
             AND e.status IN ('pending', 'approved'))
      GROUP BY ar.class_id, ar.student_id
      ORDER BY student_name`,
    ctx.date, ...cls.params
  );
  const visible = rows.filter((r: any) => isDetail(scope.depthOf(String(r.class_id))));

  return [...groupBy(visible, (r: any) => lensForClass(ctx.lenses, r.class_id))].map(([lens, list]) => {
    const students = [...new Map(list.map((r: any) => [String(r.student_id), r])).values()];
    return {
      id: `attendance:C-04:${lens}`,
      source: 'attendance' as const,
      kind: 'C-04',
      tier: 'slipping' as Tier,
      lens,
      via: [],
      depth: 'detail' as ItemDepth,
      count: students.length,
      title: `${students.length} ${plural(students.length, 'student', 'students')} absent today without notice`,
      entities: students.slice(0, MAX_ENTITIES).map((r: any) => `${r.student_name} · ${r.class_name}`),
      why: 'An unexplained absence is worth a call home the same day.',
      cta: { label: 'See registers', href: appHref('/attendance/records'), external: true },
    };
  });
}

/** "Present today" for the classes the viewer is Class Teacher of. */
async function presentTodayTile(ctx: Ctx): Promise<GlanceTile | null> {
  const lead = await ctx.leadClasses();
  if (lead.length === 0) return null;
  const scope = await classScope(ctx, 'ATTENDANCE_VIEW_ALL', 'summary');
  const classes = lead.filter((c) => inScope(scope, c.id));
  if (classes.length === 0) return null;

  const row = await ctx.db.get(
    `SELECT COUNT(DISTINCT student_id) AS total,
            COUNT(DISTINCT CASE WHEN status IN ('present', 'late') THEN student_id END) AS present
       FROM attendance_records
      WHERE session_type = 'homeroom' AND session_date = ? AND class_id IN (SELECT value FROM json_each(?))`,
    ctx.date, JSON.stringify(classes.map((c) => c.id))
  );
  const lenses = [...new Set(classes.map((c) => lensForClass(ctx.lenses, c.id)))];
  const lens = lenses.length === 1 ? lenses[0] : 'SELF';
  const base = {
    id: 'attendance:tile:present-today',
    source: 'attendance' as const,
    lens,
    label: classes.length === 1 ? `Present today · ${classes[0].name}` : 'Present today',
    href: appHref('/attendance?view=day'),
  };
  if (!row?.total) return { ...base, value: null, hint: 'Morning register not taken yet' };

  const detail = classes.every((c) => isDetail(scope.depthOf(c.id)));
  if (!detail) {
    const [cohort] = suppressSmallCohorts<CohortRow>([{ n: row.total, value: row.present }]);
    if (cohort.suppressed) return { ...base, value: null, suppressed: true, hint: 'Too few students to show' };
  }
  const rate = attendanceRate(row.present, row.total);
  return {
    ...base,
    value: `${row.present}/${row.total}`,
    hint: `${rate}% in school`,
    status: rate >= ATTENDANCE_WARN_THRESHOLD ? 'good' : 'warning',
  };
}

// ---------------------------------------------------------------------------
// SELF (learner): S-06, S-07, S-08, "Attendance"
// ---------------------------------------------------------------------------

/** S-06: own absences with no excuse yet (the /excuses/me/absences rule). */
async function ownUnexcusedAbsences(ctx: Ctx): Promise<AttentionItem[]> {
  if (!(await holds(ctx, ['EXCUSES_SUBMIT']))) return [];
  const term = termFilter(ctx, 'ar.academic_term_id');
  const rows = await ctx.db.all(
    `SELECT ar.session_date, ar.period, ar.session_type, ar.class_id, ar.class_name,
            ar.subject_id, COALESCE(s.name, '') AS subject_name
       FROM attendance_records ar
       LEFT JOIN subjects s ON s.id = ar.subject_id
      WHERE ar.student_id = ? AND ar.status = 'absent'${term.sql}
      ORDER BY ar.session_date ASC, ar.period ASC`,
    ctx.userId, ...term.params
  );
  if (rows.length === 0) return [];
  const excuses = await ctx.db.all(
    `SELECT session_date, class_id, class_name, period, session_type, subject_id
       FROM excuse_requests WHERE student_id = ?`,
    ctx.userId
  );
  // Same "covering excuse" match as GET /attendance/excuses/me/absences.
  const covered = (r: any) => excuses.some((e: any) =>
    e.session_date === r.session_date
    && (e.session_type ?? 'homeroom') === r.session_type
    && (r.session_type !== 'subject' || e.subject_id === r.subject_id)
    && (e.class_id ? e.class_id === r.class_id : String(e.class_name).toLowerCase() === String(r.class_name).toLowerCase())
    && (!e.period || e.period === r.period)
  );
  const open = rows.filter((r: any) => !covered(r));
  if (open.length === 0) return [];
  return [{
    id: 'attendance:S-06:SELF',
    source: 'attendance',
    kind: 'S-06',
    tier: 'slipping',
    lens: 'SELF',
    via: [],
    depth: 'detail',
    count: open.length,
    title: `${open.length} ${plural(open.length, 'absence has', 'absences have')} no excuse yet`,
    entities: open.slice(0, MAX_ENTITIES).map((r: any) =>
      `${r.session_type === 'subject' ? r.subject_name || 'Lesson' : 'Morning check'} · ${String(r.session_date).slice(5)}`),
    why: 'An unexplained absence counts against your attendance rate.',
    cta: { label: 'Explain', href: appHref('/excuses/new'), external: true },
    waiting_since: schoolLocalToIso(open[0].session_date, '00:00'),
  }];
}

/** Own term attendance (homeroom rate, the /attendance/me headline). */
async function ownAttendance(ctx: Ctx): Promise<{ total: number; rate: number } | null> {
  if (!(await holds(ctx, ['ATTENDANCE_VIEW_OWN', 'ATTENDANCE_DASHBOARD_VIEW_OWN']))) return null;
  const term = termFilter(ctx);
  const row = await ctx.db.get(
    `SELECT COUNT(*) AS total, SUM(${ATTENDED_SQL_CASE}) AS attended
       FROM attendance_records
      WHERE student_id = ? AND session_type = 'homeroom'${term.sql}`,
    ctx.userId, ...term.params
  );
  if (!row?.total) return null;
  return { total: row.total, rate: attendanceRate(row.attended ?? 0, row.total) };
}

/**
 * S-09: the student's own excuses (the GET /attendance/excuses/me rows):
 * pending ones waiting for a decision, and recent rejections that can still
 * be appealed (no follow-up request supersedes them yet -- the rule POST
 * /attendance/excuse applies to an appeal).
 */
async function ownExcuses(ctx: Ctx): Promise<AttentionItem[]> {
  if (!(await holds(ctx, ['EXCUSES_VIEW_OWN']))) return [];
  const term = termFilter(ctx, 'e.academic_term_id');
  const rows = await ctx.db.all(
    `SELECT e.id, e.status, e.session_date, e.session_type, e.subject_name, e.class_name, e.created_at, e.updated_at
       FROM excuse_requests e
      WHERE e.student_id = ?${term.sql}
        AND (e.status = 'pending'
             OR (e.status = 'rejected' AND e.updated_at >= datetime('now', ?)
                 AND NOT EXISTS (SELECT 1 FROM excuse_requests x
                                  WHERE x.supersedes_id = e.id AND x.student_id = e.student_id)))
      ORDER BY e.created_at ASC, e.id ASC`,
    ctx.userId, ...term.params, `-${REJECTED_EXCUSE_DAYS} days`
  );
  if (rows.length === 0) return [];
  const rejected = rows.filter((r: any) => r.status === 'rejected');
  const pending = rows.filter((r: any) => r.status === 'pending');
  const what = (r: any) =>
    `${r.session_type === 'subject' ? r.subject_name || 'Lesson' : 'Morning check'} · ${String(r.session_date).slice(5)}`;
  const parts = [
    rejected.length ? `${rejected.length} ${plural(rejected.length, 'excuse was', 'excuses were')} rejected` : '',
    pending.length ? `${pending.length} ${plural(pending.length, 'excuse is', 'excuses are')} waiting for a decision` : '',
  ].filter(Boolean);
  return [{
    id: 'attendance:S-09:SELF',
    source: 'attendance',
    kind: 'S-09',
    tier: rejected.length ? 'slipping' : 'tidy',
    lens: 'SELF',
    via: [],
    depth: 'detail',
    count: rows.length,
    title: parts.join(' · '),
    entities: [
      ...rejected.map((r: any) => `${what(r)} · rejected`),
      ...pending.map((r: any) => `${what(r)} · waiting`),
    ].slice(0, MAX_ENTITIES),
    why: rejected.length
      ? 'A rejected excuse can be resubmitted with more detail; until then the absence counts.'
      : 'Nothing to do yet -- a teacher still has to decide.',
    cta: {
      label: rejected.length ? 'Resubmit' : 'My excuses',
      href: appHref(rejected.length === 1 ? `/excuses/${rejected[0].id}` : '/excuses'),
      external: true,
    },
    waiting_since: sqliteUtcToIso((rejected[0] ?? pending[0]).created_at),
  }];
}

async function learnerSignals(ctx: Ctx): Promise<{ items: AttentionItem[]; tiles: GlanceTile[] }> {
  const items: AttentionItem[] = [...(await ownUnexcusedAbsences(ctx)), ...(await ownExcuses(ctx))];
  const tiles: GlanceTile[] = [];

  const own = await ownAttendance(ctx);
  if (own) {
    const below = own.rate < ATTENDANCE_WARN_THRESHOLD;
    // S-07: below the bar, once there are enough sessions for it to mean something.
    if (below && own.total >= ATTENDANCE_MIN_SESSIONS) {
      items.push({
        id: 'attendance:S-07:SELF',
        source: 'attendance',
        kind: 'S-07',
        tier: 'slipping',
        lens: 'SELF',
        via: [],
        depth: 'detail',
        count: 1,
        title: `Your attendance is ${own.rate}%, below ${ATTENDANCE_WARN_THRESHOLD}%`,
        entities: [],
        why: 'Falling attendance is flagged to your class teacher and is hard to recover late in the term.',
        cta: { label: 'My attendance', href: appHref('/attendance'), external: true },
      });
    }
    tiles.push({
      id: 'attendance:tile:my-attendance',
      source: 'attendance',
      lens: 'SELF',
      label: 'Attendance',
      value: `${own.rate}%`,
      hint: `This term · ${own.total} ${plural(own.total, 'day', 'days')}`,
      status: below ? 'warning' : 'good',
      href: appHref('/attendance'),
    });
  }

  // S-08: conduct balance (term ledger) below 70.
  if (await holds(ctx, ['DISCIPLINE_VIEW_OWN'])) {
    const balance = await getStudentTermBalance(ctx.db, ctx.userId, ctx.academicYearId, ctx.academicTermId);
    if (balance.eventCount > 0 && balance.balance < CONDUCT_FLAG_BELOW) {
      items.push({
        id: 'attendance:S-08:SELF',
        source: 'attendance',
        kind: 'S-08',
        tier: 'slipping',
        lens: 'SELF',
        via: [],
        depth: 'detail',
        count: 1,
        title: `Your conduct balance is ${balance.balance}`,
        entities: [],
        why: `Below ${CONDUCT_FLAG_BELOW} points, further incidents can lead to sanctions.`,
        cta: { label: 'My conduct', href: appHref('/discipline/me'), external: true },
      });
    }
  }
  return { items, tiles };
}

// ---------------------------------------------------------------------------
// SCHOOL operations: O-06
// ---------------------------------------------------------------------------

/** O-06: staff clocked in late today (a count; staff rows carry no class, so
 *  under v2 only a school-wide grant covers them). */
async function staffLateToday(ctx: Ctx): Promise<AttentionItem[]> {
  let depth: Depth | null = 'detail';
  if (ctx.enforce) {
    const s = await accessScope(ctx.req, 'STAFF_ATTENDANCE_VIEW_ALL', 'summary');
    if (!s.unrestricted) return [];
    depth = decide(await requestSnapshot(ctx.req), 'STAFF_ATTENDANCE_VIEW_ALL').depth;
  } else if (!ctx.req.user!.permissions.has('STAFF_ATTENDANCE_VIEW_ALL')) {
    return [];
  }
  const row = await ctx.db.get(
    `SELECT COUNT(*) AS n FROM staff_attendance WHERE date = ? AND status = 'late'`,
    ctx.date
  );
  const n = row?.n ?? 0;
  if (!n) return [];
  const lens = schoolLens(ctx.lenses);
  return [{
    id: `attendance:O-06:${lens}`,
    source: 'attendance',
    kind: 'O-06',
    tier: 'tidy',
    lens,
    via: [],
    depth: isDetail(depth) ? 'detail' : 'summary',
    count: n,
    title: `${n} staff ${plural(n, 'member', 'members')} clocked in late today`,
    entities: [],
    why: 'Worth a look if it keeps happening; nobody is blocked.',
    cta: { label: 'Staff attendance', href: appHref('/staff/attendance'), external: true },
  }];
}

// ---------------------------------------------------------------------------
// DISCIPLINE: D-01 .. D-03
// ---------------------------------------------------------------------------

interface StudentScope {
  /** Every student (legacy key held, or a school-wide v2 grant). */
  all: boolean;
  allowed: Set<string>;
  /** Class group per allowed student (restricted scopes only). */
  classOf: Map<string, number | null>;
}

/**
 * The students GET /discipline/overview covers for the viewer: legacy -- the
 * DISCIPLINE_VIEW_ALL key, school-wide; enforce -- studentScopeFilter at
 * detail depth over the term's discipline students. Resolved once per request.
 */
function disciplineScope(ctx: Ctx): Promise<StudentScope | null> {
  ctx.disciplineScope ??= (async () => {
    const cap = 'DISCIPLINE_VIEW_ALL';
    if (!ctx.enforce) {
      return ctx.req.user!.permissions.has(cap) ? { all: true, allowed: new Set<string>(), classOf: new Map() } : null;
    }
    const s = await accessScope(ctx.req, cap, 'detail');
    if (s.unrestricted) return { all: true, allowed: new Set<string>(), classOf: new Map() };
    if (!s.scope) return null;
    const term = termFilter(ctx);
    const candidates = (await ctx.db.all(
      `SELECT DISTINCT student_id FROM discipline_records WHERE deleted_at IS NULL${term.sql}`,
      ...term.params
    )).map((r: any) => String(r.student_id));
    const classOf = await resolveStudentClassGroups(ctx.db, candidates, {
      misToken: ctx.req.user?.misToken,
      academicYearId: ctx.academicYearId ?? null,
    });
    const allowed = new Set(candidates.filter((id) =>
      decide(s.snapshot, cap, studentTarget(id, classOf.get(id) ?? null), 'detail').allowed));
    return allowed.size ? { all: false, allowed, classOf } : null;
  })();
  return ctx.disciplineScope;
}

/**
 * The demerits D-01 (waiting for review) and D-03 (recent major incidents)
 * draw on, in one read; each item applies its own rule to the rows.
 */
function demeritRows(ctx: Ctx): Promise<any[]> {
  const term = termFilter(ctx);
  ctx.demerits ??= ctx.db.all(
    `SELECT id, student_id, student_name, title, severity, status, incident_date, created_at
       FROM discipline_records
      WHERE type = 'demerit' AND deleted_at IS NULL${term.sql}
        AND (status IN ('open', 'under_review')
             OR (severity = 'major' AND status != 'dismissed' AND incident_date >= ?))
      ORDER BY created_at ASC, id ASC`,
    ...term.params, addDays(ctx.today, -MAJOR_INCIDENT_WINDOW_DAYS)
  );
  return ctx.demerits;
}

const studentInScope = (scope: StudentScope, studentId: unknown) => scope.all || scope.allowed.has(String(studentId));
/** School-wide scopes carry no class (that would be one lookup per student). */
const disciplineLens = (ctx: Ctx, scope: StudentScope, studentId: unknown) =>
  scope.all ? schoolLens(ctx.lenses) : lensForClass(ctx.lenses, scope.classOf.get(String(studentId)) ?? null);

/** D-01: demerits waiting for a review decision (open / under review). */
async function disciplineAwaitingReview(ctx: Ctx): Promise<AttentionItem[]> {
  // Only reviewers can act on it (PUT /discipline/:id/status).
  if (!(await holds(ctx, ['DISCIPLINE_REVIEW']))) return [];
  const scope = await disciplineScope(ctx);
  if (!scope) return [];
  const rows = (await demeritRows(ctx))
    .filter((r: any) => (r.status === 'open' || r.status === 'under_review') && studentInScope(scope, r.student_id));

  return [...groupBy(rows, (r: any) => disciplineLens(ctx, scope, r.student_id))].map(([lens, list]) => {
    const oldest = sqliteUtcToIso(list[0].created_at);
    const waitedMs = oldest ? Date.now() - Date.parse(oldest) : 0;
    return {
      id: `attendance:D-01:${lens}`,
      source: 'attendance' as const,
      kind: 'D-01',
      tier: (waitedMs > DISCIPLINE_REVIEW_BLOCKING_MS ? 'blocking' : 'slipping') as Tier,
      lens,
      via: [],
      depth: 'detail' as ItemDepth,
      count: list.length,
      title: `${list.length} discipline ${plural(list.length, 'record', 'records')} waiting for review`,
      entities: list.slice(0, MAX_ENTITIES).map((r: any) => `${r.student_name} · ${r.title}`),
      why: 'Until a record is reviewed, no sanction is decided and the student and family hear nothing.',
      cta: { label: 'Review records', href: appHref('/discipline/records'), external: true },
      waiting_since: oldest,
    };
  });
}

/** D-02: students at or over the conduct follow-up threshold this term
 *  (term demerit points, the routes/discipline.ts escalation rule). */
async function conductFollowUp(ctx: Ctx): Promise<AttentionItem[]> {
  const scope = await disciplineScope(ctx);
  if (!scope) return [];
  const flagged = (await listTermBalances(ctx.db, ctx.academicTermId))
    .filter((b) => b.demeritPoints >= CONDUCT_FLAG_THRESHOLD && studentInScope(scope, b.studentId))
    .sort((a, b) => b.demeritPoints - a.demeritPoints);

  return [...groupBy(flagged, (b) => disciplineLens(ctx, scope, b.studentId))].map(([lens, list]) => ({
    id: `attendance:D-02:${lens}`,
    source: 'attendance' as const,
    kind: 'D-02',
    tier: 'slipping' as Tier,
    lens,
    via: [],
    // The scope is detail-depth by construction (studentScopeFilter's rule).
    depth: 'detail' as ItemDepth,
    count: list.length,
    title: `${list.length} ${plural(list.length, 'student needs', 'students need')} a conduct follow-up`,
    entities: list.slice(0, MAX_ENTITIES).map((b) => `${b.studentName} · ${b.demeritPoints} demerit pts`),
    why: `${CONDUCT_FLAG_THRESHOLD}+ demerit points this term is the point where a conversation should happen.`,
    cta: {
      label: 'See conduct',
      href: appHref(list.length === 1 ? `/reports/student/${encodeURIComponent(list[0].studentId)}` : '/discipline/records'),
      external: true,
    },
  }));
}

/** D-03: major incidents (major demerits) in the last 7 days. Replaces the
 *  legacy 'all'-addressed staff broadcasts Home leaves out of `updates`. */
async function recentMajorIncidents(ctx: Ctx): Promise<AttentionItem[]> {
  const scope = await disciplineScope(ctx);
  if (!scope) return [];
  const since = addDays(ctx.today, -MAJOR_INCIDENT_WINDOW_DAYS);
  const rows = (await demeritRows(ctx))
    .filter((r: any) => r.severity === 'major' && r.status !== 'dismissed' && String(r.incident_date) >= since
      && studentInScope(scope, r.student_id))
    // Newest first.
    .reverse()
    .sort((a: any, b: any) => String(b.incident_date).localeCompare(String(a.incident_date)));

  return [...groupBy(rows, (r: any) => disciplineLens(ctx, scope, r.student_id))].map(([lens, list]) => {
    const fresh = list.some((r: any) => {
      const at = sqliteUtcToIso(r.created_at);
      return at != null && Date.now() - Date.parse(at) <= MAJOR_INCIDENT_FRESH_MS;
    });
    return {
      id: `attendance:D-03:${lens}`,
      source: 'attendance' as const,
      kind: 'D-03',
      tier: (fresh ? 'slipping' : 'tidy') as Tier,
      lens,
      via: [],
      depth: 'detail' as ItemDepth,
      count: list.length,
      title: `${list.length} major ${plural(list.length, 'incident', 'incidents')} in the last ${MAJOR_INCIDENT_WINDOW_DAYS} days`,
      entities: list.slice(0, MAX_ENTITIES).map((r: any) => `${r.student_name} · ${r.title} (${String(r.incident_date).slice(5)})`),
      why: 'Serious incidents are worth knowing about even when someone else is handling them.',
      cta: { label: 'See incidents', href: appHref('/discipline/records'), external: true },
    };
  });
}

// ---------------------------------------------------------------------------
// SELF (staff): O-07 · ADMIN: A-01
// ---------------------------------------------------------------------------

/** O-07: the viewer clocks in as staff and has not today (POST /staff/clock-in). */
async function ownClockInMissing(ctx: Ctx): Promise<AttentionItem[]> {
  if (ctx.date !== ctx.today || ctx.nowMin < timeToMinutes(HOMEROOM_START_TIME)) return [];
  if (!(await holds(ctx, ['STAFF_ATTENDANCE_CLOCK']))) return [];
  if (!(await ctx.schoolDay())) return [];
  const row = await ctx.db.get(
    'SELECT 1 AS n FROM staff_attendance WHERE staff_id = ? AND date = ?',
    ctx.userId, ctx.today
  );
  if (row) return [];
  return [{
    id: 'attendance:O-07:SELF',
    source: 'attendance',
    kind: 'O-07',
    tier: 'slipping',
    lens: 'SELF',
    via: [],
    depth: 'write',
    count: 1,
    title: 'You have not clocked in today',
    entities: [],
    why: 'Your day is recorded as absent until you clock in, and a late clock-in is flagged.',
    cta: { label: 'Clock in', href: appHref('/staff/attendance'), external: true },
    waiting_since: schoolLocalToIso(ctx.today, HOMEROOM_START_TIME),
  }];
}

/** A-01: accounts that signed in but have no role yet (PUT /admin/users/:id/role). */
async function accountsAwaitingRole(ctx: Ctx): Promise<AttentionItem[]> {
  let detail = true;
  if (ctx.enforce) {
    const d = decideAny(await requestSnapshot(ctx.req), ['USERS_MANAGE']);
    if (!d.allowed) return [];
    detail = d.depth == null || isDetail(d.depth);
  } else if (!ctx.req.user!.permissions.has('USERS_MANAGE')) {
    return [];
  }
  const rows = await ctx.db.all(
    `SELECT name, created_at FROM users WHERE role = 'unassigned' ORDER BY created_at ASC, name ASC`
  );
  if (rows.length === 0) return [];
  const lens = schoolLens(ctx.lenses);
  return [{
    id: `attendance:A-01:${lens}`,
    source: 'attendance',
    kind: 'A-01',
    tier: 'tidy',
    lens,
    via: [],
    depth: detail ? 'write' : 'summary',
    count: rows.length,
    title: `${rows.length} ${plural(rows.length, 'account is', 'accounts are')} waiting for a role`,
    entities: detail ? rows.slice(0, MAX_ENTITIES).map((r: any) => String(r.name)) : [],
    why: 'They can sign in but see nothing here until someone assigns them a role.',
    cta: { label: 'Assign roles', href: appHref('/admin'), external: true },
    waiting_since: sqliteUtcToIso(rows[0].created_at),
  }];
}

// ---------------------------------------------------------------------------
// Updates: the user's own unread notifications, last 7 days
// ---------------------------------------------------------------------------

const SEVERITIES = new Set(['info', 'success', 'warning', 'critical']);

async function recentUpdates(ctx: Ctx): Promise<UpdateItem[]> {
  if (!(await holds(ctx, ['NOTIFICATIONS_MANAGE']))) return [];
  // Personal rows only: the legacy 'all' staff broadcasts name students
  // school-wide and are being replaced by holder-routed rows (access/notify.ts).
  const rows = await ctx.db.all(
    `SELECT id, type, title, message, link, severity, created_at
       FROM notifications
      WHERE user_id = ? AND read = 0
        AND type NOT IN (SELECT value FROM json_each(?))
        AND created_at >= datetime('now', '-7 days')
      ORDER BY created_at DESC, id DESC
      LIMIT ?`,
    ctx.userId, JSON.stringify(HOME_DERIVED_KINDS), MAX_UPDATES
  );
  return rows.map((n: any) => ({
    id: `attendance:notification:${n.id}`,
    source: 'attendance' as const,
    kind: String(n.type),
    title: n.title,
    body: n.message ?? null,
    severity: SEVERITIES.has(n.severity) ? n.severity : 'info',
    created_at: sqliteUtcToIso(n.created_at) ?? new Date().toISOString(),
    read: false,
    href: n.link ? (/^https?:\/\//.test(n.link) ? n.link : appHref(n.link)) : null,
  }));
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

/** One signal failing must not blank the whole summary. */
async function safely<T>(name: string, work: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await work();
  } catch (err) {
    console.warn(`[home-summary] ${name} failed: ${(err as Error)?.message ?? err}`);
    return fallback;
  }
}

export async function buildHomeSummary(
  req: AuthenticatedRequest,
  db: Database,
  input: HomeSummaryInput
): Promise<HomeSummary> {
  const today = schoolDateString();
  const date = input.date ?? today;
  const user = req.user!;
  // No current term from MIS: use the term the local calendar puts the date
  // in, so "this term" never silently means "all time".
  const period = user.academicTermId != null
    ? { academicYearId: user.academicYearId, academicTermId: user.academicTermId }
    : await resolveAcademicPeriodForDate(db, date, { academicYearId: user.academicYearId });

  let lead: Promise<Array<{ id: string; name: string }>> | null = null;
  let schoolDay: Promise<boolean> | null = null;
  const ctx: Ctx = {
    req,
    db,
    userId: user.id,
    date,
    today,
    nowMin: date < today ? 24 * 60 : date > today ? -1 : schoolMinutesOfDay(),
    lenses: input.lenses ?? [],
    lessons: input.lessons ?? [],
    academicYearId: period.academicYearId,
    academicTermId: period.academicTermId,
    enforce: accessMode() === 'enforce',
    leadClasses: () => {
      // Class Teacher placement from MIS (UserGrade), fetched once per request.
      lead ??= user.misToken
        ? fetchClassTeacherClasses(user.misToken, user.id, user.academicYearId).catch(() => [])
        : Promise.resolve([]);
      return lead;
    },
    schoolDay: () => (schoolDay ??= isSchoolDay(db, date)),
  };

  const marked = await safely('lessons', () => evaluateLessons(ctx), [] as MarkedLesson[]);
  const [teaching, learner, c01, c02, c03, c04, c05, d01, d02, d03, o06, o07, a01, present, updates] = await Promise.all([
    safely('teaching', () => teachingSignals(ctx, marked), { items: [], tiles: [] }),
    safely('learner', () => learnerSignals(ctx), { items: [], tiles: [] }),
    safely('C-01', () => homeroomMissing(ctx), []),
    safely('C-02', () => excusesPending(ctx), []),
    safely('C-03', () => belowThreshold(ctx), []),
    safely('C-04', () => absentWithoutNotice(ctx), []),
    safely('C-05', () => approvedNotReconciled(ctx), []),
    safely('D-01', () => disciplineAwaitingReview(ctx), []),
    safely('D-02', () => conductFollowUp(ctx), []),
    safely('D-03', () => recentMajorIncidents(ctx), []),
    safely('O-06', () => staffLateToday(ctx), []),
    safely('O-07', () => ownClockInMissing(ctx), []),
    safely('A-01', () => accountsAwaitingRole(ctx), []),
    safely('present-today', () => presentTodayTile(ctx), null),
    safely('updates', () => recentUpdates(ctx), []),
  ]);

  const items = [
    ...teaching.items, ...c01, ...c02, ...c03, ...c04, ...c05, ...d01, ...d02, ...d03,
    ...learner.items, ...o06, ...o07, ...a01,
  ];
  // Last line of defence: a summary-depth item never names anyone.
  for (const item of items) if (item.depth === 'summary') item.entities = [];

  return {
    ...emptyHomeSummary(true),
    items,
    tiles: [...teaching.tiles, ...(present ? [present] : []), ...learner.tiles].slice(0, MAX_TILES),
    updates,
    today_marks: marked.map((l) => ({
      lesson_key: l.lesson_key,
      status: l.status,
      ...(l.mine ? { href: appHref(l.link) } : {}),
    })),
  };
}

