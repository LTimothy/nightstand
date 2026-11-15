// WARNING! - Any changes here MUST be the same between app/src/api & server/src/db/

import { z } from 'zod';
const timeRegexFormat = /^([01]\d|2[0-3]):([0-5]\d)$/;
export const SideSchema = z.enum(['right', 'left']);


// Reusable Zod type for time
export const TimeSchema = z.string().regex(timeRegexFormat, 'Invalid time format, must be HH:mm');
export const TemperatureSchema = z.number().int().min(55).max(110);


export const AlarmSchema = z.object({
  vibrationIntensity: z.number().int().min(1).max(100),
  vibrationPattern: z.enum(['double', 'rise']),
  duration: z.number().int().positive().min(0).max(300),
}).strict();

export const AlarmJobSchema = AlarmSchema.extend({
  side: SideSchema,
  force: z.boolean().optional(),
}).strict();

export const AlarmScheduleSchema = AlarmSchema.extend({
  time: TimeSchema,
  enabled: z.boolean(),
  alarmTemperature: TemperatureSchema,
}).strict();

// Each alarm registers its own node-schedule job on the pod, so an unbounded
// array is a cheap way to bury the scheduler. Ten covers any real day.
export const MAX_ALARMS_PER_DAY = 10;
export const AlarmSchedulesSchema = z.array(AlarmScheduleSchema).max(MAX_ALARMS_PER_DAY);

// Set points each become a job too. Writes are capped at one per half hour's
// worth; stored days above it still load (see scheduleUpdateSchema.ts).
export const MAX_TEMPERATURES_PER_DAY = 48;



export const DailyScheduleSchema = z.object({
  temperatures: z.record(
    TimeSchema,
    TemperatureSchema,
  ),
  alarm: AlarmScheduleSchema,
  alarms: AlarmSchedulesSchema,
  power: z.object({
    on: TimeSchema,
    off: TimeSchema,
    onTemperature: TemperatureSchema,
    enabled: z.boolean(),
  }),
}).strict();

// Define the SideSchedule schema
export const SideScheduleSchema = z.object({
  sunday: DailyScheduleSchema,
  monday: DailyScheduleSchema,
  tuesday: DailyScheduleSchema,
  wednesday: DailyScheduleSchema,
  thursday: DailyScheduleSchema,
  friday: DailyScheduleSchema,
  saturday: DailyScheduleSchema,
}).strict();


// Define the Schedules schema
export const SchedulesSchema = z.object({
  left: SideScheduleSchema,
  right: SideScheduleSchema,
}).strict();

// Body shape for POST /schedules. Built explicitly instead of calling
// deepPartial() on SchedulesSchema, because deepPartial recurses into the
// alarm objects too and makes `time` optional, so a timeless alarm used to
// validate and reach the scheduler. Temperatures and power stay patchable;
// an alarm is all-or-nothing.
export const DailyScheduleUpdateSchema = z.object({
  temperatures: DailyScheduleSchema.shape.temperatures,
  alarm: AlarmScheduleSchema,
  alarms: AlarmSchedulesSchema,
  power: DailyScheduleSchema.shape.power.partial(),
}).strict().partial();

export const SideScheduleUpdateSchema = z.object({
  sunday: DailyScheduleUpdateSchema,
  monday: DailyScheduleUpdateSchema,
  tuesday: DailyScheduleUpdateSchema,
  wednesday: DailyScheduleUpdateSchema,
  thursday: DailyScheduleUpdateSchema,
  friday: DailyScheduleUpdateSchema,
  saturday: DailyScheduleUpdateSchema,
}).strict().partial();

export const SchedulesUpdateSchema = z.object({
  left: SideScheduleUpdateSchema,
  right: SideScheduleUpdateSchema,
}).strict().partial();

export type DailySchedule = z.infer<typeof DailyScheduleSchema>;
export type SchedulesUpdate = z.infer<typeof SchedulesUpdateSchema>;
export type SideSchedule = z.infer<typeof SideScheduleSchema>;
export type Schedules = z.infer<typeof SchedulesSchema>;
export type Alarm = z.infer<typeof AlarmSchema>;
export type AlarmJob = z.infer<typeof AlarmJobSchema>;
export type AlarmSchedule = z.infer<typeof AlarmScheduleSchema>;
export type AlarmSchedules = z.infer<typeof AlarmSchedulesSchema>;
export type Time = z.infer<typeof TimeSchema>;

// eslint-disable-next-line @typescript-eslint/no-type-alias
export type DayOfWeek = keyof SideSchedule;
// eslint-disable-next-line @typescript-eslint/no-type-alias
// export type Side = keyof Schedules;
export type Side = z.infer<typeof SideSchema>;
