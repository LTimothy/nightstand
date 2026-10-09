import moment from 'moment-timezone';
import type { Services } from '@api/services.ts';
import type { DayOfWeek, Schedules } from '@api/schedulesSchema.ts';
import { defaultFeatures, type Settings } from '@api/settingsSchema.ts';
import type { DeviceStatus } from '@api/deviceStatusSchema';
import type { MovementRecord } from '@api/movement.ts';
import type { SleepRecord } from '@api/sleepSchema.ts';
import type { VitalsRecord } from '@api/vitals.ts';
import type { ServerStatus } from '@api/serverStatusSchema.ts';
import type { StorageInfo } from '@api/storageSchema.ts';
import type { MemoryInfo } from '@api/memorySchema.ts';
import type { BaseStatus, BasePosition } from '@api/baseControl.ts';
import type { Jobs } from '@api/jobs.ts';
import type { SleepScore } from '@api/sleepScore.ts';
import type { ChangelogEntry } from '@api/changelogSchema.ts';
import { demoOffersUpdate, demoRhythmsDefault } from './demoPreferences';
import { DEMO_TIME_ZONE, createSampleNights, createSleepStages, createVitalsSamples, nightScore, type SampleNight } from './sampleNights';
import serverInfo from '../../../server/src/serverInfo.json';
import releasesJson from '../../../releases.json';
import changelogMarkdown from '../../../CHANGELOG.md?raw';
import { parseChangelog } from '../../../server/src/routes/changelog/changelogParser.ts';
import { ReleasesManifestSchema } from '@api/releases.ts';
import semver from 'semver';

type Side = 'left' | 'right';

type LogStore = Record<string, string[]>;

type QueryFilters = {
  startTime?: string;
  endTime?: string;
  side?: Side;
};

// The demo tells the same version story as the repository it was built from.
const realManifest = ReleasesManifestSchema.parse(releasesJson);
const runningChannel = realManifest.releases.find(release => release.version === serverInfo.version)?.channel ?? 'stable';

const now = new Date();
const HOURS_TO_MS = 60 * 60 * 1000;
const MINUTES_TO_MS = 60 * 1000;

const clone = <T>(value: T): T => {
  const structured = (globalThis as typeof globalThis & {
    structuredClone?: <U>(source: U) => U;
  }).structuredClone;
  if (typeof structured === 'function') {
    return structured(value);
  }
  return JSON.parse(JSON.stringify(value)) as T;
};

const toIso = (date: Date) => date.toISOString();

const toSleepRecord = (night: SampleNight): SleepRecord => {
  const start = night.start.getTime();
  const end = night.end.getTime();
  const presentIntervals: [string, string][] = [];
  let cursor = start;
  night.exits.forEach(([exitStart, exitEnd]) => {
    presentIntervals.push([toIso(new Date(cursor)), toIso(exitStart)]);
    cursor = exitEnd.getTime();
  });
  presentIntervals.push([toIso(new Date(cursor)), toIso(night.end)]);

  return {
    id: night.id,
    side: night.side,
    entered_bed_at: toIso(night.start),
    left_bed_at: toIso(night.end),
    sleep_period_seconds: Math.round((end - start) / 1000),
    times_exited_bed: night.exits.length,
    present_intervals: presentIntervals,
    not_present_intervals: night.exits.map(([exitStart, exitEnd]): [string, string] => [toIso(exitStart), toIso(exitEnd)]),
  };
};

const sampleNights = createSampleNights(now);
let sleepRecords = sampleNights.map(toSleepRecord);

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** 8 hourly samples over 8 hours:
 * 50  → 300 → 1400 → 50 (piecewise-linear)
 */
