import { Database } from 'sqlite';
import { config } from '../../config.js';
import { replaceTimetable, upsertReference } from './timetable.service.js';

/**
 * Local copy of "which students exist and which class group each is in", read
 * from the Central MIS integration API (`/integrations/sync/*`, scope
 * `sync:read`).
 *
 * The rest of Tendo reads the roster live with the signed-in user's MIS token.
 * A card tap arrives with no user behind it, so check-in resolves against this
 * cache instead. The MIS stays the owner: nothing here is edited locally, and a
 * full sync replaces what it covers.
 *
 * Credentials, in order of preference:
 *   MIS_INTEGRATION_TOKEN   an IntegrationToken minted on the MIS (Bearer)
 *   SSO_CLIENT_ID/SECRET    this app's registered System, as HTTP Basic, which
 *                           the MIS accepts for the read-only sync routes
 */

const PAGE_SIZE = 1000;
const PLACEHOLDER_SECRETS = new Set(['', 'placeholder_client_secret']);

export function misServiceAuthHeader(): string | null {
  const token = process.env.MIS_INTEGRATION_TOKEN?.trim();
  if (token) return `Bearer ${token}`;
  if (!PLACEHOLDER_SECRETS.has(config.ssoClientSecret) && config.ssoClientId) {
    return `Basic ${Buffer.from(`${config.ssoClientId}:${config.ssoClientSecret}`).toString('base64')}`;
  }
  return null;
}

