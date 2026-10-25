import { Database } from 'sqlite';
import type { Response } from 'express';
import { config } from '../config.js';
import { basicAuthHeader } from '../access/misService.js';

/**
 * Active users only (ACTIVE_USERS_CONTRACTS.md, "Tendo").
 *
 * The NGA Central MIS owns account status: `User.status` is ACTIVE, INACTIVE
 * or SUSPENDED, and a user the MIS no longer returns is treated as REMOVED.
 * Only ACTIVE counts as active.
 *
 * Tendo keeps two local copies of that status:
 *   users.status                 'active' | 'inactive', written by the SSO
 *                                exchange, the admin MIS user sync and the
 *                                roster sync (recordMisStatus below)
 *   roster_students.mis_status   the raw MIS value, written by the roster sync
 *                                (modules/rfid/roster.service.ts)
 *
 * A person is *known inactive* when either copy says so. A person with no
 * synced status is *unknown*: lists keep them (the MIS roster they came from is
 * the authority) and writes accept them, because a stale or empty cache must
 * never stop a teacher taking a register.
 *
 * Every "lists of people" and "write for a student" path uses this module, so
 * there is one rule. History (registers, conduct records, reports, exports,
 * excuses, RFID logs) is deliberately NOT filtered with it.
 */

export type ActiveState = 'active' | 'inactive' | 'unknown';

/** MIS status -> active? `null` when the MIS sent no status at all. */
export function misStatusIsActive(status: unknown): boolean | null {
  if (status == null || status === '') return null;
  return String(status).trim().toUpperCase() === 'ACTIVE';
}

/** MIS status -> the local users.status value, or null when unknown. */
export function localUserStatus(status: unknown): 'active' | 'inactive' | null {
  const active = misStatusIsActive(status);
  return active == null ? null : active ? 'active' : 'inactive';
}

/**
 * Subquery yielding the TEXT ids of every known-inactive person. For raw SQL
 * that cannot take a JS set: `... AND CAST(x.student_id AS TEXT) NOT IN (${INACTIVE_IDS_SQL})`.
 */
export const INACTIVE_IDS_SQL = `
  SELECT CAST(id AS TEXT) AS id FROM users WHERE status = 'inactive'
  UNION
  SELECT CAST(student_id AS TEXT) FROM roster_students
   WHERE mis_status IS NOT NULL AND UPPER(mis_status) <> 'ACTIVE'`;

/** ` AND <col> NOT IN (inactive ids)` -- appended to a WHERE clause. */
export function excludeInactiveSql(column: string): string {
  return ` AND CAST(${column} AS TEXT) NOT IN (${INACTIVE_IDS_SQL})`;
}

/** Every known-inactive id (users.status or the roster's MIS status). */
export async function inactiveIdSet(db: Database): Promise<Set<string>> {
  const rows = await db.all<{ id: string }[]>(INACTIVE_IDS_SQL);
  return new Set(rows.map((r) => String(r.id)));
}

/**
 * Students Tendo knows to be active: roster students with an ACTIVE MIS status,
 * plus student accounts whose local status is active, minus anyone known
 * inactive. Used where a population must be built locally (early warning).
 */
export async function activeStudentIds(db: Database): Promise<Set<string>> {
  const rows = await db.all<{ id: string }[]>(
    `SELECT CAST(student_id AS TEXT) AS id FROM roster_students WHERE UPPER(mis_status) = 'ACTIVE'
     UNION
     SELECT CAST(id AS TEXT) FROM users
      WHERE status = 'active'
        AND (role = 'student' OR role_id IN (SELECT id FROM roles WHERE level = 'STUDENT'))`
  );
  const inactive = await inactiveIdSet(db);
  return new Set(rows.map((r) => String(r.id)).filter((id) => !inactive.has(id)));
}