const createMovementRecords = (): MovementRecord[] => {
  const H = 8; // 8 total records, hourly
  const start = moment.tz(moment.tz.guess()).startOf('hour').subtract(H - 1, 'hours');

  const keyframes = [
    { f: 0.0, v: 50 },
    { f: 0.25, v: 300 },
    { f: 0.5, v: 1400 },
    { f: 1.0, v: 50 },
  ];

  const interp = (f: number) => {
    // find segment [k, k+1] where f lies
    for (let i = 0; i < keyframes.length - 1; i++) {
      const a = keyframes[i], b = keyframes[i + 1];
      if (f <= b.f) {
        const t = (f - a.f) / (b.f - a.f);
        return lerp(a.v, b.v, t);
      }
    }
    return keyframes[keyframes.length - 1].v;
  };

  const records: MovementRecord[] = [];
  for (let i = 0; i < H; i++) {
    const frac = i / (H - 1); // 0 → 1 across 8 points
    const ts = start.clone().add(i, 'hours').unix();
    const value = Math.round(clamp(interp(frac), 1, 1400));
    const side: Side = i % 2 === 0 ? 'left' : 'right';

    records.push({
      id: i + 1,
      side,
      timestamp: ts,
      total_movement: value, // 1 → 1400 following the 50→300→1400→50 curve
    });
  }
  return records;
};

const createVitalsRecords = (nights: SampleNight[]): VitalsRecord[] => {
  const records = nights.flatMap(night => createVitalsSamples(toIso(night.start), toIso(night.end))
    .filter(({ timestamp }) => !night.exits.some(([from, to]) => timestamp * 1000 >= from.getTime() && timestamp * 1000 < to.getTime()))
    .map(({ timestamp, heartRate, hrv, breathingRate }): VitalsRecord => ({
      side: night.side, timestamp, heart_rate: heartRate, hrv, breathing_rate: breathingRate,
    })));
  return records.sort((a, b) => b.timestamp - a.timestamp);
};

const createSleepScore = (startTime: string, endTime: string): SleepScore => {
  const exits = sleepRecords.find(record => record.entered_bed_at === startTime)?.times_exited_bed ?? 0;
  const night = nightScore(startTime, endTime, exits);
  const inBedMinutes = Math.floor(night.inBedSeconds / 60);

  return {
    active: true,
    score: night.score,
    components: {
      duration: {
        score: night.duration, weight: 0.4, available: true,
        value: `${Math.floor(inBedMinutes / 60)}h${inBedMinutes % 60 ? ` ${inBedMinutes % 60}m` : ''} in bed`,
      },
      continuity: { score: night.continuity, weight: 0.3, value: `${exits} ${exits === 1 ? 'trip' : 'trips'} out of bed`, available: true },
      restingHr: { score: 0, weight: 0.15, value: `${night.minHeartRate} bpm`, available: false },
    },
  };
};

