import express from 'express';
import cors from 'cors';
import { config } from './config.js';

// Import Route Handlers
import ssoRoutes from './routes/sso.js';
import attendanceRoutes from './routes/attendance.js';
import disciplineRoutes from './routes/discipline.js';
import staffRoutes from './routes/staff.js';
import reportsRoutes from './routes/reports.js';
import notificationsRoutes from './routes/notifications.js';
import adminRoutes from './routes/admin.js';
import settingsRoutes from './routes/settings.js';
import misRoutes from './routes/mis.js';
import academicsRoutes from './routes/academics.js';
import rolesPermissionsRoutes from './routes/rolesPermissions.js';
import disciplineRulesRoutes from './modules/discipline/rules.routes.js';
import subjectAttendanceRoutes from './modules/attendance/subjectAttendance.routes.js';
import scheduleRoutes from './modules/attendance/schedule.routes.js';
import reportingRoutes from './modules/reporting/reporting.routes.js';

/** The Express app, with no side effects (no DB init, no `listen`) — so
 *  tests can import it directly against an in-memory DB via supertest.
 *  Actual startup lives in index.ts. */
export const app = express();

app.disable('x-powered-by');
app.use(cors({
  origin: config.corsOrigins,
  credentials: true,
}));
app.use(express.json({ limit: '200kb' }));

app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

app.use('/api/sso', ssoRoutes);
app.use('/api/attendance', attendanceRoutes);
app.use('/api/attendance', subjectAttendanceRoutes);
app.use('/api/attendance', scheduleRoutes);
app.use('/api/discipline', disciplineRoutes);
app.use('/api/discipline', disciplineRulesRoutes);
app.use('/api/staff', staffRoutes);
app.use('/api/reports', reportsRoutes);
app.use('/api/reporting', reportingRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/roles-permissions', rolesPermissionsRoutes);
app.use('/api/settings', settingsRoutes);

// MIS roster proxy — classes, students, staff and timetables are read from the
// NGA Central MIS using the signed-in user's MIS token (see routes/mis.ts).
app.use('/api/mis', misRoutes);

// Academic year/term integration — the MIS is the source of truth (see routes/academics.ts).
app.use('/api/academics', academicsRoutes);

app.get('/health', (_req, res) => {
  res.json({ status: 'healthy', date: new Date().toISOString() });
});
