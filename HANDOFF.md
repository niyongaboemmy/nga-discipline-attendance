# HANDOFF

## Current Task
Rebuild the student Leaves & Excuses experience: overview → new request → detail,
with excuses that can target a specific subject lesson.

## Status
Solved — uncommitted in the working tree on `main`. 167/167 server tests (7 new in
`excuseStudentFlow.test.ts`), server + client typecheck, `vite build` all clean.
Not exercised in a browser (no local SSO env) — needs a real click-through as a student.

## Progress
- [x] DB: `excuse_requests` + `session_type` (default homeroom), `subject_id`, `subject_name`.
- [x] Server: POST /excuse accepts sessionType/subjectId/subjectName; duplicate guard is per lesson;
      approval flips only that lesson's `absent` row (shared `excuseTargetClause`).
- [x] Server: GET /excuses/me/absences (absent marks + covering excuse), GET /excuses/me/:id
      (own only; attendanceStatus + appeal chain), DELETE /excuse/:id (withdraw while pending).
- [x] Client: `api/excuses.ts`; pages `Excuses` (/excuses), `ExcuseNew` (/excuses/new, also `?appeal=id`),
      `ExcuseDetail` (/excuses/:id); `components/excuses/*`; `styles/excuses.css`. `LeaveRequests.tsx` removed.
- [x] Lesson detail page: absent student gets "Submit an excuse" pre-filled; review page shows the lesson.
- [x] Excuse-decision notification now deep-links to /excuses/:id.
- [ ] Commit/push when asked.

## Working Notes
- Only `absent` marks are excusable (late is not) — matches the reconcile rule, which only flips absent→excused.
- A manual request (class + date typed by hand) is always a morning-check excuse; subject excuses come from
  the absence list / lesson page, where the subject id is known.
- Pre-existing lint: `react-hooks/set-state-in-effect` everywhere, and an `no-unused-expressions` in
  ExcuseReview.tsx that predates this work.

## Recently Completed
- 2026-09-15: Excuses rebuilt as overview/new/detail pages; subject-lesson excuses; withdraw + appeal.
- 2026-09-15: Student-scoped notifications + personal absent/late notices.
- 2026-09-15: Dashboard-first sidebar; session detail page reachable from every calendar lesson.
