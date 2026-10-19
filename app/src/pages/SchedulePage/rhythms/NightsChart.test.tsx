import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { NightLog, SuggestionRow } from '@api/rhythmsSchema';
import { palette } from '@design/tokens';
import { createDemoRhythms } from '../../../mocks/rhythmsMock';
import NightsChart from './NightsChart';
import { clockAfterOn, nightsChartModel, yTickLabel } from './nightsChartModel';
import { withRows } from './rhythmsModel';

vi.mock('@mui/x-charts/LineChart', () => ({
  LineChart: (
    { series, xAxis }: { series: Array<{ id: string; color: string; data: number[] }>; xAxis: Array<{ tickInterval: number[] }> },
  ) =>
    <div data-testid="nights">
      { JSON.stringify({ series: series.map(({ id, color, data }) => ({ id, color, data })), ticks: xAxis[0].tickInterval }) }
    </div>,
}));

// Off days: on at 23:00 with 82 °F, 79 °F at 3:00 AM, off at 7:00 AM. The chart works in UTC here.
const offDays = createDemoRhythms(new Date('2026-10-12T19:00:00Z')).right.rhythms['off-days'];
const plan = [{ offsetMin: 0, temperatureF: 82 }, { offsetMin: 240, temperatureF: 79 }];
const night = (date: string, changes: Array<[string, number]>, over: Partial<NightLog> = {}): NightLog => ({
  date, rhythmId: 'off-days', tonight: false, excluded: false, plan, endMin: 480,
  changes: changes.map(([at, targetF]) => ({ at, fromF: 82, targetF, plannedF: 82, held: false, source: 'api' as const })),
  ...over,
});
const row: SuggestionRow = {
  kind: 'step', key: 'step:down', direction: 'down', supporting: 2, firstNight: '2026-10-08', lastNight: '2026-10-09',
  supportingDates: ['2026-10-08', '2026-10-09'], time: '05:00', temperatureF: 77, plannedF: 79,
};
const nights = [
  night('2026-10-08', [['2026-10-09T04:58:00Z', 77]]),
  night('2026-10-09', [['2026-10-10T05:03:00Z', 77]]),
  night('2026-10-10', []),
  night('2026-10-11', [['2026-10-11T23:30:00Z', 85]]),
  night('2026-10-07', [['2026-10-08T01:00:00Z', 70]]),
  night('2026-10-06', [['2026-10-07T01:00:00Z', 75]], { excluded: true }),
  night('2026-10-12', [], { tonight: true }),
  night('2026-10-05', [['2026-10-06T01:00:00Z', 80]], { samePlan: false }),
];
const model = () => nightsChartModel({ rhythm: offDays, after: withRows(offDays, [row]), nights, rows: [row], timeZone: 'UTC' });

describe('the nights chart model', () => {
  it('draws the plan first, one line per counted night, and the change last', () => {
    expect(model().lines.map(line => line.id)).toEqual([
      'plan', 'night-2026-10-08', 'night-2026-10-09', 'night-2026-10-10', 'night-2026-10-11', 'night-2026-10-07', 'change',
    ]);
  });

  it('marks supporting nights by direction and leaves the rest plain', () => {
    const byId = Object.fromEntries(model().lines.map(line => [line.id, line]));
    expect(byId['night-2026-10-08'].direction).toBe('down');
    expect(byId['night-2026-10-11'].direction).toBeUndefined();
  });

  it('puts a quiet night on the plan line', () => {
    const { lines } = model();
    expect(lines.find(line => line.id === 'night-2026-10-10')?.values).toEqual(lines[0].values);
  });

  it('keeps the range near the plan and clips a far night at the edge with a mark', () => {
    const result = model();
    expect(result.loF).toBe(75);
    expect(result.hiF).toBe(86);
    expect(Math.min(...result.lines.find(line => line.id === 'night-2026-10-07')!.values)).toBeCloseTo(result.loF);
    expect(result.clips).toEqual([{ x: 120, edge: 'bottom' }]);
  });

  it('ticks at power-on, the suggested time and power-off, dropping a label that would crowd another', () => {
    expect(model().ticks).toEqual([0, 360, 480]);
    const early = { ...row, time: '23:45' };
    expect(nightsChartModel({ rhythm: offDays, after: withRows(offDays, [early]), nights, rows: [early], timeZone: 'UTC' }).ticks)
      .toEqual([45, 480]);
    const close = [{ ...row, time: '00:30' }, { ...row, key: 'step:up', direction: 'up' as const, time: '01:30', temperatureF: 84 }];
    expect(nightsChartModel({ rhythm: offDays, after: withRows(offDays, close), nights, rows: close, timeZone: 'UTC' }).ticks)
      .toEqual([90, 150, 480]);
  });

  it('labels the new step and formats the axes', () => {
    expect(model().label).toEqual({ x: 360, f: 77, fromF: 79 });
    expect(yTickLabel(88, 88, 'fahrenheit')).toBe('88°F');
    expect(yTickLabel(72, 88, 'fahrenheit')).toBe('72');
    expect(yTickLabel(-2, 1, 'level')).toBe('-2');
    expect(yTickLabel(1, 1, 'level')).toBe('+1');
    expect(clockAfterOn('23:00', 360)).toBe('5:00 AM');
  });
});

describe('clockAfterOn', () => {
  it('counts wall-clock time, so a fall-back day in the browser zone does not shift it', () => {
    const zone = process.env.TZ;
    process.env.TZ = 'America/Los_Angeles';
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-01T20:00:00Z'));
    try {
      expect(clockAfterOn('00:30', 120)).toBe('2:30 AM');
    } finally {
      vi.useRealTimers();
      if (zone === undefined) delete process.env.TZ;
      else process.env.TZ = zone;
    }
  });
});

describe('the nights chart', () => {
  it('colours supporting nights by direction, others quietly, and names the figure', () => {
    render(<NightsChart
      rhythm={ offDays }
      after={ withRows(offDays, [row]) }
      nights={ nights }
      rows={ [row] }
      timeZone="UTC"
      format="fahrenheit"
      evidence="2 of 6 nights: 79°F to about 77°F around 5:00 AM."/>);
    const drawn = JSON.parse(screen.getByTestId('nights').textContent!) as { series: Array<{ id: string; color: string }> };
    const color = Object.fromEntries(drawn.series.map(series => [series.id, series.color]));
    expect(color.plan).toBe(palette.text.secondary);
    expect(color['night-2026-10-08']).toBe(palette.step.cool);
    expect(color['night-2026-10-11']).toBe(palette.border.control);
    const caption = 'One line per night. 1 had no change and sits on the dashed line. 2 had other changes.';
    expect(screen.getByText(caption)).toBeInTheDocument();
    expect(screen.getByRole('figure')).toHaveAccessibleName(`2 of 6 nights: 79°F to about 77°F around 5:00 AM. ${caption}`);
    expect(screen.getByText('With this change').closest('[aria-hidden="true"]')).not.toBeNull();
  });
});
