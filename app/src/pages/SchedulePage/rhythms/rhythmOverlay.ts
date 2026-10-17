// The chart on a rhythm card as data: the saved schedule and the last nights as the bed was set, x in minutes after
// the rhythm's power-on (clock time, so every night lines up by the hour), f in °F.
import type { NightLog, Rhythm } from '@api/rhythmsSchema';
import { wallClock } from '@api/rhythmTimes';
import { nightMinutes } from '@api/rhythmWake';
import { WINDOW_NIGHTS } from '@api/suggestionRules';
import { levelToFahrenheit } from '@lib/temperatureConversions';
import { planSteps, RANGE_F, type Step } from './nightsChartModel';
import { previewCurves } from './smartPreview';

const MINUTE = 60_000;
export type OverlayNight = { date: string; dim: boolean; points: Step[]; end: number };
export type Overlay = { endMin: number; loF: number; hiF: number; plan: Step[]; nights: OverlayNight[] };
// Last night, the six before it, and older or dimmed nights. 0.4 is the least that keeps a 3:1 line on the card in every look.
export const NIGHT_OPACITY = { last: 1, recent: 0.6, older: 0.4 } as const;
type Args = { rhythm: Rhythm; log: NightLog[]; today: string; timeZone: string; trackingOn: boolean };

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
function nightLine(night: NightLog, origin: number, endMin: number): OverlayNight | null {
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
  return points.length ? { date: night.date, dim: night.samePlan === false || night.excluded, points, end } : null;
}

export function rhythmOverlay(args: Args): Overlay {
  const { rhythm, log, timeZone } = args;
  const endMin = nightMinutes(rhythm.night.power);
  const plan = schedule(args, endMin);
  const nights = log.filter(night => night.rhythmId === rhythm.id && !night.tonight)
    .sort((a, b) => b.date.localeCompare(a.date))
    .flatMap(night => {
      const drawn = nightLine(night, wallClock(night.date, rhythm.night.power.on, timeZone).getTime(), endMin);
      return drawn ? [drawn] : [];
    })
    .slice(0, WINDOW_NIGHTS);
  const planned = plan.map(step => step.f);
  const drawn = nights.flatMap(night => night.points.map(point => point.f));
  // The schedule's values and RANGE_F either way, widened to the nights drawn, so no night is clipped in silence.
  return {
    endMin, plan, nights,
    loF: Math.min(Math.min(...planned) - RANGE_F, ...drawn),
    hiF: Math.max(Math.max(...planned) + RANGE_F, ...drawn),
  };
}
