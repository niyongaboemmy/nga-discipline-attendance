import { Database } from 'sqlite';
import { config } from '../../config.js';

/**
 * Phase 1 + Phase 3 roster/period cache sync.
 *
 * The MIS remains the source of truth for academic years/terms, subjects,
 * and the class/subject/teacher timetable. This module pulls that data and
 * upserts it into the local read-only cache tables (academic_years,
 * academic_terms, subjects, class_subject_assignments) so the rest of the
 * app can join against real local rows instead of bare nullable ids.
 *
 * Field names from the upstream MIS aren't guaranteed by a shared contract
 * test, so extraction below is defensive (tries a few common key spellings)
 * — the same posture already used in routes/mis.ts and utils/misAcademics.ts
 * for this integration. The MIS paths themselves (class-groups,
 * calendar/slots) are hardcoded, not env-overridable, now that they're
 * confirmed against the MIS's actual routes rather than guessed.
 */

async function fetchMisList(path: string, misToken: string, query?: Record<string, string>): Promise<any[]> {
  const url = new URL(`${config.ngaMisBaseUrl}${path}`);
  for (const [k, v] of Object.entries(query || {})) if (v) url.searchParams.set(k, v);
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${misToken}`, Accept: 'application/json' } });
  if (!resp.ok) throw new Error(`MIS returned ${resp.status} for ${path}`);
  const body = (await resp.json()) as any;
  return Array.isArray(body) ? body : body.data ?? body.results ?? [];
}

function pick(obj: any, ...keys: string[]): any {
  for (const k of keys) if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  return null;
}

export interface SyncResult {
  years: number;
  terms: number;
  subjects: number;
  assignments: number;
}

export async function syncAcademicPeriods(db: Database, misToken: string): Promise<{ years: number; terms: number }> {
  const years = await fetchMisList('/academics/years', misToken);
  let yearCount = 0;
  for (const y of years) {
    const id = pick(y, 'academic_year_id', 'id');
    if (id == null) continue;
    await db.run(
      `INSERT INTO academic_years (id, name, start_date, end_date, is_current, synced_at)
       VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name, start_date=excluded.start_date,
         end_date=excluded.end_date, is_current=excluded.is_current, synced_at=CURRENT_TIMESTAMP`,
      Number(id), pick(y, 'name', 'year_name') ?? `Year ${id}`,
      pick(y, 'start_date'), pick(y, 'end_date'), Number(y.is_current) === 1 ? 1 : 0
    );
    yearCount++;
  }

  // One MIS round trip per year — independent of each other, so fetch them
  // concurrently instead of awaiting one at a time (a school with several
  // years of history otherwise pays N sequential network round trips here).
  const yearsWithIds = years
    .map((y) => ({ y, yearId: pick(y, 'academic_year_id', 'id') }))
    .filter((e) => e.yearId != null);
  const termLists = await Promise.all(
    yearsWithIds.map((e) => fetchMisList('/academics/terms', misToken, { academic_year_id: String(e.yearId) }))
  );

  let termCount = 0;
  for (let i = 0; i < yearsWithIds.length; i++) {
    const { yearId } = yearsWithIds[i];
    for (const t of termLists[i]) {
      const id = pick(t, 'academic_term_id', 'id');
      if (id == null) continue;
      await db.run(
        `INSERT INTO academic_terms (id, academic_year_id, name, start_date, end_date, is_current, synced_at)
         VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(id) DO UPDATE SET academic_year_id=excluded.academic_year_id, name=excluded.name,
           start_date=excluded.start_date, end_date=excluded.end_date, is_current=excluded.is_current,
           synced_at=CURRENT_TIMESTAMP`,
        Number(id), Number(yearId), pick(t, 'name', 'term_name') ?? `Term ${id}`,
        pick(t, 'start_date'), pick(t, 'end_date'), Number(t.is_current) === 1 ? 1 : 0
      );
      termCount++;
    }
  }

  return { years: yearCount, terms: termCount };
}

export async function syncRosterSchedule(db: Database, misToken: string): Promise<{ subjects: number; assignments: number }> {
  const subjectIds = new Set<number>();
  let assignmentCount = 0;

  // Seed the subject cache from /academics/subjects first. That endpoint is
  // readable by any authenticated MIS user, whereas the timetable below
  // (/calendar/slots) needs calendar-admin permissions and 403s for
  // teachers -- so deriving subjects only from the timetable left the
  // "Subject / course" picker empty ("No subjects synced yet") for exactly
  // the people who mark attendance. Subjects now populate regardless.
  for (const s of await fetchMisList('/academics/subjects', misToken)) {
    const id = pick(s, 'subject_id', 'id');
    if (id == null) continue;
    await db.run(
      `INSERT INTO subjects (id, name, code, synced_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name, code=excluded.code, synced_at=CURRENT_TIMESTAMP`,
      Number(id), pick(s, 'name', 'subject_name') ?? `Subject ${id}`, pick(s, 'code', 'subject_code')
    );
    subjectIds.add(Number(id));
  }

  // The real MIS route is /academics/class-groups (confirmed against
  // nga_central_mis/backend/src/routes/academics.ts) -- the earlier /classes
  // default here didn't exist anywhere on the MIS and 404'd every sync.
  const classes = await fetchMisList('/academics/class-groups', misToken);

  const classesWithIds = classes
    .map((cls) => ({ cls, classId: pick(cls, 'class_group_id', 'id'), className: pick(cls, 'name', 'class_name') }))
    .filter((e) => e.classId != null);

  // One MIS round trip per class — independent of each other, so fetch
  // concurrently instead of one class at a time (a school with dozens of
  // classes otherwise pays dozens of sequential network round trips here).
  // A per-class failure degrades to an empty list rather than aborting the
  // whole sync, matching the previous per-class try/catch behavior.
  //
  // Real route is /calendar/slots (see calendarController.ts's
  // getCalendarSlots), keyed by class_group_id -- not the guessed /schedule.
  const scheduleLists = await Promise.all(
    classesWithIds.map((e) =>
      fetchMisList('/calendar/slots', misToken, { class_group_id: String(e.classId) })
        .catch((err) => {
          console.error(`Roster sync: failed to fetch schedule for class ${e.classId}:`, (err as Error).message);
          return [] as any[];
        })
    )
  );

  for (let i = 0; i < classesWithIds.length; i++) {
    const { classId, className } = classesWithIds[i];
    const entries = scheduleLists[i];

    for (const entry of entries) {
      const subjectId = pick(entry, 'subject_id', 'subjectId');
      // getCalendarSlots returns the teacher as user_id, not teacher_id.
      const teacherId = pick(entry, 'user_id', 'teacher_id', 'teacherId', 'staff_id');
      if (subjectId == null || teacherId == null) continue;

      const subjectName = pick(entry, 'subject_name', 'subjectName') ?? `Subject ${subjectId}`;
      if (!subjectIds.has(Number(subjectId))) {
        await db.run(
          `INSERT INTO subjects (id, name, code, synced_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)
           ON CONFLICT(id) DO UPDATE SET name=excluded.name, code=excluded.code, synced_at=CURRENT_TIMESTAMP`,
          Number(subjectId), subjectName, pick(entry, 'subject_code', 'code')
        );
        subjectIds.add(Number(subjectId));
      }

      const academicTermId = pick(entry, 'academic_term_id', 'academicTermId');
      const dayOfWeek = pick(entry, 'day_of_week', 'dayOfWeek');
      // getCalendarSlots has no single "period" field, just start/end times.
      const period = pick(entry, 'start_time', 'period', 'slot');
      // instructor_name/instructor_lastname are UserProfile's first/last
      // name split across two columns, not one combined teacher_name field.
      const combinedInstructorName =
        [entry.instructor_name, entry.instructor_lastname].filter(Boolean).join(' ') || null;
      const teacherName = pick(entry, 'teacher_name', 'teacherName') ?? combinedInstructorName;

      await db.run(
        `INSERT INTO class_subject_assignments
           (class_id, class_name, subject_id, subject_name, teacher_id, teacher_name, academic_term_id, day_of_week, period, synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(class_id, subject_id, academic_term_id, day_of_week, period) DO UPDATE SET
           class_name=excluded.class_name, subject_name=excluded.subject_name,
           teacher_id=excluded.teacher_id, teacher_name=excluded.teacher_name, synced_at=CURRENT_TIMESTAMP`,
        String(classId), className, Number(subjectId), subjectName,
        String(teacherId), teacherName,
        academicTermId != null ? Number(academicTermId) : null,
        dayOfWeek != null ? Number(dayOfWeek) : null,
        period
      );
      assignmentCount++;
    }
  }

  return { subjects: subjectIds.size, assignments: assignmentCount };
}

export async function syncAll(db: Database, misToken: string): Promise<SyncResult> {
  const periods = await syncAcademicPeriods(db, misToken);
  const roster = await syncRosterSchedule(db, misToken);
  return { years: periods.years, terms: periods.terms, subjects: roster.subjects, assignments: roster.assignments };
}
