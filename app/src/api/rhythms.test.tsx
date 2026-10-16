import { afterEach, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import moment from 'moment-timezone';
import type { ReactNode } from 'react';
import { act, renderHook, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderWithProviders } from '@test/renderWithProviders';
import { server } from '@test/setup';
import api, { HARDWARE_REQUEST_TIMEOUT_MS } from './api';
import { validateResponse } from './responseValidation';
import {
  disableRhythms, enableRhythms, postNightExclude, postRhythms, postSuggestionsForget, refreshRhythms, rhythmsSaveMessage,
  RhythmsUpdateSchema, useResolvedSleeps, useRhythmsState, useSuggestions,
} from './rhythms';
import type { SuggestionsResponse } from './rhythmsSchema';
import type { ResolvedSleepResponse } from './rhythmsResponse';
import { MAX_TEMPERATURES_PER_DAY } from './schedulesSchema';
import { createDemoRhythms, listMockSleeps, resetMockRhythms, updateMockRhythms } from '../mocks/rhythmsMock';

const NOW = new Date('2026-09-28T19:00:00Z');

afterEach(() => {
  vi.restoreAllMocks();
  resetMockRhythms();
});

function StateProbe() {
  const { state } = useRhythmsState();
  return <p>{ state }</p>;
}

it('strips future keys from the rhythms response and keeps saves strict', () => {
  const db = createDemoRhythms(NOW);
  const data = structuredClone(db);
  Object.assign(data, { futureTop: 1 });
  Object.assign(data.left, { futureSide: 1 });
  Object.assign(data.left.rhythms.workday, { futureRhythm: 1 });
  Object.assign(data.left.rhythms.workday.smart, { futureSmart: 1 });
  Object.assign(data.left.rhythms.workday.night.power, { futurePower: 1 });
  const response = { status: { enabled: true, active: true, future: 1 }, data, future: true };
  expect(validateResponse('/rhythms', response)).toEqual({ status: { enabled: true, active: true }, data: db });
  expect(RhythmsUpdateSchema.safeParse({ left: { ...db.left, futureSide: 1 } }).success).toBe(false);
  expect(RhythmsUpdateSchema.safeParse({ left: db.left }).success).toBe(true);
});

it('reads a file from a newer version as no data instead of failing the page', () => {
  const response = { status: { enabled: true, active: false, reason: 'unsupported-version' }, data: { version: 2 } };
  expect(validateResponse('/rhythms', response)).toEqual({ status: response.status, data: null });
});

it('reads the live Smart Schedule night, and no night', () => {
  const live = {
    side: 'left', date: '2026-09-28', phase: 'hold', waiting: false, coolStart: '2026-09-29T05:45:00.000Z',
    hold: { until: '2026-09-29T12:45:00.000Z' }, baseSince: null,
    nextChange: { at: '2026-09-29T12:56:00.000Z', level: -1, phase: 'warmup' },
  };
  expect(validateResponse('/rhythms/live', { ...live, future: 1 })).toEqual(live);
  expect(validateResponse('/rhythms/live', null)).toBeNull();
});

it('keeps known sleep events, drops unknown ones and reads an unknown mode as set by hand', () => {
  resetMockRhythms(createDemoRhythms(NOW), true);
  const [sleep] = listMockSleeps('left', new Date('2026-09-29T00:00:00Z'), new Date('2026-09-29T12:00:00Z'));
  const future = { ...sleep, mode: 'future', events: [...sleep.events, { kind: 'future', at: sleep.start }], extra: 1 };
  const [parsed] = validateResponse('/rhythms/sleeps', [future]) as ResolvedSleepResponse[];
  expect(parsed.mode).toBe('manual');
  expect(parsed.events).toEqual(sleep.events);
  expect(parsed).not.toHaveProperty('extra');
});

it('keeps a Smart Schedule curve whose point has a phase from a newer version', () => {
  resetMockRhythms(createDemoRhythms(NOW), true);
  const [sleep] = listMockSleeps('left', new Date('2026-09-29T00:00:00Z'), new Date('2026-09-29T12:00:00Z'));
  const curve = sleep.smartCurve!;
  const points = curve.points.map((point, index) => (index === 1 ? { ...point, phase: 'future' } : point));
  const [parsed] = validateResponse('/rhythms/sleeps', [{ ...sleep, smartCurve: { ...curve, points } }]) as ResolvedSleepResponse[];
  expect(parsed.smartCurve?.points).toEqual(curve.points.map((point, index) => (index === 1 ? { ...point, phase: null } : point)));
});

it('names both days when a save would overlap', async () => {
  server.use(http.post('*/rhythms', () => HttpResponse.json(
    { error: 'Two sleeps would overlap', overlaps: [{ side: 'left', first: '2026-10-03', second: '2026-10-04' }] }, { status: 400 })));
  const error = await postRhythms({ left: createDemoRhythms(NOW).left }).catch((caught: unknown) => caught);
  const tail = 'would overlap. Check when each one turns off, or pick another rhythm for one of those days.';
  expect(rhythmsSaveMessage(error, '2026-09-28')).toBe(`The sleeps starting Saturday and Sunday ${tail}`);
  expect(rhythmsSaveMessage(error, '2026-10-02')).toBe(`The sleeps starting tomorrow and Sunday ${tail}`);
  expect(rhythmsSaveMessage(error, '2026-09-23')).toBe(`The sleeps starting Sat, Oct 3 and Sun, Oct 4 ${tail}`);
  expect(rhythmsSaveMessage(new Error('offline'), '2026-09-28')).toBe('Could not save Rhythms. Your changes were not saved. Try again.');
});

it('shows the server\'s reason when a save is refused for anything else', async () => {
  server.use(http.post('*/rhythms', () => HttpResponse.json(
    { error: 'Rhythms are not set up on this Pod', state: 'absent' }, { status: 409 })));
  const refused = await postRhythms({ left: createDemoRhythms(NOW).left }).catch((caught: unknown) => caught);
  expect(rhythmsSaveMessage(refused, '2026-09-28'))
    .toBe('Could not save Rhythms. Rhythms are not set up on this Pod. Your changes were not saved.');
  server.use(http.post('*/rhythms', () => HttpResponse.json(
    { error: 'Invalid rhythms', details: ['left: Rhythm workday can have at most 48 temperature changes'] }, { status: 400 })));
  const invalid = await postRhythms({ left: createDemoRhythms(NOW).left }).catch((caught: unknown) => caught);
  expect(rhythmsSaveMessage(invalid, '2026-09-28'))
    .toBe('Could not save Rhythms. A rhythm can have at most 48 temperature changes. Your changes were not saved.');
  server.use(http.post('*/rhythms', () => HttpResponse.json(
    { error: 'Invalid rhythms', details: ['right: The Monday plan uses a rhythm that does not exist (nap)'] }, { status: 400 })));
  const other = await postRhythms({ left: createDemoRhythms(NOW).left }).catch((caught: unknown) => caught);
  const message = rhythmsSaveMessage(other, '2026-09-28');
  expect(message).toBe('Could not save Rhythms. Your changes were not saved. Try again.');
  expect(message).not.toMatch(/left:|right:/);
});

it('refuses a rhythm night over the daily temperature limit in the demo, as the Pod does', () => {
  const db = createDemoRhythms(NOW);
  resetMockRhythms(db, true);
  const left = structuredClone(db.left);
  left.rhythms.weekend.night.temperatures = Object.fromEntries(Array.from({ length: MAX_TEMPERATURES_PER_DAY + 1 }, (_, index) =>
    [moment('23:40', 'HH:mm').add(index * 10, 'minutes').format('HH:mm'), 80]));
  expect(updateMockRhythms({ left }, NOW)).toEqual({
    ok: false, status: 400, body: { error: 'Invalid rhythms', details: ['left: Rhythm weekend can have at most 48 temperature changes'] },
  });
});

it('gives turning Rhythms off the hardware timeout and turning it on the default one', async () => {
  const post = vi.spyOn(api, 'post');
  await disableRhythms({ powerOffNow: true });
  expect(post).toHaveBeenLastCalledWith('/rhythms/disable', { powerOffNow: true }, { timeout: HARDWARE_REQUEST_TIMEOUT_MS });
  await enableRhythms();
  expect(post).toHaveBeenLastCalledWith('/rhythms/enable', {});
});

it('keeps a side whose device write failed in the handoff report', async () => {
  server.use(http.post('*/rhythms/disable', () => HttpResponse.json({ sides: [
    { side: 'left', action: 'powered-off', alarmOverrideSet: false, deviceUpdateFailed: true },
    { side: 'right', action: 'none', alarmOverrideSet: false },
  ] })));
  const report = await disableRhythms({ powerOffNow: true });
  expect(report.sides[0].deviceUpdateFailed).toBe(true);
  expect(report.sides[1].deviceUpdateFailed).toBeUndefined();
});

it('reports off by default, active when the flag and file agree, inactive otherwise', async () => {
  const first = renderWithProviders(<StateProbe/>);
  expect(await screen.findByText('off')).toBeInTheDocument();
  first.unmount();

  resetMockRhythms(createDemoRhythms(NOW), true);
  const second = renderWithProviders(<StateProbe/>);
  expect(await screen.findByText('active')).toBeInTheDocument();
  second.unmount();

  server.use(http.get('*/rhythms', () => HttpResponse.json(
    { status: { enabled: true, active: false, reason: 'fingerprint-mismatch' }, data: null })));
  renderWithProviders(<StateProbe/>);
  expect(await screen.findByText('inactive')).toBeInTheDocument();
});

it('reports an error when Rhythms runs but its file cannot be read', async () => {
  resetMockRhythms(null, true);
  server.use(http.get('*/rhythms', () => HttpResponse.json({ status: { enabled: true, active: true }, data: { version: 'unreadable' } })));
  renderWithProviders(<StateProbe/>);
  expect(await screen.findByText('error')).toBeInTheDocument();
});

const alarm = { time: '06:00', enabled: true, vibrationIntensity: 30, vibrationPattern: 'rise', duration: 30, alarmTemperature: 83 };

it('keeps a side\'s sleeps while its window moves, never another side\'s', async () => {
  let release = () => {};
  let hold = false;
  server.use(http.get('*/rhythms/sleeps', async ({ request }) => {
    const side = new URL(request.url).searchParams.get('side');
    if (hold) await new Promise<void>(resolve => { release = resolve; });
    return HttpResponse.json([{
      side, date: '2026-09-28', rhythmId: null, start: '2026-09-28T22:00:00.000Z', end: '2026-09-29T06:00:00.000Z', mode: 'manual',
      night: { power: { on: '22:00', off: '06:00', onTemperature: 83, enabled: true }, temperatures: {}, alarm, alarms: [alarm] }, events: [],
    }]);
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={ client }>{ children }</QueryClientProvider>;
  const to = '2026-09-30T00:00:00.000Z';
  const view = renderHook(({ side, from }: { side: 'left' | 'right'; from: string }) => useResolvedSleeps(side, from, to),
    { wrapper, initialProps: { side: 'left', from: '2026-09-28T00:00:00.000Z' } });
  await waitFor(() => expect(view.result.current.data?.[0]?.side).toBe('left'));
  hold = true;
  view.rerender({ side: 'left', from: '2026-09-28T01:00:00.000Z' });
  expect(view.result.current.data?.[0]?.side).toBe('left');
  view.rerender({ side: 'right', from: '2026-09-28T01:00:00.000Z' });
  expect(view.result.current.data).toBeUndefined();
  await act(async () => release());
});

it('reads suggestions, dropping a row, an entry or a reason this app does not know', () => {
  const row = {
    kind: 'step', key: 'step:down', direction: 'down', supporting: 9, firstNight: '2026-09-28', lastNight: '2026-10-10',
    supportingDates: ['2026-09-28'], time: '23:45', temperatureF: 79, plannedF: 82,
  };
  const parsed = validateResponse('/rhythms/suggestions', {
    enabled: true,
    nights: {
      'off-days': { counted: 14, needed: 5, changed: 9, earlier: false, reason: 'suggested' },
      workday: { counted: 3, needed: 5, changed: 0, earlier: false, reason: 'sleepy' },
    },
    suggestions: [
      { rhythmId: 'off-days', near: false, rows: [{ ...row, later: 'kept out' }, { ...row, kind: 'curve' }] },
      { rhythmId: 'workday', near: true, rows: [{ ...row, kind: 'curve' }] },
    ],
    dismissed: [],
    log: [],
  }) as SuggestionsResponse;
  expect(Object.keys(parsed.nights)).toEqual(['off-days']);
  expect(parsed.suggestions).toEqual([{ rhythmId: 'off-days', near: false, rows: [row] }]);
});

it('asks for suggestions only while the flag is on', async () => {
  let asked = 0;
  server.use(http.get('*/rhythms/suggestions', () => {
    asked += 1;
    return HttpResponse.json({ enabled: true, nights: {}, suggestions: [], dismissed: [], log: [] });
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={ client }>{ children }</QueryClientProvider>;
  const off = renderHook(() => useSuggestions('left', false), { wrapper });
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(asked).toBe(0);
  off.unmount();
  const on = renderHook(() => useSuggestions('right', true), { wrapper });
  await waitFor(() => expect(on.result.current.data?.enabled).toBe(true));
  expect(asked).toBe(1);
});

it('posts a one-off night and a delete, and refreshRhythms invalidates suggestions', async () => {
  const posted: Array<[string, unknown]> = [];
  server.use(
    http.post('*/rhythms/suggestions/exclude', async ({ request }) => {
      posted.push(['exclude', await request.json()]);
      return new HttpResponse(null, { status: 204 });
    }),
    http.post('*/rhythms/suggestions/forget', async ({ request }) => {
      posted.push(['forget', await request.json()]);
      return new HttpResponse(null, { status: 204 });
    }),
  );
  await postNightExclude({ side: 'right', rhythmId: 'off-days', date: '2026-10-10', excluded: true });
  await postSuggestionsForget();
  expect(posted).toEqual([
    ['exclude', { side: 'right', rhythmId: 'off-days', date: '2026-10-10', excluded: true }], ['forget', {}],
  ]);
  const client = new QueryClient();
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  await refreshRhythms(client);
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ['useSuggestions'] });
});

it('reads the notes item by item, dropping a bad night or dismissed entry', () => {
  const night = (date: string) => ({
    date, rhythmId: 'off-days', tonight: false, excluded: false, plan: [{ offsetMin: 0, temperatureF: 82 }], endMin: 480, changes: [],
  });
  const dismissed = { id: '0123456789ab', rhythmId: 'off-days', key: null, time: null, scope: 'later', nightsLeft: 3 };
  const read = validateResponse('/rhythms/suggestions', {
    enabled: true, nights: {}, suggestions: [],
    log: [night('2026-10-09'), { ...night('2026-10-10'), plan: [{ offsetMin: 0 }] }, { date: '2026-10-11' }, night('2026-10-12')],
    dismissed: [dismissed, { id: 'nope' }, { ...dismissed, id: 'ba9876543210' }],
  }) as { log: Array<{ date: string }>; dismissed: Array<{ id: string }> };
  expect(read.log.map(item => item.date)).toEqual(['2026-10-09', '2026-10-12']);
  expect(read.dismissed.map(item => item.id)).toEqual(['0123456789ab', 'ba9876543210']);
});