const createSchedules = (): Schedules => ({
  left: {
    sunday: {
      temperatures: { '06:00': 82, '07:00': 100 },
      power: { on: '21:30', off: '07:30', enabled: true, onTemperature: 60 },
      alarm: { time: '07:30', vibrationIntensity: 2, vibrationPattern: 'rise', duration: 10, enabled: true, alarmTemperature: 82 },
      alarms: [{ time: '07:30', vibrationIntensity: 2, vibrationPattern: 'rise', duration: 10, enabled: true, alarmTemperature: 82 }],
    },
    monday: {
      temperatures: { '06:00': 82, '06:45': 100 },
      power: { on: '21:30', off: '07:00', enabled: true, onTemperature: 60 },
      alarm: { time: '07:00', vibrationIntensity: 3, vibrationPattern: 'double', duration: 10, enabled: true, alarmTemperature: 83 },
      alarms: [{ time: '07:00', vibrationIntensity: 3, vibrationPattern: 'double', duration: 10, enabled: true, alarmTemperature: 83 }],
    },
    tuesday: {
      temperatures: { '06:00': 82, '06:45': 100 },
      power: { on: '21:30', off: '07:00', enabled: true, onTemperature: 60 },
      alarm: { time: '07:00', vibrationIntensity: 2, vibrationPattern: 'rise', duration: 8, enabled: true, alarmTemperature: 82 },
      alarms: [{ time: '07:00', vibrationIntensity: 2, vibrationPattern: 'rise', duration: 8, enabled: true, alarmTemperature: 82 }],
    },
    wednesday: {
      temperatures: { '06:00': 82, '06:45': 100 },
      power: { on: '21:30', off: '07:00', enabled: true, onTemperature: 60 },
      alarm: { time: '07:00', vibrationIntensity: 1, vibrationPattern: 'rise', duration: 8, enabled: true, alarmTemperature: 82 },
      alarms: [{ time: '07:00', vibrationIntensity: 1, vibrationPattern: 'rise', duration: 8, enabled: true, alarmTemperature: 82 }],
    },
    thursday: {
      temperatures: { '06:00': 82, '06:45': 100 },
      power: { on: '21:30', off: '07:00', enabled: true, onTemperature: 60 },
      alarm: { time: '07:00', vibrationIntensity: 2, vibrationPattern: 'rise', duration: 8, enabled: true, alarmTemperature: 81 },
      alarms: [{ time: '07:00', vibrationIntensity: 2, vibrationPattern: 'rise', duration: 8, enabled: true, alarmTemperature: 81 }],
    },
    friday: {
      temperatures: { '06:00': 82, '07:00': 100 },
      power: { on: '22:00', off: '08:00', enabled: true, onTemperature: 60 },
      alarm: { time: '08:00', vibrationIntensity: 3, vibrationPattern: 'rise', duration: 12, enabled: true, alarmTemperature: 84 },
      alarms: [{ time: '08:00', vibrationIntensity: 3, vibrationPattern: 'rise', duration: 12, enabled: true, alarmTemperature: 84 }],
    },
    saturday: {
      temperatures: { '06:00': 82, '07:00': 100 },
      power: { on: '22:30', off: '09:00', enabled: true, onTemperature: 60 },
      alarm: { time: '09:00', vibrationIntensity: 1, vibrationPattern: 'rise', duration: 12, enabled: true, alarmTemperature: 85 },
      alarms: [{ time: '09:00', vibrationIntensity: 1, vibrationPattern: 'rise', duration: 12, enabled: true, alarmTemperature: 85 }],
    },
  },
  right: {
    sunday: {
      temperatures: { '06:00': 82, '06:45': 100 },
      power: { on: '21:00', off: '07:00', enabled: true, onTemperature: 60 },
      alarm: { time: '07:00', vibrationIntensity: 2, vibrationPattern: 'rise', duration: 10, enabled: true, alarmTemperature: 84 },
      alarms: [{ time: '07:00', vibrationIntensity: 2, vibrationPattern: 'rise', duration: 10, enabled: true, alarmTemperature: 84 }],
    },
    monday: {
      temperatures: { '06:00': 82, '07:00': 100 },
      power: { on: '21:00', off: '08:30', enabled: true, onTemperature: 60 },
      alarm: { time: '06:30', vibrationIntensity: 3, vibrationPattern: 'double', duration: 10, enabled: true, alarmTemperature: 84 },
      alarms: [{ time: '06:30', vibrationIntensity: 3, vibrationPattern: 'double', duration: 10, enabled: true, alarmTemperature: 84 }],
    },
    tuesday: {
      temperatures: { '06:00': 82, '06:15': 100 },
      power: { on: '21:15', off: '06:30', enabled: true, onTemperature: 60 },
      alarm: { time: '06:30', vibrationIntensity: 3, vibrationPattern: 'double', duration: 8, enabled: true, alarmTemperature: 83 },
      alarms: [{ time: '06:30', vibrationIntensity: 3, vibrationPattern: 'double', duration: 8, enabled: true, alarmTemperature: 83 }],
    },
    wednesday: {
      temperatures: { '05:00': 82, '06:00': 100 },
      power: { on: '21:15', off: '06:30', enabled: true, onTemperature: 60 },
      alarm: { time: '06:30', vibrationIntensity: 2, vibrationPattern: 'double', duration: 8, enabled: true, alarmTemperature: 83 },
      alarms: [{ time: '06:30', vibrationIntensity: 2, vibrationPattern: 'double', duration: 8, enabled: true, alarmTemperature: 83 }],
    },
    thursday: {
      temperatures: { '05:00': 82, '06:00': 100 },
      power: { on: '21:15', off: '06:30', enabled: true, onTemperature: 60 },
      alarm: { time: '06:30', vibrationIntensity: 2, vibrationPattern: 'double', duration: 8, enabled: true, alarmTemperature: 83 },
      alarms: [{ time: '06:30', vibrationIntensity: 2, vibrationPattern: 'double', duration: 8, enabled: true, alarmTemperature: 83 }],
    },
    friday: {
      temperatures: { '05:00': 82, '06:00': 100 },
      power: { on: '22:00', off: '07:30', enabled: true, onTemperature: 60 },
      alarm: { time: '07:30', vibrationIntensity: 3, vibrationPattern: 'rise', duration: 12, enabled: true, alarmTemperature: 85 },
      alarms: [{ time: '07:30', vibrationIntensity: 3, vibrationPattern: 'rise', duration: 12, enabled: true, alarmTemperature: 85 }],
    },
    saturday: {
      temperatures: { '05:00': 82, '06:00': 100 },
      power: { on: '22:30', off: '08:30', enabled: true, onTemperature: 60 },
      alarm: { time: '08:30', vibrationIntensity: 2, vibrationPattern: 'rise', duration: 12, enabled: true, alarmTemperature: 86 },
      alarms: [{ time: '08:30', vibrationIntensity: 2, vibrationPattern: 'rise', duration: 12, enabled: true, alarmTemperature: 86 }],
    },
  },
});