/** Local status of each id: inactive wins, then a synced ACTIVE, else unknown. */
export async function localActiveStates(db: Database, ids: string[]): Promise<Map<string, ActiveState>> {
  const unique = [...new Set(ids.map(String))];
  const out = new Map<string, ActiveState>(unique.map((id) => [id, 'unknown' as ActiveState]));
  if (unique.length === 0) return out;
  for (let i = 0; i < unique.length; i += 500) {
    const chunk = unique.slice(i, i + 500);
    const marks = chunk.map(() => '?').join(',');
    const roster = await db.all<{ id: string; mis_status: string | null }[]>(
      `SELECT CAST(student_id AS TEXT) AS id, mis_status FROM roster_students WHERE CAST(student_id AS TEXT) IN (${marks})`,
      ...chunk
    );
    for (const r of roster) {
      const active = misStatusIsActive(r.mis_status);
      if (active != null) out.set(String(r.id), active ? 'active' : 'inactive');
    }
    const users = await db.all<{ id: string }[]>(
      `SELECT CAST(id AS TEXT) AS id FROM users WHERE status = 'inactive' AND CAST(id AS TEXT) IN (${marks})`,
      ...chunk
    );
    for (const u of users) out.set(String(u.id), 'inactive');
  }
  return out;
}

export async function isActiveStudent(db: Database, id: string): Promise<ActiveState> {
  return (await localActiveStates(db, [id])).get(String(id)) ?? 'unknown';
}

/** Drop rows whose person is known inactive (unknown ones stay). */
export async function filterActive<T>(db: Database, rows: T[], idOf: (row: T) => unknown): Promise<T[]> {
  if (rows.length === 0) return rows;
  const inactive = await inactiveIdSet(db);
  if (inactive.size === 0) return rows;
  return rows.filter((row) => !inactive.has(String(idOf(row))));
}

/**
 * Record a MIS status locally: users.status and, when the person is on the
 * roster cache, roster_students.mis_status. Existing rows only; an unknown
 * status (null) changes nothing.
 */
export async function recordMisStatus(db: Database, id: string, misStatus: unknown): Promise<void> {
  const local = localUserStatus(misStatus);
  if (!local) return;
  await db.run(
    `UPDATE users SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status IS NOT ?`,
    local, String(id), local
  );
  await db.run(
    `UPDATE roster_students SET mis_status = ? WHERE student_id = ? AND mis_status IS NOT ?`,
    String(misStatus).trim().toUpperCase(), String(id), String(misStatus).trim().toUpperCase()
  );
}

// ---------------------------------------------------------------------------
// MIS fallback for ids the local caches don't know
// ---------------------------------------------------------------------------

/**
 * POST /users/profile-media/lookup with Tendo's service credentials. Once MIS
 * ships the active-users change each returned user carries `status`, and a
 * requested id it leaves out is REMOVED. Today's MIS sends no status, so the
 * answer stays "unknown" (and the write is accepted).
 */
type StatusTransport = (ids: number[]) => Promise<Array<{ user_id: number; status?: unknown }>>;

const defaultTransport: StatusTransport = async (ids) => {
  const res = await fetch(`${config.ngaMisBaseUrl.replace(/\/+$/, '')}/users/profile-media/lookup`, {
    method: 'POST',
    headers: { Authorization: basicAuthHeader(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_ids: ids }),
    signal: AbortSignal.timeout(4000),
  });
  if (!res.ok) throw new Error(`MIS lookup answered ${res.status}`);
  const body = (await res.json()) as { data?: { users?: Array<{ user_id: number; status?: unknown }> } };
  return body?.data?.users ?? [];
};
let transport: StatusTransport = defaultTransport;

const TTL_MS = 5 * 60_000;
const misCache = new Map<string, { state: ActiveState; at: number }>();

/** Tests swap the MIS call out (null restores the real one). */
export function _setStatusTransportForTests(fn: StatusTransport | null) {
  transport = fn ?? defaultTransport;
  misCache.clear();
}

/** Without real SSO client credentials (dev, tests) there is no one to ask. */
const canAskMis = () =>
  transport !== defaultTransport ||
  (!!config.ssoClientId && !['', 'placeholder_client_secret'].includes(config.ssoClientSecret));

