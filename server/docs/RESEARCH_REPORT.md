# NGA Discipline & Attendance System — Research Report

**Scope:** Deep structural analysis of the existing `nga-discipline-attendance` service and a requirements/domain research pass covering the two functional pillars — **Attendance** and **Discipline** — plus their shared **Reporting** layer, in preparation for a refactor.

**Author context:** Prepared as an engineering research report to feed a subsequent implementation plan. Not a spec for the current code — a diagnosis plus a target state.

---

## 1. Executive Summary

`nga-discipline-attendance` is a satellite Express/SQLite service that authenticates against an external system of record, **`nga_central_mis`** (via SSO token exchange), and records attendance and discipline events locally. Structurally, the service works, but it was built **route-first, not domain-first**: every route file owns its own SQL, validation, and business logic, there is no service/repository layer, and — critically for this task — **none of the three organizing concepts the business actually needs (subject-level attendance, teacher-subject-calendar attendance, and a discipline rules catalog) are modeled in the schema at all.** The RBAC subsystem is the one genuinely mature part of the codebase and should be preserved and extended, not rebuilt.

The requested feature set (A.1–A.3, B.0–B.4, C) is achievable without a rewrite, but it requires:

1. Introducing a proper **service/repository layer** (breaking the "everything in the route handler" pattern).
2. Adding **first-class local entities** for Academic Year/Term, Subject, Class-Subject-Teacher assignment (timetable), and a **Discipline Rule catalog** — currently these are either missing entirely or borrowed opportunistically from the MIS proxy with no local join key.
3. Splitting the current single `attendance_records` table into **class-session attendance** vs **subject/course attendance**, since today's schema conflates them under a `period` free-text column.
5. A **term-scoped ledger model** for discipline marks (running balance per student per term, not just a flat list of events), to satisfy B.0 and B.3 cleanly.
6. A consolidated **reporting/analytics module** that reads from both domains instead of `reports.ts` and `discipline.ts` each maintaining separate ad hoc aggregation queries.

---

## 2. Current System — What Actually Exists

### 2.1 Topology

```
nga_central_mis  (system of record: Students, Staff, ClassGroup, Grade, Program,
                   AcademicYear, AcademicTerm, StudentClassGroup,
                   StudentSubjectEnrollment, Role/Permission, SSO)
        │  SSO code exchange + bearer-token-forwarded roster proxy
        ▼
nga-discipline-attendance (satellite service)
   server/  Express 4 + raw sqlite/sqlite3, JWT session, local RBAC, SQLite file DB
   client/  React 19 + react-router-dom 7, no state/data-fetching library
```

This split is architecturally reasonable — the discipline/attendance domain genuinely is a bounded context distinct from the central MIS's enrollment/curriculum domain — but the boundary has been drawn **too aggressively**: the satellite service has no local cache/join table for the roster entities it depends on every single request (students, classes, subjects, academic terms), so it cannot express relationships like "attendance record → subject" or "discipline rule → category" without free-text duplication.

### 2.2 Server-side structure

```
server/src/
  database.ts        # all schema DDL + additive migrations + RBAC seed, run on boot
  routes/             # 11 files, ~2,400 lines combined — route + validation + SQL + business logic
  middleware/auth.ts, authorize.ts   # JWT verification + RBAC (well-built)
  utils/conduct.ts, notifier.ts, academicPeriod.ts, misAcademics.ts
```

There is **no `controllers/`, `services/`, `models/`, or `repositories/` directory**. Each route handler in `attendance.ts` and `discipline.ts` independently: validates its payload by hand (no Zod/Joi/express-validator), opens a transaction, writes raw SQL, triggers a notification side-effect, and best-effort writes an audit-log row — all inline, all duplicated between the two modules (`triggerLowAttendanceCheck` and `triggerConductCheck` are near-parallel reimplementations of "write → notify → escalate → audit"). Pagination/filter query-building is copy-pasted across `attendance.ts`, `discipline.ts`, `staff.ts`, `reports.ts`, and `admin.ts` with no shared helper, and default/max page sizes are inconsistent across endpoints for no functional reason.

The database layer is raw `sqlite`/`sqlite3` with no ORM and no migration framework — schema evolution happens via `ALTER TABLE ... ADD COLUMN` statements guarded by `PRAGMA table_info` checks, executed unconditionally on every server boot. This works at the current scale but has no rollback story and no way to express relational constraints beyond `CHECK` on enum-like text columns.

### 2.3 Data model — what's actually in the database

Confirmed directly against the live `attendance.db` (`sqlite3 .schema`):

