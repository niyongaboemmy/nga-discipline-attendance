import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setupTestDb } from './testUtils.js';
import { syncRosterSchedule } from '../modules/academics/academicsSync.service.js';

/**
 * `/calendar/slots` reports a lesson's teacher as `CalendarSlot.user_id`,
 * which the MIS never rewrites when a teacher is reassigned off a class/
 * subject (only `TeacherSubjectAssignment` changes) — so a stale row can
 * otherwise live in `class_subject_assignments` forever, and it feeds the
 * teacher delivery-rate report (subjectAttendance.routes.ts) a subject the
 * teacher no longer teaches. `/academics/teacher-assignments` is the
 * authoritative table, so syncRosterSchedule must cross-check against it.
 */
function mockMisFetch(opts: {
  classGroups: Array<{ class_group_id: number; name: string }>;
  slotsByClass: Record<number, unknown[]>;
  assignments: unknown[];
}) {
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
    const u = String(url);
    const json = (data: unknown) => new Response(JSON.stringify({ data }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
    if (u.includes('/academics/subjects')) return json([]);
    if (u.includes('/academics/teacher-assignments')) return json(opts.assignments);
    if (u.includes('/academics/class-groups')) return json(opts.classGroups);
    if (u.includes('/calendar/slots')) {
      const m = u.match(/class_group_id=(\d+)/);
      const classId = m ? Number(m[1]) : -1;
      return json(opts.slotsByClass[classId] ?? []);
    }
    return json([]);
  }));
}

