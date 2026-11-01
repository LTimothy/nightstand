// The review chart as data: the saved schedule, where the suggestion changes it, and the nights that voted for it.
// x is minutes after the rhythm's power-on, f is °F.
import type { Rhythm, SuggestionRow, SuggestionVote } from '@api/rhythmsSchema';
import { nightMinutes } from '@api/rhythmWake';
import { displayTemperature } from '@lib/temperatureConversions';
import { planSteps, RANGE_F, type Step } from './nightsChartModel';
import type { ChartDot } from './OverlayChart';
import type { Block } from './rhythmOverlay';
import { withRows } from './rhythmsModel';

// A night this far from the others' median is marked Unusual; it still counts.
export const UNUSUAL_F = 5;
const UNUSUAL_MIN_VOTES = 3;

const valueAt = (steps: Step[], x: number) => steps.reduce((value, step) => (step.x <= x ? step.f : value), steps[0].f);

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function unusualDates(votes: SuggestionVote[]): string[] {
  if (votes.length < UNUSUAL_MIN_VOTES) return [];
  return votes
    .filter((vote, index) => {
      const others = votes.filter((_, other) => other !== index).map(v => v.temperatureF);
      return Math.abs(vote.temperatureF - median(others)) > UNUSUAL_F;
    })
    .map(vote => vote.date);
}

// One block per run where the suggested schedule holds a value other than the saved one.
function blocksBetween(plan: Step[], after: Step[], endMin: number): Block[] {
  const edges = [...new Set([0, endMin, ...plan.map(s => s.x), ...after.map(s => s.x)])].sort((a, b) => a - b);
  const blocks: Block[] = [];
  let open: { from: number; f: number } | null = null;
  const close = (to: number) => {
    if (!open) return;
    const { from, f } = open;
    const schedule = [{ x: from, f: valueAt(plan, from) }, ...plan.filter(step => step.x > from && step.x < to)];
    const values = schedule.map(step => step.f);
    const cool = f < valueAt(plan, from);
    const before = from > 0 ? valueAt(after, from - 1) : valueAt(plan, 0);
    const farF = cool ? Math.max(...values) : Math.min(...values);
    blocks.push({ from, to, f, farF, schedule, turned: before === f ? null : f < before ? 'down' : 'up' });
    open = null;
  };
  for (const x of edges.slice(0, -1)) {
    const f = valueAt(after, x);
    if (open && (open as { f: number }).f !== f) close(x);
    if (!open && f !== valueAt(plan, x)) open = { from: x, f };
  }
  close(endMin);
  return blocks;
}

export function suggestionOverlay(rhythm: Rhythm, rows: SuggestionRow[]) {
  const endMin = nightMinutes(rhythm.night.power);
  const plan = planSteps(rhythm, endMin);
  const after = planSteps(withRows(rhythm, rows), endMin);
  const blocks = blocksBetween(plan, after, endMin);
  const planned = plan.map(step => step.f);
  const suggested = after.map(step => step.f);
  const loF = Math.min(Math.min(...planned) - RANGE_F, ...suggested);
  const hiF = Math.max(Math.max(...planned) + RANGE_F, ...suggested);
  const dots = rows.flatMap(row => (row.kind === 'base' ? [] : row.votes ?? [])).map((vote): ChartDot => {
    const f = Math.min(hiF, Math.max(loF, vote.temperatureF));
    const edge = vote.temperatureF < loF ? 'bottom' : vote.temperatureF > hiF ? 'top' : undefined;
    return { x: vote.offsetMin, f, key: vote.date, ...(edge && { edge, label: displayTemperature(vote.temperatureF, 'fahrenheit') }) };
  });
  const ticks = [0, blocks[0] ? blocks[0].from : endMin / 2, endMin];
  return { endMin, loF, hiF, plan, blocks, dots, ticks };
}
