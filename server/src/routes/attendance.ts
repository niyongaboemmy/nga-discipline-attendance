import { Router, Response } from 'express';
import { z } from 'zod';
import { getDb } from '../database.js';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth.js';
import { authorizePermission, selfOrPermission } from '../middleware/authorize.js';
import { recordAudit } from '../utils/conduct.js';
import { notifyUserExternal } from '../utils/notifier.js';
import { resolveAcademicPeriod, resolveAcademicPeriodForDate } from '../utils/academicPeriod.js';
import { isSubjectOnClassCurriculum, resolveGradeId, misGetList } from './mis.js';
import { validateBody, DATE_RE } from '../shared/validation.js';
import { notifyExcuseDecision, generateForUser } from '../modules/attendance/notifier.service.js';
import { isFutureSchoolDate } from '../shared/schoolTime.js';
import {
  ATTENDANCE_STATUSES,
  ATTENDED_SQL_CASE,
  ATTENDANCE_WARN_THRESHOLD,
  ATTENDANCE_MIN_SESSIONS,
  attendanceRate,
} from '../shared/attendancePolicy.js';

const router = Router();

/** Recognised session labels. Free text here meant `"Morning"` and `"morning"`
 *  became two separate registers (remediation A5). */
const PERIODS = ['Morning', 'Afternoon', 'Evening'] as const;
const MAX_RECORDS_PER_MARK = 300;

const markSchema = z.object({
  classId: z.string().min(1).max(64),
  className: z.string().min(1).max(120),
  date: z.string().regex(DATE_RE, 'Expected YYYY-MM-DD.')
    .refine((d) => !isFutureSchoolDate(d), 'Cannot record attendance for a future date.'),
  period: z.enum(PERIODS).default('Morning'),
  sessionType: z.enum(['homeroom', 'subject']).default('homeroom'),
  subjectId: z.union([z.number().int().positive(), z.null()]).default(null),
  records: z.array(z.object({
    studentId: z.string().min(1).max(64),
    studentName: z.string().min(1).max(160),
    status: z.enum(ATTENDANCE_STATUSES),
    notes: z.string().max(500).optional().default(''),
  })).min(1, 'At least one student record is required.').max(MAX_RECORDS_PER_MARK),
}).refine((v) => v.sessionType !== 'subject' || v.subjectId != null, {
  message: 'subjectId is required when sessionType is "subject".',
  path: ['subjectId'],
});

// Apply auth check on all attendance routes
router.use(authMiddleware);