describe('syncRosterSchedule — teacher-assignment cross-check', () => {
  beforeEach(async () => {
    await setupTestDb();
    const { getDb } = await import('../database.js');
    await getDb().run(
      `INSERT INTO academic_years (id, name, is_current) VALUES (1, '2026-2027', 1)`
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('syncs a slot whose teacher currently has a matching TeacherSubjectAssignment', async () => {
    mockMisFetch({
      classGroups: [{ class_group_id: 10, name: 'L3 Class A' }],
      slotsByClass: {
        10: [{
          subject_id: 5, subject_name: 'Web Development', user_id: 7,
          academic_term_id: 1, day_of_week: 1, start_time: '08:00',
        }],
      },
      assignments: [{ user_id: 7, subject_id: 5, class_group_id: 10 }],
    });

    const { getDb } = await import('../database.js');
    const result = await syncRosterSchedule(getDb(), 'mis-tkn');
    expect(result.assignments).toBe(1);

    const rows = await getDb().all(`SELECT * FROM class_subject_assignments`);
    expect(rows).toHaveLength(1);
    expect(rows[0].teacher_id).toBe('7');
  });

  it('drops a slot whose teacher has no matching TeacherSubjectAssignment (stale reassignment)', async () => {
    mockMisFetch({
      classGroups: [{ class_group_id: 10, name: 'L3 Class A' }],
      slotsByClass: {
        10: [{
          subject_id: 5, subject_name: 'Advanced Database', user_id: 7,
          academic_term_id: 1, day_of_week: 2, start_time: '11:00',
        }],
      },
      // No assignment at all for (teacher 7, subject 5, class 10).
      assignments: [],
    });

    const { getDb } = await import('../database.js');
    const result = await syncRosterSchedule(getDb(), 'mis-tkn');
    expect(result.assignments).toBe(0);

    const rows = await getDb().all(`SELECT * FROM class_subject_assignments`);
    expect(rows).toHaveLength(0);
  });

  it('evicts a previously-cached row once its teacher-assignment is removed on a later sync', async () => {
    const slot = {
      subject_id: 5, subject_name: 'Advanced Database', user_id: 7,
      academic_term_id: 1, day_of_week: 2, start_time: '11:00',
    };
    mockMisFetch({
      classGroups: [{ class_group_id: 10, name: 'L3 Class A' }],
      slotsByClass: { 10: [slot] },
      assignments: [{ user_id: 7, subject_id: 5, class_group_id: 10 }],
    });
    const { getDb } = await import('../database.js');
    await syncRosterSchedule(getDb(), 'mis-tkn');
    expect(await getDb().all(`SELECT * FROM class_subject_assignments`)).toHaveLength(1);

    // Teacher 7 gets reassigned off this class/subject; the MIS calendar
    // slot itself is untouched (the real-world bug) but the assignment table
    // no longer lists it.
    mockMisFetch({
      classGroups: [{ class_group_id: 10, name: 'L3 Class A' }],
      slotsByClass: { 10: [slot] },
      assignments: [],
    });
    await syncRosterSchedule(getDb(), 'mis-tkn');
    expect(await getDb().all(`SELECT * FROM class_subject_assignments`)).toHaveLength(0);
  });

  it('evicts a cached slot the MIS no longer returns (deleted / disabled subject or calendar)', async () => {
    const kept = {
      subject_id: 5, subject_name: 'Web Development', user_id: 7,
      academic_term_id: 1, day_of_week: 1, start_time: '08:00',
    };
    const retired = {
      subject_id: 6, subject_name: 'Old Subject', user_id: 7,
      academic_term_id: 1, day_of_week: 2, start_time: '10:00',
    };
    const assignments = [
      { user_id: 7, subject_id: 5, class_group_id: 10 },
      { user_id: 7, subject_id: 6, class_group_id: 10 },
    ];
    mockMisFetch({
      classGroups: [{ class_group_id: 10, name: 'L3 Class A' }],
      slotsByClass: { 10: [kept, retired] },
      assignments,
    });
    const { getDb } = await import('../database.js');
    await syncRosterSchedule(getDb(), 'mis-tkn');
    expect(await getDb().all(`SELECT * FROM class_subject_assignments`)).toHaveLength(2);

    // The MIS soft-deletes the slot (or disables its subject): /calendar/slots
    // simply stops listing it, while the teacher assignment still exists.
    mockMisFetch({
      classGroups: [{ class_group_id: 10, name: 'L3 Class A' }],
      slotsByClass: { 10: [kept] },
      assignments,
    });
    await syncRosterSchedule(getDb(), 'mis-tkn');
    const rows = await getDb().all(`SELECT subject_id FROM class_subject_assignments`);
    expect(rows).toHaveLength(1);
    expect(rows[0].subject_id).toBe(5);
  });

  it('keeps cached rows for a class whose timetable fetch failed', async () => {
    const slot = {
      subject_id: 5, subject_name: 'Web Development', user_id: 7,
      academic_term_id: 1, day_of_week: 1, start_time: '08:00',
    };
    const assignments = [{ user_id: 7, subject_id: 5, class_group_id: 10 }];
    mockMisFetch({
      classGroups: [{ class_group_id: 10, name: 'L3 Class A' }],
      slotsByClass: { 10: [slot] },
      assignments,
    });
    const { getDb } = await import('../database.js');
    await syncRosterSchedule(getDb(), 'mis-tkn');
    expect(await getDb().all(`SELECT * FROM class_subject_assignments`)).toHaveLength(1);

    // A 500 from /calendar/slots is not "no timetable" -- nothing is evicted.
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      const u = String(url);
      const json = (data: unknown) => new Response(JSON.stringify({ data }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
      if (u.includes('/academics/subjects')) return json([]);
      if (u.includes('/academics/teacher-assignments')) return json(assignments);
      if (u.includes('/academics/class-groups')) return json([{ class_group_id: 10, name: 'L3 Class A' }]);
      if (u.includes('/calendar/slots')) return new Response('error', { status: 500 });
      return json([]);
    }));
    await syncRosterSchedule(getDb(), 'mis-tkn');
    expect(await getDb().all(`SELECT * FROM class_subject_assignments`)).toHaveLength(1);
  });

  it('falls back to trusting the timetable when the assignments lookup itself fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      const u = String(url);
      const json = (data: unknown) => new Response(JSON.stringify({ data }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
      if (u.includes('/academics/teacher-assignments')) {
        return new Response('error', { status: 500 });
      }
      if (u.includes('/academics/class-groups')) return json([{ class_group_id: 10, name: 'L3 Class A' }]);
      if (u.includes('/calendar/slots')) {
        return json([{
          subject_id: 5, subject_name: 'Web Development', user_id: 7,
          academic_term_id: 1, day_of_week: 1, start_time: '08:00',
        }]);
      }
      return json([]);
    }));

    const { getDb } = await import('../database.js');
    const result = await syncRosterSchedule(getDb(), 'mis-tkn');
    expect(result.assignments).toBe(1);
  });
});
