import { z } from 'zod';
import { TIME_ZONES } from './timeZones.js';
import { TimeSchema } from './schedulesSchema.js';

// Display formats. 'level' is the -10..+10 scale used by the official Pod app
// (where -10 = coldest, 0 = neutral, +10 = warmest). All three map to the same
// internal Fahrenheit value; the choice is display-only.
export const TEMPERATURES = ['fahrenheit', 'celsius', 'level'] as const;
const Temperatures = z.enum(TEMPERATURES);


const TemperatureTapConfig = z.object({
  type: z.literal('temperature'),
  change: z.enum(['increment', 'decrement']),
  amount: z.number().min(0).max(10),
});

const AlarmTapConfig = z.object({
  type: z.literal('alarm'),
  behavior: z.enum(['snooze', 'dismiss']),
  snoozeDuration: z.number().min(60).max(600),
  inactiveAlarmBehavior: z.enum(['power', 'none'])
});

const BaseControlTapConfig = z.object({
  type: z.literal('base_control'),
  behavior: z.literal('toggle_preset'),
});

export const TapConfig = z.discriminatedUnion('type', [
  TemperatureTapConfig,
  AlarmTapConfig,
  BaseControlTapConfig,
]);

export const GestureSchema = z.enum(['doubleTap', 'tripleTap', 'quadTap']);

// alarmScheduler arms real jobs off these strings, and moment overflows or
// no-ops on garbage instead of rejecting it ('25:00' would fire at 01:00 the
// next day), so they are validated here rather than downstream. Empty string
// is the stored "unset" value (see db/settings.ts defaults) and stays valid.
const UNSET = z.literal('');
const OptionalTimeSchema = z.union([UNSET, TimeSchema]);
const OptionalDateTimeSchema = z.union([UNSET, z.string().datetime({ offset: true })]);

// One-off alarm: fires once at fireAt then disables itself. Independent of
// the recurring per-day-of-week alarm. fireAt is an ISO 8601 datetime
// including offset, e.g. "2026-04-30T07:00:00-07:00".
const OneOffAlarmSchema = z.object({
  enabled: z.boolean(),
  fireAt: OptionalDateTimeSchema,
  vibrationIntensity: z.number().int().min(1).max(100),
  vibrationPattern: z.enum(['double', 'rise']),
  duration: z.number().int().min(0).max(180),
});

const SideSettingsSchema = z.object({
  name: z.string().min(1).max(20),
  awayMode: z.boolean(),
  alarmsEnabled: z.boolean(),
  scheduleOverrides: z.object({
    temperatureSchedules: z.object({
      disabled: z.boolean(),
      expiresAt: OptionalDateTimeSchema,
    }),
    alarm: z.object({
      disabled: z.boolean(),
      timeOverride: OptionalTimeSchema,
      expiresAt: OptionalDateTimeSchema,
    }),
    // An empty expiresAt pauses the schedule until it is resumed.
    pause: z.object({
      active: z.boolean(),
      expiresAt: OptionalDateTimeSchema,
    }),
  }),
  oneOffAlarm: OneOffAlarmSchema,
  taps: z.object({
    doubleTap: TapConfig,
    tripleTap: TapConfig,
    quadTap: TapConfig,
  }),
}).strict();

// Which release channel the update alert/version picker treats as "latest".
// 'beta' sees every release; 'stable' only sees releases promoted to stable
// in releases.json.
export const UPDATE_CHANNELS = ['stable', 'beta'] as const;
const UpdateChannel = z.enum(UPDATE_CHANNELS);

// Runtime feature flags, each listed in server/src/features/featuresManifest.ts.
// Biometrics has its own toggle in ServicesSchema (install precondition,
// systemd side effect) and stays there rather than joining this list.
// nightstandTheme is read by nothing and not shown in Settings; it stays so
// stored settings keep validating.
export const defaultFeatures = {
  sleepScore: true,
  levelTemps: true,
  oneOffAlarms: true,
  presenceAutoOff: true,
  nightstandTheme: true,
  rhythms: false,
  biometricsV2: false,
  firmwareTargetReadout: false,
  firmwareHealth: false,
  tapDiagnostics: false,
  coolingWarning: false,
  metricsRetention: false,
  metricsLowDiskProtection: true,
  // The buttons on a Pod 5 cover (buttonMonitor.ts). Off: no RAW file is read.
  coverButtons: false,
} as const;
const FeaturesSchema = z.object({
  sleepScore: z.boolean(),
  levelTemps: z.boolean(),
  oneOffAlarms: z.boolean(),
  presenceAutoOff: z.boolean(),
  nightstandTheme: z.boolean(),
  rhythms: z.boolean(),
  biometricsV2: z.boolean(),
  firmwareTargetReadout: z.boolean(),
  firmwareHealth: z.boolean(),
  tapDiagnostics: z.boolean(),
  coolingWarning: z.boolean(),
  metricsRetention: z.boolean(),
  metricsLowDiskProtection: z.boolean(),
  coverButtons: z.boolean(),
}).strict();

export const SettingsSchema = z.object({
  id: z.string(),
  timeZone: z.enum(TIME_ZONES),
  left: SideSettingsSchema,
  right: SideSettingsSchema,
  primePodDaily: z.object({
    enabled: z.boolean(),
    time: TimeSchema,
  }),
  temperatureFormat: Temperatures,
  rebootDaily: z.boolean(),
  rawArchiveRetentionDays: z.number().int().min(1).max(60),
  updateChannel: UpdateChannel,
  features: FeaturesSchema,
}).strict();

export type SideSettings = z.infer<typeof SideSettingsSchema>;
export type Settings = z.infer<typeof SettingsSchema>;
export type Features = z.infer<typeof FeaturesSchema>;
export type Gesture = z.infer<typeof GestureSchema>
export type UpdateChannelType = z.infer<typeof UpdateChannel>