// Mark (or correct) attendance for one session (Teacher/Admin only).
//
// Upserts against the partial unique indexes added in the A1 remediation
// (uq_attendance_homeroom / uq_attendance_subject) so a re-mark updates the
// existing register in place instead of stacking duplicate rows. Every value
// it overwrites is written to attendance_record_history in the same
// transaction (A13), and one summary row lands in audit_log.
router.post('/mark', authorizePermission('ATTENDANCE_MARK'), validateBody(markSchema), async (req: any, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  const { classId, className, date, period, records, sessionType } = req.body;
  const subjectId: number | null = req.body.subjectId ?? null;

  // The subject must be on this class group's grade curriculum. The client only
  // offers matching subjects, but a stale tab or a direct API call could file
  // against a subject the class doesn't take.
  if (sessionType === 'subject' && subjectId) {
    const misToken = authReq.user?.misToken;
    if (misToken) {
      try {
        const allowed = await isSubjectOnClassCurriculum(misToken, String(classId), Number(subjectId));
        if (!allowed) {
          return res.status(400).json({
            success: false,
            message: 'That subject is not on this class group’s curriculum. Pick a subject taught to this class.',
          });
        }
      } catch (error) {
        // MIS unreachable shouldn't block a teacher's work — log and continue.
        console.error('Subject/class curriculum check skipped:', (error as Error).message);
      }
    }
  }

  const db = getDb();
  const teacherId = authReq.user!.id;
  const teacherName = authReq.user!.name;
  // Remediation X3: file the register under the term its *date* falls in, not
  // whatever term the acting user's session currently points at.
  const { academicYearId, academicTermId } = await resolveAcademicPeriodForDate(
    db, date, resolveAcademicPeriod(authReq)
  );

  const conflictClause = sessionType === 'homeroom'
    ? `ON CONFLICT(student_id, class_id, session_date, period) WHERE session_type = 'homeroom'`
    : `ON CONFLICT(student_id, class_id, session_date, subject_id, period) WHERE session_type = 'subject'`;

  let updatedCount = 0;
  let insertedCount = 0;

  try {
    await db.run('BEGIN TRANSACTION');

    for (const record of records) {
      const { studentId, studentName, status, notes = '' } = record;

      const existing = await db.get(
        `SELECT id, status, notes FROM attendance_records
          WHERE student_id = ? AND class_id = ? AND session_date = ? AND period = ?
            AND session_type = ? AND (subject_id IS ? OR subject_id = ?)`,
        studentId, classId, date, period, sessionType, subjectId, subjectId
      );

      await db.run(
        `INSERT INTO attendance_records
         (student_id, student_name, class_id, class_name, session_date, period, session_type, subject_id, status, notes, marked_by, academic_year_id, academic_term_id, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
         ${conflictClause} DO UPDATE SET
           status = excluded.status,
           notes = excluded.notes,
           marked_by = excluded.marked_by,
           student_name = excluded.student_name,
           class_name = excluded.class_name,
           academic_year_id = excluded.academic_year_id,
           academic_term_id = excluded.academic_term_id,
           updated_at = CURRENT_TIMESTAMP`,
        studentId, studentName, classId, className, date, period, sessionType, subjectId,
        status, notes, teacherId, academicYearId ?? null, academicTermId ?? null
      );

      if (existing) {
        if (existing.status !== status || (existing.notes ?? '') !== (notes ?? '')) {
          await db.run(
            `INSERT INTO attendance_record_history
             (attendance_record_id, student_id, class_id, session_date, period, session_type, subject_id,
              previous_status, new_status, previous_notes, new_notes, changed_by, changed_by_name)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            existing.id, studentId, classId, date, period, sessionType, subjectId,
            existing.status, status, existing.notes ?? '', notes ?? '', teacherId, teacherName
          );
        }
        updatedCount += 1;
      } else {
        insertedCount += 1;
      }
    }

    await recordAudit(
      db,
      { id: teacherId, name: teacherName },
      insertedCount > 0 && updatedCount === 0 ? 'attendance.mark' : 'attendance.update',
      'attendance_session',
      `${classId}:${date}:${period}:${sessionType}:${subjectId ?? '-'}`,
      { classId, className, date, period, sessionType, subjectId, inserted: insertedCount, updated: updatedCount },
      { required: true }
    );

    await db.run('COMMIT');

    // Low-attendance evaluation runs in the background, scoped to this session
    // type so subject drops don't get conflated with homeroom drops.
    triggerLowAttendanceCheck(classId, className, sessionType, academicTermId);

    // Recording a register can clear an outstanding "register missing" nudge
    // and surface the next one — reconcile in the background.
    void generateForUser(db, authReq).catch(() => {});

    return res.json({
      success: true,
      message: updatedCount > 0
        ? `Register updated — ${updatedCount} record${updatedCount === 1 ? '' : 's'} changed or confirmed${insertedCount ? `, ${insertedCount} added` : ''}.`
        : 'Attendance recorded successfully.',
      data: { inserted: insertedCount, updated: updatedCount },
    });
  } catch (error: any) {
    await db.run('ROLLBACK');
    console.error('Error saving attendance:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Error occurred while saving attendance records.',
    });
  }
});

/**
 * Remediation A2/A3 — return an existing register so it can be edited.
 *
 * `session-status` only ever reported a count; the client had no way to load
 * the actual per-student statuses, so "editing" meant blind re-marking with
 * every student defaulted back to Present. This returns the stored rows plus
 * who marked it and when.
 */
router.get('/session', authorizePermission('ATTENDANCE_MARK'), async (req: any, res: Response) => {
  const { classId, date } = req.query;
  const period = String(req.query.period || 'Morning');
  const sessionType = String(req.query.sessionType || 'homeroom');
  const subjectId = req.query.subjectId ? Number(req.query.subjectId) : null;

  if (!classId || !date || !DATE_RE.test(String(date))) {
    return res.status(400).json({ success: false, message: 'classId and a valid date (YYYY-MM-DD) are required.' });
  }
  if (sessionType !== 'homeroom' && sessionType !== 'subject') {
    return res.status(400).json({ success: false, message: "sessionType must be 'homeroom' or 'subject'." });
  }

  try {
    const db = getDb();
    const records = await db.all(
      `SELECT id, student_id, student_name, status, notes, marked_by, updated_at
         FROM attendance_records
        WHERE class_id = ? AND session_date = ? AND period = ? AND session_type = ?
          AND (subject_id IS ? OR subject_id = ?)
        ORDER BY student_name ASC`,
      classId, date, period, sessionType, subjectId, subjectId
    );

    let markedByName: string | null = null;
    let markedById: string | null = null;
    let lastMarkedAt: string | null = null;
    if (records.length > 0) {
      const latest = records.reduce((a: any, b: any) => (a.updated_at > b.updated_at ? a : b));
      lastMarkedAt = latest.updated_at;
      markedById = latest.marked_by;
      const actor = await db.get('SELECT name FROM users WHERE id = ?', latest.marked_by);
      markedByName = actor?.name ?? null;
    }

    return res.json({
      success: true,
      data: {
        exists: records.length > 0,
        classId, date, period, sessionType, subjectId,
        markedById,
        markedByName,
        markedByMe: markedById === (req as AuthenticatedRequest).user!.id,
        lastMarkedAt,
        records: records.map((r: any) => ({
          studentId: r.student_id,
          studentName: r.student_name,
          status: r.status,
          notes: r.notes ?? '',
        })),
      },
    });
  } catch (error) {
    console.error('Error loading attendance session:', error);
    return res.status(500).json({ success: false, message: 'Could not load this register.' });
  }
});

/**
 * Register coverage — which registers have NOT been taken.
 *
 * Denominator note, because it drives everything here: the obvious source
 * for "what was scheduled" is the synced timetable, but it can't be used.
 * Its `period` values are clock times ("09:00") while attendance records
 * store session names ("Morning"), so the two can't be joined, and every
 * slot currently synced belongs to a previous term. Coverage is therefore
 * measured against the class group's *grade curriculum* — the subjects the
 * class is meant to be taught — which is live MIS data and is also what the
 * page promises ("progress against the subjects in the class's grade").
 *
 * The consequence to be honest about in the UI: this reports curriculum
 * coverage for the day, not "you missed period 3", because nothing in the
 * data says which subjects were timetabled for a given day.
 */
router.get('/coverage', authorizePermission('ATTENDANCE_VIEW_ALL'), async (req: any, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  const date = String(req.query.date || new Date().toISOString().split('T')[0]);
  const classId = req.query.classId ? String(req.query.classId) : null;

  if (!DATE_RE.test(date)) {
    return res.status(400).json({ success: false, message: 'Invalid date. Expected YYYY-MM-DD.' });
  }

  const db = getDb();
  const misToken = authReq.user?.misToken;

  try {
    // What was actually recorded that day, per class and per subject.
    const recorded = await db.all(
      `SELECT class_id, class_name, session_type, subject_id,
              COUNT(*) AS students, MAX(updated_at) AS last_marked, MAX(marked_by) AS marked_by
       FROM attendance_records
       WHERE session_date = ?
       GROUP BY class_id, session_type, subject_id`,
      date
    );

    const byClass = new Map<string, { homeroom: any | null; subjects: Map<number, any>; className: string }>();
    for (const r of recorded) {
      if (!byClass.has(r.class_id)) {
        byClass.set(r.class_id, { homeroom: null, subjects: new Map(), className: r.class_name });
      }
      const entry = byClass.get(r.class_id)!;
      if (r.session_type === 'homeroom') entry.homeroom = r;
      else if (r.subject_id != null) entry.subjects.set(Number(r.subject_id), r);
    }

    // ---- Detail for one class: every curriculum subject, taken or not ----
    if (classId) {
      const entry = byClass.get(classId);
      let curriculum: Array<{ id: number; name: string; code: string | null }> = [];
      if (misToken) {
        try {
          const gradeId = await resolveGradeId(misToken, classId);
          if (gradeId != null) {
            const rows = await misGetList(misToken, `/academics/grades/${gradeId}/subjects`);
            curriculum = rows.map((x: any) => ({
              id: Number(x.subject_id),
              name: x.subject_name ?? x.name,
              code: x.subject_code ?? x.code ?? null,
            }));
          }
        } catch (err) {
          console.error('Coverage: curriculum lookup failed:', (err as Error).message);
        }
      }

      const subjects = curriculum.map((sub) => {
        const hit = entry?.subjects.get(sub.id);
        return {
          ...sub,
          recorded: !!hit,
          students: hit?.students ?? 0,
          lastMarkedAt: hit?.last_marked ?? null,
        };
      });
      // A subject marked but no longer on the curriculum still happened —
      // surface it rather than hiding a real register.
      for (const [id, hit] of entry?.subjects ?? []) {
        if (!subjects.some((x) => x.id === id)) {
          subjects.push({
            id, name: `Subject #${id}`, code: null,
            recorded: true, students: hit.students, lastMarkedAt: hit.last_marked,
          });
        }
      }

      return res.json({
        success: true,
        data: {
          date,
          classId,
          curriculumKnown: curriculum.length > 0,
          homeroom: entry?.homeroom
            ? { recorded: true, students: entry.homeroom.students, lastMarkedAt: entry.homeroom.last_marked }
            : { recorded: false, students: 0, lastMarkedAt: null },
          subjects,
        },
      });
    }

    // ---- Overview across every class group ----
    let classes: Array<{ id: string; name: string; department: string }> = [];
    if (misToken) {
      try {
        const rows = await misGetList(misToken, '/academics/class-groups');
        classes = rows.map((c: any) => ({
          id: String(c.class_group_id ?? c.id),
          name: c.name,
          department: c.program_name || c.grade_name || '',
        }));
      } catch (err) {
        console.error('Coverage: class list failed:', (err as Error).message);
      }
    }
    // Fall back to whatever has been marked, so the page still works when
    // the MIS is unreachable.
    if (classes.length === 0) {
      classes = [...byClass.entries()].map(([id, v]) => ({ id, name: v.className, department: '' }));
    }

    const items = classes.map((c) => {
      const entry = byClass.get(c.id);
      return {
        classId: c.id,
        className: c.name,
        department: c.department,
        homeroomRecorded: !!entry?.homeroom,
        homeroomStudents: entry?.homeroom?.students ?? 0,
        subjectsRecorded: entry ? entry.subjects.size : 0,
        lastMarkedAt: entry?.homeroom?.last_marked
          ?? [...(entry?.subjects.values() ?? [])].map((x: any) => x.last_marked).sort().pop()
          ?? null,
      };
    });

    return res.json({
      success: true,
      data: {
        date,
        classes: items,
        totals: {
          classes: items.length,
          homeroomTaken: items.filter((i) => i.homeroomRecorded).length,
          classesWithAnySubject: items.filter((i) => i.subjectsRecorded > 0).length,
        },
      },
    });
  } catch (error) {
    console.error('Error building attendance coverage:', error);
    return res.status(500).json({ success: false, message: 'Could not build the coverage report.' });
  }
});