type FetchLike = (url: string, init: { headers: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<any>;
}>;

async function misServiceGet(fetchImpl: FetchLike, path: string, query: Record<string, string> = {}) {
  const auth = misServiceAuthHeader();
  if (!auth) {
    throw new Error(
      'No MIS service credentials. Set MIS_INTEGRATION_TOKEN, or a real SSO_CLIENT_SECRET, in server/.env.'
    );
  }
  const url = new URL(`${config.ngaMisBaseUrl}${path}`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const resp = await fetchImpl(url.toString(), { headers: { Authorization: auth, Accept: 'application/json' } });
  if (!resp.ok) {
    throw new Error(
      resp.status === 401
        ? 'The MIS rejected Tendo’s service credentials (401). Ask a MIS admin to check the Tendo system is ACTIVE or issue an integration token.'
        : `MIS returned ${resp.status} for ${path}.`
    );
  }
  const body = await resp.json();
  return body && typeof body === 'object' && 'data' in body ? body.data : body;
}

const isStudent = (u: any) =>
  (u.roles ?? []).some((r: any) => String(r.name).toUpperCase() === 'STUDENT') ||
  String(u.profile?.userType ?? '').toUpperCase() === 'STUDENT';

const displayName = (u: any) =>
  u.profile?.fullName || [u.profile?.firstName, u.profile?.lastName].filter(Boolean).join(' ') || u.username || `Student ${u.id}`;

export interface RosterSyncResult {
  runId: number;
  students: number;
  enrolments: number;
  classGroups: number;
  /** Timetable slots cached, or null when the MIS sent none and the old timetable was kept. */
  slots: number | null;
}

/**
 * Full pass over the MIS roster. Each page is written in one transaction.
 * Enrolments the MIS no longer returns are removed at the end. That is only
 * safe because this is a full pass: the MIS's `since` delta ignores
 * link-table changes, so it is never used here.
 *
 * Callers must run this through workQueue.enqueue so it never overlaps a
 * scan's writes.
 */
export async function syncRosterFromMis(
  db: Database,
  opts: { fetchImpl?: FetchLike; triggeredBy?: string } = {}
): Promise<RosterSyncResult> {
  const fetchImpl = opts.fetchImpl ?? (fetch as unknown as FetchLike);
  const startedAt = new Date().toISOString();
  const run = await db.run(
    `INSERT INTO roster_sync_runs (started_at, triggered_by) VALUES (?, ?)`,
    startedAt, opts.triggeredBy ?? 'system'
  );
  const runId = Number(run.lastID);

  try {
    const reference = await misServiceGet(fetchImpl, '/integrations/sync/reference');
    const classGroups: any[] = reference?.classGroups ?? [];
    const classNames = new Map<string, string>();
    await db.run('BEGIN TRANSACTION');
    try {
      for (const cg of classGroups) {
        const id = String(cg.id);
        classNames.set(id, cg.name ?? `Class ${id}`);
        await db.run(
          `INSERT INTO roster_class_groups (class_id, name, grade_id, synced_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(class_id) DO UPDATE SET name = excluded.name, grade_id = excluded.grade_id, synced_at = excluded.synced_at`,
          id, cg.name ?? `Class ${id}`, cg.gradeId ?? null, startedAt
        );
      }
      await upsertReference(db, reference, startedAt);
      await db.run('COMMIT');
    } catch (err) {
      await db.run('ROLLBACK');
      throw err;
    }

    let cursor = '0';
    let students = 0;
    let enrolments = 0;
    for (let guard = 0; guard < 10_000; guard++) {
      const page = await misServiceGet(fetchImpl, '/integrations/sync/people', { cursor, limit: String(PAGE_SIZE) });
      const users: any[] = page?.users ?? [];

      await db.run('BEGIN TRANSACTION');
      try {
        for (const u of users) {
          if (!isStudent(u)) continue;
          const studentId = String(u.id);
          await db.run(
            `INSERT INTO roster_students (student_id, name, mis_status, synced_at) VALUES (?, ?, ?, ?)
             ON CONFLICT(student_id) DO UPDATE SET name = excluded.name, mis_status = excluded.mis_status, synced_at = excluded.synced_at`,
            studentId, displayName(u), u.status ?? null, startedAt
          );
          students++;
          for (const cg of u.classGroups ?? []) {
            if (cg.classGroupId == null || cg.academicYearId == null) continue;
            await db.run(
              `INSERT INTO roster_enrolments (student_id, class_id, academic_year_id, status, assigned_at, synced_at)
               VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT(student_id, class_id, academic_year_id) DO UPDATE SET
                 status = excluded.status, assigned_at = excluded.assigned_at, synced_at = excluded.synced_at`,
              studentId, String(cg.classGroupId), Number(cg.academicYearId),
              String(cg.status).toUpperCase() === 'DISABLED' ? 'DISABLED' : 'ACTIVE',
              cg.assignedAt ?? null, startedAt
            );
            enrolments++;
          }
        }
        await db.run('COMMIT');
      } catch (err) {
        await db.run('ROLLBACK');
        throw err;
      }

      const next = page?.pagination?.nextCursor;
      if (!page?.pagination?.hasMore || next == null) break;
      cursor = String(next);
    }

    // An empty answer from a MIS that used to list students is far more likely
    // an outage or a credential scoped to nothing than a school with no pupils.
    // Replacing the roster with it would stop every check-in, so refuse.
    if (students === 0) {
      const had = await db.get(`SELECT COUNT(*) AS n FROM roster_students WHERE mis_status IS NOT 'REMOVED'`);
      if (had?.n > 0) {
        throw new Error(`The MIS returned no students; kept the existing roster of ${had.n}. Check the MIS and try again.`);
      }
    }

    // Anything not seen in this full pass no longer exists on the MIS.
    await db.run(`DELETE FROM roster_enrolments WHERE synced_at < ?`, startedAt);
    await db.run(`UPDATE roster_students SET mis_status = 'REMOVED' WHERE synced_at < ?`, startedAt);

    // Each class's timetable (the MIS calendar slots Tendo's attendance calendar shows).
    const academics = await misServiceGet(fetchImpl, '/integrations/sync/academics');
    let slots: number | null;
    await db.run('BEGIN TRANSACTION');
    try {
      slots = await replaceTimetable(db, academics?.calendarSlots ?? [], startedAt);
      await db.run('COMMIT');
    } catch (err) {
      await db.run('ROLLBACK');
      throw err;
    }

    await db.run(
      `UPDATE roster_sync_runs SET finished_at = ?, students = ?, enrolments = ?, slots = ? WHERE id = ?`,
      new Date().toISOString(), students, enrolments, slots ?? 0, runId
    );
    return { runId, students, enrolments, classGroups: classGroups.length, slots };
  } catch (err) {
    await db.run(
      `UPDATE roster_sync_runs SET finished_at = ?, error = ? WHERE id = ?`,
      new Date().toISOString(), (err as Error).message.slice(0, 500), runId
    );
    throw err;
  }
}

export async function lastRosterSync(db: Database) {
  const last = await db.get(`SELECT * FROM roster_sync_runs ORDER BY id DESC LIMIT 1`);
  const lastOk = await db.get(
    `SELECT * FROM roster_sync_runs WHERE error IS NULL AND finished_at IS NOT NULL ORDER BY id DESC LIMIT 1`
  );
  const counts = await db.get(
    `SELECT (SELECT COUNT(*) FROM roster_students WHERE mis_status IS NOT 'REMOVED') AS students,
            (SELECT COUNT(*) FROM roster_enrolments WHERE status = 'ACTIVE') AS activeEnrolments,
            (SELECT COUNT(*) FROM roster_class_groups) AS classGroups,
            (SELECT COUNT(*) FROM timetable_slots WHERE is_active = 1) AS timetableSlots,
            (SELECT COUNT(DISTINCT class_id) FROM timetable_slots WHERE is_active = 1) AS classesWithTimetable`
  );
  return { last: last ?? null, lastSuccessful: lastOk ?? null, ...counts, credentialsConfigured: misServiceAuthHeader() != null };
}

/**
 * The academic year a school date belongs to: the cached MIS calendar when it
 * covers the date, otherwise the newest year the student has an active class
 * in. The fallback matters between terms and when the calendar cache is empty.
 */
export async function schoolYearForDate(db: Database, dateStr: string): Promise<{ yearId: number | null; termId: number | null }> {
  const term = await db.get(
    `SELECT id, academic_year_id FROM academic_terms
      WHERE start_date IS NOT NULL AND end_date IS NOT NULL
        AND date(?) BETWEEN date(start_date) AND date(end_date)
      ORDER BY start_date DESC LIMIT 1`,
    dateStr
  );
  if (term) return { yearId: Number(term.academic_year_id), termId: Number(term.id) };
  const year = await db.get(
    `SELECT id FROM academic_years
      WHERE start_date IS NOT NULL AND end_date IS NOT NULL
        AND date(?) BETWEEN date(start_date) AND date(end_date)
      ORDER BY start_date DESC LIMIT 1`,
    dateStr
  );
  return { yearId: year ? Number(year.id) : null, termId: null };
}

export type EnrolmentResolution =
  | { kind: 'ok'; classId: string; className: string; academicYearId: number }
  | { kind: 'none' }
  | { kind: 'ambiguous'; classIds: string[] };

export async function resolveEnrolment(
  db: Database,
  studentId: string,
  academicYearId: number | null
): Promise<EnrolmentResolution> {
  let yearId = academicYearId;
  if (yearId == null) {
    const latest = await db.get(
      `SELECT MAX(academic_year_id) AS y FROM roster_enrolments WHERE student_id = ? AND status = 'ACTIVE'`,
      studentId
    );
    yearId = latest?.y ?? null;
  }
  if (yearId == null) return { kind: 'none' };

  const rows = await db.all(
    `SELECT e.class_id, COALESCE(c.name, 'Class ' || e.class_id) AS class_name
       FROM roster_enrolments e LEFT JOIN roster_class_groups c ON c.class_id = e.class_id
      WHERE e.student_id = ? AND e.academic_year_id = ? AND e.status = 'ACTIVE'`,
    studentId, yearId
  );
  if (rows.length === 0) return { kind: 'none' };
  if (rows.length > 1) return { kind: 'ambiguous', classIds: rows.map((r: any) => r.class_id) };
  return { kind: 'ok', classId: rows[0].class_id, className: rows[0].class_name, academicYearId: yearId };
}
