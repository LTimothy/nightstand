import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ResolvedSleepResponse } from '@api/rhythmsResponse';
import { useBedCaption } from './useBedCaption';
import type { BedSleeps } from './useBedSleeps';

const fixture = vi.hoisted(() => ({
  pause: { active: false, expiresAt: '' }, status: undefined as unknown, away: false, bed: { state: 'legacy' } as BedSleeps,
  live: null as unknown, presence: undefined as unknown, partnerAway: false, timeZone: 'UTC',
}));
vi.mock('@state/appStore', () => ({ useAppStore: () => ({ side: 'left' }) }));
vi.mock('@api/settings', () => ({ useSettings: () => ({ data: {
  timeZone: fixture.timeZone,
  left: { awayMode: fixture.away, scheduleOverrides: { pause: fixture.pause } }, right: { awayMode: fixture.partnerAway },
} }) }));
const night = (on: string) => ({ power: { enabled: true, on, off: '07:00', onTemperature: 82 }, temperatures: {} });
vi.mock('@api/schedules', () => ({ useSchedules: () => ({ data: { left: { monday: night('21:00'), tuesday: night('22:00') } } }) }));
vi.mock('@api/deviceStatus', () => ({ useDeviceStatus: () => ({ data: fixture.status }) }));
vi.mock('./useBedSleeps', () => ({ useBedSleeps: () => fixture.bed }));
vi.mock('@api/rhythms', () => ({ useRhythmsLive: () => ({ data: fixture.live }) }));
vi.mock('@api/presence', async importOriginal => ({
  ...(await importOriginal<typeof import('@api/presence')>()),
  usePresence: () => ({ data: fixture.presence }),
}));

function Caption({ isOn }: { isOn: boolean }) {
  return <>{ useBedCaption(isOn).map(line => <p key={ line }>{ line }</p>) }</>;
}
const label = (isOn: boolean) => render(<Caption isOn={ isOn }/>);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  // Monday 8:00 PM.
  vi.setSystemTime(new Date('2026-09-28T20:00:00Z'));
  fixture.pause = { active: true, expiresAt: '2026-09-29T07:00:00.000Z' };
  fixture.status = undefined;
  fixture.away = false;
  fixture.bed = { state: 'legacy' };
  fixture.live = null;
  fixture.presence = undefined;
  fixture.partnerAway = false;
  fixture.timeZone = 'UTC';
});

const alarm = { time: '06:30', enabled: false, vibrationIntensity: 30, vibrationPattern: 'rise' as const, duration: 30, alarmTemperature: 83 };
// A rhythm sleep from 10:30 PM on `date` to 6:45 AM the next morning (UTC).
const sleep = (date: string, next: string): ResolvedSleepResponse => ({
  side: 'left', date, rhythmId: 'workday', mode: 'manual',
  start: `${date}T22:30:00.000Z`, end: `${next}T06:45:00.000Z`,
  night: { power: { on: '22:30', off: '06:45', onTemperature: 82, enabled: true }, temperatures: {}, alarm, alarms: [] },
  events: [
    { kind: 'power-on', at: `${date}T22:30:00.000Z`, temperatureF: 82 },
    { kind: 'power-off', at: `${next}T06:45:00.000Z` },
  ],
});
afterEach(() => vi.useRealTimers());

it('names when the firmware timer turns a running side off during a pause', () => {
  fixture.status = { left: { isOn: true, secondsRemaining: 5400 } };
  label(true);
  expect(screen.getByText('Turns off at 9:30 PM')).toBeInTheDocument();
  expect(screen.queryByText(/Turns off tonight/)).not.toBeInTheDocument();
});

it('says a running side without a timer stays on during a pause', () => {
  fixture.status = { left: { isOn: true, secondsRemaining: 0 } };
  label(true);
  expect(screen.getByText('Stays on until you turn it off')).toBeInTheDocument();
});

it('names the first start after a timed pause, and none for a pause until resumed', () => {
  const { unmount } = label(false);
  expect(screen.getByText('Turns on tomorrow at 10:00 PM')).toBeInTheDocument();
  unmount();

  fixture.pause = { active: true, expiresAt: '' };
  label(false);
  expect(screen.queryByText(/Turns on/)).not.toBeInTheDocument();
});

