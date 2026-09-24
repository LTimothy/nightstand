import { ServerStatus as ServerStatusType } from './routes/serverStatus/serverStatusSchema.js';
import { isSystemDateValid } from './jobs/isSystemDateValid.js';
import servicesDB from './db/services.js';
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
        description: 'Whether or not the system date is correct. Scheduling jobs depend on this.',
        message: '',
      },
      temperatureSchedule: {
        name: 'Temperature schedule',
        status: 'not_started',
        description: 'Temperature adjustment schedule',
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
    try {
      await prisma.$queryRaw`SELECT 1`;
      const quick = await prisma.$queryRawUnsafe<
        Array<{ quick_check: string }>
      >(`PRAGMA quick_check;`);
      const quickCheckHealthy = quick?.[0] && Object.values(quick[0])[0] === 'ok';
      delete this.status.database.unappliedMigrations;
      if (quickCheckHealthy) {
        // An update that could not migrate leaves the server running against
        // a database missing tables it needs, and nothing else notices until a
        // request touches one.
        localMigrations ??= listLocalMigrations(MIGRATIONS_DIR);
        const rows = await prisma.$queryRaw<MigrationRow[]>`
          SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations`;
        const unapplied = findUnappliedMigrations(localMigrations, rows);
        if (unapplied.length > 0) {
          this.status.database.status = 'failed';
          this.status.database.message =
            `Some database changes this version needs were never applied (${unapplied.join(', ')}). ` +
            'To apply them, open Settings, then Versions, and choose Reinstall on the running version.';
          this.status.database.unappliedMigrations = unapplied;
        } else {
          this.status.database.status = 'healthy';
          this.status.database.message = '';
        }
      } else {
        this.status.database.status = 'failed';
        this.status.database.message = `SQLite DB is unhealthy! - ${JSON.stringify(quick)}`;
      }
    } catch (error) {
      this.status.database.status = 'failed';
      const message = error instanceof Error ? error.message : String(error);
      this.status.database.message = message;
    }
  }

  updateSystemDate() {
    const isValid = isSystemDateValid();
    if (isValid) {
      this.status.systemDate.status = 'healthy';
      this.status.systemDate.message = '';
    } else {
      this.status.systemDate.status = 'failed';
      this.status.systemDate.message = `Invalid system date: ${new Date().toISOString()}`;
    }
  }

  async updateServices() {
    await servicesDB.read();
    this.status.biometricsInstallation = servicesDB.data.biometrics.jobs.installation;
    if (servicesDB.data.biometrics.enabled) {
      this.status.analyzeSleepLeft = servicesDB.data.biometrics.jobs.analyzeSleepLeft;
      this.status.analyzeSleepRight = servicesDB.data.biometrics.jobs.analyzeSleepRight;
      this.status.biometricsCalibrationLeft = servicesDB.data.biometrics.jobs.calibrateLeft;
      this.status.biometricsCalibrationRight = servicesDB.data.biometrics.jobs.calibrateRight;
      this.status.pumpHealthLeft = servicesDB.data.biometrics.jobs.pumpLeft;
      this.status.pumpHealthRight = servicesDB.data.biometrics.jobs.pumpRight;

      const time = moment(servicesDB.data.biometrics.jobs.stream.timestamp);
      if (moment().diff(time, 'minutes') >= 5) {
        servicesDB.data.biometrics.jobs.stream.status = 'failed';
        servicesDB.data.biometrics.jobs.stream.message = 'Biometrics stream died! Run `systemctl restart free-sleep-stream`';
      }
      await servicesDB.write();
      this.status.biometricsStream = servicesDB.data.biometrics.jobs.stream;
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
    return this.status;
  }
}

export default ServerStatus.getInstance();
