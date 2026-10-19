import { expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import TimeSeriesChart from './TimeSeriesChart';

const hhmm = (date: Date) => date.toISOString().slice(11, 16);

const lineChart = vi.hoisted(() => ({ props: {} as {
  xAxis?: { min: Date; max: Date; tickNumber: number }[];
  series?: { showMark: boolean | ((params: { index: number }) => boolean); connectNulls?: boolean }[];
  dataset?: { value: number | null }[];
  margin?: { right: number };
} }));
vi.mock('@mui/x-charts/LineChart', () => ({ LineChart: (props: typeof lineChart.props) => {
  lineChart.props = props;
  return null;
} }));
it('reserves label space, marks a lone reading, and fixes the time axis to the recording window', () => {
  render(<TimeSeriesChart
    data={ [{ timestamp: new Date('2026-09-28T04:00:00Z'), value: 60 }] }
    startTime="2026-09-28T00:00:00Z"
    endTime="2026-09-28T07:30:00Z"
    xValueFormatter={ hhmm }/>);
  expect(lineChart.props.xAxis?.[0].min.toISOString()).toBe('2026-09-28T00:00:00.000Z');
  expect(lineChart.props.xAxis?.[0].max.toISOString()).toBe('2026-09-28T07:30:00.000Z');
  expect(lineChart.props.xAxis?.[0].tickNumber).toBe(3);
  const showMark = lineChart.props.series?.[0].showMark;
  expect(typeof showMark === 'function' ? showMark({ index: 0 }) : showMark).toBe(true);
  expect(lineChart.props.margin?.right).toBe(24);
});

it('passes a missing reading through as a break in the line, with nothing drawn behind it', () => {
  const data = [
    { timestamp: new Date('2026-09-28T01:00:00Z'), value: 60 },
    { timestamp: new Date('2026-09-28T01:30:00Z'), value: null },
    { timestamp: new Date('2026-09-28T02:00:00Z'), value: 62 },
  ];
  const { container } = render(<TimeSeriesChart
    data={ data }
    xValueFormatter={ hhmm }/>);
  expect(lineChart.props.dataset?.map(point => point.value)).toEqual([60, null, 62]);
  expect(lineChart.props.series?.[0].connectNulls).toBeFalsy();
  expect(container.firstElementChild?.childElementCount).toBe(0);
});

it('marks only a reading with no neighbour to draw a line to', () => {
  const values = [60, 61, null, 62, null, 63, 64];
  render(<TimeSeriesChart
    data={ values.map((value, index) => ({ timestamp: new Date(Date.UTC(2026, 8, 28, 1, index)), value })) }
    xValueFormatter={ hhmm }/>);
  const showMark = lineChart.props.series?.[0].showMark as (params: { index: number }) => boolean;
  expect(values.map((_, index) => showMark({ index }))).toEqual([false, false, false, true, false, false, false]);
});
