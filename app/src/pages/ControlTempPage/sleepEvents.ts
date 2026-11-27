import moment from 'moment-timezone';
import type { AlarmSchedule } from '@api/schedulesSchema';
import type { ResolvedSleepResponse, SleepEvent } from '@api/rhythmsResponse';
import { warmsBeforeBedtime } from '@api/smartCurve';

export type SleepBedEvent = { at: moment.Moment; kind: 'on' | 'off' | 'temperature'; temperature?: number };
type TemperatureEvent = Extract<SleepEvent, { kind: 'power-on' | 'temperature' }>;

const isTemperature = (event: SleepEvent): event is TemperatureEvent => event.kind === 'power-on' || event.kind === 'temperature';

export function nextSleepEvent(sleeps: ResolvedSleepResponse[], timeZone: string, now = moment.tz(timeZone), kind?: 'on' | 'off') {
  const events = sleeps.flatMap(sleep => {
    // A Smart Schedule curve repeats its level at some phase starts; those are not changes.
    let level: number | undefined;
    return sleep.events.flatMap((event): SleepBedEvent[] => {
      const at = moment.tz(event.at, timeZone);
      if (event.kind === 'power-on') {
        level = event.temperatureF;
        return [{ at, kind: 'on', temperature: event.temperatureF }];
      }
      if (event.kind === 'power-off') return [{ at, kind: 'off' }];
      if (event.kind !== 'temperature' || event.temperatureF === level) return [];
      level = event.temperatureF;
      return [{ at, kind: 'temperature', temperature: event.temperatureF }];
    });
  });
  return events.filter(event => event.at.isAfter(now) && (!kind || event.kind === kind))
    .sort((first, second) => first.at.valueOf() - second.at.valueOf())[0] as SleepBedEvent | undefined;
}

export function currentSleep(sleeps: ResolvedSleepResponse[], now: Date) {
  return sleeps.find(sleep => Date.parse(sleep.start) <= now.getTime() && now.getTime() < Date.parse(sleep.end));
}

// Before a sleep starts this is its power-on temperature, during it the latest step.
export function scheduledTemperatureFromSleeps(sleeps: ResolvedSleepResponse[], now: Date): number | undefined {
  const sleep = [...sleeps].sort((first, second) => Date.parse(first.start) - Date.parse(second.start))
    .find(item => Date.parse(item.end) > now.getTime());
  if (!sleep) return undefined;
  const steps = sleep.events.filter(isTemperature);
  const active = steps.filter(event => Date.parse(event.at) <= now.getTime()).pop();
  return (active ?? steps[0])?.temperatureF;
}

export function alarmNightFromSleeps(
  sleeps: ResolvedSleepResponse[], timeZone: string, now = moment.tz(timeZone), override?: { expiresAt: string },
) {
  const nights = sleeps.flatMap(sleep => {
    const start = moment.tz(sleep.start, timeZone);
    const end = moment.tz(sleep.end, timeZone);
    if (!end.isAfter(now)) return [];
    const hasOverride = !!override?.expiresAt && moment(override.expiresAt).isBetween(start, end, undefined, '(]');
    const alarms = sleep.events
      .flatMap((event): Array<{ alarm: AlarmSchedule; at: moment.Moment }> =>
        event.kind === 'alarm' && event.alarm.enabled ? [{ alarm: event.alarm, at: moment.tz(event.at, timeZone) }] : [])
      .filter(({ at }) => (hasOverride || at.isSameOrAfter(now)) && at.isSameOrBefore(end))
      .sort((first, second) => first.at.valueOf() - second.at.valueOf());
    return alarms.length ? [{ start, end, alarms }] : [];
  });
  return nights.sort((first, second) => first.alarms[0].at.valueOf() - second.alarms[0].at.valueOf())[0] as
    { start: moment.Moment; end: moment.Moment; alarms: Array<{ alarm: AlarmSchedule; at: moment.Moment }> } | undefined;
}

// The sleep an event belongs to, end instant included.
export function sleepAt(sleeps: ResolvedSleepResponse[], at: Date) {
  return sleeps.find(sleep => Date.parse(sleep.start) <= at.getTime() && at.getTime() <= Date.parse(sleep.end));
}

// Whether that pre-warm is above neutral; at neutral the early power-on is just "Turns on".
export function preWarms(sleep: ResolvedSleepResponse | undefined): boolean {
  const first = sleep?.smart ? sleep.smartCurve?.points[0] : undefined;
  return !!first?.phase && warmsBeforeBedtime([{ at: new Date(first.at), level: first.level, phase: first.phase }]);
}

export function isEveningSleep(sleep: ResolvedSleepResponse, timeZone: string): boolean {
  const hour = moment.tz(sleep.start, timeZone).hour();
  return hour >= 17 || hour < 3;
}

// "Tonight only" reads wrong for a day sleep, so a sleep that starts outside the evening is "this sleep".
export function pauseOptionLabel(sleep: ResolvedSleepResponse | undefined, timeZone: string): string {
  if (!sleep) return 'Tonight only';
  return isEveningSleep(sleep, timeZone) ? 'Tonight only' : 'This sleep only';
}

export type Skip = { at: moment.Moment; kind: 'start' | 'alarm' | 'temperature' | 'turn off' };

// What a pause ending at `end` skips: power and temperature events before it, and alarms up to and including it.
export function skippedFromSleeps(sleeps: ResolvedSleepResponse[], timeZone: string, now: moment.Moment, end?: moment.Moment): Skip[] {
  return sleeps.flatMap(sleep => sleep.events.flatMap((event): Skip[] => {
    const at = moment.tz(event.at, timeZone);
    const inside = at.isAfter(now) && (!end || (event.kind === 'alarm' ? at.isSameOrBefore(end) : at.isBefore(end)));
    if (!inside) return [];
    if (event.kind === 'alarm') return event.alarm.enabled ? [{ at, kind: 'alarm' }] : [];
    return [{ at, kind: event.kind === 'power-on' ? 'start' : event.kind === 'power-off' ? 'turn off' : 'temperature' }];
  })).sort((first, second) => first.at.valueOf() - second.at.valueOf());
}

// "Skips: 10:00 PM start, 6:30 AM alarm". Temperature steps are folded into one item.
export function skipLine(skips: Skip[], now: moment.Moment): string {
  const when = (at: moment.Moment) => at.diff(now, 'hours', true) < 20 ? at.format('h:mm A') : at.format('ddd h:mm A');
  const items: string[] = [];
  let steps = false;
  for (const skip of skips) {
    if (skip.kind === 'temperature') {
      if (!steps) items.push('temperature changes');
      steps = true;
    } else items.push(`${when(skip.at)} ${skip.kind}`);
  }
  if (!items.length) return 'Nothing scheduled is skipped.';
  const shown = items.slice(0, 3);
  return `Skips: ${shown.join(', ')}${items.length > shown.length ? ` and ${items.length - shown.length} more` : ''}`;
}
