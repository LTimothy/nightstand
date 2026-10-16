import express from 'express';
import schedule from 'node-schedule';
import { Server } from 'http';
import logger from './logger.js';
import { connectFranken, disconnectFranken, getFrankenQueueDepth } from './8sleep/frankenServer.js';
import { FrankenMonitor } from './8sleep/frankenMonitor.js';
import { initWaterLevel } from './8sleep/waterLevel.js';
import { startPresenceAutoOff, stopPresenceAutoOff } from './8sleep/presenceAutoOffMonitor.js';
import { startButtonMonitor, stopButtonMonitor } from './8sleep/buttonMonitor.js';
import './jobs/jobScheduler.js';
import { abortAlarmWaits } from './jobs/alarmActivity.js';
import { setRebuilding } from './jobs/rebuildState.js';
import { stopScheduleResumes } from './jobs/resumeSchedule.js';


// Setup code
import setupMiddleware from './setup/middleware.js';
import setupRoutes from './setup/routes.js';
import config from './config.js';
import serverStatus from './serverStatus.js';
import { prisma } from './db/prisma.js';
import { loadWifiSignalStrength } from './8sleep/wifiSignalStrength.js';
import metrics from './metrics/metrics.js';
import { wsServer } from './ws/wsServer.js';
import settingsDB from './db/settings.js';
import { syncRawArchiveConf } from './jobs/rawArchiveConf.js';
import { syncBiometrics } from './jobs/biometricsSync.js';

const port = 3000;
const app = express();
let server: Server | undefined;
let frankenMonitor: FrankenMonitor | undefined;

async function disconnectPrisma() {
  try {
    logger.debug('Flushing SQLite');
    // Flush WAL into main DB and truncate WAL file (no-op if not in WAL mode)
    await prisma.$queryRawUnsafe('PRAGMA wal_checkpoint(TRUNCATE)');
    logger.debug('Flushed SQLite');
  } catch (error) {
    logger.error('Error flushing SQLite');
    const message = error instanceof Error ? error.message : String(error);
    logger.error(message);
  }
  try {
    logger.debug('Disconnecting Prisma');
    await prisma.$disconnect();
    logger.debug('Disconnected Prisma');
  } catch (error) {
    logger.error('Error disconnecting from Prisma');
    const message = error instanceof Error ? error.message : String(error);
    logger.error(message);
  }
}


// Graceful Shutdown Function
async function gracefulShutdown(signal: string) {
  stopScheduleResumes();
  logger.debug(`\nReceived ${signal}. Initiating graceful shutdown...`);
  let finishedExiting = false;

  // Force shutdown after 10 seconds
  setTimeout(() => {
    if (finishedExiting) return;
    const error = new Error('Could not close connections in time. Forcing shutdown.');
    logger.error({ error });
    process.exit(1);
  }, 15_000);
  logger.debug('Stopping node-schedule');
  // A power-off waiting for an alarm goes out now; the shutdown waits for it.
  abortAlarmWaits();
  // Cancelling every job leaves the list empty for the rest of the process.
  setRebuilding(true);
  await schedule.gracefulShutdown();
  await disconnectPrisma();


  try {
    await wsServer.close();
  } catch (err) {
    // Pass the Error object itself, not a template-string interpolation:
    // `${err}` only calls Error.prototype.toString() (message only).
    // Winston is configured with format.errors({stack: true}), which only
    // extracts the stack when the Error is the logged value itself.
    logger.error('Error closing WS server:');
    logger.error(err instanceof Error ? err : new Error(String(err)));
  }

  try {
    if (server) {
      // Stop accepting new connections
      server.close(() => {
        logger.debug('Closed out remaining HTTP connections.');
      });
    }

    if (!config.remoteDevMode) {
      stopPresenceAutoOff();
      stopButtonMonitor();
      frankenMonitor?.stop();
      await disconnectFranken();
      logger.debug('Successfully closed Franken components.');
    }
  } catch (err) {
    logger.error('Error during shutdown:');
    logger.error(err instanceof Error ? err : new Error(String(err)));
  }

  finishedExiting = true;
  logger.debug('Exiting now...');
  process.exit(0);
}

// Initialize Franken on server startup
async function initFranken() {
  logger.info('Initializing Franken on startup...');
  serverStatus.status.franken.status = 'started';
  // Force creation of the Franken and FrankenServer so it’s ready before we listen
  await connectFranken();

  serverStatus.status.franken.status = 'healthy';
  logger.info('Franken has been initialized successfully.');
}


const initFrankenMonitor = async () => {
  // Loads the last recorded tank level first, so the monitor's readings
  // compare against it rather than logging it again.
  await initWaterLevel();
  logger.info('Starting franken monitor...');
  serverStatus.status.frankenMonitor.status = 'started';
  frankenMonitor = new FrankenMonitor();
  void frankenMonitor.start();
  logger.info('Frank monitor started!');
  startPresenceAutoOff();
  // Checks settings.features.coverButtons on every poll, so it always starts.
  startButtonMonitor();
};


// Main startup function
async function startServer() {
  metrics.registerFrankenQueueDepth(getFrankenQueueDepth);
  // Older updaters can boot new code after a migration was blocked.
  // Check in the background without delaying startup; Recovery offers Reinstall
  // to apply missing migrations safely once the check finishes.
  void serverStatus.updateDB();
  setupMiddleware(app);
  setupRoutes(app);
  // Listen on desired port
  server = app.listen(port, () => {
    logger.debug(`Server running on http://localhost:${port}`);
  });
  wsServer.attach(server);
  serverStatus.status.express.status = 'healthy';
  serverStatus.status.logger.status = 'healthy';
  // An update or a first boot can leave the file missing or stale.
  void syncRawArchiveConf(settingsDB.data.rawArchiveRetentionDays);
  void syncBiometrics();

  // Initialize Franken once before listening
  if (!config.remoteDevMode) {
    void initFranken()
      .then(() => initFrankenMonitor())
      .catch(error => {
        serverStatus.status.franken.status = 'failed';
        const message = error instanceof Error ? error.message : String(error);
        serverStatus.status.franken.message = message;

        logger.error(error);
      });
  }
  void loadWifiSignalStrength();
  setInterval(loadWifiSignalStrength, 10_000);

  // Register signal handlers for graceful shutdown
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  // Handle uncaught exceptions and rejections
  process.on('uncaughtException', async (err) => {
    console.error('Uncaught Exception:', err);
    logger.error(err);
    await gracefulShutdown('uncaughtException');
  });
  process.on('unhandledRejection', async (reason, promise) => {
    logger.error(`Unhandled Rejection at: ${promise}, reason: ${reason}`);
    await gracefulShutdown('unhandledRejection');
  });
}

// Actually start the server
startServer().catch((err) => {
  logger.error('Failed to start server:', err);
  process.exit(1);
});
