# NGA Discipline & Attendance System — Implementation Plan

Companion document to [`RESEARCH_REPORT.md`](./RESEARCH_REPORT.md). This plan is scoped to be executed incrementally against the live system — no rewrite, no downtime migration that can't be rolled back.

---

## 1. Guiding Principles

1. **Extend, don't replace, the RBAC and SSO subsystems** — they're the strongest part of the codebase.
2. **Additive schema changes only** — new tables plus new nullable/discriminator columns, following the project's existing `ALTER TABLE` migration convention in `database.ts`, never destructive drops until an old path is confirmed unused.
3. **One domain = one module** — `attendance`, `discipline`, `reporting`, `roster-cache` each get their own `routes/service/repository` slice; no cross-module SQL.
4. **The MIS stays the source of truth for roster/curriculum data** (students, staff, classes, subjects, enrollment, base academic calendar). This service **caches**, it doesn't duplicate ownership.
5. **Every ledger-affecting write is atomic with its audit-log row** — no more best-effort audit writes for discipline/attendance mutations.

---

## 2. Target Architecture

```
server/src/
  modules/
    attendance/
      attendance.routes.ts
      attendance.service.ts       # business rules: session validation, low-attendance checks
      attendance.repository.ts    # all SQL for attendance_records
      attendance.types.ts
    discipline/
      discipline.routes.ts
      discipline.service.ts       # ledger math, rule lookups, conduct scoring
      discipline.repository.ts    # discipline_records + discipline_rules + term ledger queries
      discipline.types.ts
    roster-cache/
      roster.service.ts           # syncs/caches Student, ClassGroup, Subject, AcademicYear/Term from MIS
      roster.repository.ts
    reporting/
      reporting.routes.ts
      reporting.service.ts        # termly/annual/combined/comparison aggregations
  shared/
    pagination.ts                 # one clamp/offset helper, replaces 5 duplicated implementations
    query-builder.ts              # shared WHERE-clause builder for filtered list endpoints
    validation.ts                 # Zod schemas per module (adds a validation library)
    audit.ts                      # writeAudit() wrapper used inside every mutating transaction
  middleware/  (unchanged: auth.ts, authorize.ts)
  routes/sso.ts, admin.ts, settings.ts, notifications.ts, rolesPermissions.ts  (unchanged, or thin re-export)
```

This mirrors the "feature-based modular monolith" pattern (routes → controller/service → repository per bounded module) validated in the research pass, and is a natural fit for the existing Express/SQLite stack without introducing microservices complexity the team doesn't need yet.

**Client mirror**: add `client/src/api/` (one typed client per module: `attendanceApi.ts`, `disciplineApi.ts`, `reportingApi.ts`, wrapping `fetch` + the `sso_token` header + the `{success,data}` envelope once), and extract `useListQuery`-style hooks for the repeated filter/paginate/fetch pattern currently copy-pasted across `AttendanceRecords`, `DisciplineRecords`, `ExcuseReview`, `LeaveRequests`.

---

## 3. Data Model Changes

### 3.1 New: Academic Year / Term cache (local, synced from MIS)

```sql
CREATE TABLE academic_years (
  id INTEGER PRIMARY KEY,        -- mirrors MIS AcademicYear.id
  name TEXT NOT NULL,
  start_date DATE, end_date DATE,
  is_current INTEGER NOT NULL DEFAULT 0,
  synced_at DATETIME
);

CREATE TABLE academic_terms (
  id INTEGER PRIMARY KEY,        -- mirrors MIS AcademicTerm.id
  academic_year_id INTEGER NOT NULL REFERENCES academic_years(id),
  name TEXT NOT NULL,            -- "Term 1", "Term 2", ...
  start_date DATE, end_date DATE,
  is_current INTEGER NOT NULL DEFAULT 0,
  synced_at DATETIME
);
```

Populated by a `roster.service.ts` sync job (pull from `/api/academics/years|terms`, upsert). This turns `attendance_records.academic_term_id` / `discipline_records.academic_term_id` from bare nullable ints into **real foreign keys**, closing the single biggest gap from §2.3 of the research report. Migration: backfill existing rows by matching `session_date`/`incident_date` against the cached term date ranges; anything unmatched stays NULL and is reported to admins as a one-time cleanup list rather than silently dropped.

### 3.2 New: Subject + Class-Subject-Teacher assignment (timetable) cache

```sql
CREATE TABLE subjects (
  id INTEGER PRIMARY KEY,        -- mirrors MIS subject id
  name TEXT NOT NULL,
  code TEXT,
  synced_at DATETIME
);

CREATE TABLE class_subject_assignments (   -- "who teaches what, to which class group, when"
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  class_group_id TEXT NOT NULL,   -- MIS ClassGroup id (kept as TEXT to match existing class_id convention)
  subject_id INTEGER NOT NULL REFERENCES subjects(id),
  teacher_id TEXT NOT NULL,       -- MIS staff id
  academic_term_id INTEGER NOT NULL REFERENCES academic_terms(id),
  day_of_week INTEGER,            -- 0-6, nullable if MIS schedule is date-based instead
  period TEXT,                    -- period/slot label from MIS CalendarSlot
  synced_at DATETIME,
  UNIQUE(class_group_id, subject_id, academic_term_id, day_of_week, period)
);
```

