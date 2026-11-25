import { config } from './config.js';
import { initDatabase } from './database.js';
import { startRfidScheduler } from './modules/rfid/rfid.scheduler.js';
import { app } from './app.js';
import { activityRelay } from './activity/relay.js';
import activityCatalog from './activity/catalog.json';
import { startEarlyWarningScheduler } from './modules/integration/earlyWarning.service.js';
import { serviceAuthHeader } from './tenancy/index.js';
import { startFallbackReporter } from './tenancy/fallbacks.js';

async function startServer() {
  try {
    // Tenant 1 (NGA) at DATABASE_PATH; other schools' files open on first use
    // (sign-in, a scheduler pass over the registry, or provisioning).
    await initDatabase();
    startRfidScheduler();
    app.listen(config.port, () => {
      console.log(`🚀 NGA Attendance Express server running on http://localhost:${config.port}`);
    });
    // Publish Tendo's feature catalog to the MIS usage analytics (non-fatal).
    void activityRelay.pushCatalog(activityCatalog);
    // Daily early-warning signals to MIS (no-op unless configured).
    startEarlyWarningScheduler();
    // Tenancy fallback counts to MIS, at start-up and hourly (Phase 4 heartbeat; no-op unless configured).
    startFallbackReporter(() => ({ misBaseUrl: config.ngaMisBaseUrl, authHeader: serviceAuthHeader() }));
  } catch (err) {
    console.error('Failed to initialize server database:', err);
    process.exit(1);
  }
}

startServer();