const createSettings = (): Settings => ({
  id: 'demo-user',
  timeZone: DEMO_TIME_ZONE,
  temperatureFormat: 'level',
  rebootDaily: true,
  rawArchiveRetentionDays: 14,
  updateChannel: runningChannel,
  features: { ...defaultFeatures, rhythms: demoRhythmsDefault() },
  left: {
    name: 'Alex',
    awayMode: false,
    alarmsEnabled: true,
    scheduleOverrides: {
      temperatureSchedules: { disabled: false, expiresAt: '' },
      alarm: { disabled: false, timeOverride: '', expiresAt: '' },
      pause: { active: false, expiresAt: '' },
    },
    oneOffAlarm: {
      enabled: false,
      fireAt: '',
      vibrationIntensity: 100,
      vibrationPattern: 'rise',
      duration: 30,
    },
    taps: {
      doubleTap: {
        type: 'temperature',
        change: 'decrement',
        amount: 1,
      },
      tripleTap: {
        type: 'temperature',
        change: 'increment',
        amount: 1,
      },
      quadTap: {
        type: 'alarm',
        behavior: 'dismiss',
        snoozeDuration: 60,
        inactiveAlarmBehavior: 'power',
      },
    },
  },
  right: {
    name: 'Sam',
    awayMode: false,
    alarmsEnabled: true,
    scheduleOverrides: {
      temperatureSchedules: { disabled: false, expiresAt: '' },
      alarm: { disabled: false, timeOverride: '', expiresAt: '' },
      pause: { active: false, expiresAt: '' },
    },
    oneOffAlarm: {
      enabled: false,
      fireAt: '',
      vibrationIntensity: 100,
      vibrationPattern: 'rise',
      duration: 30,
    },
    taps: {
      doubleTap: {
        type: 'temperature',
        change: 'decrement',
        amount: 1,
      },
      tripleTap: {
        type: 'temperature',
        change: 'increment',
        amount: 1,
      },
      quadTap: {
        type: 'alarm',
        behavior: 'dismiss',
        snoozeDuration: 60,
        inactiveAlarmBehavior: 'power',
      },
    },
  },
  primePodDaily: { enabled: true, time: '14:30' },
});

const createServices = (): Services => ({
  biometrics: {
    enabled: true,
    jobs: {
      installation: {
        name: 'Biometrics installation',
        description: 'Initial biometric sensor installation',
        status: 'healthy',
        message: 'Installation completed successfully',
        timestamp: now.toISOString(),
      },
      stream: {
        name: 'Biometrics stream',
        description: 'Sensor data ingestion service',
        status: 'healthy',
        message: 'Streaming data smoothly',
        timestamp: new Date(now.getTime() - 2 * MINUTES_TO_MS).toISOString(),
      },
      analyzeSleepLeft: {
        name: 'Analyze sleep - left',
        description: 'Analyzes sleep data for left side',
        status: 'healthy',
        message: 'Last run completed 15 minutes ago',
        timestamp: new Date(now.getTime() - 15 * MINUTES_TO_MS).toISOString(),
      },
      analyzeSleepRight: {
        name: 'Analyze sleep - right',
        description: 'Analyzes sleep data for right side',
        status: 'healthy',
        message: 'Next run scheduled soon',
        timestamp: new Date(now.getTime() - 12 * MINUTES_TO_MS).toISOString(),
      },
      calibrateLeft: {
        name: 'Calibration job - Left',
        description: 'Sensor calibration for left side',
        status: 'healthy',
        message: 'Calibrated this morning',
        timestamp: new Date(now.getTime() - 3 * HOURS_TO_MS).toISOString(),
      },
      calibrateRight: {
        name: 'Calibration job - Right',
        description: 'Sensor calibration for right side',
        status: 'healthy',
        message: 'Calibrated this morning',
        timestamp: new Date(now.getTime() - 3 * HOURS_TO_MS).toISOString(),
      },
      pumpLeft: {
        name: 'Pump health - left',
        description: 'Watches for a stalled circulation pump while the heater/cooler is active',
        status: 'healthy',
        message: 'Circulating normally',
        timestamp: now.toISOString(),
      },
      pumpRight: {
        name: 'Pump health - right',
        description: 'Watches for a stalled circulation pump while the heater/cooler is active',
        status: 'healthy',
        message: 'Circulating normally',
        timestamp: now.toISOString(),
      },
    },
  },
});

