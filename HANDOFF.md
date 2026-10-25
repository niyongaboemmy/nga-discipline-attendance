# HANDOFF

## Current Task
Card (RFID) attendance: the ESP32 writes taps to Supabase `public.rfid_scans`. Tendo reads them and marks the same
registers a teacher would, following **each student's own class timetable**. The RFID implementation is now merged
into local `main` from `Levi`; no push was performed.

## Status
**Merge completed 2026-10-25:** the local `main` branch contains both the fetched `origin/main` and all `Levi`
commits. The one merge conflict was documentation-only in `client/src/api/client.ts`; both machine-readable error
code explanations were retained without changing runtime behavior. The admin page only needs to show cards the scanner
assign them to students. Attendance marking is parked.** The page is now: feed Live/Not-live bar (with "Assign it" for the
last tap), roster bar, tabs Scanned cards (default, `?scanned=1`) / Scan log / Scanners. Removed: Today tab, days-off UI,
Unregistered tab, the manual Register card and Enter a scan buttons (the APIs remain).

Fixed 2026-09-25 after the user reported "not live, can't assign":
(1) the client cached role permissions at sign-in and never refreshed them, so admins who signed in before the RFID
permissions existed had the Assign buttons hidden. AuthContext now re-syncs from /api/roles-permissions/me on load and
every 3 min (pre-existing app-wide gap).
(2) The bridge polled every 10 s with up to 60 s backoff, so taps took up to a minute to appear. It now polls every 1 s
(SUPABASE_POLL_MS) with retries at most 5 s apart; LIVE_WITHIN_MS is 15 s. Measured: last check under 1 s ago; the SSE
stream reaches the browser through Vite on :3000.
(3) 2026-09-25 12:25Z: the user said "a new card doesn't show". Supabase had no rows after id 103 (11:57Z), and Tendo's cursor
was already at 103: the ESP stopped sending (likely its Wi-Fi-drop bug, which never reconnects). The feed bar now shows
"Scanner last sent a card N min ago" to separate scanner problems from Tendo problems. Gave the user a fixed sketch.

Working end to end. Server: 254/254 tests. Client typechecks and builds; new files lint clean (repo baseline is still
121 pre-existing lint problems). Smoke-tested on 2026-09-25 against the real Supabase project (bridge read-only) with a
seeded timetable. Headless-Chrome screenshots of /attendance/cards look right.
**Not verified:** the roster + timetable sync against the real Central MIS. Locally the MIS isn't running, and prod
needs the prod SSO secret.

## The rule (engine.ts, agreed with the user)
- A class's lessons for the day are split into blocks at breaks (a gap of 10 min or more, `RFID_BREAK_MIN_GAP_MINUTES`).
- A tap is the student's arrival for the block it falls in (from the previous block's end, or midnight).
- For each lesson in that block: on time up to 3 min after the start (`RFID_GRACE_MINUTES`, so 07:33 is on time and
  07:34 late), late while the lesson runs, skipped once it has ended.
- The first block also fills the morning (homeroom) register.
- A double lesson (same subject and period) is one register.
- Closing: when a lesson ends, card holders with no mark get `absent`, or `excused` if an approved excuse covers it.
  The morning register closes at the end of the morning block.
- Students without cards are never auto-marked; teachers mark them as before.
- Days off (`rfid_days_off`) and dates outside term dates are skipped.
- A card never overwrites a teacher's mark. Card follow-ups are the same as a teacher save: student notices and the
  low-attendance check.

