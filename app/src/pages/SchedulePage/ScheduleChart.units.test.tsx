import { expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { getSchedules } from '../../mocks/mockData';
import { useScheduleStore } from './scheduleStore';
import TemperatureScheduleChart from './ScheduleChart';
vi.mock('@api/deviceStatus.ts', async importOriginal => ({
  ...(await importOriginal<typeof import('@api/deviceStatus.ts')>()), useDeviceStatus: () => ({ data: undefined }),
}));
vi.mock('@api/settings.ts', () => ({ useSettings: () => ({ data: { temperatureFormat: 'level', timeZone: 'Asia/Tokyo' } }) }));
vi.mock('@mui/x-charts/LineChart', () => ({
  LineChart: ({ yAxis, xAxis, onAxisClick }: {
    xAxis: Array<{ data: Date[]; valueFormatter: (date: Date) => string }>;
    yAxis: Array<{ label?: string }>;
    onAxisClick: (event: unknown, data: { dataIndex: number }) => void;
  }) => <div aria-label="Temperature plot" onClick={ () => onAxisClick(undefined, { dataIndex: 1 }) }>
    { yAxis[0].label }<span>{ xAxis[0].valueFormatter(new Date('2026-09-28T12:00:00Z')) }</span>
    <span>{ xAxis[0].data[0].toISOString() }</span>
  </div>,
  lineElementClasses: {}, areaElementClasses: {},
}));
it('omits the repeated axis title, step chips and wake caption', () => {
  useScheduleStore.setState({ selectedSchedule: getSchedules().left.monday });
  render(<TemperatureScheduleChart/>);
  expect(screen.queryByText('Level')).not.toBeInTheDocument();
  expect(screen.queryByText(/^Wake /)).not.toBeInTheDocument();
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
});

it('focuses the matching row when its chart step is selected', () => {
  const schedule = structuredClone(getSchedules().left.monday);
  schedule.temperatures = { '01:00': 83 };
  schedule.power.on = '21:00';
  schedule.power.off = '09:00';
  useScheduleStore.setState({ selectedSchedule: schedule });
  render(<><TemperatureScheduleChart/><div id="schedule-temperature-01:00"><input type="time" aria-label="Change time"/></div></>);
  fireEvent.click(screen.getByLabelText('Temperature plot'));
  expect(screen.getByLabelText('Change time')).toHaveFocus();
});

it('formats absolute chart times in the Pod timezone and builds its bedtime in that timezone', () => {
  const schedule = structuredClone(getSchedules().left.monday);
  schedule.power = { ...schedule.power, enabled: true, on: '21:00', off: '09:00' };
  useScheduleStore.setState({ selectedSchedule: schedule });
  render(<TemperatureScheduleChart/>);
  expect(screen.getByText('9:00 PM')).toBeInTheDocument();
  expect(screen.getByText(/T12:00:00.000Z$/)).toBeInTheDocument();
});