const createDeviceStatus = (): DeviceStatus => ({
  left: {
    currentTemperatureLevel: 4,
    currentTemperatureF: 82,
    targetTemperatureF: 84,
    secondsRemaining: 1_200,
    isOn: true,
    isAlarmVibrating: false,
  },
  right: {
    currentTemperatureLevel: 5,
    currentTemperatureF: 85,
    targetTemperatureF: 86,
    secondsRemaining: 1_560,
    isOn: true,
    isAlarmVibrating: false,
  },
  waterLevel: 'true',
  isPriming: false,
  settings: {
    v: 12,
    gainLeft: 3,
    gainRight: 4,
    ledBrightness: 60,
  },
  coverVersion: 'Pod 5',
  hubVersion: 'Pod 5',
  freeSleep: {
    version: serverInfo.version,
    branch: 'main',
  },
  wifiStrength: 82,
  sensorTemps: {
    ambientC: 21.5,
    ambientF: 71,
    heatsinkC: 31.0,
    leftC: 28.5,
    rightC: 29.0,
    lastUpdated: now.toISOString(),
  },
});

const createServerStatus = (): ServerStatus => ({
  alarmSchedule: {
    name: 'Alarm schedule',
    status: 'healthy',
    description: 'Alarm scheduling service',
    message: '',
  },
  database: {
    name: 'Database',
    status: 'healthy',
    description: 'SQLite database connection',
    message: '',
  },
  express: {
    name: 'Express',
    status: 'healthy',
    description: 'HTTP server',
    message: '',
  },
  franken: {
    name: 'Franken sock',
    status: 'healthy',
    description: 'Hardware socket interface',
    message: '',
  },
  frankenMonitor: {
    name: 'Franken monitor',
    status: 'healthy',
    description: 'Handles gestures and monitoring the status',
    message: '',
  },
  buttonMonitor: {
    name: 'Cover buttons',
    status: 'healthy',
    description: 'Reads ignored cover clicks from the RAW files',
    message: 'Off in Settings > Features',
  },
  jobs: {
    name: 'Job scheduler',
    status: 'healthy',
    description: 'Background job execution',
    message: 'All jobs executed successfully overnight',
  },
  logger: {
    name: 'Logger',
    status: 'healthy',
    description: 'Application logs',
    message: '',
  },
  powerSchedule: {
    name: 'Power schedule',
    status: 'healthy',
    description: 'Controls power on/off cycles',
    message: 'Bed powered on for bedtime routine',
  },
  primeSchedule: {
    name: 'Prime schedule',
    status: 'healthy',
    description: 'Daily prime job',
    message: 'Next prime scheduled for 14:30',
  },
  rebootSchedule: {
    name: 'Reboot schedule',
    status: 'healthy',
    description: 'Daily system reboot',
    message: 'Reboot completed successfully last night',
  },
  systemDate: {
    name: 'System date',
    status: 'healthy',
    description: 'System clock status',
    message: '',
  },
  temperatureSchedule: {
    name: 'Temperature schedule',
    status: 'healthy',
    description: 'Temperature automation',
    message: '',
  },
  waterTank: {
    name: 'Water tank',
    status: 'healthy',
    description: 'Water level in the tank',
    message: '',
  },
  analyzeSleepLeft: {
    name: 'Analyze sleep - left',
    status: 'healthy',
    description: 'Sleep analytics for left side',
    message: 'Last analysis completed successfully',
  },
  analyzeSleepRight: {
    name: 'Analyze sleep - right',
    status: 'healthy',
    description: 'Sleep analytics for right side',
    message: 'Last analysis completed successfully',
  },
  biometricsInstallation: {
    name: 'Biometrics installation',
    status: 'healthy',
    description: 'Installation status',
    message: '',
  },
  biometricsStream: {
    name: 'Biometrics stream',
    status: 'healthy',
    description: 'Biometrics data stream',
    message: '',
    timestamp: new Date(now.getTime() - 2 * MINUTES_TO_MS).toISOString(),
  },
  biometricsCalibrationLeft: {
    name: 'Calibration job - Left',
    status: 'healthy',
    description: 'Left side calibration',
    message: '',
  },
  biometricsCalibrationRight: {
    name: 'Calibration job - Right',
    status: 'healthy',
    description: 'Right side calibration',
    message: '',
  },
  pumpHealthLeft: {
    name: 'Pump health - left',
    status: 'healthy',
    description: 'Watches for a stalled circulation pump while the heater/cooler is active',
    message: '',
    timestamp: new Date(now.getTime() - 2 * MINUTES_TO_MS).toISOString(),
  },
  pumpHealthRight: {
    name: 'Pump health - right',
    status: 'healthy',
    description: 'Watches for a stalled circulation pump while the heater/cooler is active',
    message: '',
    timestamp: new Date(now.getTime() - 2 * MINUTES_TO_MS).toISOString(),
  },
});

