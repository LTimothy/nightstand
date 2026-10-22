import { describe, expect, it } from 'vitest';
import type { NightLog } from '@api/rhythmsSchema';
import { createDemoRhythms } from '../../../mocks/rhythmsMock';
import { rhythmOverlay } from './rhythmOverlay';

const demo = createDemoRhythms(new Date('2026-10-12T19:00:00Z'));
// Off days: on at 23:00 with 82 °F, 79 °F at 3:00 AM, off at 7:00 AM. The chart works in UTC here.
const offDays = demo.right.rhythms['off-days'];
const at = (date: string, hours: number) => new Date(Date.parse(`${date}T23:00:00.000Z`) + hours * 3_600_000).toISOString();
const change = (date: string, hours: number, targetF: number, fromF = 82) =>
  ({ at: at(date, hours), fromF, targetF, plannedF: 82, held: false, source: 'api' as const });
// A night as the Pod wrote it: the plan's steps, the power-off, and the hand changes given.
const night = (date: string, changes: NightLog['changes'] = [], over: Partial<NightLog> = {}): NightLog => ({
  date, rhythmId: 'off-days', tonight: false, excluded: false, samePlan: true, start: at(date, 0), endMin: 480,
  plan: [{ offsetMin: 0, temperatureF: 82 }, { offsetMin: 240, temperatureF: 79 }],
  sets: [{ at: at(date, 0), temperatureF: 82 }, { at: at(date, 4), temperatureF: 79 }, { at: at(date, 8), temperatureF: null }],
  changes, ...over,
});
const dates = Array.from({ length: 16 }, (_, index) => `2026-09-${String(index + 10).padStart(2, '0')}`);
const args = { rhythm: offDays, today: '2026-10-12', timeZone: 'UTC', trackingOn: false };
const overlay = (log: NightLog[]) => rhythmOverlay({ ...args, log });

