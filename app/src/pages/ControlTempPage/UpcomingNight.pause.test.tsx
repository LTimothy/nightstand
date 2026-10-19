import { useEffect, useState } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import moment from 'moment-timezone';
import UpcomingNight from './UpcomingNight';
import type { ResolvedSleepResponse } from '@api/rhythmsResponse';
import type { BedSleeps } from './useBedSleeps';

const fixture = vi.hoisted(() => ({
  pause: { active: false, expiresAt: '' },
  awayMode: false,
  timeZone: 'UTC',
  bed: { state: 'legacy' } as BedSleeps,
  serverKnowsPause: true,
  listeners: new Set<() => void>(),
  postSettings: vi.fn(),
  postDeviceStatus: vi.fn(),
  refetch: vi.fn(),
}));
vi.mock('@state/appStore.tsx', () => ({ useAppStore: () => ({ side: 'left' }) }));
const settingsData = () => ({
  timeZone: fixture.timeZone, temperatureFormat: 'fahrenheit',
  left: { name: 'Alex', awayMode: fixture.awayMode, scheduleOverrides: {
    temperatureSchedules: { disabled: false, expiresAt: '' },
    ...(fixture.serverKnowsPause ? { pause: fixture.pause } : {}),
  } },
  right: { name: 'Sam', awayMode: false, scheduleOverrides: { pause: { active: false, expiresAt: '' } } },
});
vi.mock('@api/settings.ts', () => ({
  // Like the real query, every consumer re-renders when a refetch lands.
  useSettings: () => {
    const [, bump] = useState(0);
    useEffect(() => {
      const listener = () => bump((value) => value + 1);
      fixture.listeners.add(listener);
      return () => { fixture.listeners.delete(listener); };
    }, []);
    return { refetch: fixture.refetch, data: settingsData() };
  },
  postSettings: fixture.postSettings,
}));
vi.mock('@api/schedules.ts', () => ({ useSchedules: () => ({ data: { left: { monday: {
  power: { enabled: true, on: '21:00', off: '07:00', onTemperature: 82 }, temperatures: {},
}, tuesday: {
  power: { enabled: true, on: '22:00', off: '07:00', onTemperature: 82 }, temperatures: {},
} } } }) }));
vi.mock('./AlarmNotification', () => ({ default: () => 'Alarm row' }));
vi.mock('./useBedSleeps', () => ({ useBedSleeps: () => fixture.bed }));
vi.mock('@api/deviceStatus.ts', () => ({
  useDeviceStatus: () => ({ data: undefined }),
  postDeviceStatus: fixture.postDeviceStatus,
}));

const renderCard = () => render(<MemoryRouter><UpcomingNight/></MemoryRouter>);

beforeEach(() => {
  vi.spyOn(moment, 'now').mockReturnValue(Date.parse('2026-09-28T20:00:00Z'));
  fixture.pause = { active: false, expiresAt: '' };
  fixture.awayMode = false;
  fixture.timeZone = 'UTC';
  fixture.bed = { state: 'legacy' };
  fixture.serverKnowsPause = true;
  fixture.listeners.clear();
  fixture.postDeviceStatus.mockReset();
  fixture.postSettings.mockReset().mockImplementation(async (body: { left: { scheduleOverrides: { pause: typeof fixture.pause } } }) => {
    fixture.pause = body.left.scheduleOverrides.pause;
    return {};
  });
  fixture.refetch.mockReset().mockImplementation(async () => {
    // The re-render trails the fetch, as React Query's deferred notification does.
    setTimeout(() => fixture.listeners.forEach((listener) => listener()), 0);
    return { data: settingsData() };
  });
});
afterEach(() => vi.restoreAllMocks());

const rhythmSleep = (date: string, next: string): ResolvedSleepResponse => ({
  side: 'left', date, rhythmId: 'workday', mode: 'manual',
  start: `${date}T22:30:00Z`, end: `${next}T06:45:00Z`,
  night: { power: { enabled: true, on: '22:30', off: '06:45', onTemperature: 82 }, temperatures: {},
    alarm: { enabled: false, time: '06:30', vibrationIntensity: 30, vibrationPattern: 'rise', duration: 30, alarmTemperature: 83 }, alarms: [] },
  events: [
    { kind: 'power-on', at: `${date}T22:30:00Z`, temperatureF: 82 },
    { kind: 'power-off', at: `${next}T06:45:00Z` },
  ],
});

const setEngine = (engine: 'legacy' | 'rhythms') => {
  if (engine === 'rhythms') fixture.bed = { state: 'rhythms', names: { workday: 'Workday' },
    sleeps: [rhythmSleep('2026-09-28', '2026-09-29'), rhythmSleep('2026-09-29', '2026-09-30')] };
};

