import { z } from 'zod';
import moment from 'moment-timezone';
import { DeviceStatusSchema, Version } from './deviceStatusSchema';
import { SettingsSchema } from './settingsSchema';
import { AlarmScheduleSchema, DailyScheduleSchema, SideScheduleSchema, SchedulesSchema } from './schedulesSchema';
import { ServicesSchema } from '../../../server/src/db/servicesSchema';
import { sleepRecordSchema } from './sleepSchema';
import { ChangelogResponseSchema } from './changelogSchema';
import { MemoryInfoSchema } from './memorySchema';
import { StorageInfoSchema } from './storageSchema';
import { StatusInfoSchema } from './serverStatusSchema';
import { vitalsRecordSchema } from '../../../server/src/db/vitalsRecordSchema';
import { movementRecordSchema } from '../../../server/src/db/movementRecordSchema';
import { ResolvedSleepsResponseSchema, RhythmsLiveReadSchema, RhythmsResponseReadSchema } from './rhythmsResponse';

import { responseSchema } from './responseSchema';

// Response compatibility: a field the app only displays, or can safely treat
// as unset, degrades on its own instead of failing the whole read. A field a
// control acts on or edits (temperatures the bed is set to, the on and off
// times, alarm times, away mode, override flags, daily priming) stays
// validated, since a made-up default there would be shown as fact or saved.
const soft = <T extends z.ZodTypeAny>(schema: T, fallback: z.output<T>) => responseSchema(schema).catch(fallback);

// The Pod reads override times and steps with plain moment and string splits,
// so values zod would reject can still be honored there. Read them the same
// way, so an active override or armed alarm never shows as absent.
const isoWithOffset = z.string().datetime({ offset: true });
function normalizeInstant(value: unknown): string {
  if (value === '') return '';
  if (typeof value === 'string') {
    if (isoWithOffset.safeParse(value).success) return value;
    const iso = moment(value, moment.ISO_8601);
    if (iso.isValid()) return iso.format();
    const date = new Date(value);
    // Unreadable text stays as sent: still present, and the Pod ignores it.
    return Number.isNaN(date.getTime()) ? value : moment(date).format();
  }
  return typeof value === 'number' && Number.isFinite(value) && moment(value).isValid() ? moment(value).format() : '';
}
function normalizeClock(value: unknown): string {
  const match = typeof value === 'string' ? /^(\d{1,2}):(\d{1,2})(?::\d+(?:\.\d+)?)?$/.exec(value) : null;
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) return '';
  return `${match[1].padStart(2, '0')}:${match[2].padStart(2, '0')}`;
}
const instantResponse = z.unknown().transform(normalizeInstant);
// The Pod tests these flags for truthiness, so a stray value reads as on or off, not as absent.
const flagResponse = z.unknown().transform(value => (value === undefined ? undefined : Boolean(value)));
const clockResponse = z.unknown().transform(normalizeClock);

// Steps are padded and rounded to what the request schema accepts. Only steps
// with no readable time or no numeric value are dropped, because the server
// refuses to save those, so keeping them would make the day impossible to save.
// Out-of-range numbers are kept so the schedule page can flag them on save.
const temperaturesResponse = z.record(z.unknown()).transform(steps => {
  const kept: Record<string, number> = {};
  let changed = false;
  for (const [time, temperature] of Object.entries(steps)) {
    const clock = normalizeClock(time);
    const usable = clock && typeof temperature === 'number' && Number.isFinite(temperature);
    if (!usable || (clock !== time && Object.keys(steps).includes(clock))) { changed = true; continue; }
    kept[clock] = Math.round(temperature);
    if (clock !== time || kept[clock] !== temperature) changed = true;
  }
  if (changed) console.warn('Adjusted schedule temperature steps that were not stored in the usual form');
  return kept;
});
const dailyResponse = DailyScheduleSchema.extend({
  temperatures: temperaturesResponse, alarms: z.array(AlarmScheduleSchema).default([]),
});
const sideResponse = SideScheduleSchema.extend(Object.fromEntries(
  Object.keys(SideScheduleSchema.shape).map(day => [day, dailyResponse]),
) as Record<keyof typeof SideScheduleSchema.shape, typeof dailyResponse>);

