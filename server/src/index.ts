import { config } from './config.js';
import { initDatabase } from './database.js';
import { app } from './app.js';

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
