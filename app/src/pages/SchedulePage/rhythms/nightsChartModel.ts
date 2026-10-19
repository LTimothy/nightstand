// The nights behind a suggestion as chart data: x is minutes after the power-on, values are °F.
import moment from 'moment-timezone';
import type { NightLog, Rhythm, SuggestionRow } from '@api/rhythmsSchema';
import { wallClock } from '@api/rhythmTimes';
import { minutesAfterOn, temperatureInPowerWindow } from '@api/rhythmWake';
import { formatDisplayValue, type TemperatureFormat } from '@lib/temperatureConversions';

export type Step = { x: number; f: number };
export type ChartLine = { id: string; kind: 'plan' | 'night' | 'change'; date?: string; direction?: 'down' | 'up'; values: number[] };
export type ClipMark = { x: number; edge: 'top' | 'bottom' };
export type NightsChartModel = {
  xs: number[]; endMin: number; lines: ChartLine[]; loF: number; hiF: number; ticks: number[];
  label: { x: number; f: number; fromF: number } | null; clips: ClipMark[];
};
type ValueRow = Extract<SuggestionRow, { kind: 'step' | 'on' }>;

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

// What one night did: its plan's steps and its hand changes, in time order.
function nightSteps(night: NightLog, rhythm: Rhythm, timeZone: string): Step[] {
  const start = wallClock(night.date, rhythm.night.power.on, timeZone).getTime();
  return [
    ...night.plan.map(step => ({ x: step.offsetMin, f: step.temperatureF })),
    ...night.changes.map(change => ({ x: Math.max(0, Math.round((Date.parse(change.at) - start) / 60_000)), f: change.targetF })),
  ].sort((a, b) => a.x - b.x);
}

const valueAt = (steps: Step[], x: number) => steps.reduce((value, step) => (step.x <= x ? step.f : value), steps[0].f);

type ModelArgs = { rhythm: Rhythm; after: Rhythm; nights: NightLog[]; rows: SuggestionRow[]; timeZone: string };

export function nightsChartModel(args: ModelArgs): NightsChartModel {
  const { rhythm, after, rows, timeZone } = args;
  const nights = args.nights.filter(night => !night.excluded && !night.tonight && night.samePlan !== false);
  const { power } = rhythm.night;
  const nightLength = power.off === power.on ? 1440 : minutesAfterOn(power.off, power.on);
  const endMin = nights.length ? Math.max(...nights.map(night => night.endMin)) : nightLength;
  const plan = planSteps(rhythm, endMin);
  const changed = planSteps(after, endMin);
  const perNight = nights.map(night => ({ night, steps: nightSteps(night, rhythm, timeZone).filter(step => step.x <= endMin) }));
  const xs = [...new Set([0, endMin, ...plan.map(step => step.x), ...changed.map(step => step.x),
    ...perNight.flatMap(({ steps }) => steps.map(step => step.x))])].sort((a, b) => a - b);
  const planned = plan.map(step => step.f);
  const suggested = changed.map(step => step.f);
  // The plan's values and RANGE_F either way, widened only to fit the change, so one far night does not flatten the rest.
  const loF = Math.min(Math.min(...planned) - RANGE_F, ...suggested);
  const hiF = Math.max(Math.max(...planned) + RANGE_F, ...suggested);
  const clips: ClipMark[] = [];
  const clipped = (steps: Step[]) => {
    let outside = false;
    return xs.map(x => {
      const f = valueAt(steps, x);
      const edge = f < loF ? 'bottom' : f > hiF ? 'top' : null;
      if (edge && !outside) clips.push({ x, edge });
      outside = edge !== null;
      return Math.min(hiF, Math.max(loF, f));
    });
  };
  const directionOf = (date: string) => rows.find(row => row.supportingDates.includes(date))?.direction;
  const lines: ChartLine[] = [
    { id: 'plan', kind: 'plan', values: xs.map(x => valueAt(plan, x)) },
    ...perNight.map(({ night, steps }): ChartLine => ({
      id: `night-${night.date}`, kind: 'night', date: night.date, direction: directionOf(night.date), values: clipped(steps),
    })),
    { id: 'change', kind: 'change', values: xs.map(x => valueAt(changed, x)) },
  ];
  // The suggestion's own times always keep their labels; power-on and power-off are dropped where they would crowd one.
  const gap = endMin / 4;
  const ticks = [...new Set(rows.map(row => (row.kind === 'step' ? minutesAfterOn(row.time, power.on) : 0)))];
  for (const x of [0, endMin]) {
    if (ticks.every(tick => Math.abs(tick - x) >= gap)) ticks.push(x);
  }
  const first = rows.find((row): row is ValueRow => row.kind !== 'base');
  const label = first
    ? { x: first.kind === 'step' ? minutesAfterOn(first.time, power.on) : 0, f: first.temperatureF, fromF: first.plannedF } : null;
  return { xs, endMin, lines, loF, hiF, ticks: ticks.sort((a, b) => a - b), label, clips };
}

// The unit goes on the top tick only; a level keeps its sign on every tick.
export const yTickLabel = (value: number, top: number, format: TemperatureFormat) =>
  (value === top || format === 'level' ? formatDisplayValue(value, format) : String(value));

// UTC, since this is wall-clock arithmetic and a DST change in the browser zone must not shift it.
export const clockAfterOn = (on: string, minutes: number) => moment.utc(on, 'HH:mm').add(minutes, 'minutes').format('h:mm A');
