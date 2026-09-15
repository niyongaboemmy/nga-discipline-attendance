# HANDOFF

## Current Task
Student Attendance Report restyle (the staff one was done earlier; the student page still had the old look).

## Status
Solved — uncommitted on `main`. Typecheck + build clean; rendered via the mocked-API harness as a
student (overview light, subject detail dark). Not exercised against live data.

## Progress
- [x] `StudentAttendanceReport.tsx` rewritten: same toolbar as staff (breadcrumb · Full term / 30d / 2w presets ·
      From/To), **default range = full term** (the old 2-week default often had no marks → no charts),
      4 stat tiles (overall rate + tier, sessions, unexcused absences, late), analytics panel (term running-rate
      trend from `/api/attendance/me` days · marks-by-subject stack · absences-by-subject columns), subject list.
      Detail view: trend + mix + register. `?from&to&section` in the URL; dashboard "My Classes" rows deep-link.
- [x] `ColumnChart` gained `plotHeight`.
- [ ] Commit/push when asked.

## Recently Completed
- 2026-09-15: Student attendance report restyled with term trend, subject mix, absences chart; full-term default.
- 2026-09-15: Sidebar single-highlight; report restyle + linkable URLs; dashboard Today agenda; /dashboard home.
- 2026-09-15: Report analytics charts (trend, mark mix, bands) for staff and student reports.
- 2026-09-15: Excuses rebuilt as overview/new/detail pages; subject-lesson excuses; withdraw + appeal.
- 2026-09-15: Student-scoped notifications + personal absent/late notices.
- 2026-09-15: Dashboard-first sidebar; session detail page reachable from every calendar lesson.