it.each(['legacy', 'rhythms'] as const)('changes a %s pause end with one active pause write', async engine => {
  setEngine(engine);
  vi.spyOn(moment, 'now').mockReturnValue(Date.parse('2026-09-29T03:58:00Z'));
  fixture.timeZone = 'America/Los_Angeles';
  fixture.pause = { active: true, expiresAt: '2026-09-28T21:30:00-07:00' };
  renderCard();
  fireEvent.click(screen.getByRole('button', { name: 'Change pause' }));
  expect(fixture.postSettings).not.toHaveBeenCalled();
  const input = await screen.findByLabelText('Resume at');
  expect(input).toHaveValue('2026-09-28T21:30');
  fireEvent.change(input, { target: { value: '2026-09-28T21:10' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save pause' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(fixture.postSettings.mock.calls).toEqual([[{
    left: { scheduleOverrides: { pause: { active: true, expiresAt: '2026-09-28T21:10:00-07:00' } } },
  }]]);
  expect(fixture.postDeviceStatus).not.toHaveBeenCalled();
  // The dialog leaves the DOM before MUI lifts aria-hidden off the page, so wait for the button to be reachable.
  expect(await screen.findByRole('button', { name: 'Change pause' })).toHaveFocus();
});

it('edits an open-ended pause without first resuming it', async () => {
  fixture.pause = { active: true, expiresAt: '' };
  renderCard();
  fireEvent.click(screen.getByRole('button', { name: 'Change pause' }));
  expect(await screen.findByRole('radio', { name: /^Until I resume/ })).toBeChecked();
  fireEvent.click(screen.getByRole('radio', { name: 'Until a set time' }));
  fireEvent.change(screen.getByLabelText('Resume at'), { target: { value: '2026-09-28T23:00' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save pause' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(fixture.postSettings.mock.calls).toEqual([[{
    left: { scheduleOverrides: { pause: { active: true, expiresAt: '2026-09-28T23:00:00Z' } } },
  }]]);
});