it.each(['legacy', 'rhythms'] as const)('predicts the pause end inside a %s night', engine => {
  fixture.pause.expiresAt = '2026-09-28T23:00:00Z';
  if (engine === 'rhythms') fixture.bed = { state: 'rhythms', sleeps: [sleep('2026-09-28', '2026-09-29')] };
  label(false);
  expect(screen.getByText('Turns on tonight at 11:00 PM')).toBeInTheDocument();
});

it.each(['legacy', 'rhythms'] as const)('predicts a resume after midnight in a %s night', engine => {
  fixture.pause.expiresAt = '2026-09-29T02:00:00Z';
  if (engine === 'rhythms') fixture.bed = { state: 'rhythms', sleeps: [sleep('2026-09-28', '2026-09-29')] };
  label(false);
  expect(screen.getByText('Turns on tomorrow at 2:00 AM')).toBeInTheDocument();
});

it.each(['legacy', 'rhythms'] as const)('keeps the next start outside a %s night', engine => {
  fixture.pause.expiresAt = '2026-09-29T12:00:00Z';
  if (engine === 'rhythms') fixture.bed = { state: 'rhythms', sleeps: [sleep('2026-09-28', '2026-09-29'), sleep('2026-09-29', '2026-09-30')] };
  label(false);
  expect(screen.getByText(`Turns on tomorrow at ${engine === 'legacy' ? '10:00' : '10:30'} PM`)).toBeInTheDocument();
});

it.each(['legacy', 'rhythms'] as const)('keeps the next start when a pause ends at the %s night end', engine => {
  fixture.pause.expiresAt = engine === 'legacy' ? '2026-09-29T07:00:00Z' : '2026-09-29T06:45:00Z';
  if (engine === 'rhythms') fixture.bed = { state: 'rhythms', sleeps: [sleep('2026-09-28', '2026-09-29'), sleep('2026-09-29', '2026-09-30')] };
  label(false);
  expect(screen.getByText(`Turns on tomorrow at ${engine === 'legacy' ? '10:00' : '10:30'} PM`)).toBeInTheDocument();
});

it.each(['legacy', 'rhythms'] as const)('keeps the next start when the delayed %s resume reaches 7 AM', engine => {
  fixture.pause.expiresAt = '2026-09-29T06:59:00Z';
  if (engine === 'rhythms') {
    const ending = sleep('2026-09-28', '2026-09-29');
    ending.end = '2026-09-29T07:00:00Z';
    ending.night.power.off = '07:00';
    ending.events[1] = { kind: 'power-off', at: ending.end };
    fixture.bed = { state: 'rhythms', sleeps: [ending, sleep('2026-09-29', '2026-09-30')] };
  }
  label(false);
  expect(screen.getByText(`Turns on tomorrow at ${engine === 'legacy' ? '10:00' : '10:30'} PM`)).toBeInTheDocument();
});

it('does not resume past the scheduled When I get up off time after the delay', () => {
  fixture.pause.expiresAt = '2026-09-29T06:44:00Z';
  const ending = sleep('2026-09-28', '2026-09-29');
  ending.mode = 'smart';
  ending.smart = { baseLevel: 0, intensity: 'standard', warmStart: false, warmUp: true, upEarly: false, offWhenUp: true };
  ending.end = '2026-09-29T09:45:00Z';
  ending.events[1] = { kind: 'power-off', at: ending.end };
  fixture.bed = { state: 'rhythms', sleeps: [ending, sleep('2026-09-29', '2026-09-30')] };
  label(false);
  expect(screen.getByText('Turns on tomorrow at 10:30 PM')).toBeInTheDocument();
});

