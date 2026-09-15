# HANDOFF

## Current Task
Student notifications: scope the bell to the signed-in user and add
"you were marked absent/late for <subject>" notices.

## Status
Solved — uncommitted on `main` (working tree). 160/160 server tests pass;
server + client typecheck clean. Not exercised in a browser (no local SSO env).

## Progress
- [x] `routes/notifications.ts`: `user_id = 'all'` rows (attendance-drop, major-incident,
      conduct follow-up broadcasts) are now returned only to teacher/admin; students get
      only rows addressed to them. Applies to list, read-one, read-all.
- [x] `notifier.service.ts`: `notifyStudentMarked()` — type `attendance_marked`, absent =
      warning, late = info, present/excused = nothing. Dedupe key per session+status; a
      correction deletes the previous status' notice. Links to `/attendance/session?…`.
- [x] `routes/attendance.ts` POST /mark: fans out per student after COMMIT, in the background.
- [x] Client: `attendance_marked` type + icon in NotificationCenter.
- [x] Tests in `__tests__/notifier.service.test.ts` (3 new).
- [ ] Commit/push when asked.

## Working Notes
- Broadcasts still use the `'all'` sentinel in the DB; only the read side changed, so
  existing rows behave correctly without a migration. If a "staff" audience is ever
  needed distinct from "all users", introduce a new sentinel then.
- Student "lesson starting soon" reminders are unchanged (they're about the student's own timetable).

## Recently Completed
- 2026-09-15: Student-scoped notifications + personal absent/late notices.
- 2026-09-15: Dashboard-first sidebar; session detail page reachable from every calendar lesson.
