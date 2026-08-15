import express from 'express';
import cors from 'cors';
import { config } from './config.js';
import { initDatabase } from './database.js';

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

const app = express();

// Middlewares
app.disable('x-powered-by');
app.use(cors({
  origin: config.corsOrigins,
  credentials: true,
}));
app.use(express.json({ limit: '200kb' }));

// Baseline security headers (no extra dependency needed).
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

// Main App API Routes
app.use('/api/sso', ssoRoutes);
app.use('/api/attendance', attendanceRoutes);
app.use('/api/discipline', disciplineRoutes);
app.use('/api/staff', staffRoutes);
app.use('/api/reports', reportsRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/settings', settingsRoutes);

// MIS roster proxy — classes, students, staff and timetables are read from the
// NGA Central MIS using the signed-in user's MIS token (see routes/mis.ts).
app.use('/api/mis', misRoutes);

// Academic year/term integration — the MIS is the source of truth (see routes/academics.ts).
app.use('/api/academics', academicsRoutes);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', date: new Date().toISOString() });
});

// Initialization
async function startServer() {
  try {
    await initDatabase();
    app.listen(config.port, () => {
      console.log(`🚀 NGA Attendance Express server running on http://localhost:${config.port}`);
    });
  } catch (err) {
    console.error('Failed to initialize server database:', err);
    process.exit(1);
  }
}

startServer();