async function misActiveStates(db: Database, ids: string[]): Promise<Map<string, ActiveState>> {
  const out = new Map<string, ActiveState>();
  if (!canAskMis()) {
    for (const id of ids) out.set(id, 'unknown');
    return out;
  }
  const now = Date.now();
  const ask: number[] = [];
  for (const id of ids) {
    const hit = misCache.get(id);
    if (hit && now - hit.at < TTL_MS) out.set(id, hit.state);
    else if (/^\d+$/.test(id)) ask.push(Number(id));
    else out.set(id, 'unknown');
  }
  if (ask.length === 0) return out;
  const users = await transport(ask);
  const statusAware = users.some((u) => u && 'status' in u && u.status != null);
  const answered = new Set<string>();
  for (const u of users) {
    const id = String(u.user_id);
    answered.add(id);
    const active = misStatusIsActive(u.status);
    const state: ActiveState = active == null ? 'unknown' : active ? 'active' : 'inactive';
    out.set(id, state);
    misCache.set(id, { state, at: now });
    if (active != null) await recordMisStatus(db, id, u.status);
  }
  for (const n of ask) {
    const id = String(n);
    if (answered.has(id)) continue;
    // Only a status-aware MIS's silence means REMOVED.
    const state: ActiveState = statusAware ? 'inactive' : 'unknown';
    out.set(id, state);
    misCache.set(id, { state, at: now });
    if (statusAware) await recordMisStatus(db, id, 'REMOVED');
  }
  return out;
}

/**
 * Re-ask the MIS about one person now (a back-channel logout may be a
 * deactivation). Best effort: failures are logged, never thrown.
 */
export async function recheckMisStatus(db: Database, id: string): Promise<ActiveState> {
  misCache.delete(String(id));
  try {
    return (await misActiveStates(db, [String(id)])).get(String(id)) ?? 'unknown';
  } catch (err) {
    console.warn(`[active-students] status re-check for ${id} failed: ${(err as Error).message}`);
    return 'unknown';
  }
}

export interface StudentCheck {
  inactive: string[];
  unknown: string[];
}

/**
 * Which of `ids` are not active students. Local caches first, then one MIS
 * lookup for the ids they don't know. If the MIS can't be asked, unknown ids
 * are reported as unknown (the caller accepts them and this logs a warning).
 */
export async function checkStudentsActive(db: Database, ids: unknown[], context = 'write'): Promise<StudentCheck> {
  const list = [...new Set(ids.filter((v) => v != null && v !== '').map(String))];
  const local = await localActiveStates(db, list);
  const inactive: string[] = [];
  let unknown: string[] = [];
  for (const [id, state] of local) {
    if (state === 'inactive') inactive.push(id);
    else if (state === 'unknown') unknown.push(id);
  }
  if (unknown.length > 0) {
    try {
      const remote = await misActiveStates(db, unknown);
      const still: string[] = [];
      for (const id of unknown) {
        const state = remote.get(id) ?? 'unknown';
        if (state === 'inactive') inactive.push(id);
        else if (state === 'unknown') still.push(id);
      }
      unknown = still;
    } catch (err) {
      console.warn(
        `[active-students] ${context}: MIS status check failed for ${unknown.length} student(s); accepting them: ${(err as Error).message}`
      );
    }
  }
  return { inactive, unknown };
}

/** The 422 every student write answers when it names inactive students. */
export function studentInactiveBody(ids: string[]) {
  return {
    success: false,
    code: 'STUDENT_INACTIVE',
    ids,
    message:
      ids.length === 1
        ? 'That student’s account is no longer active on the MIS, so nothing new can be recorded for them.'
        : `${ids.length} of these students’ accounts are no longer active on the MIS, so nothing new can be recorded for them.`,
  };
}

/**
 * Guard for writes that create records for students (registers, conduct
 * records): answers 422 STUDENT_INACTIVE and returns true when any id is a
 * known-inactive student. Unknown ids pass (logged), so a stale cache or an
 * unreachable MIS never blocks marking.
 */
export async function rejectInactiveStudents(
  res: Response, db: Database, ids: unknown[], context: string
): Promise<boolean> {
  const { inactive, unknown } = await checkStudentsActive(db, ids, context);
  if (unknown.length > 0) {
    console.warn(`[active-students] ${context}: ${unknown.length} student(s) with no known MIS status accepted: ${unknown.slice(0, 10).join(', ')}`);
  }
  if (inactive.length === 0) return false;
  res.status(422).json(studentInactiveBody(inactive));
  return true;
}