it('predicts the Rhythms pause end before an off time in the spring gap', () => {
  fixture.timeZone = 'America/Los_Angeles';
  vi.setSystemTime(new Date('2027-03-14T04:00:00Z'));
  fixture.pause.expiresAt = '2027-03-14T09:45:00Z';
  const ending = sleep('2027-03-13', '2027-03-14');
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
  const next = sleep('2027-03-14', '2027-03-15');
  next.night.power.on = '20:30';
  next.start = '2027-03-15T03:30:00Z';
  next.end = '2027-03-15T13:45:00Z';
  next.events = [
    { kind: 'power-on', at: next.start, temperatureF: 82 },
    { kind: 'power-off', at: next.end },
  ];
  fixture.bed = { state: 'rhythms', sleeps: [ending, next] };
  label(false);
  expect(screen.getByText('Turns on tomorrow at 1:45 AM')).toBeInTheDocument();
});

it.each(['legacy', 'rhythms'] as const)('keeps an imminent %s scheduled start', engine => {
  const start = engine === 'legacy' ? '21:00' : '22:30';
  for (const minutes of [2, 0.5]) {
    fixture.pause.expiresAt = new Date(Date.parse(`2026-09-28T${start}:00Z`) - minutes * 60_000).toISOString();
    if (engine === 'rhythms') fixture.bed = { state: 'rhythms', sleeps: [sleep('2026-09-28', '2026-09-29')] };
    const { unmount } = label(false);
    expect(screen.getByText(`Turns on tonight at ${engine === 'legacy' ? '9:00' : '10:30'} PM`)).toBeInTheDocument();
    unmount();
  }
});

it.each(['legacy', 'rhythms'] as const)('leaves an away side without a %s resume caption', engine => {
  fixture.pause.expiresAt = '2026-09-28T23:00:00Z';
  fixture.away = true;
  if (engine === 'rhythms') fixture.bed = { state: 'rhythms', sleeps: [sleep('2026-09-28', '2026-09-29')] };
  label(false);
  expect(screen.queryByText(/Turns on/)).not.toBeInTheDocument();
});

it.each(['legacy', 'rhythms'] as const)('formats a %s resume in the configured time zone', engine => {
  fixture.timeZone = 'America/Los_Angeles';
  vi.setSystemTime(new Date('2026-09-29T03:00:00Z'));
  fixture.pause.expiresAt = '2026-09-29T06:00:00Z';
  if (engine === 'rhythms') {
    const localSleep = sleep('2026-09-28', '2026-09-29');
    localSleep.start = '2026-09-29T05:30:00Z';
    localSleep.end = '2026-09-29T13:45:00Z';
    localSleep.events = [
      { kind: 'power-on', at: localSleep.start, temperatureF: 82 },
      { kind: 'power-off', at: localSleep.end },
    ];
    fixture.bed = { state: 'rhythms', sleeps: [localSleep] };
  }
  label(false);
  expect(screen.getByText('Turns on tonight at 11:00 PM')).toBeInTheDocument();
});

it('does not resume a When I get up sleep after its scheduled off', () => {
  fixture.pause.expiresAt = '2026-09-29T08:00:00Z';
  const extended = sleep('2026-09-28', '2026-09-29');
  extended.mode = 'smart';
  extended.smart = { baseLevel: 0, intensity: 'standard', warmStart: false, warmUp: true, upEarly: false, offWhenUp: true };
  extended.end = '2026-09-29T09:45:00Z';
  extended.events[1] = { kind: 'power-off', at: extended.end };
  fixture.bed = { state: 'rhythms', sleeps: [extended, sleep('2026-09-29', '2026-09-30')] };
  label(false);
  expect(screen.getByText('Turns on tomorrow at 10:30 PM')).toBeInTheDocument();
});

it('names the firmware timer when it turns a running side off before the next weekly night', () => {
  fixture.pause = { active: false, expiresAt: '' };
  // Tuesday 10:00 AM, between weekly nights, as after a sleep kept on when Rhythms was turned off.
  vi.setSystemTime(new Date('2026-09-29T10:00:00Z'));
  fixture.status = { left: { isOn: true, secondsRemaining: 5.5 * 3600 } };
  const { unmount } = label(true);
  expect(screen.getByText('Turns off today at 3:30 PM')).toBeInTheDocument();
  unmount();

  // A timer that runs past the next weekly start leaves the weekly turn-off.
  fixture.status = { left: { isOn: true, secondsRemaining: 14 * 3600 } };
  const second = label(true);
  expect(screen.getByText('Turns off tomorrow at 7:00 AM')).toBeInTheDocument();
  second.unmount();

  // An away side shows no schedule text.
  fixture.away = true;
  fixture.status = { left: { isOn: true, secondsRemaining: 5.5 * 3600 } };
  label(true);
  expect(screen.queryByText(/Turns off/)).not.toBeInTheDocument();
});

