import { DailySchedule, DailyScheduleSchema, AlarmScheduleSchema, MAX_ALARMS_PER_DAY } from '@api/schedulesSchema';
import { temperatureInPowerWindow } from '@api/rhythmWake';

export { temperatureInPowerWindow };

export function minutesSincePowerOn(time: string, powerOn: string): number {
  const minutes = (value: string) => {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return NaN;
    const [hour, minute] = value.split(':').map(Number);
    return hour * 60 + minute;
  };
  return (minutes(time) - minutes(powerOn) + 1440) % 1440;
}

export function timeInPowerWindow(time: string, power: DailySchedule['power']): boolean {
  const offset = minutesSincePowerOn(time, power.on);
  const end = power.off === power.on ? 1440 : minutesSincePowerOn(power.off, power.on);
  return Number.isFinite(offset) && end > 0 && offset <= end;
}

export function validateSchedule(schedule: DailySchedule | undefined, existingAlarmCount = 0) {
  const parsed = DailyScheduleSchema.extend({
    alarms: AlarmScheduleSchema.array().max(Math.max(MAX_ALARMS_PER_DAY, existingAlarmCount)),
  }).safeParse(schedule);
  if (!parsed.success) return { invalidTimes: 0, schemaIssues: parsed.error.issues };
  const validSchedule = parsed.data;
  const alarms = validSchedule.alarms.length ? validSchedule.alarms : [validSchedule.alarm];
  const invalidTimes = !validSchedule.power.enabled ? 0
    : alarms.filter(alarm => alarm.enabled && !timeInPowerWindow(alarm.time, validSchedule.power)).length
      + Object.keys(validSchedule.temperatures).filter(time => !temperatureInPowerWindow(time, validSchedule.power)).length;
  return { invalidTimes, schemaIssues: [] };
}

export function scheduleIsValid(schedule: DailySchedule | undefined, existingAlarmCount = 0): boolean {
  const { invalidTimes, schemaIssues } = validateSchedule(schedule, existingAlarmCount);
  return invalidTimes === 0 && schemaIssues.length === 0;
}