This is the entity A.1.2 and A.2 both depend on. Sourced from the MIS `/api/mis/schedule` proxy (already exists in `mis.ts`) — extend that proxy to also **cache** results here on read (write-through cache), rather than only forwarding.

### 3.3 Changed: `attendance_records` — session-type discriminator

```sql
ALTER TABLE attendance_records ADD COLUMN session_type TEXT
  CHECK(session_type IN ('homeroom','subject')) DEFAULT 'homeroom';
ALTER TABLE attendance_records ADD COLUMN subject_id INTEGER REFERENCES subjects(id);
```

- `session_type = 'homeroom'` → A.1.1 (overall class attendance), `subject_id` NULL.
- `session_type = 'subject'` → A.1.2 (course attendance), `subject_id` required, `class_id` still present (which class group took the subject).

Update the existing `UNIQUE(student_id, class_id, session_date, period)` constraint to `UNIQUE(student_id, class_id, session_date, session_type, subject_id, period)` so a student can have both a homeroom mark and a subject mark on the same day without collision.

### 3.4 Changed: `staff_attendance` — staff-type discriminator

```sql
ALTER TABLE staff_attendance ADD COLUMN staff_type TEXT
  CHECK(staff_type IN ('teacher','other')) DEFAULT 'other';
```

Derived at write time from whether the staff member has any row in `class_subject_assignments` for the current term. For teachers, the reporting layer additionally computes a **derived delivery rate**: scheduled subject-sessions for the day vs. subject-attendance actually submitted by that teacher (A.2's "depends on their subject calendar" requirement) — this is a *read-model* computation in `reporting.service.ts`, not a new write path, to avoid a second source of truth for "did the teacher show up."

### 3.5 New: Discipline Rules catalog (B.1)

```sql
CREATE TABLE discipline_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL CHECK(type IN ('demerit','merit')),
  category TEXT NOT NULL,          -- replaces the hardcoded DEMERIT_CATEGORIES/MERIT_CATEGORIES
  title TEXT NOT NULL,
  description TEXT,
  default_points INTEGER NOT NULL,
  fine_amount DECIMAL(10,2) DEFAULT 0,
  severity TEXT,                   -- minor/moderate/major or small/notable/outstanding
  is_active INTEGER NOT NULL DEFAULT 1,
  created_by TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE discipline_rule_versions (   -- lets a rule's point value change between terms
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_id INTEGER NOT NULL REFERENCES discipline_rules(id),
  academic_term_id INTEGER REFERENCES academic_terms(id),  -- NULL = applies until superseded
  points INTEGER NOT NULL,
  fine_amount DECIMAL(10,2),
  effective_from DATE NOT NULL
);
```

Seed this table from the current `utils/conduct.ts` constants as a one-time migration script (each existing category/severity combination becomes one row), so behavior is unchanged on day one — the catalog becomes editable going forward without a deploy.

```sql
ALTER TABLE discipline_records ADD COLUMN rule_id INTEGER REFERENCES discipline_rules(id);
```

Kept nullable for backward compatibility with historical rows (which predate the catalog); new writes always set it. `category`/`severity`/`points` columns stay on `discipline_records` as a **snapshot at time of recording** (so a later rule-value change doesn't rewrite history) — this mirrors the "previous/new value" audit-trail principle from the research pass.

### 3.6 New: Discipline term ledger (view, not a table)

```sql
CREATE VIEW discipline_term_balance AS
SELECT student_id, academic_year_id, academic_term_id,
       SUM(CASE WHEN type='merit' THEN points ELSE -points END) AS net_points,
       COUNT(*) AS event_count
FROM discipline_records
WHERE status != 'dismissed'
GROUP BY student_id, academic_year_id, academic_term_id;
```

Satisfies B.0 (per-term history) and B.3 (student's remaining marks) as a pure read, with no new write path or dual-bookkeeping risk. If a starting-balance-per-term model (e.g., "start at 100, deduct down") is wanted instead of a pure net-points model, add a `term_starting_balance` config table read alongside this view — defer until the business confirms which framing (accumulate-demerits vs. deduct-from-100) matches actual school policy; **flag this as an open question for stakeholder confirmation**, since research shows both models are common in practice.

### 3.7 Audit trail hardening

Wrap every ledger-affecting write (`attendance mark`, `discipline log/adjust`, `rule create/update`) in a single transaction that includes its `audit_log` insert — currently several paths treat the audit write as best-effort/fire-and-forget. Add `previous_value`/`new_value` JSON columns to `audit_log` for point-adjustment actions specifically, per the audit-trail research findings.

---

## 4. API Changes

| New/changed endpoint | Purpose |
|---|---|
| `GET/POST/PUT /api/discipline/rules` | Rules catalog CRUD (B.1) — permission `DISCIPLINE_RULES_MANAGE` |
| `POST /api/discipline/:id/adjust` | Explicit point adjustment as a new ledger entry referencing a `rule_id` and reason, replacing ad hoc edits to `points` (B.2) |
| `GET /api/discipline/term-balance/me` | Student's own remaining marks for the current (or specified) term (B.3) |
| `GET /api/discipline/stats?scope=student|class|grade|program` | Generalizes today's `/overview` into parameterized roster-hierarchy stats (B.4) |
| `POST /api/attendance/mark` (changed) | Adds required `session_type` + optional `subject_id` in payload |
| `GET /api/attendance/subject/:subjectId` | Subject/course attendance list, filtered by class group + term (A.1.2) |
| `GET /api/staff/teachers/:id/delivery` | Derived "scheduled vs. delivered" subject-session rate for a teacher/day (A.2) |
| `GET /api/reporting/termly`, `/annual`, `/combined`, `/compare` | New unified reporting module (C) |
| `GET /api/mis/schedule` (changed) | Now write-through caches into `class_subject_assignments` on each successful call |

All new endpoints follow the existing `authorizePermission`/`selfOrPermission` middleware pattern — no new auth mechanism needed, only new permission keys added to `constants/permissions.ts` (`DISCIPLINE_RULES_MANAGE`, `DISCIPLINE_ADJUST`, `REPORTING_VIEW_CLASS`, `REPORTING_VIEW_GRADE`, `REPORTING_VIEW_ALL`, etc.), seeded to the default roles the same way current permissions are.

---

## 5. Phased Rollout

**Phase 0 — Foundations (no behavior change)**
- Add `shared/pagination.ts`, `shared/query-builder.ts`, `shared/audit.ts`; introduce Zod for validation.
- Extract existing route logic into `service`/`repository` files per module *without changing behavior* — pure refactor, covered by adding the first tests (none exist today).
- Add `client/src/api/` typed clients; migrate pages to use them incrementally (start with the 3 largest: `Dashboard`, `LogIncident`, `RolesPermissions`).

**Phase 1 — Academic Year/Term as first-class data (unblocks B.0)**
- Add `academic_years`/`academic_terms` tables + sync job.
- Backfill `academic_year_id`/`academic_term_id` on existing rows.
- Switch all `OR academic_term_id IS NULL` query escape hatches to a real FK join once backfill is verified complete.

**Phase 2 — Discipline rules catalog (unblocks B.1, B.2)**
- Add `discipline_rules`/`discipline_rule_versions`; seed from `utils/conduct.ts`.
- Add `rule_id` to `discipline_records`; update log/bulk-log endpoints to require a `rule_id` going forward (category/severity/points auto-populated from the rule, still stored as a snapshot).
- Build the rules-catalog admin UI page + `/discipline/rules` endpoints.
- Add `/discipline/:id/adjust` and the term-balance view/endpoint (B.0, B.3).

**Phase 3 — Subject-level attendance + teacher subject calendar (unblocks A.1.2, A.2)**
- Add `subjects`/`class_subject_assignments`, write-through cache from `/api/mis/schedule`.
- Add `session_type`/`subject_id` to `attendance_records`; update `/attendance/mark` and client `MarkAttendance` page to select homeroom vs. subject mode.
- Add teacher delivery-rate derived endpoint; extend `staff_attendance` with `staff_type`.

**Phase 4 — Unified reporting module (unblocks B.4, C)**
- Build `reporting.service.ts` combining attendance + discipline + roster-hierarchy (student → class group → grade → program, via MIS-sourced `class_subject_assignments`/roster cache).
- Termly, annual, combined, and term-comparison views; retire the separate `reports.ts`/`discipline.ts` `/overview` implementations in favor of this module (keep old routes as thin wrappers during transition to avoid breaking the client until it's migrated).
- Client: new `Reports`/`Analytics` pages consuming the unified API, following the dashboard-design research (small set of comparison-oriented KPIs, not raw dumps).

**Phase 5 — Cleanup**
- Remove now-dead `OR ... IS NULL` clauses, deprecated `/discipline/overview` and old `reports.ts` routes once client migration is confirmed complete.
- Backfill test coverage for the new service layer (none exists today — this is the first opportunity to establish a baseline, focused on the service layer's business logic rather than route wiring).

---

## 6. Open Questions for Stakeholder Confirmation

1. **Discipline balance model**: net-points-per-term (can go negative) vs. starting-balance-per-term (e.g., start at 100, floor at 0)? Affects §3.6 design and the student-facing "remaining marks" wording.
2. **Fine collection**: is `fine_amount` on a rule purely informational/reporting, or does it need to integrate with a finance/payments module (none currently exists in this service)?
3. **Homeroom vs. subject attendance weighting**: does "overall attendance" (A.1.1) get computed independently from subject attendance, or should it be *derived* as an aggregate of the student's subject attendance for the day? This determines whether Phase 3's `session_type='homeroom'` records are teacher-entered directly or system-computed.
4. **Teacher delivery-rate semantics** (A.2): should a missed subject-attendance submission count as the teacher being "absent" for reporting purposes, or only an explicit clock-in/out absence? Needed before building the derived endpoint in Phase 3.

These should be resolved before Phase 2/3 schema work begins, since they affect column defaults and view definitions, not just UI copy.