const createStorageInfo = (): StorageInfo => ({
  mountPath: '/persistent/free-sleep-data',
  totalBytes: 15_375_304 * 1024,
  usedBytes: 1_719_180 * 1024,
  availableBytes: 12_853_308 * 1024,
  usedPercent: 11.2,
  breakdown: {
    logsBytes: 10 * 1024 * 1024,
    biometricsArchiveBytes: 351 * 1024 * 1024,
    databaseBytes: 220 * 1024,
  },
});

const createMemoryInfo = (): MemoryInfo => ({
  totalBytes: 2_014_796 * 1024,
  usedBytes: (2_014_796 - 1_486_852) * 1024,
  availableBytes: 1_486_852 * 1024,
  usedPercent: 26.2,
});

// Demo pods have no real adjustable base hardware, but the Elevation tab is
// worth showing off, isConfigured: true unlocks it (see useBaseConfigured).
const BASE_PRESETS: Record<string, { head: number; feet: number }> = {
  flat: { head: 0, feet: 0 },
  sleep: { head: 1, feet: 5 },
  relax: { head: 30, feet: 15 },
  read: { head: 40, feet: 0 },
};

const createBaseStatus = (): BaseStatus => ({
  head: 0,
  feet: 0,
  isMoving: false,
  lastUpdate: now.toISOString(),
  isConfigured: true,
});

let baseStatus = createBaseStatus();
let baseMoveTimer: ReturnType<typeof setTimeout> | null = null;

// Simulates gradual movement: flips isMoving on immediately (so the UI's
// "Base is moving..." state has something to poll), then lands on the
// target position after a beat, roughly how the real BLE-driven base
// reports itself over a couple of useBaseStatus polls.
const simulateBaseMove = (target: { head: number; feet: number }) => {
  baseStatus = { ...baseStatus, isMoving: true, lastUpdate: new Date().toISOString() };
  if (baseMoveTimer) clearTimeout(baseMoveTimer);
  baseMoveTimer = setTimeout(() => {
    baseStatus = { ...baseStatus, ...target, isMoving: false, lastUpdate: new Date().toISOString() };
  }, 2500);
  return baseStatus;
};

export const getBaseStatus = () => baseStatus;

export const setBasePosition = (position: BasePosition) => simulateBaseMove(position);

export const setBasePreset = (preset: string) => simulateBaseMove(BASE_PRESETS[preset] ?? BASE_PRESETS.flat);

export const stopBase = () => {
  if (baseMoveTimer) clearTimeout(baseMoveTimer);
  baseStatus = { ...baseStatus, isMoving: false, lastUpdate: new Date().toISOString() };
  return baseStatus;
};