it('keeps the weekly turn-off during a weekly night', () => {
  fixture.pause = { active: false, expiresAt: '' };
  vi.setSystemTime(new Date('2026-09-28T23:00:00Z'));
  fixture.status = { left: { isOn: true, secondsRemaining: 3600 } };
  label(true);
  expect(screen.getByText('Turns off tomorrow at 7:00 AM')).toBeInTheDocument();
});

it('names the firmware timer under Rhythms after tonight\'s running sleep is removed', () => {
  fixture.pause = { active: false, expiresAt: '' };
  // Tuesday 2:00 AM: Monday night's sleep was set to no sleep while it ran, so the next sleep is Tuesday night.
  vi.setSystemTime(new Date('2026-09-29T02:00:00Z'));
  fixture.bed = { state: 'rhythms', sleeps: [sleep('2026-09-29', '2026-09-30')] };
  fixture.status = { left: { isOn: true, secondsRemaining: 5 * 3600 + 50 * 60 } };
  label(true);
  expect(screen.getByText('Turns off today at 7:50 AM')).toBeInTheDocument();
  expect(screen.queryByText(/Turns off tomorrow/)).not.toBeInTheDocument();
});

it('names the firmware timer under Rhythms after a manual start between sleeps', () => {
  fixture.pause = { active: false, expiresAt: '' };
  // Tuesday 2:00 PM, after Monday night's sleep ended.
  vi.setSystemTime(new Date('2026-09-29T14:00:00Z'));
  fixture.bed = { state: 'rhythms', sleeps: [sleep('2026-09-28', '2026-09-29'), sleep('2026-09-29', '2026-09-30')] };
  fixture.status = { left: { isOn: true, secondsRemaining: 2 * 3600 } };
  const { unmount } = label(true);
  expect(screen.getByText('Turns off today at 4:00 PM')).toBeInTheDocument();
  unmount();

  // A timer that runs past the next sleep's start leaves that sleep's turn-off.
  fixture.status = { left: { isOn: true, secondsRemaining: 10 * 3600 } };
  label(true);
  expect(screen.getByText('Turns off tomorrow at 6:45 AM')).toBeInTheDocument();
});

it('keeps the sleep\'s turn-off under Rhythms while a sleep runs', () => {
  fixture.pause = { active: false, expiresAt: '' };
  vi.setSystemTime(new Date('2026-09-28T23:00:00Z'));
  fixture.bed = { state: 'rhythms', sleeps: [sleep('2026-09-28', '2026-09-29')] };
  fixture.status = { left: { isOn: true, secondsRemaining: 3600 } };
  label(true);
  expect(screen.getByText('Turns off tomorrow at 6:45 AM')).toBeInTheDocument();
});

it('says a "When I get up" sleep turns off when they get up, by its latest off', () => {
  fixture.pause = { active: false, expiresAt: '' };
  vi.setSystemTime(new Date('2026-09-28T23:00:00Z'));
  fixture.status = { left: { isOn: true, secondsRemaining: 8 * 3600 } };
  fixture.bed = { state: 'rhythms', sleeps: [sleep('2026-09-28', '2026-09-29')] };
  fixture.live = { side: 'left', date: '2026-09-28', offWhenUp: { by: '2026-09-29T09:45:00.000Z' } };
  fixture.presence = { left: { present: true, lastUpdatedAt: '2026-09-28T22:59:00.000Z' } };
  const { unmount } = label(true);
  expect(screen.getByText('Turns off when you get up, tomorrow by 9:45 AM')).toBeInTheDocument();
  unmount();

  fixture.live = null;
  label(true);
  expect(screen.getByText('Turns off tomorrow at 6:45 AM')).toBeInTheDocument();
});