// View attendance history (Teacher/Admin only)
/**
 * Has this exact session already been marked?
 *
 * POST /mark upserts (ON CONFLICT DO UPDATE), so re-submitting silently
 * replaces an existing register with no indication that prior marks were
 * overwritten. This lets the client warn first — it reports what's already
 * recorded rather than deciding anything itself.
 */
router.get('/session-status', authorizePermission('ATTENDANCE_MARK'), async (req: any, res: Response) => {
  const { classId, date, period = 'Morning', sessionType = 'homeroom' } = req.query;
  const subjectId = req.query.subjectId ? Number(req.query.subjectId) : null;

  if (!classId || !date) {
    return res.status(400).json({ success: false, message: 'classId and date are required.' });
  }
  if (!DATE_RE.test(String(date))) {
    return res.status(400).json({ success: false, message: 'Invalid date. Expected YYYY-MM-DD.' });
  }

  try {
    const db = getDb();
    const row = await db.get(
      `SELECT COUNT(*) AS count, MAX(updated_at) AS last_marked, MAX(marked_by) AS marked_by
       FROM attendance_records
       WHERE class_id = ? AND session_date = ? AND period = ? AND session_type = ?
         AND (subject_id IS ? OR subject_id = ?)`,
      classId, date, period, sessionType, subjectId, subjectId
    );
    const count = row?.count ?? 0;
    let markedByName: string | null = null;
    if (count > 0 && row?.marked_by) {
      const actor = await db.get('SELECT name FROM users WHERE id = ?', row.marked_by);
      markedByName = actor?.name ?? null;
    }
    return res.json({
      success: true,
      data: { exists: count > 0, count, lastMarkedAt: row?.last_marked ?? null, markedByName },
    });
  } catch (error) {
    console.error('Error checking session status:', error);
    return res.status(500).json({ success: false, message: 'Could not check this session.' });
  }
});