| Table | Purpose | Notable gaps |
|---|---|---|
| `attendance_records` | One row per student/class/date/period | No `subject_id`; `period` is free text; `student_id`/`class_id` have **no FK** — by explicit design comment, since those entities live in the MIS |
| `staff_attendance` | Clock in/out per staff/day | No distinction between "has subjects" vs "no subjects" staff — same table, same status logic for a teacher and an administrator |
| `discipline_records` | One row per merit/demerit event | `category` is free text validated only in app code (`utils/conduct.ts` constants) — **no rules catalog table, no per-rule fine/point value in the DB, no rule ID** |
| `excuse_requests` | Student-submitted absence excuses | No link to a specific `attendance_records` row — matched by student/class/date at query time |
| `users`, `roles`, `permissions`, `role_permissions` | Local identity cache + full RBAC | Well-designed; `role_permission_seed_log` prevents seed drift |
| `audit_log` | Actor/action/entity/details | Present but only "best-effort" — several write paths swallow audit failures |
| `notifications`, `notification_outbox` | In-app + external notification queues | `user_id = 'all'` broadcast sentinel and reused `type: 'system'` are brittle string conventions |

**The two gaps that matter most for this task:**

- **No Academic Year/Term entities locally.** `academic_year_id`/`academic_term_id` are bare nullable integers bolted on via later migrations. Every list/detail query across 4+ route files has to defensively `OR academic_term_id IS NULL` to stay backward-compatible with pre-migration rows. This is the wrong foundation for B.0 ("discipline marks grouped in academic year and terms, each term has its own history") — right now that grouping is an afterthought, not a first-class dimension.
- **No Discipline Rules catalog.** `category`, `severity`, and `points` are validated against hardcoded TypeScript constants (`server/src/utils/conduct.ts`), not a database table. There is no way for an admin to add a new rule, attach a fine amount, retire a rule, or version a rule's point value across terms without a code deploy. This directly blocks B.1 and complicates B.2 (permission-gated point adjustment needs something to *point at*).

### 2.4 Client-side structure

React 19 app, 20+ pages, only **one custom hook** (`usePermissions`), **no API service layer** — 21 of ~23 page files call `fetch()` directly, several reimplementing their own `authHeaders()` helper, all assuming the same untyped `{success, data}` response envelope. The largest pages (`Dashboard.tsx` 343 lines, `LogIncident.tsx` 318, `RolesPermissions.tsx` 300) mix data-fetching, filter/pagination state, and presentation in one file. `AuthContext.tsx` and `usePermissions` are the one bright spot — permission gating is centralized and consistent, mirroring the server's RBAC model.

### 2.5 Auth & RBAC (the strong part)

Two-layer model: SSO-derived JWT for authentication, plus a genuinely well-built RBAC system for authorization — three system roles (`Student`/`Teacher`/`Admin`) with a `level`, custom-role support, ~25 granular permission keys (`ATTENDANCE_MARK`, `DISCIPLINE_REVIEW`, `USERS_MANAGE`, etc.), and three composable middleware patterns (`authorizePermission`, `authorizeAllPermissions`, `selfOrPermission`). This is the piece to **extend**, not replace, when adding the granular "any staff with permission can adjust a specific rule's points" requirement in B.2.

---

## 3. Requirements Deep-Dive

### A. Attendance

**A.1 Student attendance — two distinct views, one currently-conflated schema**

| Sub-requirement | What it needs |
|---|---|
| A.1.1 Overall attendance by class/grade group, per academic period, per teacher | A **class-session** attendance record: "was this student physically present for this class group on this day" — homeroom/registration-style, one mark per student per day (or per session block), attributable to the teacher who took it. |
| A.1.2 Course/subject attendance by subject + class group, per academic period, per teacher | A **subject-session** attendance record: "was this student present for *this subject's* period on this day" — requires a `subject_id`, tied to the specific timetable slot, attributable to the subject teacher. |

Today's single `attendance_records` table with a free-text `period` column cannot cleanly distinguish these two without inferring meaning from a string. Research into attendance-system schema design (see §4) consistently recommends modeling attendance as **many-to-many between Student and Session**, where a "Session" is itself typed (homeroom-day vs subject-period) and carries its own teacher/subject/class-group foreign keys — i.e., **attendance should reference a timetable/session entity, not duplicate class/subject context inline on every row.**

**A.2 Teacher attendance — calendar/subject-driven, not a flat clock-in**

The requirement is explicit: teacher attendance is *derived from their assigned-subject calendar*, daily. This is fundamentally different from generic staff clock-in — it implies a **teacher-subject-timetable** entity already needs to exist (for A.1.2 anyway), and teacher "attendance" for a given day is really "did the teacher deliver each of their scheduled subject sessions," which can be partially inferred from whether they submitted subject-attendance for that session, plus an explicit clock-in/out for presence-on-campus. The current `staff_attendance` table (a flat daily clock-in/out) is a reasonable building block for the "on campus" half but has no link to the subject-calendar half at all.

