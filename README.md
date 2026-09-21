# NGA Attendance System (SSO Integrated)

> **Setting this up on your machine?** Start with **[LOCAL_SETUP.md](LOCAL_SETUP.md)** — it covers the whole local stack, including the Central MIS sign-in every module depends on.

This is the attendance management system for NGA Central MIS. It integrates using standard OAuth2 Single Sign-On (SSO) with the NGA MIS login portal.

---

## 🛠 Features

- **SSO Authentication**: Login with NGA Central MIS account. Supports automatic theme synchronization (`preferred_theme`).
- **Student Attendance Checksheets**: Teachers select classes, set dates, and mark student presence (Present, Absent, Late, Excused) with optional session notes.
- **Attendance History Log**: Full filtering sheets (class name, search, date range) and JSON export support.
- **Staff Duty clock**: Teachers and admins can clock-in and clock-out daily shifts, with auto-evaluation of late status.
- **Analytics Reports**: Aggregates presence rates, logs counts, and trends graph.
- **School Directory**: Access lists of active students and staff synchronized from the NGA Central MIS.
- **Dark Mode**: High-fidelity dark mode matching the NGA MIS design language.

---

## 🚀 Quick Start

### 1. Prerequisites

Make sure you have Node.js (v20+) and npm installed.

### 2. Configure Environment variables

```bash
cp client/.env.example client/.env
cp server/.env.example server/.env
```

Then fill in `SSO_CLIENT_SECRET` in `server/.env` (issued by the MIS admin — ask the
maintainer) and pick any long random `JWT_SECRET`. You sign in with your NGA MIS
account; the SQLite database is created automatically on first run.

#### Frontend Client Configuration (`client/.env`):
```ini
VITE_MIS_LOGIN_URL=https://mis.amashuri.com/login
VITE_SSO_CLIENT_ID=your_client_id
VITE_API_BASE_URL=/api
```

#### Backend Server Configuration (`server/.env`):
```ini
PORT=5171
NGA_MIS_BASE_URL=https://api.amashuri.com
SSO_CLIENT_ID=your_client_id
SSO_CLIENT_SECRET=your_client_secret
JWT_SECRET=your_jwt_secret_phrase
DATABASE_PATH=./data/attendance.db
```

### 3. Install & Run

From the root directory of this repository:

```bash
# Install dependencies for both frontend and backend
npm run install:all

# Run both client (port 3000) and server (port 5171) concurrently
npm run dev
```

The React frontend will open on: **[http://localhost:3000](http://localhost:3000)**.

To build for production:

```bash
npm run build   # builds the server (tsc) then the client (vite build)
npm start --prefix server
```

> **Authentication:** all sign-ins go through the real NGA Central MIS SSO flow.
> Roster data (classes, students, staff, timetables) is read live from the MIS via
> the authenticated proxy in `server/src/routes/mis.ts`; if the MIS exposes these
> under non-default paths, override them with the `MIS_*_PATH` env variables.

---

## 👥 Roles & Access

The NGA Central MIS is **permission-based** — its SSO token returns a
`permissions` array, not an explicit role. This app therefore **derives a role
automatically on every login** from those permissions, so users are classified
without any manual assignment (see `roleFromPermissions` in `server/src/routes/sso.ts`):

| Role | Granted when the user's MIS permissions include… |
| :--- | :--- |
| `admin` | institution management (`MANAGE_USERS`, `MANAGE_ROLES`, `ADMIN`, …) |
| `teacher` | staff capabilities (`MARK_ATTENDANCE`, `MANAGE_DISCIPLINE`, `MANAGE_LESSON`, …) |
| `student` | self-service only (`VIEW_RESULTS`, `VIEW_ATTENDANCE`, `STUDENT_*`, …) |
| `unassigned` | nothing recognizable — an admin assigns the role from **Admin → Users** |

> ⚠️ **For the hosting/lead dev:** the `student` mapping is confirmed against real
> MIS data, but the `teacher`/`admin` keyword lists are a best-effort guess — we
> have not yet seen a teacher's or admin's actual permission strings. Please verify
> the keyword sets in `roleFromPermissions` against the real MIS permission
> vocabulary and adjust as needed.

**Bootstrapping the first admin.** If no MIS account carries app-admin permissions,
set `ADMIN_USERNAMES` and/or `ADMIN_EMAILS` (comma-separated, case-insensitive) in
`server/.env`. Listed accounts are forced to `admin` regardless of their MIS
permissions, so the owner can never be locked out. Leave empty to rely entirely on
MIS permissions.

---

## 🏗 Project Architecture

- **Frontend**: React + Vite + TypeScript. Layout utility grid systems, custom responsive views, CSS custom properties variable sheets.
- **Backend**: Node.js + Express + TypeScript. Route modular files, JWT sessions, role guards, and CORS bindings.
- **Database**: SQLite3. Schema migrations; starts with a clean state (no seed data) — all records originate from real usage.
