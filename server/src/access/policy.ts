import { getDb } from '../database.js';
import {
  AccessSnapshot,
  decide,
  Decision,
  Depth,
  scopeFor,
  ScopeEntry,
  Target,
} from '../vendor/nga-access/index.js';
import { getSnapshot } from './snapshot.js';
import { resolveStudentClassGroups } from './students.js';

/**
 * How this app uses access control v2 (plan §13, packages/access README §7):
 *
 *   off      legacy checks only; v2 is never consulted          <- tests
 *   shadow   legacy checks decide; v2 decides too, every
 *            disagreement is counted in access_shadow_diffs    <- default
 *   enforce  v2 decides
 *
 * In shadow nothing a client sees changes: comparisons run after the legacy
 * decision, in the background (never awaited by the request), and are
 * skipped silently when there is no snapshot.
 */
export type AccessMode = 'off' | 'shadow' | 'enforce';

export function accessMode(): AccessMode {
  const raw = (process.env.ACCESS_V2_MODE || '').trim().toLowerCase();
  if (raw === 'off' || raw === 'shadow' || raw === 'enforce') return raw;
  return process.env.NODE_ENV === 'test' ? 'off' : 'shadow';
}

// ---------------------------------------------------------------------------
// Background work (shadow comparisons) -- tracked so tests can wait for it.
// ---------------------------------------------------------------------------
const pending = new Set<Promise<unknown>>();

export function inBackground(work: () => Promise<unknown>) {
  const p = Promise.resolve()
    .then(work)
    .catch((err) => console.warn(`[access] background check failed: ${(err as Error)?.message ?? err}`))
    .finally(() => pending.delete(p));
  pending.add(p);
}

/** Resolves once every queued shadow comparison has finished (tests). */
export async function accessIdle() {
  while (pending.size > 0) await Promise.allSettled([...pending]);
}

// ---------------------------------------------------------------------------
// Snapshot + decisions
// ---------------------------------------------------------------------------

/** The requesting user's snapshot, memoised on the request. null = none. */
export async function requestSnapshot(req: any): Promise<AccessSnapshot | null> {
  if (req._accessSnapshot === undefined) {
    req._accessSnapshot = req?.user ? await getSnapshot(req.user, req.user.misToken) : null;
  }
  return req._accessSnapshot;
}

/** Any-of decision over several capabilities; deepest covering depth wins. */
export function decideAny(
  snapshot: AccessSnapshot | null,
  caps: string[],
  target?: Target | null,
  minDepth?: Depth | null
): Decision {
  let best: Decision = { allowed: false, depth: null, via: [] };
  for (const cap of caps) {
    const d = decide(snapshot, cap, target, minDepth ?? null);
    if (d.allowed && (!best.allowed || (d.depth && !best.depth))) best = d;
  }
  return best;
}

export const routeOf = (req: any) =>
  `${req.method} ${(req.baseUrl || '') + (req.route?.path || req.path || '')}`.slice(0, 200);

// ---------------------------------------------------------------------------
// Shadow diffs
// ---------------------------------------------------------------------------
const recentDiffs = new Map<string, number>();
const DIFF_THROTTLE_MS = 60_000;

/** Count a legacy/v2 disagreement (throttled per key, never throws). */
export async function recordShadowDiff(entry: {
  userId: string;
  capability: string;
  route: string;
  legacyAllowed: boolean;
  v2: Pick<Decision, 'allowed' | 'depth'>;
  target?: unknown;
}) {
  const key = `${entry.userId}|${entry.capability}|${entry.route}|${entry.legacyAllowed}|${entry.v2.allowed}`;
  const last = recentDiffs.get(key) ?? 0;
  if (Date.now() - last < DIFF_THROTTLE_MS) return;
  recentDiffs.set(key, Date.now());
  if (recentDiffs.size > 5000) recentDiffs.clear();
  try {
    await getDb().run(
      `INSERT INTO access_shadow_diffs
         (app, user_id, capability, route, legacy_allowed, v2_allowed, v2_depth, sample_target)
       VALUES ('da', ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, capability, route, legacy_allowed, v2_allowed) DO UPDATE SET
         hits = hits + 1,
         last_seen = CURRENT_TIMESTAMP,
         v2_depth = excluded.v2_depth,
         sample_target = COALESCE(excluded.sample_target, sample_target)`,
      String(entry.userId),
      entry.capability.slice(0, 150),
      entry.route,
      entry.legacyAllowed ? 1 : 0,
      entry.v2.allowed ? 1 : 0,
      entry.v2.depth ?? null,
      entry.target != null ? JSON.stringify(entry.target).slice(0, 500) : null
    );
  } catch (err) {
    console.warn(`[access] shadow diff not recorded: ${(err as Error)?.message ?? err}`);
  }
}

/**
 * Shadow comparison for the legacy permission guards. Legacy semantics are
 * global ("holds the key"), so v2 is asked the same: "held anywhere" (no
 * target). Background only; never changes the response.
 */