const createLogs = (): LogStore => ({
  'free-sleep.log': [
    `[${new Date(now.getTime() - 3 * MINUTES_TO_MS).toISOString()}] INFO Starting Nightstand demo mode`,
    `[${new Date(now.getTime() - 2 * MINUTES_TO_MS).toISOString()}] INFO Schedules loaded successfully`,
    `[${new Date(now.getTime() - 90 * 1000).toISOString()}] INFO Biometrics stream connected`,
    `[${new Date(now.getTime() - 30 * 1000).toISOString()}] INFO Demo data refreshed`,
  ],
  'scheduler.log': [
    `[${new Date(now.getTime() - 6 * MINUTES_TO_MS).toISOString()}] INFO Prime job executed`,
    `[${new Date(now.getTime() - 4 * MINUTES_TO_MS).toISOString()}] INFO Temperature schedule updated`,
    `[${new Date(now.getTime() - 60 * 1000).toISOString()}] INFO Nightly reboot completed`,
  ],
});

const movementRecords = createMovementRecords();
const vitalsRecords = createVitalsRecords(sampleNights);
let schedules = createSchedules();
let settings = createSettings();
let services = createServices();
let deviceStatus = createDeviceStatus();
let serverStatus = createServerStatus();
let storageInfo = createStorageInfo();
let memoryInfo = createMemoryInfo();
let logsStore = createLogs();

export const mergeDeep = (target: unknown, source: unknown): unknown => {
  if (source === undefined || source === null) {
    return target;
  }
  if (Array.isArray(source)) {
    return Array.isArray(target) ? source.slice() : source.slice();
  }
  if (typeof source === 'object') {
    const targetObj = typeof target === 'object' && target !== null ? target as Record<string, unknown> : {};
    const sourceObj = source as Record<string, unknown>;
    const result: Record<string, unknown> = { ...targetObj };
    Object.entries(sourceObj).forEach(([key, value]) => {
      result[key] = mergeDeep(result[key], value);
    });
    return result;
  }
  return source;
};

export const getServices = () => services;
export const updateServices = (partial: Partial<Services>) => {
  services = mergeDeep(clone(services), partial) as Services;
  return services;
};

export const getSchedules = () => schedules;
export const updateSchedules = (partial: Partial<Schedules>) => {
  schedules = mergeDeep(clone(schedules), partial) as Schedules;
  for (const side of ['left', 'right'] as const) {
    for (const [day, update] of Object.entries(partial[side] ?? {})) {
      if (update?.temperatures) schedules[side][day as DayOfWeek].temperatures = clone(update.temperatures);
    }
  }
  return schedules;
};

export const getSettings = () => settings;
export const updateSettings = (partial: Partial<Settings>) => {
  const partialCopy = { ...partial };
  // Never allow overwriting the generated ID in demo mode
  delete (partialCopy as { id?: string }).id;
  settings = mergeDeep(clone(settings), partialCopy) as Settings;
  return settings;
};

export const getDeviceStatus = () => deviceStatus;

// The Pod only primes when nothing is running, in the ten minutes after the daily prime time.
export const isPrimingAt = (at: Date, status: DeviceStatus = deviceStatus): boolean => {
  const { enabled, time } = settings.primePodDaily;
  if (!enabled || status.left.isOn || status.right.isOn) return false;
  const local = moment.tz(at, settings.timeZone);
  const [hour, minute] = time.split(':').map(Number);
  const sinceMinutes = local.diff(local.clone().set({ hour, minute, second: 0, millisecond: 0 }), 'minutes');
  return sinceMinutes >= 0 && sinceMinutes < 10;
};

export const updateDeviceStatus = (partial: Partial<DeviceStatus>) => {
  // As on the Pod, isPriming false is ignored: no verified command stops a prime.
  const { isPriming, ...rest } = partial;
  const applied = isPriming === false ? rest : partial;
  deviceStatus = mergeDeep(clone(deviceStatus), applied) as DeviceStatus;
  return deviceStatus;
};

export const getServerStatus = () => serverStatus;
export const setServerStatus = (next: ServerStatus) => {
  serverStatus = clone(next);
  return serverStatus;
};

export const getStorageInfo = () => storageInfo;
export const setStorageInfo = (next: StorageInfo) => {
  storageInfo = clone(next);
  return storageInfo;
};