it('cancels a pause edit without changing settings or the device', async () => {
  fixture.pause = { active: true, expiresAt: '2026-09-28T23:00:00Z' };
  renderCard();
  fireEvent.click(screen.getByRole('button', { name: 'Change pause' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(fixture.postSettings).not.toHaveBeenCalled();
  expect(fixture.postDeviceStatus).not.toHaveBeenCalled();
  expect(await screen.findByRole('button', { name: 'Change pause' })).toHaveFocus();
});

it('keeps the current pause when saving its new end fails', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  fixture.pause = { active: true, expiresAt: '2026-09-28T23:30:00Z' };
  fixture.postSettings.mockRejectedValue(new Error('offline'));
  renderCard();
  fireEvent.click(screen.getByRole('button', { name: 'Change pause' }));
  fireEvent.change(await screen.findByLabelText('Resume at'), { target: { value: '2026-09-28T23:10' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save pause' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not pause the schedule. Try again.');
  expect(fixture.postSettings.mock.calls).toEqual([[{
    left: { scheduleOverrides: { pause: { active: true, expiresAt: '2026-09-28T23:10:00Z' } } },
  }]]);
  expect(fixture.pause).toEqual({ active: true, expiresAt: '2026-09-28T23:30:00Z' });
  expect(fixture.postDeviceStatus).not.toHaveBeenCalled();
});

it.each(['legacy', 'rhythms'] as const)('shows the pause end as back on schedule inside a %s night', engine => {
  setEngine(engine);
  fixture.pause = { active: true, expiresAt: '2026-09-28T23:00:00Z' };
  renderCard();
  expect(screen.getByText(`Back on schedule tonight at 11:00 PM${engine === 'rhythms' ? ' (Workday)' : ''}`)).toBeInTheDocument();
});

it.each(['legacy', 'rhythms'] as const)('keeps back on schedule at the next start outside a %s night', engine => {
  setEngine(engine);
  fixture.pause = { active: true, expiresAt: '2026-09-29T12:00:00Z' };
  renderCard();
  expect(screen.getByText(`Back on schedule tomorrow at ${engine === 'legacy' ? '10:00 PM' : '10:30 PM (Workday)'}`)).toBeInTheDocument();
});

it.each(['legacy', 'rhythms'] as const)('keeps back on schedule at the next start when the delayed %s resume reaches 7 AM', engine => {
  setEngine(engine);
  fixture.pause = { active: true, expiresAt: '2026-09-29T06:59:00Z' };
  if (fixture.bed.state === 'rhythms') {
    const ending = fixture.bed.sleeps[0];
    ending.end = '2026-09-29T07:00:00Z';
    ending.night.power.off = '07:00';
    ending.events[1] = { kind: 'power-off', at: ending.end };
  }
  renderCard();
  expect(screen.getByText(`Back on schedule tomorrow at ${engine === 'legacy' ? '10:00 PM' : '10:30 PM (Workday)'}`)).toBeInTheDocument();
});

it('shows the Rhythms pause end before an off time in the spring gap', () => {
  fixture.timeZone = 'America/Los_Angeles';
  vi.spyOn(moment, 'now').mockReturnValue(Date.parse('2027-03-14T04:00:00Z'));
  fixture.pause = { active: true, expiresAt: '2027-03-14T09:45:00Z' };
  const ending = rhythmSleep('2027-03-13', '2027-03-14');
  ending.mode = 'smart';
  ending.smart = { baseLevel: 0, intensity: 'standard', warmStart: false, warmUp: true, upEarly: false, offWhenUp: true };
  ending.night.power.on = '21:00';
  ending.night.power.off = '02:30';
  ending.start = '2027-03-14T05:00:00Z';
  ending.end = '2027-03-14T13:30:00Z';
  ending.events = [
    { kind: 'power-on', at: ending.start, temperatureF: 82 },
    { kind: 'power-off', at: ending.end },
  ];
  const next = rhythmSleep('2027-03-14', '2027-03-15');
  next.night.power.on = '20:30';
  next.start = '2027-03-15T03:30:00Z';
  next.end = '2027-03-15T13:45:00Z';
  next.events = [
    { kind: 'power-on', at: next.start, temperatureF: 82 },
    { kind: 'power-off', at: next.end },
  ];
  fixture.bed = { state: 'rhythms', names: { workday: 'Workday' }, sleeps: [ending, next] };
  renderCard();
  expect(screen.getByText('Back on schedule tomorrow at 1:45 AM (Workday)')).toBeInTheDocument();
});

it.each(['legacy', 'rhythms'] as const)('does not predict back on schedule for an away %s side', engine => {
  setEngine(engine);
  fixture.awayMode = true;
  fixture.pause = { active: true, expiresAt: '2026-09-28T23:00:00Z' };
  renderCard();
  expect(screen.queryByText(/Back on schedule/)).not.toBeInTheDocument();
});

it('offers a pause next to tonight\'s plan', () => {
  renderCard();
  expect(screen.getByRole('button', { name: 'Pause schedule' })).toBeInTheDocument();
  expect(screen.getByText('Turns on tonight at 9:00 PM, set to 82°F')).toBeInTheDocument();
  expect(screen.getByText('Alarm row')).toBeInTheDocument();
});

it('does not offer a pause when the server does not know about pausing', () => {
  fixture.serverKnowsPause = false;
  renderCard();
  expect(screen.queryByRole('button', { name: 'Pause schedule' })).not.toBeInTheDocument();
  expect(screen.getByText('Turns on tonight at 9:00 PM, set to 82°F')).toBeInTheDocument();
});

it('replaces tonight\'s plan with the paused notice', () => {
  fixture.pause = { active: true, expiresAt: '2026-09-29T07:00:00Z' };
  renderCard();
  expect(screen.getByText('Schedule paused until 7:00 AM tomorrow')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Resume schedule' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Pause schedule' })).not.toBeInTheDocument();
  expect(screen.queryByText(/Turns on/)).not.toBeInTheDocument();
  expect(screen.queryByText('Alarm row')).not.toBeInTheDocument();
});

it('shows an open-ended pause', () => {
  fixture.pause = { active: true, expiresAt: '' };
  renderCard();
  expect(screen.getByText('Schedule paused until you resume')).toBeInTheDocument();
});

it('goes back to tonight\'s plan once the pause has ended', () => {
  fixture.pause = { active: true, expiresAt: '2026-09-28T19:00:00Z' };
  renderCard();
  expect(screen.getByRole('button', { name: 'Pause schedule' })).toBeInTheDocument();
  expect(screen.queryByText(/Schedule paused/)).not.toBeInTheDocument();
});

it('does not offer a pause while the side is away', () => {
  fixture.awayMode = true;
  renderCard();
  expect(screen.getByRole('link', { name: 'Edit schedule' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Pause schedule' })).not.toBeInTheDocument();
});

it('still offers a resume while a paused side is away', () => {
  fixture.awayMode = true;
  fixture.pause = { active: true, expiresAt: '' };
  renderCard();
  expect(screen.getByRole('link', { name: 'Edit schedule' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Resume schedule' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Pause schedule' })).not.toBeInTheDocument();
});

it('opens the pause sheet with tonight only selected', async () => {
  renderCard();
  fireEvent.click(screen.getByRole('button', { name: 'Pause schedule' }));
  expect(await screen.findByRole('radio', { name: /^Tonight only/ })).toBeChecked();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(screen.queryByRole('radio', { name: /^Tonight only/ })).not.toBeInTheDocument());
});

it('keeps keyboard focus on the pause button after the sheet closes', async () => {
  renderCard();
  fireEvent.click(screen.getByRole('button', { name: 'Pause schedule' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Pause schedule' })).toHaveFocus());
});

it('moves focus to the resume button after pausing', async () => {
  renderCard();
  fireEvent.click(screen.getByRole('button', { name: 'Pause schedule' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Pause' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Resume schedule' })).toHaveFocus());
  expect(document.activeElement).not.toBe(document.body);
});

it.each(['legacy', 'rhythms'] as const)('resumes a %s pause with one write and moves focus back to the pause button', async engine => {
  setEngine(engine);
  fixture.pause = { active: true, expiresAt: '' };
  renderCard();
  fireEvent.click(screen.getByRole('button', { name: 'Resume schedule' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Pause schedule' })).toHaveFocus());
  expect(fixture.postSettings.mock.calls).toEqual([[{
    left: { scheduleOverrides: { pause: { active: false, expiresAt: '' } } },
  }]]);
  expect(fixture.postDeviceStatus).not.toHaveBeenCalled();
});
