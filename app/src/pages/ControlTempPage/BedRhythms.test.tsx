import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { renderWithProviders } from '@test/renderWithProviders';
import { server } from '@test/setup';
import { useAppStore } from '@state/appStore';
import type { ResolvedSleepResponse } from '@api/rhythmsResponse';
import { levelToFahrenheit } from '@lib/temperatureConversions';
import { getSettings } from '../../mocks/mockData';
import type { BedSleeps } from './useBedSleeps';
import { useControlTempStore } from './controlTempStore';
import UpcomingNight from './UpcomingNight';
import CaptionSlot from './CaptionSlot';
import PowerButton from './PowerButton';
import AlarmNotification from './AlarmNotification';

const bed = vi.hoisted(() => ({ value: { state: 'legacy' } as BedSleeps }));
vi.mock('./useBedSleeps', () => ({ useBedSleeps: () => bed.value }));
vi.mock('./SmartPhaseLine', () => ({ default: () => <p>Smart phase line</p> }));

const alarm = { time: '06:30', enabled: true, vibrationIntensity: 30, vibrationPattern: 'rise' as const, duration: 30, alarmTemperature: 83 };
const tonight = (mode: 'manual' | 'smart'): ResolvedSleepResponse => ({
  side: 'left', date: '2026-09-28', rhythmId: 'workday', mode,
  start: '2026-09-29T05:30:00.000Z', end: '2026-09-29T13:45:00.000Z',
  night: { power: { on: '22:30', off: '06:45', onTemperature: 88, enabled: true }, temperatures: {}, alarm, alarms: [alarm] },
  ...(mode === 'smart' ? { smart: { baseLevel: 0, intensity: 'standard' as const, warmStart: true, warmUp: true, upEarly: false } } : {}),
  events: [
    { kind: 'power-on', at: '2026-09-29T05:30:00.000Z', temperatureF: 88 },
    { kind: 'temperature', at: '2026-09-29T06:30:00.000Z', temperatureF: 77 },
    { kind: 'alarm', at: '2026-09-29T13:30:00.000Z', alarm, index: 0 },
    { kind: 'power-off', at: '2026-09-29T13:45:00.000Z' },
  ],
});
// A Smart Schedule sleep at 10:30 PM, with a pre-warm from 10:00 PM when `prewarm` is given.
const smartTonight = ({ base, prewarm }: { base: number; prewarm?: number }): ResolvedSleepResponse => {
  const bedtime = '2026-09-29T05:30:00.000Z';
  const start = prewarm === undefined ? bedtime : '2026-09-29T05:00:00.000Z';
  const sleep = tonight('smart');
  return {
    ...sleep,
    start,
    smart: { baseLevel: base, intensity: 'standard', warmStart: prewarm !== undefined, warmUp: true, upEarly: false },
    smartCurve: {
      bedtime, coolStart: bedtime, wake: '2026-09-29T13:30:00.000Z', daySleep: false, points: [
        ...(prewarm === undefined ? [] : [{ at: start, level: prewarm, phase: 'prewarm' as const }]),
        { at: bedtime, level: base, phase: 'bedtime' as const },
      ],
    },
    events: [{ kind: 'power-on', at: start, temperatureF: levelToFahrenheit(prewarm ?? base) }, ...sleep.events.slice(1)],
  };
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-28T19:00:00Z'));
  useAppStore.setState({ side: 'left', isUpdating: false });
  useControlTempStore.setState({ commandError: undefined, deviceStatus: undefined, pendingEdits: 0 });
  bed.value = { state: 'rhythms', sleeps: [tonight('manual')] };
});
afterEach(() => vi.useRealTimers());