export function shadowCompareLegacy(req: any, keys: string[], legacyAllowed: boolean, all = false) {
  if (accessMode() !== 'shadow' || !req?.user?.id) return;
  const route = routeOf(req);
  inBackground(async () => {
    const snapshot = await requestSnapshot(req);
    if (!snapshot) return;
    const v2 = all
      ? (keys.every((k) => decide(snapshot, k).allowed) ? decide(snapshot, keys[0]) : { allowed: false, depth: null, via: [] })
      : decideAny(snapshot, keys);
    if (v2.allowed !== legacyAllowed) {
      await recordShadowDiff({ userId: req.user.id, capability: keys.join(all ? '&' : '|'), route, legacyAllowed, v2 });
    }
  });
}

/**
 * The v2 verdict for a legacy guard in enforce mode ("held anywhere").
 * null = no snapshot (caller fails closed).
 */
export async function enforceHeldAnywhere(req: any, keys: string[], all = false): Promise<boolean | null> {
  const snapshot = await requestSnapshot(req);
  if (!snapshot) return null;
  return all ? keys.every((k) => decide(snapshot, k).allowed) : decideAny(snapshot, keys).allowed;
}

// ---------------------------------------------------------------------------
// Scoped point checks
// ---------------------------------------------------------------------------

export interface AccessCheckOptions {
  minDepth?: Depth | null;
  /** What the legacy code decided (default true: the route guard already passed). */
  legacyAllowed?: boolean;
  /** Label for the shadow diff row (default: the request's route). */
  route?: string;
}

/**
 * May the user use `cap` on `target`?
 *   off     -> legacy verdict
 *   shadow  -> legacy verdict; v2 compared in the background
 *   enforce -> v2 verdict (no snapshot -> false)
 */
export type TargetArg = Target | null | undefined | (() => Promise<Target | null | undefined>);
const resolveTarget = async (t: TargetArg) => (typeof t === 'function' ? t() : t);

export async function accessCheck(
  req: any,
  cap: string | string[],
  targetArg: TargetArg,
  opts: AccessCheckOptions = {}
): Promise<boolean> {
  const caps = Array.isArray(cap) ? cap : [cap];
  const legacyAllowed = opts.legacyAllowed ?? true;
  const mode = accessMode();
  if (mode === 'off') return legacyAllowed;
  if (mode === 'shadow') {
    if (req?.user?.id) {
      const route = opts.route ?? routeOf(req);
      inBackground(async () => {
        const snapshot = await requestSnapshot(req);
        if (!snapshot) return;
        const target = await resolveTarget(targetArg);
        const v2 = decideAny(snapshot, caps, target, opts.minDepth);
        if (v2.allowed !== legacyAllowed) {
          await recordShadowDiff({ userId: req.user.id, capability: caps.join('|'), route, legacyAllowed, v2, target });
        }
      });
    }
    return legacyAllowed;
  }
  const snapshot = await requestSnapshot(req);
  if (!snapshot) return false;
  return decideAny(snapshot, caps, await resolveTarget(targetArg), opts.minDepth).allowed;
}

