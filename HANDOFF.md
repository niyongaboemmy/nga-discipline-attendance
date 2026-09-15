# HANDOFF

## Current Task
Analytics charts on the Attendance Report (staff + student).

## Status
Solved — uncommitted in the working tree on `main`. Client typecheck + `vite build` clean;
charts rendered and screenshotted via a throwaway harness (headless Edge) in light, dark and
narrow widths. Not clicked through against live data (no local SSO env).

## Progress
- [x] `components/charts/`: TrendLine (SVG, crosshair + keyboard), StackedBar (100% stacks, per-segment
      tooltip), ColumnChart, shared tooltip/legend/table-twin, `statusSeries.tsx`, `useWidth.ts`.
- [x] `utils/attendanceAnalytics.ts`: daily class rates, running rate, totals, tier counts — all client-side
      from the existing report payload (no new endpoints).
- [x] Staff report: `ClassAnalytics` panel (daily rate trend · mark mix · students by band) above the
      per-student ranking, inside the print area.
- [x] Student report: overview's comparison bars → status mix by subject; section detail gets the running-rate
      trend + a legend-bearing mix bar (replacing the unlabeled colour strip).
- [x] `--chart-*` fill tokens in variables.css, validated with the dataviz palette script on both surfaces.
- [ ] Commit/push when asked.

## Working Notes
- Chart fills deliberately don't follow the dark-mode status tokens (too light for fills); same four hexes
  in both themes, segment order present → late → excused → absent, icons + 2px gaps as secondary encoding.
- Trend charts need ≥ 2 recorded days; otherwise a one-line note is shown in their slot.

## Recently Completed
- 2026-09-15: Report analytics charts (trend, mark mix, bands) for staff and student reports.
- 2026-09-15: Excuses rebuilt as overview/new/detail pages; subject-lesson excuses; withdraw + appeal.
- 2026-09-15: Student-scoped notifications + personal absent/late notices.
- 2026-09-15: Dashboard-first sidebar; session detail page reachable from every calendar lesson.
