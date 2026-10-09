import { ServerStatusKey, ServerStatus, Status, StatusInfo, StatusInfoSchema } from '@api/serverStatusSchema.ts';

export type StatusGroup = 'schedules' | 'biometrics' | 'core';

export type StatusItemMeta = {
  group: StatusGroup;
  // Plain-English replacement for the raw backend `description` field.
  blurb: string;
  // What each status value specifically means for *this* item - falls back
  // to a generic meaning (see genericMeaning below) when a value isn't listed.
  meaning?: Partial<Record<Status, string>>;
  // Shown next to the Run button on items the user can trigger manually.
  runHint?: string;
  runLabel?: string;
};

export const STATUS_META: Record<ServerStatusKey, StatusItemMeta> = {
  firmwareHealth: { group: 'biometrics', blurb: 'Selected firmware messages. Requires Biometrics; silence does not establish recovery.' },
  alarmSchedule: {
    group: 'schedules',
    blurb: 'Wakes you up with vibration and temperature changes at your alarm time.',
    meaning: { healthy: 'Your alarms are loaded.' },
  },
  powerSchedule: {
    group: 'schedules',
    blurb: 'Turns each side of the bed on and off automatically.',
    meaning: { healthy: 'Your on/off schedule is active.' },
  },
  primeSchedule: {
    group: 'schedules',
    blurb: 'Runs the daily prime cycle that clears air bubbles from the water lines.',
    meaning: { healthy: "Today's prime is scheduled." },
  },
  rebootSchedule: {
    group: 'schedules',
    blurb: 'Restarts the Pod once a day to keep things running smoothly, if enabled in Settings.',
    meaning: { healthy: 'The nightly reboot is scheduled.' },
  },
  temperatureSchedule: {
    group: 'schedules',
    blurb: 'Applies your saved temperature schedule throughout the night.',
    meaning: { healthy: 'Your temperature schedule is active.' },
  },
  rhythmsSchedule: {
    group: 'schedules',
    blurb: "Plans each side's sleeps from Rhythms for the next two days.",
    meaning: { healthy: 'Your Rhythms sleeps are planned.' },
  },
  biometricsInstallation: {
    group: 'biometrics',
    blurb: 'Whether the biometrics add-on (heart rate and sleep estimates) is installed on the Pod.',
    meaning: { healthy: 'Installed and available.' },
  },
  biometricsStream: {
    group: 'biometrics',
    blurb: 'Reads live sensor data from both sides of the bed in real time.',
    meaning: { healthy: 'Actively streaming sensor data right now.' },
  },
  analyzeSleepLeft: {
    runLabel: 'Analyze left-side sleep',
    group: 'biometrics',
    blurb: "Finds last night's bed times and movement from the sensor data, left side.",
    meaning: {
      healthy: 'Finished analyzing the most recent sleep session.',
      waiting_for_data: 'No full night to analyze yet. Runs automatically after your first night.',
    },
    runHint: 'Analyzes the last 24 hours right now, instead of waiting for the overnight job.',
  },
  analyzeSleepRight: {
    runLabel: 'Analyze right-side sleep',
    group: 'biometrics',
    blurb: "Finds last night's bed times and movement from the sensor data, right side.",
    meaning: {
      healthy: 'Finished analyzing the most recent sleep session.',
      waiting_for_data: 'No full night to analyze yet. Runs automatically after your first night.',
    },
    runHint: 'Analyzes the last 24 hours right now, instead of waiting for the overnight job.',
  },
  biometricsCalibrationLeft: {
    runLabel: 'Calibrate left presence',
    group: 'biometrics',
    blurb: 'Learns what an empty bed looks like to the sensors, so presence detection fits this bed, left side.',
    meaning: {
      healthy: 'Calibration finished successfully.',
      waiting_for_data: 'Collecting data. Calibration runs automatically once the sensors record a stretch of empty bed.',
    },
    runHint: 'Recalibrates presence detection. Get off this side first: it assumes the side is empty.',
  },
  biometricsCalibrationRight: {
    runLabel: 'Calibrate right presence',
    group: 'biometrics',
    blurb: 'Learns what an empty bed looks like to the sensors, so presence detection fits this bed, right side.',
    meaning: {
      healthy: 'Calibration finished successfully.',
      waiting_for_data: 'Collecting data. Calibration runs automatically once the sensors record a stretch of empty bed.',
    },
    runHint: 'Recalibrates presence detection. Get off this side first: it assumes the side is empty.',
  },
  pumpHealthLeft: {
    group: 'core',
    blurb: 'Watches for a stalled water pump while the heater/cooler is running, left side. '
      + 'A stalled pump can make the sensor read a false runaway temperature.',
    meaning: {
      healthy: 'Circulating normally.',
      failed: 'Pump stall suspected: the displayed temperature on this side may not be accurate.',
    },
  },
  pumpHealthRight: {
    group: 'core',
    blurb: 'Watches for a stalled water pump while the heater/cooler is running, right side. '
      + 'A stalled pump can make the sensor read a false runaway temperature.',
    meaning: {
      healthy: 'Circulating normally.',
      failed: 'Pump stall suspected: the displayed temperature on this side may not be accurate.',
    },
  },
  waterTank: {
    group: 'core',
    blurb: "The Pod's water tank sensor. Heating and cooling need water circulating.",
    meaning: {
      healthy: 'The tank has enough water.',
      failed: 'The tank is low or empty. Refill it.',
      not_started: 'Waiting for the first reading from the Pod.',
    },
  },
  express: {
    group: 'core',
    blurb: 'The web server this app and the Pod controls run on.',
    meaning: { healthy: 'Responding normally.' },
  },
  franken: {
    group: 'core',
    blurb: "The low-level connection this app uses to talk to the Pod's heating and cooling hardware.",
    meaning: { healthy: 'Connected to the hardware.' },
  },
  frankenMonitor: {
    group: 'core',
    blurb: 'Watches for physical taps on the Pod and keeps the hardware connection alive.',
    meaning: { healthy: 'Watching for taps and monitoring the connection.' },
  },
  buttonMonitor: {
    group: 'core',
    blurb: 'For a Pod 4 hub with a Pod 5 cover. When Cover buttons is on, reads ignored plus and minus clicks '
      + 'from RAW files and steps that side by 1 F, 15 to 25 s later, because the firmware writes its log in batches. '
      + 'A Pod 5 hub handles its buttons itself, so this does nothing there.',
    meaning: {
      healthy: 'Watching for ignored button clicks, or off in Settings.',
      failed: 'Cannot apply button clicks. The Pod is not writing RAW files, or a click could not be read or applied.',
    },
  },
  jobs: {
    group: 'core',
    blurb: 'The internal scheduler that runs all the timed jobs below (temperature, power, priming, reboots).',
    meaning: { healthy: 'The scheduler is running.' },
  },
  logger: {
    group: 'core',
    blurb: 'Writes the activity logs you can view under Logs.',
    meaning: { healthy: 'Logging normally.' },
  },
  database: {
    group: 'core',
    blurb: 'Local storage for your settings, schedules, and sleep history.',
    meaning: { healthy: 'Reachable and passed its integrity check.' },
  },
  systemDate: {
    group: 'core',
    blurb: "Whether the Pod's clock is correct. Scheduling depends on this.",
    meaning: { healthy: 'The clock is correct.' },
  },
};