router.get('/records', authorizePermission('ATTENDANCE_VIEW_ALL'), async (req: any, res: Response) => {
  const { classId, dateFrom, dateTo, search, status, sessionType, subjectId } = req.query;
  const db = getDb();
  const { academicTermId } = resolveAcademicPeriod(req as AuthenticatedRequest);

  let where = ' WHERE 1=1';
  const params: any[] = [];

  if (academicTermId != null) {
    // Legacy rows (no academic_term_id recorded yet) stay visible under any period.
    where += ' AND (ar.academic_term_id = ? OR ar.academic_term_id IS NULL)';
    params.push(academicTermId);
  }
  if (classId) { where += ' AND ar.class_id = ?'; params.push(classId); }
  if (sessionType) { where += ' AND ar.session_type = ?'; params.push(sessionType); }
  if (subjectId) { where += ' AND ar.subject_id = ?'; params.push(subjectId); }
  if (status && status !== 'all') { where += ' AND ar.status = ?'; params.push(status); }
  if (dateFrom) { where += ' AND ar.session_date >= ?'; params.push(dateFrom); }
  if (dateTo) { where += ' AND ar.session_date <= ?'; params.push(dateTo); }
  if (search) {
    where += ' AND (ar.student_name LIKE ? OR ar.student_id LIKE ?)';
    params.push(`%${search}%`, `%${search}%`);
  }

  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 500);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

  try {
    const totalRow = await db.get(`SELECT COUNT(*) as count FROM attendance_records ar${where}`, ...params);
    const records = await db.all(
      `SELECT ar.*, s.name AS subject_name
         FROM attendance_records ar
         LEFT JOIN subjects s ON s.id = ar.subject_id
        ${where}
        ORDER BY ar.session_date DESC, ar.period ASC, ar.student_name ASC
        LIMIT ? OFFSET ?`,
      ...params, limit, offset
    );
    return res.json({
      success: true,
      data: records,
      total: totalRow.count,
    });
  } catch (error) {
    console.error('Error fetching attendance records:', error);
    return res.status(500).json({
      success: false,
      message: 'Error fetching attendance records.',
    });
  }
});