export const getMemoryInfo = () => memoryInfo;
export const setMemoryInfo = (next: MemoryInfo) => {
  memoryInfo = clone(next);
  return memoryInfo;
};

const changelogEntries: ChangelogEntry[] = parseChangelog(changelogMarkdown).slice(0, 8);

export const getChangelog = () => changelogEntries;

export const listSleepRecords = () => sleepRecords;
export const setSleepRecords = (records: SleepRecord[]) => {
  sleepRecords = records;
  return sleepRecords;
};

export const getSleepStages = createSleepStages;
export const getSleepScore = createSleepScore;

export const listMovementRecords = () => movementRecords;


export const listVitalsRecords = () => vitalsRecords;


export const listLogs = () => logsStore;
export const setLogs = (next: LogStore) => {
  logsStore = next;
  return logsStore;
};

export const getLogFiles = () => Object.keys(logsStore);

export const appendLogEntry = (file: string, message: string) => {
  if (!logsStore[file]) {
    logsStore[file] = [];
  }
  logsStore[file].push(message);
  if (logsStore[file].length > 1000) {
    logsStore[file] = logsStore[file].slice(-1000);
  }
};

export const filterByQuery = <T extends { side?: Side }>(records: T[], filters: QueryFilters, getTimestamp: (record: T) => number) => {
  const start = filters.startTime ? Date.parse(filters.startTime) : undefined;
  const end = filters.endTime ? Date.parse(filters.endTime) : undefined;
  const side = filters.side;

  return records.filter((record) => {
    if (side && record.side !== side) {
      return false;
    }
    const timestamp = getTimestamp(record);
    if (Number.isFinite(start) && start !== undefined && timestamp < start) {
      return false;
    }
    if (Number.isFinite(end) && end !== undefined && timestamp > end) {
      return false;
    }
    return true;
  });
};

export const handleJobs = (jobs: Jobs) => {
  const timestamp = new Date().toISOString();
  jobs.forEach((job) => {
    appendLogEntry('free-sleep.log', `[${timestamp}] INFO Job executed: ${job}`);
  });
};

// A sample release one minor version ahead, offered only when the demo is set to show an update.
const demoNextVersion = semver.inc(serverInfo.version, 'minor')!;
const sampleRelease = () => (demoOffersUpdate() ? [{
  kind: 'bundle', version: demoNextVersion, channel: 'stable', date: '2026-10-01', upstreamBase: serverInfo.upstreamBase, features: [],
}] : []);

// Mock of the release manifest the app fetches raw from GitHub: the real one.
export const getReleasesManifest = () => ({
  ...realManifest,
  releases: [...sampleRelease(), ...realManifest.releases],
});

// Mock of the newest published build, fetched raw from GitHub. The hook reads
// version and branch only.
export const getRemoteServerInfo = () => ({ version: demoOffersUpdate() ? demoNextVersion : serverInfo.version, branch: 'main' });

// Mock of CHANGELOG.md fetched raw from GitHub: the real file, with the
// sample release's notes ahead of the first section when the demo offers one.
export const getRemoteChangelogMarkdown = () => {
  if (!demoOffersUpdate()) return changelogMarkdown;
  const found = changelogMarkdown.search(/^## /m);
  const firstSection = found < 0 ? changelogMarkdown.length : found;
  const sample = `## [${demoNextVersion}] - 2026-10-01\nSample release offered by the demo.\n\n`;
  return changelogMarkdown.slice(0, firstSection) + sample + changelogMarkdown.slice(firstSection);
};

// Mock of the pod's rollback availability.
export const rollbackInfo = { available: true, version: '2.9.0' };

// Mock presence for both sides (no zod schema; the hook consumes a plain
// PresenceData shape).
export const presence = {
  left: { present: false },
  right: { present: false },
};

// Mock calibration state for both sides.
export const mockCalibration = {
  left: {
    state: 'calibrated' as const,
    summary: 'Learned from a 22 min empty-bed window.',
    quality: 0.8,
    calibratedAt: 1_700_001_400,
    lastRunStatus: 'success',
    capFormat: null,
  },
  right: {
    state: 'none' as const,
    summary: 'Not calibrated yet. This happens automatically once the sensors record a stretch of empty bed.',
    quality: null,
    calibratedAt: null,
    lastRunStatus: null,
    capFormat: null,
  },
};
