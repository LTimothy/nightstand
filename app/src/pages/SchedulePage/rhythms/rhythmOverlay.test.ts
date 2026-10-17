import { describe, expect, it } from 'vitest';
import type { NightLog } from '@api/rhythmsSchema';
import { createDemoRhythms } from '../../../mocks/rhythmsMock';
import { rhythmOverlay } from './rhythmOverlay';

const demo = createDemoRhythms(new Date('2026-10-12T19:00:00Z'));
// Off days: on at 23:00 with 82 °F, 79 °F at 3:00 AM, off at 7:00 AM. The chart works in UTC here.
const offDays = demo.right.rhythms['off-days'];
const at = (date: string, hours: number) => new Date(Date.parse(`${date}T23:00:00.000Z`) + hours * 3_600_000).toISOString();
const night = (date: string, over: Partial<NightLog> = {}): NightLog => ({
  date, rhythmId: 'off-days', tonight: false, excluded: false, samePlan: true, start: at(date, 0), endMin: 480,
  plan: [{ offsetMin: 0, temperatureF: 82 }, { offsetMin: 240, temperatureF: 79 }], changes: [], ...over,
});
const change = (date: string, hours: number, targetF: number) =>
  ({ at: at(date, hours), fromF: 82, targetF, plannedF: 82, held: false, source: 'api' as const });
const args = { rhythm: offDays, today: '2026-10-12', timeZone: 'UTC', trackingOn: false };
const log = [
  night('2026-10-11', { tonight: true }),
  night('2026-10-10', {
    sets: [
      { at: at('2026-10-10', 0), temperatureF: 82 }, { at: at('2026-10-10', 4), temperatureF: 79 },
      { at: at('2026-10-10', 8), temperatureF: null },
    ],
    changes: [change('2026-10-10', 0.75, 81)],
  }),
  night('2026-10-09', {
    samePlan: false, plan: [], sets: [{ at: at('2026-10-09', 0), temperatureF: 82 }, { at: at('2026-10-09', 3), temperatureF: null }],
  }),
  night('2026-10-08', { changes: [change('2026-10-08', 2, 70)] }),
  night('2026-10-07'),
];

describe('the chart on a rhythm card', () => {
  it('draws the schedule in steps over the rhythm\'s own length', () => {
    const overlay = rhythmOverlay({ ...args, log: [] });
    expect(overlay.endMin).toBe(480);
    expect(overlay.plan).toEqual([{ x: 0, f: 82 }, { x: 240, f: 79 }]);
    expect(overlay.nights).toEqual([]);
    expect([overlay.loF, overlay.hiF]).toEqual([75, 86]);
  });

  it('draws each ended night as the bed was set, newest first, ending where it ended', () => {
    const { nights } = rhythmOverlay({ ...args, log });
    expect(nights.map(night => night.date)).toEqual(['2026-10-10', '2026-10-09', '2026-10-08']);
    expect(nights[0]).toEqual({ date: '2026-10-10', dim: false, end: 480, points: [{ x: 0, f: 82 }, { x: 45, f: 81 }, { x: 240, f: 79 }] });
    expect(nights[1]).toEqual({ date: '2026-10-09', dim: true, end: 180, points: [{ x: 0, f: 82 }] });
    // Noted before the Pod kept what it set: holds from its first change.
    expect(nights[2]).toEqual({ date: '2026-10-08', dim: false, end: 480, points: [{ x: 120, f: 70 }] });
  });

  it('ends a night without a power-off line at the night\'s own end', () => {
    // A Smart power-off when up, or a handoff, writes no off line.
    const early = night('2026-10-10', { endMin: 300, sets: [{ at: at('2026-10-10', 0), temperatureF: 82 }] });
    expect(rhythmOverlay({ ...args, log: [early] }).nights[0].end).toBe(300);
    const late = night('2026-10-10', { start: at('2026-10-10', 1), endMin: 300, sets: [{ at: at('2026-10-10', 1), temperatureF: 82 }] });
    expect(rhythmOverlay({ ...args, log: [late] }).nights[0]).toMatchObject({ end: 360, points: [{ x: 60, f: 82 }] });
  });

  it('starts a night written before the power-on at the power-on, with the value in force', () => {
    const prewarm = night('2026-10-10', {
      start: at('2026-10-10', -0.5),
      sets: [{ at: at('2026-10-10', -0.5), temperatureF: 88 }, { at: at('2026-10-10', 1), temperatureF: 80 }],
    });
    expect(rhythmOverlay({ ...args, log: [prewarm] }).nights[0].points).toEqual([{ x: 0, f: 88 }, { x: 60, f: 80 }]);
  });

  it('widens the range to the nights drawn and dims a night left out', () => {
    const overlay = rhythmOverlay({ ...args, log: [log[3], { ...log[1], excluded: true }] });
    expect([overlay.loF, overlay.hiF]).toEqual([70, 86]);
    expect(overlay.nights.map(night => night.dim)).toEqual([true, false]);
  });

  it('keeps the last 14 nights drawn', () => {
    const many = Array.from({ length: 16 }, (_, index) => {
      const date = `2026-09-${String(index + 10).padStart(2, '0')}`;
      return night(date, { sets: [{ at: at(date, 0), temperatureF: 82 }] });
    });
    expect(rhythmOverlay({ ...args, log: many }).nights).toHaveLength(14);
    expect(rhythmOverlay({ ...args, log: many }).nights[0].date).toBe('2026-09-25');
  });

  it('draws tonight\'s curve for a Smart rhythm, from the power-on', () => {
    const workday = demo.left.rhythms.workday;
    const overlay = rhythmOverlay({ ...args, rhythm: workday, log: [] });
    expect(overlay.endMin).toBe(495);
    expect(overlay.plan[0].x).toBe(0);
    expect(overlay.plan.length).toBeGreaterThan(2);
    expect(overlay.plan.every(point => point.x >= 0 && point.x < 495)).toBe(true);
    expect(overlay.loF).toBe(Math.min(...overlay.plan.map(point => point.f)) - 4);
  });
});