// Student's own attendance (Student only)
router.get('/me', authorizePermission('ATTENDANCE_VIEW_OWN'), async (req: any, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  const studentId = authReq.user!.id;
  const db = getDb();
  const { academicTermId } = resolveAcademicPeriod(authReq);

  try {
    // Remediation A16: return homeroom AND subject rows (tagged), plus a
    // day-by-day merge and a summary. The headline rate stays the homeroom
    // signal (A.1.1) — matching every report and the warning check (A6) — but
    // the student can finally see their per-subject attendance too.
    const termClause = academicTermId != null
      ? ' AND (academic_term_id = ? OR academic_term_id IS NULL)' : '';
    const termParams = academicTermId != null ? [academicTermId] : [];

    const all = await db.all(
      `SELECT id, class_id, class_name, session_date, period, session_type, subject_id, status, notes, updated_at
         FROM attendance_records
        WHERE student_id = ?${termClause}
        ORDER BY session_date DESC, period ASC`,
      studentId, ...termParams
    );
    const subjectNames = new Map<number, string>(
      (await db.all('SELECT id, name FROM subjects')).map((s: any) => [s.id, s.name])
    );

    const homeroom = all.filter((r: any) => r.session_type === 'homeroom');
    const subjects = all
      .filter((r: any) => r.session_type === 'subject')
      .map((r: any) => ({ ...r, subject_name: subjectNames.get(r.subject_id) ?? `Subject #${r.subject_id}` }));

    const excuses = await db.all(
      `SELECT id, class_id, class_name, session_date, status FROM excuse_requests
        WHERE student_id = ?${termClause}`,
      studentId, ...termParams
    );
    const excuseByDay = new Map<string, string>();
    for (const e of excuses) {
      const key = `${e.session_date}`;
      // approved wins over pending wins over rejected for the day badge
      const rank = (s: string) => (s === 'approved' ? 3 : s === 'pending' ? 2 : 1);
      if (!excuseByDay.has(key) || rank(e.status) > rank(excuseByDay.get(key)!)) excuseByDay.set(key, e.status);
    }

    // Day-by-day merge (A16).
    const dayMap = new Map<string, any>();
    for (const r of [...homeroom, ...subjects]) {
      if (!dayMap.has(r.session_date)) {
        dayMap.set(r.session_date, {
          date: r.session_date, classId: r.class_id, className: r.class_name,
          homeroom: null, subjects: [], excuseStatus: excuseByDay.get(r.session_date) ?? null,
        });
      }
      const day = dayMap.get(r.session_date);
      if (r.session_type === 'homeroom') {
        day.homeroom = { status: r.status, notes: r.notes, period: r.period };
        day.classId = r.class_id; day.className = r.class_name;
      } else {
        day.subjects.push({ subjectId: r.subject_id, subjectName: (r as any).subject_name, status: r.status, notes: r.notes, period: r.period });
      }
    }
    const days = [...dayMap.values()].sort((a, b) => (a.date < b.date ? 1 : -1));

    const total = homeroom.length;
    const attended = homeroom.filter((r: any) => ['present', 'late', 'excused'].includes(r.status)).length;
    const summary = {
      total,
      present: homeroom.filter((r: any) => r.status === 'present').length,
      late: homeroom.filter((r: any) => r.status === 'late').length,
      excused: homeroom.filter((r: any) => r.status === 'excused').length,
      absent: homeroom.filter((r: any) => r.status === 'absent').length,
      rate: total > 0 ? Math.round((attended / total) * 100) : 100,
      threshold: ATTENDANCE_WARN_THRESHOLD,
    };

    return res.json({
      success: true,
      data: { summary, days, homeroom, subjects },
    });
  } catch (error) {
    console.error('Error fetching own attendance:', error);
    return res.status(500).json({
      success: false,
      message: 'Error fetching own attendance records.',
    });
  }
});

// Specific student's attendance (anyone with ATTENDANCE_VIEW_ALL, or the student themself)
router.get('/student/:id', selfOrPermission('id', 'ATTENDANCE_VIEW_ALL'), async (req: any, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  const studentId = req.params.id;

  const db = getDb();
  const { academicTermId } = resolveAcademicPeriod(authReq);
  try {
    // Homeroom-only, matching /me and the reports overview — otherwise a
    // student's own attendance rate and their instructor-facing StudentReport
    // rate would disagree once subject/course sessions are also recorded.
    const records = academicTermId != null
      ? await db.all(
          "SELECT * FROM attendance_records WHERE student_id = ? AND session_type = 'homeroom' AND (academic_term_id = ? OR academic_term_id IS NULL) ORDER BY session_date DESC",
          studentId, academicTermId
        )
      : await db.all(
          "SELECT * FROM attendance_records WHERE student_id = ? AND session_type = 'homeroom' ORDER BY session_date DESC",
          studentId
        );
    return res.json({
      success: true,
      data: records,
    });
  } catch (error) {
    console.error('Error fetching student attendance:', error);
    return res.status(500).json({
      success: false,
      message: 'Error fetching student attendance records.',
    });
  }
});

// Fetch student's own excuse requests
router.get('/excuses/me', authorizePermission('EXCUSES_VIEW_OWN'), async (req: any, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  const studentId = authReq.user!.id;
  const db = getDb();
  const { academicTermId } = resolveAcademicPeriod(authReq);

  try {
    const excuses = academicTermId != null
      ? await db.all(
          'SELECT * FROM excuse_requests WHERE student_id = ? AND (academic_term_id = ? OR academic_term_id IS NULL) ORDER BY created_at DESC',
          studentId, academicTermId
        )
      : await db.all(
          'SELECT * FROM excuse_requests WHERE student_id = ? ORDER BY created_at DESC',
          studentId
        );
    return res.json({
      success: true,
      data: excuses,
    });
  } catch (error) {
    console.error('Error fetching student excuses:', error);
    return res.status(500).json({
      success: false,
      message: 'Error fetching excuse requests.',
    });
  }
});