## UI (2026-09-25, redesign)
- /attendance/cards (pages/RfidCards.tsx): scanner→Supabase→Tendo pipeline strip (components/rfid/ScannerFeed.tsx,
  uses the card's *current* status/holder), roster status top-right, clickable stat tiles as filters, search,
  Grid/List toggle saved in localStorage `tendo.cards.view`, card tiles drawn as physical cards (CardBits.tsx CardFace),
  live highlight on tap. Tabs: Cards / Scan log / Scanners (moved to components/rfid/*Tab.tsx).
- /attendance/cards/:id (pages/RfidCardDetail.tsx): big card face, taps (total/today/last), Held by + actions
  (assign / give to someone else / take back / lost / disable / re-enable / printed number), holders timeline,
  live tap history. GET /api/rfid/cards/:id returns holder+class, taps, tapsToday, 50 scans.
- Shared: utils/rfidCards.ts, components/rfid/CardModals.tsx (Assign, Action, Label modals).
- Cards are drawn as NGA student IDs (CardBits.tsx CardFace): NGA red band (#e63c2d) with the shield
  (client/public/nga-logo.png, copied from Central MIS frontend/src/assets/logo.png), "NGA Coding Academy" (name used in
  the MIS reports), photo slot with initials, name, class, card no., UID, barcode footer; stamped when lost/disabled.
- Magic MCP was unreachable (timeout), so it was hand-built on the design system.

## Progress
- [x] Timetable cache `timetable_slots` from MIS `/integrations/sync/academics` calendarSlots. Subjects, terms and years
      come from `/integrations/sync/reference` (the `misDate` fix handles timezone-shifted MySQL DATEs).
- [x] `timetable.service.ts`, `closing.service.ts` (30 s tick, `rfid_closed_registers`), `ingest.service.ts`, routes:
      `/api/rfid/today` and `/api/rfid/days-off`.
- [x] Check-in Sessions (windows/occurrences) REMOVED everywhere, along with permission CHECKIN_SESSIONS_MANAGE.
- [x] UI: Attendance → **Attendance Cards** (`/attendance/cards`, admin), with tabs Today (+ day off) / Cards /
      Unregistered / Scan log / Scanners. UIDs are shown as `79:43:01:04`.
- [x] Supabase bridge uses SUPABASE_SERVICE_KEY. Polls every 2 s in school hours and every 10 s otherwise. The page shows a
      "Scanner feed: Live / Not live" bar (server-decided, `/api/rfid/bridge/status`) with the last tap.
- [x] Verified with the real ESP on 2026-09-25: card 1D:FC:FF:03 tapped twice and was ingested as unknown_card within seconds.
      Local MIS sync: 14 students, Year 1 (class 9), 16 lessons Mon–Thu. MIS has no term covering 2026-09-25 (Term 3
      ends 2026-08-30), so taps can't mark anything until the MIS gets current term dates.
- [ ] Teacher-facing work: OUT OF SCOPE (the user said so). Don't build it.
- [ ] Security: anon can SELECT `rfid_scans` + `students` in Supabase. Write RLS SQL (anon INSERT-only on
      rfid_scans, no access to students) once the user confirms no other app reads with anon.
- [ ] The user should rotate the Supabase secret key (it was pasted in chat), then update server/.env and deploy secrets.
- [ ] Deploy: add SUPABASE_URL / SUPABASE_SERVICE_KEY to deploy.yml's .env block, and to GitHub secrets.

## Working Notes
- server/.env (git-ignored) has SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_KEY. Never put them in VITE_ vars.
- Supabase: `rfid_scans(id, uid 'xx:xx:xx:xx', device 'ESP32', scanned_at = insert time)`. `students` there is a
  5-row test list, not a Tendo source. The bridge's first run skips existing rows (SUPABASE_BRIDGE_START=all to import).
- The MIS accepts Tendo's SSO client_id:secret as Basic auth for `/integrations/sync/*`, so no extra token is needed.
- Headless screenshot harness: scratchpad `rfid-smoke/shot.mjs`. Run with `MSYS_NO_PATHCONV=1`, since Git Bash
  mangles `/paths`. Git Bash's `TZ=Africa/Kigali date` prints UTC; don't trust it.
- Risk: everything depends on class timetables in the MIS being complete for the current term. Check the
  "timetables for N classes" figure in the page's roster banner after the first real sync.

## Recently Completed
- 2026-09-25: Card attendance reworked to follow each class timetable; sessions removed; Attendance Cards page.
- 2026-09-25: Supabase bridge live-verified; teacher UI dropped from scope.
- 2026-09-25: RFID card backend + admin pages (branch feat/rfid-attendance, uncommitted).
- 2026-09-15: Save-register FK failure fixed — subject cache self-heals on save.
