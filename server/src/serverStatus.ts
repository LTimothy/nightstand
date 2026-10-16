import settingsDB from './db/settings.js';
import { firmwareHealthSummary } from './firmware/firmwareRuntime.js';
import { ServerStatus as ServerStatusType } from './routes/serverStatus/serverStatusSchema.js';
import { isSystemDateValid } from './jobs/isSystemDateValid.js';
import servicesDB, { updateServices } from './db/services.js';
import { prisma } from './db/prisma.js';
import { findUnappliedMigrations, listLocalMigrations, MigrationRow } from './db/unappliedMigrations.js';
import moment from 'moment-timezone';
import path from 'node:path';

await servicesDB.read();

// src/ and dist/ sit side by side under server/, so this resolves the same
// from either. Listed once: the tree does not change while the server runs.
const MIGRATIONS_DIR = path.resolve(import.meta.dirname, '../prisma/migrations');
let localMigrations: string[] | undefined;

class ServerStatus {
  // eslint-disable-next-line no-use-before-define
  private static instance: ServerStatus;

  public status: ServerStatusType;

  private constructor() {
    this.status = {
      alarmSchedule: {
        name: 'Alarm schedule',
        status: 'not_started',
        description: '',
        message: '',
      },
      database: {
        name: 'Database',
        status: 'not_started',
        description: 'Connection to SQLite DB',
        message: '',
      },
      express: {
        name: 'Express',
        status: 'not_started',
        description: 'The back-end server',
        timestamp: new Date().toISOString(),
        message: '',
      },
      franken: {
        name: 'Franken sock',
        status: 'not_started',
        description: 'Socket service for controlling the hardware',
        message: '',
      },
      frankenMonitor: {
        name: 'Franken monitor',
        status: 'not_started',
        description: 'Handles gestures and monitoring the status',
        message: '',
      },
      buttonMonitor: {
        name: 'Cover buttons',
        status: 'not_started',
        description: 'Reads ignored cover clicks from the RAW files',
        message: '',
      },
      jobs: {
        name: 'Job scheduler',
        status: 'not_started',
        description: 'Scheduling service for temperature changes, alarms, and maintenance',
        message: '',
      },
      logger: {
        name: 'Logger',
        status: 'not_started',
        description: 'Logging service',
        message: '',
      },
      powerSchedule: {
        name: 'Power schedule',
        status: 'not_started',
        description: 'Power on/off schedule',
        message: '',
      },
      primeSchedule: {
        name: 'Prime schedule',
        status: 'not_started',
        description: 'Daily prime job',
        message: '',
      },
      rebootSchedule: {
        name: 'Reboot schedule',
        status: 'not_started',
        description: 'Daily system reboots',
        message: '',
      },
      systemDate: {
        name: 'System date',
        status: 'not_started',
        description: 'Jobs arm when the system year is plausible. NTP synchronization is checked separately.',
        message: '',
      },
      temperatureSchedule: {
        name: 'Temperature schedule',
        status: 'not_started',
        description: 'Temperature adjustment schedule',
        message: '',
      },
      waterTank: {
        name: 'Water tank',
        status: 'not_started',
        description: 'Water level in the tank',
        message: '',
      },
    };
  }

  public static getInstance(): ServerStatus {
    if (!ServerStatus.instance) {
      ServerStatus.instance = new ServerStatus();
    }
    return ServerStatus.instance;
  }

  async updateDB() {
    const database: ServerStatusType['database'] = {
      name: this.status.database.name,
      description: this.status.database.description,
      status: 'failed',
      message: '',
    };
    try {
      await prisma.$queryRaw`SELECT 1`;
      const quick = await prisma.$queryRawUnsafe<
        Array<{ quick_check: string }>
      >(`PRAGMA quick_check;`);
      const quickCheckHealthy = quick?.[0] && Object.values(quick[0])[0] === 'ok';
      if (quickCheckHealthy) {
        // An update that could not migrate leaves the server running against
        // a database missing tables it needs, and nothing else notices until a
        // request touches one.
        localMigrations ??= listLocalMigrations(MIGRATIONS_DIR);
        const rows = await prisma.$queryRaw<MigrationRow[]>`
          SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations`;
        const unapplied = findUnappliedMigrations(localMigrations, rows);
        if (unapplied.length > 0) {
          database.status = 'failed';
          database.message =
            `Some database changes this version needs were never applied (${unapplied.join(', ')}). ` +
            'To apply them, open Settings, then Software, expand Recovery, and choose Reinstall on the running version.';
          database.unappliedMigrations = unapplied;
        } else {
          database.status = 'healthy';
          database.message = '';
        }
      } else {
        database.status = 'failed';
        database.message = `SQLite DB is unhealthy! - ${JSON.stringify(quick)}`;
      }
    } catch (error) {
      database.status = 'failed';
      const message = error instanceof Error ? error.message : String(error);
      database.message = message;
    }
    this.status.database = database;
  }

  updateSystemDate() {
    const isValid = isSystemDateValid();
    if (isValid) {
      // The scheduler owns the year check and clock synchronization warnings.
      if (this.status.systemDate.status !== 'retrying' && this.status.systemDate.status !== 'healthy'
        && this.status.systemDate.status !== 'started') {
        this.status.systemDate.status = 'healthy';
        this.status.systemDate.message = '';
      }
    } else {
      this.status.systemDate.status = 'failed';
      this.status.systemDate.message = `Invalid system date: ${new Date().toISOString()}`;
    }
  }

  async updateServices() {
    // Check inside the write queue so a fresh stream report cannot be overwritten.
    const services = await updateServices(draft => {
      const stream = draft.biometrics.jobs.stream;
      const message = 'Biometrics stream died! Run `systemctl restart free-sleep-stream`';
      if (!draft.biometrics.enabled || moment().diff(moment(stream.timestamp), 'minutes') < 5
        || !moment(stream.timestamp).isValid()) return false;
      if (stream.status === 'failed' && stream.message === message) return false;
      stream.status = 'failed';
      stream.message = message;
    });
    this.status.biometricsInstallation = services.biometrics.jobs.installation;
    if (services.biometrics.enabled) {
      this.status.analyzeSleepLeft = services.biometrics.jobs.analyzeSleepLeft;
      this.status.analyzeSleepRight = services.biometrics.jobs.analyzeSleepRight;
      this.status.biometricsCalibrationLeft = services.biometrics.jobs.calibrateLeft;
      this.status.biometricsCalibrationRight = services.biometrics.jobs.calibrateRight;
      this.status.pumpHealthLeft = services.biometrics.jobs.pumpLeft;
      this.status.pumpHealthRight = services.biometrics.jobs.pumpRight;
      this.status.biometricsStream = services.biometrics.jobs.stream;
    } else {
      // Delete keys from server status
      delete this.status.analyzeSleepLeft;
      delete this.status.analyzeSleepRight;
      delete this.status.biometricsCalibrationLeft;
      delete this.status.biometricsCalibrationRight;
      delete this.status.biometricsStream;
      delete this.status.pumpHealthLeft;
      delete this.status.pumpHealthRight;
    }
  }

  async toJSON(): Promise<ServerStatusType> {
    await this.updateDB();
    await this.updateServices();
    this.updateSystemDate();
    await settingsDB.read();
    const firmwareHealth = firmwareHealthSummary(settingsDB.data.features, servicesDB.data.biometrics.enabled);
    if (firmwareHealth) this.status.firmwareHealth = firmwareHealth;
    else delete this.status.firmwareHealth;
    return this.status;
  }
}

export default ServerStatus.getInstance();
