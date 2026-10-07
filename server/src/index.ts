import { config } from './config.js';
import { initDatabase } from './database.js';
import { app } from './app.js';
import { activityRelay } from './activity/relay.js';
import activityCatalog from './activity/catalog.json';
import { startEarlyWarningScheduler } from './modules/integration/earlyWarning.service.js';

async function startServer() {
  try {
    await initDatabase();
    app.listen(config.port, () => {
      console.log(`🚀 NGA Attendance Express server running on http://localhost:${config.port}`);
    });
    // Publish Tendo's feature catalog to the MIS usage analytics (non-fatal).
    void activityRelay.pushCatalog(activityCatalog);
    // Daily early-warning signals to MIS (no-op unless configured).
    startEarlyWarningScheduler();
  } catch (err) {
    console.error('Failed to initialize server database:', err);
    process.exit(1);
  }
}

startServer();