// Submit a new excuse request
router.post('/excuse', authorizePermission('EXCUSES_SUBMIT'), async (req: any, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  const studentId = authReq.user!.id;
  const studentName = authReq.user!.name;
  const { className, classId = null, period = null, sessionDate, reason, description } = req.body;
  const supersedesId = req.body.supersedesId ? Number(req.body.supersedesId) : null;

  if (!className || !sessionDate || !reason) {
    return res.status(400).json({
      success: false,
      message: 'Missing required fields: className, sessionDate, reason.',
    });
  }
  if (!DATE_RE.test(String(sessionDate))) {
    return res.status(400).json({ success: false, message: 'Invalid sessionDate. Expected YYYY-MM-DD.' });
  }
  if (isFutureSchoolDate(String(sessionDate))) {
    return res.status(400).json({ success: false, message: 'You can only request an excuse for a past or current date.' });
  }
  if (String(reason).length > 100 || String(className).length > 100 || String(description || '').length > 2000) {
    return res.status(400).json({ success: false, message: 'Input too long: reason/className max 100 chars, description max 2000.' });
  }
  if (period != null && !(PERIODS as readonly string[]).includes(String(period))) {
    return res.status(400).json({ success: false, message: `Invalid period. Expected one of: ${PERIODS.join(', ')}.` });
  }

  const db = getDb();
  // Remediation X3: an excuse belongs to the term its date falls in.
  const { academicYearId, academicTermId } = await resolveAcademicPeriodForDate(
    db, sessionDate, resolveAcademicPeriod(authReq)
  );
  try {
    // Remediation A9: one request per student/class/date regardless of status.
    // The previous guard only blocked a *pending* duplicate and matched on the
    // free-text class name, so a re-typed name or a re-submit after a decision
    // slipped straight through and flooded the reviewer's queue. A genuine
    // appeal is still possible — the student passes `supersedesId` pointing at
    // the decided request they're following up on.
    const dupWhere = classId
      ? `student_id = ? AND class_id = ? AND session_date = ?`
      : `student_id = ? AND lower(class_name) = lower(?) AND session_date = ?`;
    const existing = await db.get(
      `SELECT * FROM excuse_requests WHERE ${dupWhere} ORDER BY created_at DESC LIMIT 1`,
      studentId, classId ?? className, sessionDate
    );
    if (existing) {
      const appealingThis = supersedesId === existing.id && existing.status === 'rejected';
      if (!appealingThis) {
        return res.status(409).json({
          success: false,
          code: 'EXCUSE_EXISTS',
          message: existing.status === 'pending'
            ? 'You already have a request for this class on that date — wait for it to be reviewed.'
            : `This absence already has a ${existing.status} excuse request. Open it to appeal if you have new evidence.`,
          data: { existingId: existing.id, existingStatus: existing.status },
        });
      }
    }

    const result = await db.run(
      `INSERT INTO excuse_requests
         (student_id, student_name, class_id, class_name, period, session_date, reason, description, status, academic_year_id, academic_term_id, supersedes_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      studentId, studentName, classId, className, period, sessionDate,
      reason, description || '', academicYearId ?? null, academicTermId ?? null,
      supersedesId
    );

    const inserted = await db.get('SELECT * FROM excuse_requests WHERE id = ?', result.lastID);

    return res.json({
      success: true,
      data: inserted,
      message: 'Excuse request submitted successfully.',
    });
  } catch (error: any) {
    console.error('Error submitting excuse:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Error submitting excuse request.',
    });
  }
});

/**
 * Remediation A8 — reconcile an excuse decision with the absence it covers.
 * Approving flips the student's `absent` homeroom rows for that day (scoped to
 * the excuse's period when it has one) to `excused`; moving an approved excuse
 * back to rejected restores them. Returns how many rows changed for the audit.
 */
async function reconcileExcuseWithAttendance(
  db: any,
  excuse: { student_id: string; session_date: string; class_id: string | null; class_name: string; period: string | null },
  direction: 'approve' | 'revert'
): Promise<number> {
  const from = direction === 'approve' ? 'absent' : 'excused';
  const to = direction === 'approve' ? 'excused' : 'absent';
  const classClause = excuse.class_id ? 'AND class_id = ?' : 'AND lower(class_name) = lower(?)';
  const classVal = excuse.class_id ?? excuse.class_name;
  const periodClause = excuse.period ? 'AND period = ?' : '';
  const params: any[] = [to, from, excuse.student_id, excuse.session_date, classVal];
  if (excuse.period) params.push(excuse.period);

  const result = await db.run(
    `UPDATE attendance_records
        SET status = ?, updated_at = CURRENT_TIMESTAMP
      WHERE status = ? AND session_type = 'homeroom'
        AND student_id = ? AND session_date = ? ${classClause} ${periodClause}`,
    ...params
  );
  return result.changes ?? 0;
}


// List excuse requests for review (Teacher/Admin only)
router.get('/excuses', authorizePermission('EXCUSES_REVIEW'), async (req: any, res: Response) => {
  const { status, search } = req.query;
  const db = getDb();
  const { academicTermId } = resolveAcademicPeriod(req as AuthenticatedRequest);

  let query = 'SELECT * FROM excuse_requests WHERE 1=1';
  const params: any[] = [];
  if (academicTermId != null) {
    query += ' AND (academic_term_id = ? OR academic_term_id IS NULL)';
    params.push(academicTermId);
  }
  if (status) { query += ' AND status = ?'; params.push(status); }
  if (search) {
    query += ' AND (student_name LIKE ? OR student_id LIKE ? OR class_name LIKE ?)';
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  // Pending first, then most recent.
  query += " ORDER BY (status = 'pending') DESC, created_at DESC";

  try {
    const excuses = await db.all(query, ...params);

    // Remediation A10: the reviewer needs context — is the student actually
    // marked absent that day, and how many excuses have they filed before?
    const enriched = await Promise.all(excuses.map(async (ex: any) => {
      const classClause = ex.class_id ? 'AND class_id = ?' : 'AND lower(class_name) = lower(?)';
      const classVal = ex.class_id ?? ex.class_name;
      const att = await db.get(
        `SELECT status FROM attendance_records
          WHERE student_id = ? AND session_date = ? AND session_type = 'homeroom' ${classClause}
          ORDER BY (status = 'absent') DESC LIMIT 1`,
        ex.student_id, ex.session_date, classVal
      );
      const priorCount = await db.get(
        `SELECT COUNT(*) AS n FROM excuse_requests WHERE student_id = ? AND id != ?`,
        ex.student_id, ex.id
      );
      return {
        ...ex,
        attendanceStatus: att?.status ?? null,
        isMarkedAbsent: att?.status === 'absent',
        priorExcuseCount: priorCount?.n ?? 0,
      };
    }));

    return res.json({ success: true, data: enriched });
  } catch (error) {
    console.error('Error fetching excuse requests:', error);
    return res.status(500).json({ success: false, message: 'Error fetching excuse requests.' });
  }
});

async function applyExcuseDecision(
  db: any,
  actor: { id: string; name: string },
  existing: any,
  status: 'approved' | 'rejected',
  reviewerNote: string | null
) {
  await db.run(
    `UPDATE excuse_requests
        SET status = ?, reviewer_note = ?, reviewed_by = ?, reviewed_by_name = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?`,
    status, reviewerNote, actor.id, actor.name ?? null, existing.id
  );

  // Remediation A8: move the underlying absence.
  let reconciled = 0;
  if (status === 'approved' && existing.status !== 'approved') {
    reconciled = await reconcileExcuseWithAttendance(db, existing, 'approve');
  } else if (status === 'rejected' && existing.status === 'approved') {
    reconciled = await reconcileExcuseWithAttendance(db, existing, 'revert');
  }

  await recordAudit(db, actor, 'excuse.review', 'excuse_request', existing.id,
    { from: existing.status, to: status, attendanceRowsChanged: reconciled }, { required: true });

  await db.run(
    `INSERT INTO notifications (user_id, type, title, message) VALUES (?, 'system', ?, ?)`,
    existing.student_id,
    `Excuse ${status}`,
    `Your excuse for ${existing.class_name} on ${existing.session_date} was ${status}${reviewerNote ? ` — "${reviewerNote}"` : ''}.`
  );
  await notifyUserExternal(
    db,
    existing.student_id,
    `Excuse request ${status}`,
    `Your excuse for ${existing.class_name} (${existing.session_date}) has been ${status} by ${actor.name}.`
  );
  return reconciled;
}

// Approve or reject an excuse request (Teacher/Admin only)
router.put('/excuse/:id/status', authorizePermission('EXCUSES_REVIEW'), async (req: any, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  const id = req.params.id;
  const { status } = req.body as { status?: string };
  const reviewerNote = req.body.reviewerNote ? String(req.body.reviewerNote).slice(0, 500) : null;

  if (status !== 'approved' && status !== 'rejected') {
    return res.status(400).json({ success: false, message: "Invalid status. Expected 'approved' or 'rejected'." });
  }

  const db = getDb();
  const actor = authReq.user!;

  try {
    const existing = await db.get('SELECT * FROM excuse_requests WHERE id = ?', id);
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Excuse request not found.' });
    }

    await db.run('BEGIN TRANSACTION');
    let reconciled = 0;
    try {
      reconciled = await applyExcuseDecision(db, actor, existing, status, reviewerNote);
      await db.run('COMMIT');
    } catch (err) {
      await db.run('ROLLBACK');
      throw err;
    }

    if (existing.student_id) {
      await notifyExcuseDecision(db, {
        studentId: String(existing.student_id),
        approved: status === 'approved',
        sessionDate: String(existing.session_date),
        excuseId: Number(id),
      });
    }

    const updated = await db.get('SELECT * FROM excuse_requests WHERE id = ?', id);
    return res.json({
      success: true,
      data: updated,
      message: reconciled > 0
        ? `Excuse ${status}; ${reconciled} attendance record${reconciled === 1 ? '' : 's'} updated to excused.`
        : `Excuse ${status}.`,
    });
  } catch (error: any) {
    console.error('Error reviewing excuse:', error);
    return res.status(500).json({ success: false, message: error.message || 'Error updating the excuse request.' });
  }
});

// Bulk approve/reject pending excuse requests (Teacher/Admin only) — A10.
router.put('/excuses/bulk', authorizePermission('EXCUSES_REVIEW'), async (req: any, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  const actor = authReq.user!;
  const { ids, status } = req.body as { ids?: unknown; status?: string };
  const reviewerNote = req.body.reviewerNote ? String(req.body.reviewerNote).slice(0, 500) : null;

  if (status !== 'approved' && status !== 'rejected') {
    return res.status(400).json({ success: false, message: "Invalid status. Expected 'approved' or 'rejected'." });
  }
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 200) {
    return res.status(400).json({ success: false, message: 'Provide 1–200 excuse request ids.' });
  }

  const db = getDb();
  let processed = 0;
  let reconciled = 0;
  try {
    await db.run('BEGIN TRANSACTION');
    try {
      for (const rawId of ids) {
        const existing = await db.get('SELECT * FROM excuse_requests WHERE id = ?', rawId);
        if (!existing || existing.status === status) continue;
        reconciled += await applyExcuseDecision(db, actor, existing, status, reviewerNote);
        processed += 1;
        if (existing.student_id) {
          await notifyExcuseDecision(db, {
            studentId: String(existing.student_id),
            approved: status === 'approved',
            sessionDate: String(existing.session_date),
            excuseId: Number(rawId),
          });
        }
      }
      await db.run('COMMIT');
    } catch (err) {
      await db.run('ROLLBACK');
      throw err;
    }
    return res.json({
      success: true,
      data: { processed, attendanceRowsChanged: reconciled },
      message: `${processed} request${processed === 1 ? '' : 's'} ${status}.`,
    });
  } catch (error: any) {
    console.error('Error bulk-reviewing excuses:', error);
    return res.status(500).json({ success: false, message: error.message || 'Error updating excuse requests.' });
  }
});

// Helper background logic to analyze attendance drop and push system alerts
async function triggerLowAttendanceCheck(
  classId: string,
  className: string,
  sessionType: string = 'homeroom',
  academicTermId?: number
) {
  const db = getDb();
  try {
    // Scoped to the term the session belongs to, and to the same "attended"
    // definition (present + late + excused) the student sees on their own page
    // and every report — remediation A6. Averaging over every term ever
    // recorded, or counting only bare `present`, made the warning fire against
    // a figure shown nowhere in the UI.
    const stats = await db.all(
      `SELECT student_id, student_name,
              SUM(${ATTENDED_SQL_CASE}) as attended,
              COUNT(*) as total
       FROM attendance_records
       WHERE class_id = ? AND session_type = ?
         AND (? IS NULL OR academic_term_id = ? OR academic_term_id IS NULL)
       GROUP BY student_id`,
      classId, sessionType, academicTermId ?? null, academicTermId ?? null
    );

    const today = new Date().toISOString().split('T')[0];

    for (const student of stats) {
      const percentage = attendanceRate(student.attended, student.total);
      if (student.total < ATTENDANCE_MIN_SESSIONS || percentage >= ATTENDANCE_WARN_THRESHOLD) continue;

      // One student alert per class per day — a real unique constraint now
      // (remediation X4), not a title LIKE match.
      const dedupeKey = `low_attendance:${student.student_id}:${classId}:${sessionType}:${today}`;
      const already = await db.get(
        `SELECT 1 FROM notifications WHERE dedupe_key = ?`, dedupeKey
      );
      if (already) continue;

      await db.run(
        `INSERT INTO notifications (user_id, type, title, message, dedupe_key) VALUES (?, 'low_attendance', ?, ?, ?)`,
        student.student_id,
        `Low attendance warning (${percentage}%)`,
        `Your attendance in ${className} is currently ${percentage}% (${student.attended}/${student.total} sessions). Please contact your instructor.`,
        dedupeKey
      );

      await notifyUserExternal(
        db,
        student.student_id,
        `Low attendance in ${className}`,
        `Your attendance in ${className} has dropped to ${percentage}% (${student.attended}/${student.total}). Please contact your instructor.`,
        { kind: 'absence' }
      );

      await db.run(
        `INSERT INTO notifications (user_id, type, title, message, dedupe_key) VALUES ('all', 'low_attendance', ?, ?, ?)`,
        `Attendance drop: ${student.student_name}`,
        `${student.student_name}'s attendance in ${className} has dropped to ${percentage}%.`,
        `${dedupeKey}:staff`
      );
    }
  } catch (err) {
    console.error('Error in triggerLowAttendanceCheck:', err);
  }
}

export default router;