**A.3 Other staff (no subjects) — simple daily attendance**

This is close to what `staff_attendance` already does today, and should remain the simplest of the three attendance types. The main gap is that it's currently undifferentiated from teacher attendance in the schema/route — there's no `staff_type` or role-derived branching, so reporting can't cleanly separate "teachers without a subject session today" from "admin/support staff daily attendance."

### B. Discipline

**B.0 Term-scoped history** — Discipline is not just an event log; it needs a **ledger view**: for a given student + academic year + term, what's their running point balance, and what's the full event trail that produced it? This is a reporting/aggregation requirement layered on top of the event table, and it depends entirely on B.0's prerequisite — real Academic Year/Term entities (§2.3 gap) — being in place first.

**B.1 Rules directory** — Needs a genuine catalog table: rule name, category, description, default point value (demerit) or merit value, an optional monetary fine, active/inactive status, and versioning (so a rule's point value can change between terms without rewriting history). This is the single highest-leverage schema addition in the whole plan — it turns `category`/`severity`/`points` from hardcoded app constants into governable, admin-editable data, and gives every discipline record a stable foreign key to hang reporting off of.

**B.2 Permission-gated point adjustment by any staff** — The RBAC system already supports this pattern generically (`authorizePermission('DISCIPLINE_LOG')` etc.); what's missing is that adjustments should be recorded as **discrete ledger entries referencing a rule**, not free-text edits to a record's `points` field, so the audit trail is inherently correct (see §4's audit-trail research: append-only, previous/new value, actor, reason).

**B.3 Student self-view of remaining marks per term** — A direct read of the B.0 ledger view, scoped to `self`, already achievable with the existing `selfOrPermission` middleware pattern once the term-scoped balance exists.

**B.4 Staff analytics — student/class/grade/program statistics** — Needs aggregation queries across the (now-linked) rule catalog, term ledger, and roster hierarchy (student → class group → grade → program) that the MIS already models (`ClassGroup`, `Grade`, `Program`, `StudentClassGroup` all exist centrally). Today `discipline.ts`'s `/overview` endpoint does a version of this already (totals, trends, top offenders) — it's a reasonable starting point to generalize, not a green-field build.

### C. Reporting

Termly/annual attendance and discipline analytics, a **combined** report, and **term-over-term comparison** are all aggregation/read-model concerns that should live in one reporting module reading from the (post-refactor) attendance and discipline ledgers plus the MIS roster hierarchy — not scattered between `reports.ts` and `discipline.ts` as two unrelated analytics implementations, which is the current state.

---

## 4. External Research Findings

Research into SIS/attendance/discipline system design converged on a small number of consistent, cross-source recommendations directly applicable here:

- **Attendance as a Student↔Session relationship, not a flat table with denormalized context.** Attendance is naturally a many-to-many between students and timed sessions; a composite/lookup key (student, session) with a status enum is the standard shape, and the "session" side should itself be a typed, queryable entity (so homeroom vs subject sessions are distinguishable) rather than a string column. — [Attendance Management System ERD](https://itsourcecode.com/uml/attendance-management-system-erd-entity-relationship-diagram/), [Relational DB design for timetables/attendance](https://dev.to/pocharis/relational-database-design-to-store-university-timetables-and-record-of-students-attendance-3jg4)
- **Academic year/term must be modeled so historical data survives year rollover** without being overwritten or losing prior-year linkage — exactly the gap identified in §2.3. — [Student Management System DB Architecture Guide](https://openeducat.org/articles/student-management-system-database-guide/)
- **Referential integrity via real foreign keys**, not denormalized text duplication, is repeatedly flagged as the difference between a schema that scales and one that silently drifts. This directly supports replacing `student_name`/`class_name` copy-fields with FK-only local caches synced from the MIS. — [Student DB System design](https://www.researchgate.net/publication/272393985_Design_of_Student_Information_Management_Database_Application_System_for_Office_and_Departmental_Target_Responsibility_System)
- **Demerit/merit point systems in practice** are structured as a **starting balance per term** (commonly 100), with a **discipline-code catalog** where each code has a fixed point deduction/addition and its own severity tier — validating the B.1 rules-catalog + B.0 term-ledger design directly, rather than inventing a bespoke model. — [Demerit (school discipline) — overview](https://en.wikipedia.org/wiki/Demerit_(school_discipline)), [Rediker AdminPlus: discipline codes](https://docs.rediker.com/adminplus/set-up-discipline-codes-to-subtract-merits-from-demerits-or-demerits-from-merits-329955.html)
- **RBAC with role hierarchy + per-permission route guards** is the standard, proven pattern for Node/Express school systems with Admin/Teacher/Student tiers — which is exactly what this codebase already has; research confirms this subsystem should be **extended** (new permission keys for rule-management, ledger-adjustment) rather than replaced. — [RBAC in Node.js/Express](https://medium.com/@jayantchoudhary271/building-role-based-access-control-rbac-in-node-js-and-express-js-bc870ec32bdb), [Secure web-based school MIS with RBAC (case study)](https://journals.ust.edu/index.php/JST/article/view/3194)
- **Audit trails for point/permission adjustments should be append-only**, recording actor, timestamp, entity, previous value, new value, and reason — the current `audit_log` table has the right shape but is treated as best-effort/optional in several write paths; it should become a mandatory side-effect of every ledger-affecting write, ideally inside the same transaction. — [Audit trail design principles](https://www.isolvedhcm.com/glossary/audit-trail), [GxP audit trail (who/what/when/why)](https://sgsystemsglobal.com/glossary/audit-trail-gxp/)
- **Feature-based modular-monolith structure** (routes/controller/service/repository per domain module, e.g. `/modules/attendance`, `/modules/discipline`) is the current consensus pattern for mid-size Node/Express systems that aren't ready for microservices but have outgrown flat route files — directly applicable to breaking up the current `routes/*.ts`-only structure. — [Modular monolith structuring](https://dev.to/shieldstring/how-to-structure-a-modular-monolith-110o), [Express.js project structure for scale](https://oneuptime.com/blog/post/2026-02-02-express-project-structure/view)
- **Dashboards should be built around a small set of comparison-oriented KPIs** (attendance %, discipline point trend, term-over-term deltas) rather than raw data dumps, with attendance and behavior metrics integrated into one view so leadership can spot combined patterns (e.g., discipline spikes correlating with attendance drops) — directly supports the "combined report" requirement in C. — [K-12 data dashboard design](https://www.solvedconsulting.com/blog/unlocking-real-time-school-data-insights-with-a-k-12-data-dashboard), [School performance dashboard examples](https://www.boldbi.com/dashboard-examples/education/school-performance-dashboard/)

---

## 5. Gap Analysis Matrix

| Requirement | Current support | Gap |
|---|---|---|
| A.1.1 Overall class attendance by grade group/teacher/term | Partial — `attendance_records` exists | No clean class-group/grade rollup; no term-scoped view beyond raw filter |
| A.1.2 Subject/course attendance | **Not modeled** | No `subject_id` on attendance; `period` is a free-text stand-in |
| A.2 Teacher attendance from subject calendar | **Not modeled** | No timetable/teacher-subject-assignment entity; `staff_attendance` is undifferentiated clock-in |
| A.3 Other staff daily attendance | Supported | Needs to be split from teacher attendance logically (staff type) |
| B.0 Term-scoped discipline history | Partial | `academic_term_id` exists but nullable/bolted-on; no ledger/balance view |
| B.1 Rules directory with fines | **Not modeled** | Categories are hardcoded TS constants, not a DB table; no fine field |
| B.2 Permission-gated point adjustment | RBAC exists, adjustment model doesn't | Adjustments aren't first-class ledger entries tied to a rule |
| B.3 Student self-view of remaining marks | Achievable today with existing middleware | Needs the term-ledger read model from B.0 |
| B.4 Staff analytics across student/class/grade/program | Partial (`/discipline/overview`) | Needs generalization + roster-hierarchy joins via MIS |
| C. Termly/annual, combined, comparison reports | Partial (`reports.ts`, `/discipline/overview` separately) | No unified reporting module; no combined attendance+discipline view; no term comparison |

---

## 6. Recommendations Summary (detail in Implementation Plan)

1. Introduce a **service + repository layer** per domain module (attendance, discipline, reporting), ending the "SQL in route handlers" pattern.
2. Promote **Academic Year/Term**, **Subject**, **Class-Subject-Teacher assignment (timetable)**, and **Discipline Rule** to first-class local tables with real foreign keys, synced/cached from `nga_central_mis` where they originate there.
3. Split attendance into **session-typed records** (`homeroom` vs `subject`) sharing one table shape but a `session_type` + `subject_id` (nullable for homeroom) discriminator — avoiding a full table split while fixing the conflation.
4. Model discipline as an **event table + per-term ledger/balance view**, with every event referencing a `rule_id`.
5. Build one **reporting module** serving termly/annual/combined/comparison views, replacing the two parallel ad hoc analytics implementations.
6. Preserve and extend the existing RBAC — it is the strongest part of the system.
7. Add a client-side **API service layer** and extract shared list/filter/pagination hooks, mirroring the server-side de-duplication.