it('says the schedule is unavailable when Rhythms cannot load, and tries again', async () => {
  const retry = vi.fn();
  bed.value = { state: 'error', retry };
  const { user } = renderWithProviders(<UpcomingNight/>);
  expect(await screen.findByText('Schedule unavailable.')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Try again' }));
  expect(retry).toHaveBeenCalled();
});

it('keeps the Bed page error when a power command fails under Rhythms', async () => {
  server.use(http.post('*/deviceStatus', () => HttpResponse.json(
    { error: { message: 'Pod hardware is not connected. Try again in a moment.' } }, { status: 503 })));
  const { user } = renderWithProviders(<PowerButton isOn={ false } refetch={ () => Promise.resolve({ data: undefined }) }/>);
  await user.click(await screen.findByRole('button', { name: 'Turn on' }));
  await waitFor(() => expect(useControlTempStore.getState().commandError).toBe('Pod hardware is not connected. Try again in a moment.'));
  await waitFor(() => expect(useAppStore.getState().isUpdating).toBe(false), { timeout: 3000 });
});

it('fills the Tonight card and the alarm line from the resolved sleep', async () => {
  renderWithProviders(<UpcomingNight/>);
  expect(await screen.findByText(/Turns on tonight at 10:30 PM, set to \+2/)).toBeInTheDocument();
  expect(await screen.findByText('Alarm tomorrow at 6:30 AM')).toBeInTheDocument();
});

it('shows the Smart Schedule line during a Smart Schedule sleep', async () => {
  vi.setSystemTime(new Date('2026-09-29T08:00:00Z'));
  bed.value = { state: 'rhythms', sleeps: [tonight('smart')] };
  renderWithProviders(<UpcomingNight/>);
  expect(await screen.findByText('Smart phase line')).toBeInTheDocument();
});

it('says the schedule is loading while it cannot tell which engine runs', async () => {
  bed.value = { state: 'loading' };
  renderWithProviders(<UpcomingNight/>);
  expect(await screen.findByText('Loading schedule')).toBeInTheDocument();
  expect(screen.queryByText(/Turns on/)).not.toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'Upcoming' })).not.toBeInTheDocument();
});

it('names the resolved power-off in the caption slot', async () => {
  vi.setSystemTime(new Date('2026-09-29T08:00:00Z'));
  renderWithProviders(<CaptionSlot isOn/>);
  expect(await screen.findByText('Turns off today at 6:45 AM')).toBeInTheDocument();
});

it('turns on at the resolved sleep temperature', async () => {
  let posted: unknown;
  server.use(http.post('*/deviceStatus', async ({ request }) => {
    posted = await request.json();
    return new HttpResponse(null, { status: 204 });
  }));
  const { user } = renderWithProviders(<PowerButton isOn={ false } refetch={ () => Promise.resolve({ data: undefined }) }/>);
  await user.click(await screen.findByRole('button', { name: 'Turn on' }));
  await waitFor(() => expect(posted).toEqual({ left: { isOn: true, targetTemperatureF: 88 } }));
  await waitFor(() => expect(useAppStore.getState().isUpdating).toBe(false), { timeout: 3000 });
});

it('skips tonight\'s alarms until the resolved sleep ends, the bound the server checks', async () => {
  let posted: unknown;
  server.use(http.post('*/settings', async ({ request }) => {
    posted = await request.json();
    return HttpResponse.json({});
  }));
  const { user } = renderWithProviders(<AlarmNotification/>);
  await user.click(await screen.findByRole('button', { name: 'Skip' }));
  await user.click(await screen.findByRole('button', { name: 'Disable tonight' }));
  await waitFor(() => expect(posted).toBeDefined());
  const { alarm: written } = (posted as { left: { scheduleOverrides: { alarm: { disabled: boolean; expiresAt: string } } } })
    .left.scheduleOverrides;
  expect(written.disabled).toBe(true);
  expect(Date.parse(written.expiresAt)).toBe(Date.parse('2026-09-29T13:45:00.000Z'));
});

