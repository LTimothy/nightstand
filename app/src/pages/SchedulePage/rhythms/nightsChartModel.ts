// Shared chart pieces: x is minutes after the power-on, values are °F.
import moment from 'moment-timezone';
import type { Rhythm } from '@api/rhythmsSchema';
import { minutesAfterOn, temperatureInPowerWindow } from '@api/rhythmWake';
import { formatDisplayValue, type TemperatureFormat } from '@lib/temperatureConversions';

export type Step = { x: number; f: number };

// How far the range reaches past the plan's values, in °F.
export const RANGE_F = 4;

export const planSteps = (rhythm: Rhythm, endMin: number): Step[] => [
  { x: 0, f: rhythm.night.power.onTemperature },
  ...Object.entries(rhythm.night.temperatures)
    .filter(([time]) => temperatureInPowerWindow(time, rhythm.night.power))
    .map(([time, f]) => ({ x: minutesAfterOn(time, rhythm.night.power.on), f }))
    .filter(step => step.x < endMin)
    .sort((a, b) => a.x - b.x),
];

// The unit goes on the top tick only; a level keeps its sign on every tick.
export const yTickLabel = (value: number, top: number, format: TemperatureFormat) =>
  (value === top || format === 'level' ? formatDisplayValue(value, format) : String(value));

// UTC, since this is wall-clock arithmetic and a DST change in the browser zone must not shift it.
export const clockAfterOn = (on: string, minutes: number) => moment.utc(on, 'HH:mm').add(minutes, 'minutes').format('h:mm A');
