import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { renderWithProviders } from '@test/renderWithProviders';
import { server } from '@test/setup';
import { getSchedules, getSettings } from '../../mocks/mockData';
import AlarmNotification from './AlarmNotification';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-28T22:00:00Z'));
  const settings = structuredClone(getSettings());
  settings.timeZone = 'UTC';
  settings.left.scheduleOverrides.alarm = { disabled: false, timeOverride: '', expiresAt: '' };
  server.use(http.get('*/settings', () => HttpResponse.json(settings)));
});
afterEach(() => vi.useRealTimers());

function alarms(times: Array<[string, boolean]>, powerOff = '09:00') {
  const schedules = structuredClone(getSchedules());
  const day = schedules.left.monday;
  day.power = { ...day.power, enabled: true, on: '21:00', off: powerOff };
  day.alarms = times.map(([time, enabled]) => ({ ...day.alarm, time, enabled }));
  day.alarm = day.alarms[0];
  server.use(http.get('*/schedules', () => HttpResponse.json(schedules)));
}

it('shows the next enabled secondary alarm and preserves 24-hour dialog input', async () => {
  alarms([['07:00', false], ['23:00', true], ['08:00', true]]);
  renderWithProviders(<AlarmNotification />);
  expect(await screen.findByText('Alarm today at 11:00 PM')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Change' }));
  expect(await screen.findByLabelText('Alarm')).toHaveValue('23:00');
  expect(screen.getByText(/replaces all recurring alarms/i)).toBeInTheDocument();
});

it('disabling the night expires after all its alarms, on the correct overnight date', async () => {
  alarms([['23:00', true], ['08:00', true]]);
  let payload: any;
  server.use(http.post('*/settings', async ({ request }) => {
    payload = await request.json();
    return HttpResponse.json(getSettings());
  }));
  renderWithProviders(<AlarmNotification />);
  fireEvent.click(await screen.findByRole('button', { name: 'Skip' }));
  fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Skip' }));
  await waitFor(() => expect(payload?.left.scheduleOverrides.alarm.disabled).toBe(true));
  expect(payload.left.scheduleOverrides.alarm.expiresAt).toBe('2026-09-29T09:00:00Z');
});

it('keeps a later replacement visible after the original alarm time has passed', async () => {
  vi.setSystemTime(new Date('2026-09-29T07:30:00Z'));
  alarms([['07:00', true]]);
  const settings = structuredClone(getSettings());
  settings.timeZone = 'UTC';
  settings.left.scheduleOverrides.alarm = { disabled: false, timeOverride: '08:00', expiresAt: '2026-09-29T09:00:00Z' };
  server.use(http.get('*/settings', () => HttpResponse.json(settings)));
  renderWithProviders(<AlarmNotification />);
  expect(await screen.findByText('Alarm today at 8:00 AM')).toBeInTheDocument();
});


it('keeps alarms visible inside a full-day power window', async () => {
  alarms([['23:00', true]], '21:00');
  renderWithProviders(<AlarmNotification />);
  expect(await screen.findByText('Alarm today at 11:00 PM')).toBeInTheDocument();
});

it('does not carry a completed full-day override into the next night', async () => {
  vi.setSystemTime(new Date('2026-09-29T22:00:00Z'));
  const schedules = structuredClone(getSchedules());
  for (const day of Object.values(schedules.left)) {
    day.power = { ...day.power, enabled: true, on: '21:00', off: '21:00' };
    day.alarms = [{ ...day.alarm, time: '23:00', enabled: true }];
    day.alarm = day.alarms[0];
  }
  const settings = structuredClone(getSettings());
  settings.timeZone = 'UTC';
  settings.left.scheduleOverrides.alarm = { disabled: true, timeOverride: '', expiresAt: '2026-09-29T21:00:00Z' };
  server.use(http.get('*/settings', () => HttpResponse.json(settings)), http.get('*/schedules', () => HttpResponse.json(schedules)));
  renderWithProviders(<AlarmNotification />);
  expect(await screen.findByText('Alarm today at 11:00 PM')).toBeInTheDocument();
});


it('uses the overridden alarm date when the replacement moves before midnight', async () => {
  alarms([['07:00', true]]);
  const settings = structuredClone(getSettings());
  settings.timeZone = 'UTC';
  settings.left.scheduleOverrides.alarm = { disabled: false, timeOverride: '23:00', expiresAt: '2026-09-29T09:00:00Z' };
  server.use(http.get('*/settings', () => HttpResponse.json(settings)));
  renderWithProviders(<AlarmNotification />);
  expect(await screen.findByText('Alarm today at 11:00 PM')).toBeInTheDocument();
  expect(screen.getByText(/Alarm today at/)).toBeInTheDocument();
  expect(screen.queryByText(/Alarm tomorrow at/)).not.toBeInTheDocument();
});

it('makes changing the upcoming alarm an explicit action beside its time', async () => {
  alarms([['07:00', true]]);
  renderWithProviders(<AlarmNotification/>);
  expect(await screen.findByText('Alarm tomorrow at 7:00 AM')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Change' }));
  expect(await screen.findByRole('dialog', { name: /Change this night's recurring alarms/ })).toBeInTheDocument();
});

it('opens the change dialog without an error when the bed turns off at wake', async () => {
  alarms([['07:00', true]], '07:00');
  renderWithProviders(<AlarmNotification/>);
  expect(await screen.findByText('Alarm tomorrow at 7:00 AM')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Change' }));
  expect(await screen.findByLabelText('Alarm')).toHaveValue('07:00');
  expect(screen.queryByText('Already past or too late.')).not.toBeInTheDocument();
  expect(screen.getByLabelText('Alarm')).not.toBeInvalid();
});

it('still rejects a replacement after the night ends', async () => {
  alarms([['07:00', true]], '07:00');
  renderWithProviders(<AlarmNotification/>);
  expect(await screen.findByText('Alarm tomorrow at 7:00 AM')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Change' }));
  fireEvent.change(await screen.findByLabelText('Alarm'), { target: { value: '07:01' } });
  expect(screen.getByText('Already past or too late.')).toBeInTheDocument();
});

it('shows upstream recurring alarms when the optional alarmsEnabled flag is absent', async () => {
  alarms([['23:00', true]]);
  const settings = structuredClone(getSettings());
  settings.timeZone = 'UTC';
  delete (settings.left as Partial<typeof settings.left>).alarmsEnabled;
  server.use(http.get('*/settings', () => HttpResponse.json(settings)));
  renderWithProviders(<AlarmNotification />);
  expect(await screen.findByText('Alarm today at 11:00 PM')).toBeInTheDocument();
});

it('puts the alarm and its actions on one row, with 44 px actions', async () => {
  alarms([['23:00', true]]);
  renderWithProviders(<AlarmNotification />);
  const line = await screen.findByText('Alarm today at 11:00 PM');
  const change = screen.getByRole('button', { name: 'Change' });
  expect(change).toHaveStyle({ minHeight: '44px', fontSize: '15px' });
  expect(line.parentElement!.parentElement).toContainElement(change);
  expect(change.parentElement).toHaveStyle({ marginLeft: 'auto' });
});