/** Express middleware form of accessCheck (403 when it says no). */
export function requireAccess(cap: string | string[], targetOf: (req: any) => TargetArg, opts: AccessCheckOptions = {}) {
  return async (req: any, res: any, next: any) => {
    try {
      if (accessMode() === 'off') return next();
      const ok = await accessCheck(req, cap, () => resolveTarget(targetOf(req)), opts);
      if (ok) return next();
      return res.status(403).json({ success: false, message: 'Forbidden. This is outside the classes or students you are responsible for.' });
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Where may the user use `cap` at `minDepth`? Only meaningful in enforce:
 *   { unrestricted: true }          -- off/shadow, or an `all` scope
 *   { unrestricted: false, scope }  -- enforce; scope null = nowhere
 */
export async function accessScope(
  req: any,
  cap: string,
  minDepth: Depth | null = null
): Promise<{ unrestricted: true } | { unrestricted: false; scope: ScopeEntry | null; snapshot: AccessSnapshot | null }> {
  if (accessMode() !== 'enforce') return { unrestricted: true };
  const snapshot = await requestSnapshot(req);
  const scope = scopeFor(snapshot, cap, minDepth);
  if (scope?.all) return { unrestricted: true };
  return { unrestricted: false, scope, snapshot };
}

/** SQL fragment for a scope over rows that carry class/subject/student ids. */
export function scopeToSql(
  scope: ScopeEntry | null,
  cols: { classId: string; subjectId?: string; studentId: string }
): { sql: string; params: any[] } {
  if (!scope) return { sql: '1=0', params: [] };
  if (scope.all) return { sql: '1=1', params: [] };
  const parts: string[] = [];
  const params: any[] = [];
  if (scope.class_groups?.length) {
    parts.push(`${cols.classId} IN (SELECT CAST(value AS TEXT) FROM json_each(?))`);
    params.push(JSON.stringify(scope.class_groups));
  }
  if (cols.subjectId && scope.pairs?.length) {
    parts.push(
      `EXISTS (SELECT 1 FROM json_each(?) p WHERE json_extract(p.value, '$[0]') = ${cols.subjectId}
                 AND CAST(json_extract(p.value, '$[1]') AS TEXT) = ${cols.classId})`
    );
    params.push(JSON.stringify(scope.pairs));
  }
  const students = [...(scope.students ?? []), ...(scope.self != null ? [scope.self] : [])];
  if (students.length) {
    parts.push(`${cols.studentId} IN (SELECT CAST(value AS TEXT) FROM json_each(?))`);
    params.push(JSON.stringify(students));
  }
  return parts.length ? { sql: `(${parts.join(' OR ')})`, params } : { sql: '1=0', params: [] };
}

const numOrNull = (v: unknown) => {
  const n = Number(v);
  return v !== null && v !== undefined && v !== '' && Number.isInteger(n) ? n : null;
};

export function studentTarget(studentId: unknown, classGroupId: unknown, subjectId?: unknown): Target {
  // A student in a class with no subject in context (conduct, excuses,
  // attendance history): a subject teacher of that class is covered too
  // (anySubject). Whole-class actions such as the homeroom register never
  // go through here.
  const subject = numOrNull(subjectId);
  return { studentId: numOrNull(studentId), classGroupId: numOrNull(classGroupId), subjectId: subject, anySubject: subject == null };
}

/** Class group of one student (local registers, then MIS). */
export async function classGroupOfStudent(req: any, studentId: string): Promise<number | null> {
  const map = await resolveStudentClassGroups(getDb(), [String(studentId)], {
    misToken: req?.user?.misToken,
    academicYearId: req?.user?.academicYearId ?? null,
  });
  return map.get(String(studentId)) ?? null;
}

/**
 * Of these students, which may the user see with `cap` at `minDepth`?
 * (Row target = the student + their class group.)
 */
export async function allowedStudents(
  req: any,
  snapshot: AccessSnapshot | null,
  cap: string,
  minDepth: Depth | null,
  studentIds: string[],
  knownClass: Map<string, number | null> = new Map(),
  subjectId: number | null = null
): Promise<Set<string>> {
  const unknown = studentIds.filter((id) => !knownClass.has(String(id)));
  const resolved = await resolveStudentClassGroups(getDb(), unknown, {
    misToken: req?.user?.misToken,
    academicYearId: req?.user?.academicYearId ?? null,
  });
  const out = new Set<string>();
  for (const id of studentIds) {
    const cg = knownClass.has(String(id)) ? knownClass.get(String(id)) : resolved.get(String(id));
    if (decide(snapshot, cap, studentTarget(id, cg, subjectId), minDepth).allowed) out.add(String(id));
  }
  return out;
}

/**
 * Enforce-mode list filter over a table's student_id column: returns a SQL
 * fragment restricting rows to students the user may see, or null when no
 * filtering applies (off/shadow, or an all-school scope).
 * `candidates` loads the distinct student ids the unfiltered query would hit.
 */
export async function studentScopeFilter(
  req: any,
  cap: string,
  minDepth: Depth | null,
  candidates: () => Promise<string[]>,
  column = 'student_id'
): Promise<{ sql: string; params: any[] } | null> {
  const s = await accessScope(req, cap, minDepth);
  if (s.unrestricted) return null;
  if (!s.scope) return { sql: '1=0', params: [] };
  const ok = await allowedStudents(req, s.snapshot, cap, minDepth, await candidates());
  return { sql: `${column} IN (SELECT value FROM json_each(?))`, params: [JSON.stringify([...ok])] };
}

/**
 * Shadow mode: count (never log the data of) rows in a legacy result that v2
 * would hide. Background only.
 */
export function shadowListLeak(
  req: any,
  cap: string,
  minDepth: Depth | null,
  rows: Array<{ studentId: unknown; classGroupId?: unknown; subjectId?: unknown }>,
  route?: string
) {
  if (accessMode() !== 'shadow' || !req?.user?.id || rows.length === 0) return;
  const r = route ?? routeOf(req);
  const copy = rows.map((x) => ({ ...x }));
  inBackground(async () => {
    const snapshot = await requestSnapshot(req);
    if (!snapshot) return;
    const scope = scopeFor(snapshot, cap, minDepth);
    if (scope?.all) return;
    const needClass = copy.filter((x) => x.classGroupId == null).map((x) => String(x.studentId));
    const classes = await resolveStudentClassGroups(getDb(), needClass, {
      misToken: req.user.misToken,
      academicYearId: req.user.academicYearId ?? null,
    });
    let hidden = 0;
    for (const x of copy) {
      const cg = x.classGroupId ?? classes.get(String(x.studentId)) ?? null;
      if (!decide(snapshot, cap, studentTarget(x.studentId, cg, x.subjectId), minDepth).allowed) hidden += 1;
    }
    if (hidden > 0) {
      await recordShadowDiff({
        userId: req.user.id,
        capability: `${cap}@${minDepth ?? 'any'}:rows`,
        route: r,
        legacyAllowed: true,
        v2: { allowed: false, depth: null },
        target: { hidden, total: copy.length },
      });
    }
  });
}

/** Test hook. */
export function __resetPolicyState() {
  recentDiffs.clear();
}