const sideSettingsShape = SettingsSchema.shape.left.shape;
const overrideShape = sideSettingsShape.scheduleOverrides.shape;
const oneOffShape = responseSchema(sideSettingsShape.oneOffAlarm.extend({ fireAt: z.string() }));
// An enabled alarm is armed by the Pod, so it is normalized or rejected, never
// hidden. One that is switched off is ignored by the Pod and may be dropped.
const oneOffResponse = z.unknown().transform((value, context) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const alarm = value as Record<string, unknown>;
  const parsed = oneOffShape.safeParse({ ...alarm, fireAt: normalizeInstant(alarm.fireAt) });
  if (parsed.success) return parsed.data;
  if (alarm.enabled === false) return undefined;
  context.addIssue({ code: z.ZodIssueCode.custom, message: 'Unreadable one-time alarm' });
  return z.NEVER;
});
const sideSettingsResponse = SettingsSchema.shape.left.extend({
  name: soft(sideSettingsShape.name, ''),
  alarmsEnabled: flagResponse,
  scheduleOverrides: z.object({
    temperatureSchedules: z.object({
      disabled: overrideShape.temperatureSchedules.shape.disabled,
      expiresAt: instantResponse,
    }),
    alarm: z.object({
      disabled: overrideShape.alarm.shape.disabled,
      timeOverride: clockResponse,
      expiresAt: instantResponse,
    }),
    // Settings saved before pause existed have no scheduleOverrides.pause.
    pause: z.object({
      active: overrideShape.pause.shape.active,
      expiresAt: instantResponse,
    }).optional(),
  }),
  oneOffAlarm: oneOffResponse,
  taps: soft(sideSettingsShape.taps.optional(), undefined),
  buttons: soft(sideSettingsShape.buttons.optional(), undefined),
});
// The zone list is a picker, not a limit: any zone the app can format is kept.
// Unset stays unset (the Pod schedules nothing without a zone); so does one the
// app cannot use.
const timeZoneResponse = z.unknown().transform(zone => (typeof zone === 'string' && moment.tz.zone(zone) ? zone : null));
const settingsShape = SettingsSchema.shape;
const settingsResponse = SettingsSchema.extend({
  id: soft(settingsShape.id, ''),
  timeZone: timeZoneResponse,
  left: sideSettingsResponse,
  right: sideSettingsResponse,
  temperatureFormat: soft(settingsShape.temperatureFormat, 'fahrenheit'),
  rebootDaily: soft(settingsShape.rebootDaily.optional(), undefined),
  rawArchiveRetentionDays: soft(settingsShape.rawArchiveRetentionDays.optional(), undefined),
  updateChannel: soft(settingsShape.updateChannel.optional(), undefined),
  features: soft(z.object(Object.fromEntries(Object.entries(settingsShape.features.shape)
    .map(([key]) => [key, flagResponse]))).optional(), undefined),
});
const servicesResponse = ServicesSchema.extend({ biometrics: ServicesSchema.shape.biometrics.extend({
  jobs: ServicesSchema.shape.biometrics.shape.jobs.partial({ calibrateLeft: true, calibrateRight: true, pumpLeft: true, pumpRight: true }),
}) });

const seconds = z.number().finite().nonnegative();
const percentage = seconds.max(100);
const stages = <T extends z.ZodTypeAny>(value: T) => z.object({ awake: value, rem: value, light: value, deep: value });
const scoreComponent = z.object({ score: percentage, weight: seconds, value: z.string(), available: z.boolean() });
const presenceSide = z.object({
  present: z.boolean(),
  lastUpdatedAt: z.string().optional(),
  stateChangedAt: z.string().optional(),
  lastPresenceAt: z.string().optional(),
});
const calibrationSide = z.object({
  state: z.enum(['none', 'imported', 'calibrated']),
  summary: z.string(),
  quality: z.number().nullable(),
  calibratedAt: z.number().nullable(),
  lastRunStatus: z.string().nullable(),
  capFormat: soft(z.string().nullable(), null),
});

// HTTP and WebSocket status reads share the same compatibility boundary. The
// bed controls need the temperatures, power and alarm state; hardware labels,
// Wi-Fi, water level and sensor readings are display-only.
const deviceSideResponse = DeviceStatusSchema.shape.left.extend({
  currentTemperatureLevel: soft(z.number().optional(), undefined),
  secondsRemaining: soft(z.number().optional(), undefined),
});
export const deviceStatusResponseSchema = responseSchema(DeviceStatusSchema.extend({
  left: deviceSideResponse,
  right: deviceSideResponse,
  waterLevel: soft(DeviceStatusSchema.shape.waterLevel.optional(), undefined),
  coverVersion: soft(DeviceStatusSchema.shape.coverVersion, Version.NotFound),
  hubVersion: soft(DeviceStatusSchema.shape.hubVersion, Version.NotFound),
  wifiStrength: soft(DeviceStatusSchema.shape.wifiStrength, 0),
  sensorTemps: soft(DeviceStatusSchema.shape.sensorTemps.optional(), undefined),
}));

