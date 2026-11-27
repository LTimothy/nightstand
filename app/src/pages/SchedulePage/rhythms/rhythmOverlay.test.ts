import { describe, expect, it } from 'vitest';
import type { NightLog } from '@api/rhythmsSchema';
import { createDemoRhythms } from '../../../mocks/rhythmsMock';
import { rhythmOverlay } from './rhythmOverlay';
import { MATCH_CURVE, typicalNightText } from './suggestionsCopy';

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
    expect(overlay([])).toEqual({ endMin: 480, plan: [{ x: 0, f: 82 }, { x: 240, f: 79 }], drawn: 0, blocks: [], loF: 75, hiF: 86 });
  });

  it('draws a change half or more of the nights made, and never a one-off', () => {
    const log = [
      ...dates.slice(0, 3).map(date => night(date, [change(date, 0.75, 79)])),
      night(dates[3], [change(dates[3], 2, 88)]), night(dates[4]), night(dates[5]),
    ];
    expect(overlay(log)).toMatchObject({ loF: 75, hiF: 86, blocks: [
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
    expect(overlay(changed)).toMatchObject({ blocks: [expect.objectContaining({ f: 79 })] });
    expect(overlay([{ ...changed[0], excluded: true }, ...changed.slice(1)])).toMatchObject({ blocks: [] });
    expect(overlay([{ ...changed[0], samePlan: false, plan: [] }, ...changed.slice(1)])).toMatchObject({ blocks: [] });
    expect(overlay([{ ...changed[0], tonight: true }, ...changed.slice(1)])).toMatchObject({ blocks: [] });
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
    expect(overlay([night(dates[0]), held])).toMatchObject({ drawn: 1 });
  });

  it('counts the last 14 nights and widens the range to the typical night', () => {
    const log = dates.map(date => night(date, [change(date, 2, 70)]));
    expect(overlay(log)).toMatchObject({ loF: 70, hiF: 86, blocks: [expect.objectContaining({ from: 120, f: 70 })] });
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

  // Workday: on at 22:30, the curve cools from 22:40 and holds from 23:40, wake 6:30, off 6:45.
  const workday = demo.left.rhythms.workday;
  const onAt = (date: string, minutes: number) => new Date(Date.parse(`${date}T22:30:00.000Z`) + minutes * 60_000).toISOString();
  // A null target is a power-off.
  const smartNight = (date: string, changes: Array<[number, number | null]> = [], over: Partial<NightLog> = {}): NightLog => ({
    ...night(date, changes.map(([minutes, targetF]) => ({ ...change(date, 0, 80), at: onAt(date, minutes), targetF: targetF as number })), {
      rhythmId: 'workday', endMin: 495, start: onAt(date, 0), plan: [{ offsetMin: 0, temperatureF: 80 }],
      // The controller's own writes: a cool-down that waited for sleep, then the power-off.
      sets: [{ at: onAt(date, 0), temperatureF: 83 }, { at: onAt(date, 120), temperatureF: 75 }, { at: onAt(date, 495), temperatureF: null }],
    }),
    ...over,
  });
  const smart = (log: NightLog[], rhythm = workday) => rhythmOverlay({ ...args, rhythm, log });
  const noWarmUp = { ...workday, smart: { ...workday.smart, warmUp: false } };

  it('draws tonight\'s curve for a Smart rhythm and leaves out the curve\'s own writes', () => {
    const drawn = smart(dates.slice(0, 5).map(date => smartNight(date)));
    expect(drawn).toMatchObject({ endMin: 495, drawn: 5, blocks: [] });
    expect(drawn.plan[0].x).toBe(0);
    expect(drawn.plan.length).toBeGreaterThan(2);
    expect(typicalNightText(drawn.blocks, '22:30', 'fahrenheit', true)).toBe(MATCH_CURVE);
    expect(smart([])).toMatchObject({ blocks: [] });
  });

  it('holds a cool-down change on a Smart night until the hold phase starts', () => {
    const log = [...dates.slice(0, 3).map(date => smartNight(date, [[15, 90]])), smartNight(dates[3]), smartNight(dates[4])];
    expect(smart(log).blocks.map(({ from, to, f, turned }) => ({ from, to, f, turned }))).toEqual([{ from: 15, to: 70, f: 90, turned: 'up' }]);
    expect(smart(log.slice(1)).blocks).toEqual([]);
  });

  it('holds a change during the hold phase three hours with warm-up off, and never past the power-off', () => {
    const held = smart(dates.slice(0, 5).map(date => smartNight(date, [[120, 90]])), noWarmUp);
    expect(held.blocks.map(({ from, to, f }) => ({ from, to, f }))).toEqual([{ from: 120, to: 300, f: 90 }]);
    const late = { ...noWarmUp, night: { ...noWarmUp.night, power: { ...noWarmUp.night.power, off: '06:30' } } };
    const cut = smart(dates.slice(0, 5).map(date => smartNight(date, [[420, 90]], { endMin: 480 })), late);
    expect(cut.blocks.map(({ from, to, f }) => ({ from, to, f }))).toEqual([{ from: 420, to: 480, f: 90 }]);
  });

  it('lets a later change on a Smart night replace the earlier hold, and ends the line at a power-off', () => {
    const log = dates.slice(0, 5).map(date => smartNight(date, [[120, 90], [180, 70], [200, null]]));
    // A night counts through its last minute, as on a hand-set rhythm.
    expect(smart(log, noWarmUp).blocks.map(({ from, to, f }) => ({ from, to, f })))
      .toEqual([{ from: 120, to: 180, f: 90 }, { from: 180, to: 201, f: 70 }]);
  });
});
