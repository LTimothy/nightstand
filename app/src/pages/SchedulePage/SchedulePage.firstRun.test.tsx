import { beforeEach, expect, it } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { renderWithProviders } from '@test/renderWithProviders';
import { server } from '@test/setup';
import { useAppStore } from '@state/appStore';
import { useScheduleStore } from './scheduleStore';
import SchedulePage from './SchedulePage';
import { getSchedules } from '../../mocks/mockData';

beforeEach(() => {
  useAppStore.setState({ side: 'left', isUpdating: false });
  useScheduleStore.setState(useScheduleStore.getInitialState(), true);
});

it('offers setup for an unused side and preserves its saved times when starting', async () => {
  const schedules = structuredClone(getSchedules());
  for (const day of Object.values(schedules.left)) {
    day.power = { ...day.power, enabled: false, on: '22:15', off: '08:30' };
    day.temperatures = {};
    day.alarm = { ...day.alarm, enabled: false, time: '08:00' };
    day.alarms = [];
  }
  server.use(http.get('*/schedules', () => HttpResponse.json(schedules)));
  renderWithProviders(<SchedulePage/>);
  fireEvent.click(await screen.findByRole('button', { name: 'Set bedtime and wake time' }));
  expect(screen.getByLabelText('Turn on at')).toHaveValue('22:15');
  expect(screen.getByLabelText('Wake at')).toHaveValue('08:00');
  expect(useScheduleStore.getState().selectedSchedule?.power.off).toBe('08:30');
  expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
});

it('starts a night on an unused side with a double pulse at full strength for 30 s', async () => {
  const schedules = structuredClone(getSchedules());
  for (const day of Object.values(schedules.left)) {
    day.power = { ...day.power, enabled: false };
    day.temperatures = {};
    day.alarm = { ...day.alarm, enabled: false, vibrationIntensity: 30, vibrationPattern: 'rise', duration: 10 };
    day.alarms = [];
  }
  server.use(http.get('*/schedules', () => HttpResponse.json(schedules)));
  renderWithProviders(<SchedulePage/>);
  fireEvent.click(await screen.findByRole('button', { name: 'Set bedtime and wake time' }));
  const { vibrationIntensity, vibrationPattern, duration } = useScheduleStore.getState().getEditedAlarms()[0];
  expect({ vibrationIntensity, vibrationPattern, duration }).toEqual({ vibrationIntensity: 100, vibrationPattern: 'double', duration: 30 });
});
