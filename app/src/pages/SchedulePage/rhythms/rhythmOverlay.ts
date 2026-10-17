// The chart on a rhythm card as data: the saved schedule and, where it differs, a typical night of the recent nights,
// x in minutes after the rhythm's power-on (clock time, so every night lines up by the hour), f in °F.
import type { NightLog, Rhythm } from '@api/rhythmsSchema';
import { wallClock } from '@api/rhythmTimes';
import { nightMinutes } from '@api/rhythmWake';
import { MIN_NIGHTS, TIME_ROUND_MIN, WINDOW_NIGHTS } from '@api/suggestionRules';
import { levelToFahrenheit } from '@lib/temperatureConversions';
import { planSteps, RANGE_F, type Step } from './nightsChartModel';
import { previewCurves } from './smartPreview';

const MINUTE = 60_000;
// The tint inside a block, over the card. Its dashed edge in the full step colour is the 3:1 mark.
export const BLOCK_OPACITY = 0.22;
// One stretch where the typical night held one value and the schedule had another. `schedule` starts at `from`;
// `farF` is the schedule's value farthest from `f` inside it. `turned` is how the typical night moved at `from`,
// null when it held still and the schedule moved instead.
export type Block = { from: number; to: number; f: number; farF: number; schedule: Step[]; turned: 'down' | 'up' | null };
export type Overlay = { endMin: number; loF: number; hiF: number; plan: Step[]; nights: number; blocks: Block[] };
type Args = { rhythm: Rhythm; log: NightLog[]; today: string; timeZone: string; trackingOn: boolean };
type Night = { points: Step[]; end: number };

const valueAt = (steps: Step[], x: number) => steps.reduce((value, step) => (step.x <= x ? step.f : value), steps[0].f);

// Starts a step line at 0 with the value in force there and cuts it at `end`; what falls outside the axis is not drawn.
function within(points: Step[], end: number): Step[] {
  const sorted = [...points].sort((a, b) => a.x - b.x);
  const before = sorted.filter(point => point.x <= 0);
  const first = before.length ? [{ x: 0, f: before[before.length - 1].f }] : [];
  return [...first, ...sorted.filter(point => point.x > 0 && point.x < end)];
}

// Tonight's curve for a Smart rhythm, the saved steps for a hand-set one.
function schedule({ rhythm, today, timeZone, trackingOn }: Args, endMin: number): Step[] {
  if (rhythm.temperatureMode !== 'smart') return planSteps(rhythm, endMin);
  const origin = wallClock(today, rhythm.night.power.on, timeZone).getTime();
  const { series } = previewCurves({ night: rhythm.night, wake: rhythm.wake, smart: rhythm.smart, date: today, timeZone, trackingOn });
  return within(series.map(point => ({ x: Math.round((point.at.getTime() - origin) / MINUTE), f: levelToFahrenheit(point.level) })), endMin);
}

// One ended night as the bed was set: the scheduler's writes and the hand changes in time order, ending at the
// first power-off, the night's own end or the axis. A night noted before the writes were kept holds from its first change.
function nightLine(night: NightLog, origin: number, endMin: number): Night | null {
  const minutes = (at: string) => Math.round((Date.parse(at) - origin) / MINUTE);
  const events = [
    ...(night.sets ?? []).map(set => ({ x: minutes(set.at), f: set.temperatureF, hand: 0 })),
    ...night.changes.map(change => ({ x: minutes(change.at), f: change.targetF as number | null, hand: 1 })),
  ].sort((a, b) => a.x - b.x || a.hand - b.hand);
  const off = events.find(event => event.f === null);
  // Some power-offs write no off line, so the night's end always counts.
  const ended = (night.start ? minutes(night.start) : 0) + night.endMin;
  const end = Math.min(endMin, ended, off?.x ?? endMin);
  if (end <= 0) return null;
  const points = within(events.flatMap(event => (event.f === null ? [] : [{ x: event.x, f: event.f }])), end);
  return points.length ? { points, end } : null;
}

// The value half or more of the nights were set to at each minute, null while fewer than half are still running.
// An even count's tie goes to the value farther from the schedule, so a change on exactly half the nights shows.
function typicalNight(nights: Night[], plan: Step[], endMin: number): Array<number | null> {
  return Array.from({ length: endMin + 1 }, (_, minute) => {
    const values = nights.filter(night => minute >= night.points[0].x && minute <= night.end)
      .map(night => valueAt(night.points, minute)).sort((a, b) => a - b);
    if (values.length * 2 < nights.length) return null;
    const middle = values.length >> 1;
    if (values.length % 2) return values[middle];
    const planned = valueAt(plan, minute);
    return Math.abs(values[middle - 1] - planned) >= Math.abs(values[middle] - planned) ? values[middle - 1] : values[middle];
  });
}

// Where the typical night differs from the schedule, split where it changes value or crosses the schedule.
function differences(typical: Array<number | null>, plan: Step[], endMin: number): Block[] {
  type Open = { from: number; f: number; cool: boolean; turned: Block['turned'] };
  const blocks: Block[] = [];
  // A difference shorter than the time rounding is noise, not a habit.
  const close = (open: Open, to: number) => {
    if (to - open.from < TIME_ROUND_MIN) return;
    const schedule = [{ x: open.from, f: valueAt(plan, open.from) }, ...plan.filter(step => step.x > open.from && step.x < to)];
    const values = schedule.map(step => step.f);
    blocks.push({ from: open.from, to, f: open.f, farF: open.cool ? Math.max(...values) : Math.min(...values), schedule, turned: open.turned });
  };
  let open: Open | null = null;
  for (let minute = 0; minute <= endMin; minute += 1) {
    const value = typical[minute];
    const planned = valueAt(plan, minute);
    const cool = value !== null && value < planned;
    if (open && (value !== open.f || cool !== open.cool)) {
      close(open, minute);
      open = null;
    }
    if (!open && value !== null && value !== planned) {
      const before = minute > 0 ? typical[minute - 1] : null;
      open = { from: minute, f: value, cool, turned: before === value ? null : value < (before ?? planned) ? 'down' : 'up' };
    }
  }
  if (open) close(open, endMin);
  return blocks;
}

export function rhythmOverlay(args: Args): Overlay {
  const { rhythm, log, timeZone } = args;
  const endMin = nightMinutes(rhythm.night.power);
  const plan = schedule(args, endMin);
  // The notes' own rule: a night left out or under another plan does not count.
  const nights = log.filter(night => night.rhythmId === rhythm.id && !night.tonight && !night.excluded && night.samePlan !== false)
    .sort((a, b) => b.date.localeCompare(a.date))
    .flatMap(night => {
      const drawn = nightLine(night, wallClock(night.date, rhythm.night.power.on, timeZone).getTime(), endMin);
      return drawn ? [drawn] : [];
    })
    .slice(0, WINDOW_NIGHTS);
  const blocks = nights.length >= MIN_NIGHTS && plan.length ? differences(typicalNight(nights, plan, endMin), plan, endMin) : [];
  const planned = plan.map(step => step.f);
  const typical = blocks.map(block => block.f);
  // The schedule's values and RANGE_F either way, widened to the typical night where it is drawn.
  return {
    endMin, plan, nights: nights.length, blocks,
    loF: Math.min(Math.min(...planned) - RANGE_F, ...typical),
    hiF: Math.max(Math.max(...planned) + RANGE_F, ...typical),
  };
}