it('keeps only the latest turn-off while presence is stale or unknown', () => {
  fixture.pause = { active: false, expiresAt: '' };
  vi.setSystemTime(new Date('2026-09-28T23:00:00Z'));
  fixture.status = { left: { isOn: true, secondsRemaining: 8 * 3600 } };
  fixture.bed = { state: 'rhythms', sleeps: [sleep('2026-09-28', '2026-09-29')] };
  fixture.live = { side: 'left', date: '2026-09-28', offWhenUp: { by: '2026-09-29T09:45:00.000Z' } };
  fixture.presence = { left: { present: true, lastUpdatedAt: '2026-09-28T22:50:00.000Z' } };
  const { unmount } = label(true);
  const line = screen.getByText('Turns off tomorrow by 9:45 AM');
  expect(line.textContent).toBe('Turns off tomorrow by\u00a09:45\u00a0AM');
  unmount();

  fixture.presence = undefined;
  label(true);
  expect(screen.getByText('Turns off tomorrow by 9:45 AM')).toBeInTheDocument();
});

it('reads the other side\'s presence too while that side is away, as the server does', () => {
  fixture.pause = { active: false, expiresAt: '' };
  vi.setSystemTime(new Date('2026-09-28T23:00:00Z'));
  fixture.status = { left: { isOn: true, secondsRemaining: 8 * 3600 } };
  fixture.bed = { state: 'rhythms', sleeps: [sleep('2026-09-28', '2026-09-29')] };
  fixture.live = { side: 'left', date: '2026-09-28', offWhenUp: { by: '2026-09-29T09:45:00.000Z' } };
  fixture.presence = {
    left: { present: false, lastUpdatedAt: '2026-09-28T22:50:00.000Z' },
    right: { present: true, lastUpdatedAt: '2026-09-28T22:59:00.000Z' },
  };
  const { unmount } = label(true);
  expect(screen.getByText('Turns off tomorrow by 9:45 AM')).toBeInTheDocument();
  unmount();

  fixture.partnerAway = true;
  label(true);
  expect(screen.getByText('Turns off when you get up, tomorrow by 9:45 AM')).toBeInTheDocument();
});

it('leaves "when you get up" out during a pause', () => {
  vi.setSystemTime(new Date('2026-09-28T23:00:00Z'));
  fixture.pause = { active: true, expiresAt: '' };
  fixture.status = { left: { isOn: true, secondsRemaining: 0 } };
  fixture.bed = { state: 'rhythms', sleeps: [sleep('2026-09-28', '2026-09-29')] };
  fixture.live = { side: 'left', date: '2026-09-28', offWhenUp: { by: '2026-09-29T09:45:00.000Z' } };
  label(true);
  expect(screen.queryByText(/when you get up/)).not.toBeInTheDocument();
  expect(screen.getByText('Stays on until you turn it off')).toBeInTheDocument();
});

it('keeps "at" and the time together on one line', () => {
  fixture.pause = { active: false, expiresAt: '' };
  fixture.status = { left: { isOn: false, secondsRemaining: 0 } };
  label(false);
  const line = screen.getByText('Turns on tonight at 9:00 PM');
  expect(line.textContent).toBe('Turns on tonight at\u00a09:00\u00a0PM');
});

it.each([[0, 'Turns on'], [1, 'Starts warming']])('words a level %i pre-warm caption as "%s"', (level, verb) => {
  fixture.pause = { active: false, expiresAt: '' };
  fixture.bed = { state: 'rhythms', sleeps: [{
    ...sleep('2026-09-28', '2026-09-29'), mode: 'smart',
    smart: { baseLevel: 0, intensity: 'standard', warmStart: true, warmUp: true, upEarly: false },
    smartCurve: {
      bedtime: '2026-09-28T22:30:00.000Z', coolStart: '2026-09-28T22:30:00.000Z', wake: '2026-09-29T06:30:00.000Z',
      daySleep: false,
      points: [{ at: '2026-09-28T22:30:00.000Z', level, phase: 'prewarm' }],
    },
  }] };
  label(false);
  expect(screen.getByText(`${verb} tonight at 10:30 PM`)).toBeInTheDocument();
});
