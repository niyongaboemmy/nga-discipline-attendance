import type { Database } from 'sqlite';
import { misGetListOrNull } from '../services/misClient.js';

/**
 * A student's class group, for access targets ("pass the student's class
 * group too, so class-teacher and DOS scopes apply" -- packages/access README).
 *
 * discipline_records carries only a class *name*, so the class group comes
 * from, in order:
 *   1. the local registers: the class group of the student's most recent
 *      attendance row (preferring the given academic year) -- no network;
 *   2. MIS GET /users/:id/grades (UserGrade placement) with the caller's
 *      token, cached for 30 minutes (negative results too).
 * Unresolvable students map to null, which leaves only student-level scopes
 * (mentees, children, self) able to cover them.
 */

const MIS_TTL_MS = 30 * 60 * 1000;
const MAX_MIS_LOOKUPS_PER_CALL = 40;
const misCache = new Map<string, { at: number; classGroupId: number | null }>();

export async function resolveStudentClassGroups(
  db: Database,
  studentIds: string[],
  opts: { misToken?: string | null; academicYearId?: number | null } = {}
): Promise<Map<string, number | null>> {
  const ids = [...new Set(studentIds.map(String).filter(Boolean))];
  const out = new Map<string, number | null>();
  if (ids.length === 0) return out;

  const rows = await db.all(
    `SELECT student_id, class_id FROM attendance_records
      WHERE student_id IN (SELECT value FROM json_each(?))
      ORDER BY (academic_year_id IS ?) DESC, session_date DESC, id DESC`,
    JSON.stringify(ids), opts.academicYearId ?? null
  );
  for (const r of rows as Array<{ student_id: string; class_id: string }>) {
    if (out.has(r.student_id)) continue;
    const n = Number(r.class_id);
    if (Number.isInteger(n)) out.set(r.student_id, n);
  }

  const missing = ids.filter((id) => !out.has(id));
  let lookups = 0;
  for (const id of missing) {
    const hit = misCache.get(id);
    if (hit && Date.now() - hit.at < MIS_TTL_MS) {
      out.set(id, hit.classGroupId);
      continue;
    }
    if (!opts.misToken || lookups >= MAX_MIS_LOOKUPS_PER_CALL || !/^\d+$/.test(id)) {
      out.set(id, null);
      continue;
    }
    lookups += 1;
    let classGroupId: number | null = null;
    try {
      const grades = await misGetListOrNull(opts.misToken, `/users/${encodeURIComponent(id)}/grades`);
      const pick =
        (grades ?? []).find((g: any) => opts.academicYearId != null && Number(g?.academic_year_id) === opts.academicYearId) ??
        (grades ?? []).find((g: any) => g?.academic_year_is_current) ??
        (grades ?? [])[0];
      const n = Number(pick?.class_group_id);
      classGroupId = Number.isInteger(n) ? n : null;
    } catch {
      classGroupId = null;
    }
    misCache.set(id, { at: Date.now(), classGroupId });
    out.set(id, classGroupId);
  }
  if (misCache.size > 20000) misCache.clear();
  return out;
}

export function __resetStudentClassCache() {
  misCache.clear();
}
