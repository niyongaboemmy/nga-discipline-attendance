# HANDOFF

## Current Task
Fix "SQLITE_CONSTRAINT: FOREIGN KEY constraint failed" when a teacher saves a subject register.

## Status
Solved — uncommitted on `main`. 171/171 server tests (4 new in `markUnsyncedSubject.test.ts`, which
reproduce the failure without the fix). Server + client typecheck clean.

## Progress
- [x] Root cause: `attendance_records.subject_id` → `subjects(id)` FK; `subjects` is a local cache filled only
      by the admin roster sync, so an unsynced subject made the insert fail.
- [x] `ensureSubjectCached()` in academicsSync.service.ts: cached → MIS `/academics/subjects` → placeholder
      from the client-supplied name. Called from POST /mark before the transaction.
- [x] `subjectName` accepted by the mark schema; RegisterDrawer + MarkAttendance send it.
- [ ] Commit/push when asked.

## Recently Completed
- 2026-09-15: Save-register FK failure fixed — subject cache self-heals on save.
- 2026-09-15: Student attendance report restyled with term trend, subject mix, absences chart; full-term default.
- 2026-09-15: Sidebar single-highlight; report restyle + linkable URLs; dashboard Today agenda; /dashboard home.
- 2026-09-15: Report analytics charts (trend, mark mix, bands) for staff and student reports.
- 2026-09-15: Excuses rebuilt as overview/new/detail pages; subject-lesson excuses; withdraw + appeal.
- 2026-09-15: Student-scoped notifications + personal absent/late notices.
- 2026-09-15: Dashboard-first sidebar; session detail page reachable from every calendar lesson.
