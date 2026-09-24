// WARNING! - Any changes here MUST be the same between app/src/api & server/src/db/
import { z } from 'zod';


const StatusSchema = z.enum([
  'failed',
  'healthy',
  'not_started',
  'restarting',
  'retrying',
  'started',
  // Data-dependent jobs (calibration, sleep analysis) report this when there
  // is not yet enough archived RAW/sleep data to run, e.g. on a fresh install
  // or shortly after biometrics is enabled. It is a calm "collecting data"
  // state, deliberately NOT counted as unhealthy on the Status page.
  'waiting_for_data',
]);

export type Status = z.infer<typeof StatusSchema>;

export const StatusInfoSchema = z.object({
  name: z.string(),
  status: StatusSchema,
  description: z.string(),
  message: z.string(),
  timestamp: z.string().optional(),
  // Set on the database entry only: migrations this version ships that the
  // database never applied, which the Versions page offers to finish.
  unappliedMigrations: z.array(z.string()).optional(),
});

export type StatusInfo = z.infer<typeof StatusInfoSchema>;

export type ServerStatus = {
  alarmSchedule: StatusInfo;
  database: StatusInfo;
  express: StatusInfo;
  franken: StatusInfo;
  frankenMonitor: StatusInfo;
  jobs: StatusInfo;
  logger: StatusInfo;
  powerSchedule: StatusInfo;
  primeSchedule: StatusInfo;
  rebootSchedule: StatusInfo;
  systemDate: StatusInfo;
  temperatureSchedule: StatusInfo;
  analyzeSleepLeft?: StatusInfo;
  analyzeSleepRight?: StatusInfo;
  biometricsInstallation?: StatusInfo;
  biometricsStream?: StatusInfo;
  biometricsCalibrationLeft?: StatusInfo;
  biometricsCalibrationRight?: StatusInfo;
  pumpHealthLeft?: StatusInfo;
  pumpHealthRight?: StatusInfo;
};

// eslint-disable-next-line @typescript-eslint/no-type-alias
export type ServerStatusKey = keyof ServerStatus;
