# HANDOFF

## Current Task
Sidebar double-highlight, Attendance Report restyle, dashboard "Today" agenda, /dashboard as home.

## Status
Solved — uncommitted in the working tree on `main`. Client typecheck + `vite build` clean. Rendered via a
throwaway full-app harness (mocked API, headless Edge): report landing + loaded report, staff dashboard
(light), student dashboard (dark). Not exercised against live data.

## Progress
- [x] Sidebar: one active item — longest matching nav path wins (`activePathFor` in Sidebar.tsx).
- [x] `homeRouteForRole` → `/dashboard` (login, "/" guard, 404, ProtectedRoute all follow it).
- [x] Attendance Report (staff): single toolbar (mode · date presets 2w/30d/term · class + register chips),
      landing card with class tiles, 4 stat tiles, "students who need attention" (bottom 8, expandable),
      URL-driven state (`?mode&classId&section&subjectId&from&to`) so reports are linkable.
- [x] `components/dashboard/TodayAgenda.tsx` + `styles/todayAgenda.css`: today's timetable on both
      dashboards — done/now/overdue/upcoming, Take register / Edit for staff, own mark + Excuse for students,
      rows open the session detail page. Replaces the old TodayStrip.
- [x] `COMMENT_FILL` (chart tokens) for tier bars; `newExcuseLinkForSession` shared in api/excuses.ts.
- [ ] Commit/push when asked.

## Working Notes
- Harness recipe (deleted, easy to recreate): `.harness/mock.ts` overriding window.fetch by URL regex +
  seeding localStorage session, `.harness/page.tsx` mounting `<App />` after `history.replaceState(go)`,
  screenshot with `msedge --headless=new --screenshot`. Headless Edge clamps viewport width to ~496px.

## Recently Completed
- 2026-09-15: Sidebar single-highlight; report restyle + linkable URLs; dashboard Today agenda; /dashboard home.
- 2026-09-15: Report analytics charts (trend, mark mix, bands) for staff and student reports.
- 2026-09-15: Excuses rebuilt as overview/new/detail pages; subject-lesson excuses; withdraw + appeal.
- 2026-09-15: Student-scoped notifications + personal absent/late notices.
- 2026-09-15: Dashboard-first sidebar; session detail page reachable from every calendar lesson.