// Validate a list row by row so one malformed record cannot hide the rest.
// A list where more than half the rows fail still fails, which keeps a
// wholesale format change visible as an error instead of a partial history.
function rowsSchema(label: string, row: z.ZodTypeAny) {
  return z.array(z.unknown()).transform((rows, context) => {
    const kept = rows.flatMap(item => {
      const result = row.safeParse(item);
      return result.success ? [result.data as unknown] : [];
    });
    const dropped = rows.length - kept.length;
    if (dropped === 0) return kept;
    // Mostly invalid rows mean the format changed, not that a few rows are bad.
    if (dropped * 2 > rows.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `Most ${label} rows are invalid` });
      return z.NEVER;
    }
    console.warn(`Ignored ${dropped} invalid ${label} ${dropped === 1 ? 'row' : 'rows'}`);
    return kept;
  });
}

// Validate before responses reach query caches or controls. The Pod's schemas
// remain the source of truth; local schemas cover responses with only TS types.
const responseSchemas: Record<string, z.ZodTypeAny> = {
  '/deviceStatus': deviceStatusResponseSchema,
  '/settings': responseSchema(settingsResponse),
  '/schedules': responseSchema(SchedulesSchema.extend({ left: sideResponse, right: sideResponse })),
  '/services': responseSchema(servicesResponse),
  '/rhythms': responseSchema(RhythmsResponseReadSchema),
  '/rhythms/sleeps': responseSchema(ResolvedSleepsResponseSchema),
  '/rhythms/live': responseSchema(RhythmsLiveReadSchema),
  '/metrics/sleep': rowsSchema('sleep', sleepRecordSchema.refine(record => record.sleep_period_seconds >= 0
    && Date.parse(record.left_bed_at) >= Date.parse(record.entered_bed_at), 'Invalid sleep interval')),
  // Reads accept any recorded value; charts drop empty and non-positive ones.
  '/metrics/vitals': rowsSchema('vitals', vitalsRecordSchema.extend({
    heart_rate: z.number().nullable(), hrv: z.number().nullable(), breathing_rate: z.number().nullable(),
  })),
  '/metrics/movement': movementRecordSchema.array(),
  '/metrics/vitals/summary': z.object({
    avgHeartRate: seconds,
    minHeartRate: seconds,
    maxHeartRate: seconds,
    avgHRV: seconds,
    avgBreathingRate: seconds,
    retained: z.object({ avgHeartRate: seconds, avgBreathingRate: seconds }).optional(),
  }),
  '/metrics/sleep-stages': z.object({
    active: z.boolean(), epochs: z.array(z.object({ startUnix: seconds, endUnix: seconds, stage: z.enum(['awake', 'rem', 'light', 'deep']) })),
    totals: stages(seconds), percentages: stages(percentage), totalSeconds: seconds, lowCoverage: z.boolean().optional(),
  }),
  '/metrics/sleep-score': z.object({
    active: z.boolean(), score: percentage.nullable(),
    components: z.object({
      duration: scoreComponent.optional(),
      continuity: scoreComponent.optional(),
      restingHr: scoreComponent.optional(),
    }),
  }),
  '/metrics/presence': z.object({ left: presenceSide, right: presenceSide }),
  '/calibration': z.object({ left: calibrationSide, right: calibrationSide }),
  '/logs': z.object({ logs: z.array(z.string()) }),
  '/changelog': ChangelogResponseSchema,
  '/memory': MemoryInfoSchema,
  '/storage': StorageInfoSchema,
  '/serverStatus': z.record(StatusInfoSchema).refine(status => Object.keys(status).length > 0, 'Missing status checks'),
  '/update/rollback-info': z.object({ available: z.boolean(), version: z.string().nullable().optional() }),
};

export function validateResponse(path: string, data: unknown): unknown {
  const schema = responseSchemas[path.split('?')[0]];
  return schema ? schema.parse(data) : data;
}