it('says the bed starts warming only when the pre-warm is above neutral', async () => {
  bed.value = { state: 'rhythms', sleeps: [smartTonight({ base: 0, prewarm: 2 })] };
  const { unmount } = renderWithProviders(<UpcomingNight/>);
  expect(await screen.findByText('Starts warming tonight at 10:00 PM for a 10:30 PM bedtime, set to +2')).toBeInTheDocument();
  unmount();

  bed.value = { state: 'rhythms', sleeps: [smartTonight({ base: 0 })] };
  const second = renderWithProviders(<UpcomingNight/>);
  expect(await screen.findByText('Turns on tonight at 10:30 PM, set to 0')).toBeInTheDocument();
  second.unmount();

  // A cool sleeper's pre-warm stays below neutral, so the bed only turns on early.
  bed.value = { state: 'rhythms', sleeps: [smartTonight({ base: -7, prewarm: -5 })] };
  renderWithProviders(<UpcomingNight/>);
  expect(await screen.findByText('Turns on tonight at 10:00 PM for a 10:30 PM bedtime, set to \u22125')).toBeInTheDocument();
  expect(screen.queryByText(/Starts warming/)).not.toBeInTheDocument();
});

it('shows the pre-warm line, not a start in the past, when a sleep turns on late', async () => {
  vi.setSystemTime(new Date('2026-09-29T05:15:00Z'));
  bed.value = { state: 'rhythms', sleeps: [smartTonight({ base: 0, prewarm: 2 })] };
  renderWithProviders(<UpcomingNight/>);
  expect(await screen.findByText('Smart phase line')).toBeInTheDocument();
  expect(screen.queryByText(/Turns on|Starts warming/)).not.toBeInTheDocument();
});

it('names a day sleep in progress "This sleep"', async () => {
  vi.setSystemTime(new Date('2026-09-29T17:00:00Z'));
  bed.value = { state: 'rhythms', sleeps: [{
    ...tonight('manual'), date: '2026-09-29', start: '2026-09-29T16:00:00.000Z', end: '2026-09-29T22:00:00.000Z',
    events: [{ kind: 'power-on', at: '2026-09-29T16:00:00.000Z', temperatureF: 82 }, { kind: 'power-off', at: '2026-09-29T22:00:00.000Z' }],
  }] };
  renderWithProviders(<UpcomingNight/>);
  expect(await screen.findByRole('heading', { name: 'This sleep' })).toBeInTheDocument();
  expect(screen.getByText('Turns off today at 3:00 PM')).toBeInTheDocument();
});

it('says when a paused schedule comes back, and with which rhythm', async () => {
  const settings = getSettings();
  server.use(http.get('*/settings', () => HttpResponse.json({ ...settings, left: { ...settings.left, scheduleOverrides: {
    ...settings.left.scheduleOverrides, pause: { active: true, expiresAt: '2026-09-29T14:00:00.000Z' },
  } } })));
  const next = tonight('manual');
  bed.value = { state: 'rhythms', names: { workday: 'Workday' }, sleeps: [next, {
    ...next, date: '2026-09-29', start: '2026-09-30T05:30:00.000Z', end: '2026-09-30T13:45:00.000Z',
    events: [{ kind: 'power-on', at: '2026-09-30T05:30:00.000Z', temperatureF: 88 }, { kind: 'power-off', at: '2026-09-30T13:45:00.000Z' }],
  }] };
  renderWithProviders(<UpcomingNight/>);
  expect(await screen.findByText('Back on schedule tomorrow at 10:30 PM (Workday)')).toBeInTheDocument();
});


it('says an away side follows the present side\'s schedule under Rhythms', async () => {
  const settings = getSettings();
  server.use(http.get('*/settings', () => HttpResponse.json({ ...settings, left: { ...settings.left, awayMode: true } })));
  renderWithProviders(<UpcomingNight/>);
  expect(await screen.findByText((_, element) => element?.tagName === 'P'
    && element.textContent === `Away mode is on, so this side follows ${settings.right.name}'s schedule.`)).toBeInTheDocument();
  expect(screen.queryByText(/No sleep scheduled/)).not.toBeInTheDocument();
});

it('says no sleep is scheduled across the whole loaded window', async () => {
  bed.value = { state: 'rhythms', sleeps: [] };
  renderWithProviders(<UpcomingNight/>);
  expect(await screen.findByText('No sleep scheduled in the next 14 days.')).toBeInTheDocument();
});