describe('the chart on a rhythm card', () => {
  it('draws the schedule in steps over the rhythm\'s own length', () => {
    expect(overlay([])).toEqual({ endMin: 480, plan: [{ x: 0, f: 82 }, { x: 240, f: 79 }], nights: 0, drawn: 0, blocks: [], loF: 75, hiF: 86 });
  });

  it('draws a change half or more of the nights made, and never a one-off', () => {
    const log = [
      ...dates.slice(0, 3).map(date => night(date, [change(date, 0.75, 79)])),
      night(dates[3], [change(dates[3], 2, 88)]), night(dates[4]), night(dates[5]),
    ];
    expect(overlay(log)).toMatchObject({ nights: 6, loF: 75, hiF: 86, blocks: [
      { from: 45, to: 240, f: 79, farF: 82, schedule: [{ x: 45, f: 82 }], turned: 'down' },
    ] });
    expect(overlay(log.slice(1)).blocks).toEqual([]);
  });

  it('reads a value held while the schedule moved as kept, with the schedule inside the block', () => {
    const log = dates.slice(0, 6).map(date => night(date, [change(date, 4, 82, 79)]));
    expect(overlay(log).blocks).toEqual([{ from: 240, to: 480, f: 82, farF: 79, schedule: [{ x: 240, f: 79 }], turned: null }]);
  });

  it('skips a difference shorter than the time rounding', () => {
    const log = dates.slice(0, 6).map(date => night(date, [change(date, 0.75, 79), change(date, 0.75 + 10 / 60, 82, 79)]));
    expect(overlay(log).blocks).toEqual([]);
  });

  it('shows nothing of the nights under five, left out or under another plan', () => {
    const changed = dates.slice(0, 5).map(date => night(date, [change(date, 0.75, 79)]));
    expect(overlay(changed)).toMatchObject({ nights: 5, blocks: [expect.objectContaining({ f: 79 })] });
    expect(overlay([{ ...changed[0], excluded: true }, ...changed.slice(1)])).toMatchObject({ nights: 4, blocks: [] });
    expect(overlay([{ ...changed[0], samePlan: false, plan: [] }, ...changed.slice(1)])).toMatchObject({ nights: 4, blocks: [] });
    expect(overlay([{ ...changed[0], tonight: true }, ...changed.slice(1)])).toMatchObject({ nights: 4, blocks: [] });
  });

  it('stops once fewer than half the nights are still running', () => {
    const short = (date: string) => night(date, [], {
      endMin: 300, sets: [{ at: at(date, 0), temperatureF: 82 }, { at: at(date, 4), temperatureF: 79 }, { at: at(date, 5), temperatureF: null }],
    });
    const log = [...dates.slice(0, 4).map(short), ...dates.slice(4, 6).map(date => night(date, [change(date, 5.5, 70, 79)]))];
    expect(overlay(log).blocks).toEqual([]);
  });

  it('shows only a value half or more of all the nights hold, late in the night too', () => {
    const short = (date: string) => night(date, [], {
      endMin: 300, sets: [{ at: at(date, 0), temperatureF: 82 }, { at: at(date, 4), temperatureF: 79 }, { at: at(date, 5), temperatureF: null }],
    });
    const log = [...dates.slice(0, 3).map(short), night(dates[3], [change(dates[3], 5.5, 70, 79)]),
      night(dates[4], [change(dates[4], 5.5, 70, 79)]), night(dates[5])];
    expect(overlay(log).blocks).toEqual([]);
  });

  it('counts a night with nothing written to draw, as the notes do', () => {
    const held = night(dates[1], [], { sets: [{ at: at(dates[1], 8), temperatureF: null }] });
    expect(overlay([night(dates[0]), held])).toMatchObject({ nights: 2, drawn: 1 });
  });

  it('counts the last 14 nights and widens the range to the typical night', () => {
    const log = dates.map(date => night(date, [change(date, 2, 70)]));
    expect(overlay(log)).toMatchObject({ nights: 14, loF: 70, hiF: 86, blocks: [expect.objectContaining({ from: 120, f: 70 })] });
  });

  it('starts a night written before the power-on at the power-on, with the value in force', () => {
    const prewarm = (date: string) => night(date, [], {
      start: at(date, -0.5), sets: [{ at: at(date, -0.5), temperatureF: 88 }, { at: at(date, 1), temperatureF: 80 }],
    });
    const { blocks } = overlay(dates.slice(0, 5).map(prewarm));
    // 80 is below the 82 start and above the 79 step, so the block splits where the schedule crosses it.
    expect(blocks.map(({ from, to, f, turned }) => ({ from, to, f, turned }))).toEqual([
      { from: 0, to: 60, f: 88, turned: 'up' }, { from: 60, to: 240, f: 80, turned: 'down' }, { from: 240, to: 451, f: 80, turned: null },
    ]);
  });

  it('draws tonight\'s curve for a Smart rhythm and the nights that held one value against it', () => {
    const workday = demo.left.rhythms.workday;
    const flat = (date: string): NightLog => {
      const on = Date.parse(`${date}T22:30:00.000Z`);
      return {
        ...night(date, [], { rhythmId: 'workday', endMin: 495, plan: [{ offsetMin: 0, temperatureF: 80 }] }),
        start: new Date(on).toISOString(),
        sets: [{ at: new Date(on).toISOString(), temperatureF: 80 }, { at: new Date(on + 495 * 60_000).toISOString(), temperatureF: null }],
      };
    };
    const drawn = rhythmOverlay({ ...args, rhythm: workday, log: dates.slice(0, 5).map(flat) });
    expect(drawn.endMin).toBe(495);
    expect(drawn.plan[0].x).toBe(0);
    expect(drawn.plan.length).toBeGreaterThan(2);
    expect(drawn.nights).toBe(5);
    expect(drawn.blocks.length).toBeGreaterThan(0);
    // The first block opens the night against the schedule's start; the rest hold the one value.
    const turned = (block: { from: number }) => (block.from === 0 ? 'down' : null);
    expect(drawn.blocks.every(block => block.f === 80 && block.turned === turned(block) && block.schedule.length > 1)).toBe(true);
    expect(rhythmOverlay({ ...args, rhythm: workday, log: [] })).toMatchObject({ nights: 0, blocks: [] });
  });
});
