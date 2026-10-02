import dotenv from 'dotenv';
import path from 'path';

// Load env variables
dotenv.config();

const DEFAULT_JWT_SECRET = 'local_dev_secret_change_in_production';

export const config = {
  port: parseInt(process.env.PORT || '5171', 10),
  ngaMisBaseUrl: process.env.NGA_MIS_BASE_URL || 'https://ngamis.isengesho.com',
  // The MIS web app, for deep links (e.g. an office-hours register).
  ngaMisFrontendUrl: (process.env.NGA_MIS_FRONTEND_URL || 'https://mis.amashuri.com').replace(/\/+$/, ''),
  ssoClientId: process.env.SSO_CLIENT_ID || 'placeholder_client_id',
  ssoClientSecret: process.env.SSO_CLIENT_SECRET || 'placeholder_client_secret',
  jwtSecret: process.env.JWT_SECRET || DEFAULT_JWT_SECRET,
  databasePath: process.env.DATABASE_PATH || './data/attendance.db',
  // Comma-separated list of allowed browser origins (e.g. the deployed client URL).
  // Defaults cover local development.
  corsOrigins: (process.env.CORS_ORIGINS ||
    'http://localhost:5172,http://127.0.0.1:5172,http://localhost:3000,http://127.0.0.1:3000')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),
  // Public base URL of this app's SPA, for absolute links handed to other apps
  // (the MIS Home page). Falls back to the first CORS origin, which is the
  // deployed client in every environment we run.
  appPublicUrl: (process.env.APP_PUBLIC_URL || '').trim().replace(/\/+$/, ''),
  // Bootstrap administrators. The NGA Central MIS is permission-based and grants
  // no app-specific role, so these allowlists let the app owner(s) hold 'admin'
  // here regardless of their MIS permissions. Match is case-insensitive on the
  // MIS username and/or email. At least one entry is needed to bootstrap the
  // first admin who can then assign roles to everyone else.
  adminUsernames: (process.env.ADMIN_USERNAMES || '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  adminEmails: (process.env.ADMIN_EMAILS || '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
};

if (!config.appPublicUrl) {
  config.appPublicUrl = (config.corsOrigins[0] || 'http://localhost:3000').replace(/\/+$/, '');
}

// Fail fast in production rather than signing tokens with a publicly-known secret.
// The default is fine for local development.
if (process.env.NODE_ENV === 'production' && config.jwtSecret === DEFAULT_JWT_SECRET) {
  throw new Error(
    'JWT_SECRET is set to the insecure default in a production environment. ' +
    'Set a strong, unique JWT_SECRET before starting the server.'
  );
}

// Ensure database path directories exist
import fs from 'fs';
const dbDir = path.dirname(config.databasePath);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}