// Fallback wording for status values a specific item didn't override above.
export const GENERIC_MEANING: Record<Status, string> = {
  healthy: 'Working normally.',
  not_started: "Hasn't run yet.",
  started: 'Running right now.',
  restarting: 'Recovering from an error, restarting automatically.',
  retrying: 'Hit a snag, retrying automatically.',
  failed: 'Needs attention.',
  waiting_for_data: 'Collecting data. This runs automatically once there is enough.',
};

export const GROUP_LABELS: Record<StatusGroup, string> = {
  schedules: 'Schedules',
  biometrics: 'Sleep tracking',
  core: 'Core services',
};

export const needsAttention = (status?: Status) => status === 'failed' || status === 'retrying' || status === 'restarting';

export function usableStatusKeys(data?: ServerStatus): ServerStatusKey[] {
  return data ? (Object.keys(data) as ServerStatusKey[])
    .filter(key => !!STATUS_META[key] && StatusInfoSchema.safeParse(data[key]).success) : [];
}

export const CORE_KEYS: ServerStatusKey[] = (Object.keys(STATUS_META) as ServerStatusKey[])
  .filter(key => STATUS_META[key].group === 'core');

export function coreServicesReady(data?: ServerStatus): boolean {
  return CORE_KEYS.every(key => StatusInfoSchema.safeParse(data?.[key]).success && data?.[key]?.status === 'healthy');
}

export function waitingCoreKeys(data?: ServerStatus): ServerStatusKey[] {
  return CORE_KEYS.filter(key => !StatusInfoSchema.safeParse(data?.[key]).success || data?.[key]?.status !== 'healthy');
}

export function overdueCoreKeys(data: ServerStatus | undefined, podNow: number | undefined): ServerStatusKey[] {
  const startedAt = Date.parse(data?.express?.timestamp ?? '');
  if (!Number.isFinite(startedAt) || podNow === undefined || podNow - startedAt < 120_000) return [];
  return CORE_KEYS.filter(key => data?.[key]?.status === 'not_started');
}

export function statusName(key: ServerStatusKey, info?: StatusInfo): string {
  if (key === 'pumpHealthLeft') return 'Left pump';
  if (key === 'pumpHealthRight') return 'Right pump';
  if (key === 'biometricsCalibrationLeft') return 'Left presence calibration';
  if (key === 'biometricsCalibrationRight') return 'Right presence calibration';
  if (key === 'express') return 'Web server';
  if (key === 'franken') return 'Hardware link';
  return info?.name ?? key;
}

export function statusImpact(key: ServerStatusKey): string {
  if (key === 'waterTank') return 'Heating and cooling need water. Check the tank below.';
  if (key.startsWith('pumpHealth')) return 'A pump may be stalled. Temperature readings may be inaccurate.';
  if (STATUS_META[key].group === 'schedules') return 'Some scheduled changes may not run. Review this service below.';
  if (key === 'biometricsStream') return 'Sleep tracking stopped. New sleep data may not be recorded.';
  if (key === 'franken') return 'Heating and cooling controls cannot reach the hardware.';
  if (key === 'database') return 'Settings and sleep history may be unavailable.';
  if (key === 'systemDate') return 'Scheduled changes may run at the wrong time.';
  return STATUS_META[key].meaning?.failed ?? STATUS_META[key].blurb;
}
