import { http, HttpResponse, delay, sse } from 'msw';
import { demoPresence, demoPresenceStale, demoReads, demoWritesHang } from './demoPreferences';
import type { SleepRecord } from '@api/sleepSchema.ts';
import type { Jobs } from '@api/jobs.ts';
import type { BasePosition } from '@api/baseControl.ts';
import type { MissedAlarm } from '@api/missedAlarms.ts';
import { inUseLines, type InUseReasonText } from '@api/bedInUse.ts';
import {
  getServices,
  updateServices,
  getSchedules,
  updateSchedules,
  getSettings,
  updateSettings,
  getDeviceStatus,
  isPrimingAt,
  updateDeviceStatus,
  getServerStatus,
  getStorageInfo,
  getMemoryInfo,
  getBaseStatus,
  setBasePosition,
  setBasePreset,
  stopBase,
  listSleepRecords,
  setSleepRecords,
  listMovementRecords,
  listVitalsRecords,
  getSleepStages,
  getSleepScore,
  filterByQuery,
  listLogs,
  getLogFiles,
  getChangelog,
  handleJobs,
  getReleasesManifest,
  getRemoteServerInfo,
  getRemoteChangelogMarkdown,
  rollbackInfo,
  presence,
  mockCalibration,
} from './mockData';
import type { RhythmsUpdate } from '@api/rhythms';
import type { NightExclude, SuggestionDismiss } from '@api/rhythmsSchema';
import {
  dismissMockSuggestion, excludeMockNight, forgetMockSuggestions, getMockSuggestions, restoreMockSuggestions,
} from './suggestionsMock';
import {
  disableMockRhythms, enableMockRhythms, getMockRhythmsResponse, listMockSleeps, mockLive, scheduledSecondsRemaining, updateMockRhythms,
} from './rhythmsMock';

type Side = 'left' | 'right';

// The demo shows no missed alarms unless it is opened with ?missed-alarms, so
// the other pages stay as they were. The list is read once, when the first
// request arrives, because navigating drops the query string.
let demoMissedAlarms: MissedAlarm[] | undefined;
const missedAlarmsForDemo = (): MissedAlarm[] => {
  demoMissedAlarms ??= new URLSearchParams(globalThis.location?.search).has('missed-alarms') ? [
    { id: 'demo-left-late', side: 'left', at: '2026-10-05T13:30:00.000Z', reason: 'late', recordedAt: '2026-10-05T13:40:00.000Z' },
    { id: 'demo-right-off', side: 'right', at: '2026-10-05T14:00:00.000Z', reason: 'side-off', recordedAt: '2026-10-05T14:10:00.000Z' },
  ] : [];
  return demoMissedAlarms;
};

// The demo treats the bed as idle unless it is opened with ?in-use, so update,
// rollback and switch can show their second confirmation. Read once, as above.
let demoInUse: InUseReasonText[] | undefined;
const inUseForDemo = (): InUseReasonText[] => {
  demoInUse ??= new URLSearchParams(globalThis.location?.search).has('in-use') ? ['left-on', 'alarm-soon'] : [];
  return demoInUse;
};
const refuseWhileInUse = async (request: Request) => {
  const reasons = inUseForDemo();
  if (reasons.length === 0) return undefined;
  const text = await request.clone().text();
  if ((text ? JSON.parse(text) : {}).confirmInUse === true) return undefined;
  const message = inUseLines(reasons).join(' ');
  return HttpResponse.json({ error: message, message, reasons }, { status: 409 });
};

type Filters = {
  startTime?: string;
  endTime?: string;
  side?: Side;
};

const deepClone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const toFilters = (request: Request): Filters => {
  const url = new URL(request.url);
  const startTime = url.searchParams.get('startTime') ?? undefined;
  const endTime = url.searchParams.get('endTime') ?? undefined;
  const sideParam = url.searchParams.get('side') ?? undefined;
  const side = sideParam === 'left' || sideParam === 'right' ? sideParam : undefined;
  return { startTime, endTime, side };
};

const notFound = (message: string) => HttpResponse.json({ message }, { status: 404 });

export const handlers = [
  http.get('/api/services', async () => {
    await delay(120);
    return HttpResponse.json(deepClone(getServices()));
  }),
  http.post('/api/services', async ({ request }) => {
    const body = (await request.json()) as Partial<ReturnType<typeof getServices>>;
    const updated = updateServices(body);
    await delay(120);
    return HttpResponse.json(deepClone(updated));
  }),
  http.get('/api/schedules', async () => {
    if (demoReads() === 'hang') await delay('infinite');
    await delay(120);
    return HttpResponse.json(deepClone(getSchedules()));
  }),
  http.post('/api/schedules', async ({ request }) => {
    const body = (await request.json()) as Partial<ReturnType<typeof getSchedules>>;
    const updated = updateSchedules(body);
    await delay(120);
    return HttpResponse.json(deepClone(updated));
  }),
  http.get('/api/rhythms', async () => {
    if (demoReads() === 'hang') await delay('infinite');
    await delay(120);
    return HttpResponse.json(deepClone(getMockRhythmsResponse()));
  }),
  http.post('/api/rhythms', async ({ request }) => {
    const result = updateMockRhythms((await request.json()) as RhythmsUpdate);
    await delay(120);
    return result.ok ? HttpResponse.json(deepClone(result.body)) : HttpResponse.json(result.body, { status: result.status });
  }),
  http.get('/api/rhythms/sleeps', async ({ request }) => {
    if (demoReads() === 'hang') await delay('infinite');
    const url = new URL(request.url);
    const side = url.searchParams.get('side') === 'right' ? 'right' : 'left';
    const from = new Date(url.searchParams.get('from') ?? Date.now());
    const to = new Date(url.searchParams.get('to') ?? Date.now());
    await delay(120);
    return HttpResponse.json(listMockSleeps(side, from, to));
  }),
  http.post('/api/rhythms/enable', async () => {
    await delay(120);
    return HttpResponse.json(enableMockRhythms());
  }),
  http.post('/api/rhythms/disable', async ({ request }) => {
    const body = (await request.json()) as { powerOffNow?: boolean };
    await delay(120);
    return HttpResponse.json(disableMockRhythms(body));
  }),
  // The demo has no presence, so only a "When I get up" sleep is live.
  http.get('/api/rhythms/live', async ({ request }) => {
    const side = new URL(request.url).searchParams.get('side') === 'right' ? 'right' : 'left';
    await delay(120);
    return HttpResponse.json(mockLive(side));
  }),
  http.get('/api/rhythms/suggestions', async ({ request }) => {
    const side = new URL(request.url).searchParams.get('side') === 'right' ? 'right' : 'left';
    await delay(120);
    return HttpResponse.json(getMockSuggestions(side));
  }),
  http.post('/api/rhythms/suggestions/dismiss', async ({ request }) => {
    const ids = dismissMockSuggestion((await request.json()) as SuggestionDismiss);
    await delay(120);
    return HttpResponse.json({ ids });
  }),
  http.post('/api/rhythms/suggestions/restore', async ({ request }) => {
    const body = (await request.json()) as { side: 'left' | 'right'; ids: string[] };
    await delay(120);
    return restoreMockSuggestions(body.side, body.ids)
      ? new HttpResponse(null, { status: 204 }) : HttpResponse.json({ error: 'Nothing is hidden with those ids' }, { status: 404 });
  }),
  http.post('/api/rhythms/suggestions/exclude', async ({ request }) => {
    excludeMockNight((await request.json()) as NightExclude);
    await delay(120);
    return new HttpResponse(null, { status: 204 });
  }),
  http.post('/api/rhythms/suggestions/forget', async () => {
    forgetMockSuggestions();
    await delay(120);
    return new HttpResponse(null, { status: 204 });
  }),
  http.get('/api/settings', async () => {
    await delay(120);
    return HttpResponse.json(deepClone(getSettings()));
  }),
  http.post('/api/settings', async ({ request }) => {
    const body = (await request.json()) as Partial<ReturnType<typeof getSettings>>;
    const updated = updateSettings(body);
    await delay(120);
    return HttpResponse.json(deepClone(updated));
  }),
  http.get('/api/deviceStatus', async () => {
    if (demoReads() === 'hang') await delay('infinite');
    if (demoReads() === 'fail') {
      return HttpResponse.json({ error: { message: 'Pod did not respond in time, retrying connection' } }, { status: 503 });
    }
    await delay(120);
    const status = deepClone(getDeviceStatus());
    // The demo's timers follow the schedule; unit tests keep a fixed status so refetches change nothing.
    for (const side of import.meta.env.MODE === 'test' ? [] : ['left', 'right'] as const) {
      const seconds = status[side].isOn ? scheduledSecondsRemaining(side) : undefined;
      if (seconds !== undefined) status[side].secondsRemaining = seconds;
    }
    if (import.meta.env.MODE !== 'test' && !status.isPriming) status.isPriming = isPrimingAt(new Date(), status);
    return HttpResponse.json(status);
  }),
  http.post('/api/deviceStatus', async ({ request }) => {
    if (demoWritesHang()) await delay('infinite');
    const body = (await request.json()) as Partial<ReturnType<typeof getDeviceStatus>>;
    updateDeviceStatus(body);
    await delay(120);
    return new HttpResponse(null, { status: 204 });
  }),
  http.get('/api/serverStatus', async () => {
    await delay(150);
    return HttpResponse.json(deepClone(getServerStatus()));
  }),
  http.get('/api/storage', async () => {
    await delay(150);
    return HttpResponse.json(deepClone(getStorageInfo()));
  }),
  http.get('/api/memory', async () => {
    await delay(150);
    return HttpResponse.json(deepClone(getMemoryInfo()));
  }),
  http.get('/api/changelog', async () => {
    await delay(150);
    return HttpResponse.json({ entries: deepClone(getChangelog()) });
  }),
  http.get('/api/update/rollback-info', () => HttpResponse.json(rollbackInfo)),
  http.get('/api/update/last-result', () => HttpResponse.json({ error: 'No result recorded yet' }, { status: 404 })),
  http.post('/api/update', async ({ request }) => (await refuseWhileInUse(request)) ?? new HttpResponse(null, { status: 204 })),
  http.get('/api/base-control', async () => {
    await delay(100);
    return HttpResponse.json(deepClone(getBaseStatus()));
  }),
  http.post('/api/base-control', async ({ request }) => {
    const body = (await request.json()) as BasePosition;
    await delay(100);
    return HttpResponse.json(deepClone(setBasePosition(body)));
  }),
  http.post('/api/base-control/preset', async ({ request }) => {
    const body = (await request.json()) as { preset: string };
    await delay(100);
    return HttpResponse.json(deepClone(setBasePreset(body.preset)));
  }),
  http.post('/api/base-control/stop', async () => {
    await delay(100);
    return HttpResponse.json(deepClone(stopBase()));
  }),
  http.get('/api/metrics/sleep-stages', async ({ request }) => {
    const { startTime, endTime } = toFilters(request);
    await delay(150);
    if (!startTime || !endTime) {
      return HttpResponse.json({
        epochs: [],
        totals: { awake: 0, rem: 0, light: 0, deep: 0 },
        percentages: { awake: 0, rem: 0, light: 0, deep: 0 },
        totalSeconds: 0,
      });
    }
    return HttpResponse.json(getSleepStages(startTime, endTime));
  }),
  http.get('/api/metrics/sleep-score', async ({ request }) => {
    const { startTime, endTime } = toFilters(request);
    await delay(150);
    if (!startTime || !endTime) {
      return HttpResponse.json({
        score: 0,
        components: {
          duration: { score: 0, weight: 0.4, value: '', available: false },
          continuity: { score: 0, weight: 0.3, value: '', available: false },
          restingHr: { score: 0, weight: 0.15, value: '', available: false },
        },
      });
    }
    return HttpResponse.json(getSleepScore(startTime, endTime));
  }),
  http.get('/api/metrics/sleep', async ({ request }) => {
    const filters = toFilters(request);
    const records = listSleepRecords();
    // @ts-expect-error
    const filtered = filterByQuery(records, filters, (record: SleepRecord) => Date.parse(record.entered_bed_at));
    await delay(150);
    return HttpResponse.json(deepClone(filtered));
  }),
  http.delete('/api/metrics/sleep/:id', async ({ params }) => {
    const id = Number(params.id);
    const records = listSleepRecords();
    const next = records.filter((record) => record.id !== id);
    if (next.length === records.length) {
      return notFound('Sleep record not found');
    }
    setSleepRecords(next);
    await delay(80);
    return new HttpResponse(null, { status: 204 });
  }),
  http.put('/api/metrics/sleep/:id', async ({ params, request }) => {
    const id = Number(params.id);
    const updates = (await request.json()) as Partial<SleepRecord>;
    const records = deepClone(listSleepRecords());
    const index = records.findIndex((record) => record.id === id);
    if (index === -1) {
      return notFound('Sleep record not found');
    }
    const updatedRecord = { ...records[index], ...updates } satisfies SleepRecord;
    records[index] = updatedRecord;
    setSleepRecords(records);
    await delay(80);
    return HttpResponse.json(updatedRecord);
  }),
  http.get('/api/metrics/movement', async () => {
    // const filters = toFilters(request);
    const records = listMovementRecords();
    // const filtered = filterByQuery(records, filters, (record: MovementRecord) => record.timestamp * 1000);
    await delay(120);
    return HttpResponse.json(records);
  }),
  http.get('/api/metrics/vitals', async ({ request }) => {
    const filters = toFilters(request);
    const records = listVitalsRecords();
    const filtered = filterByQuery(records, filters, record => record.timestamp * 1000);
    await delay(120);
    return HttpResponse.json(filtered);
  }),
  http.get('/api/metrics/presence', () => {
    const now = Date.now();
    // Someone was in bed at the last report, which is too old to trust.
    if (demoPresenceStale()) {
      return HttpResponse.json({
        ...presence,
        left: {
          present: true, lastUpdatedAt: new Date(now - 10 * 60_000).toISOString(), stateChangedAt: new Date(now - 40 * 60_000).toISOString(),
        },
      });
    }
    const seated = demoPresence();
    // The demo acts as if presence were fresh, as its live state does; a spec can make it stale.
    if (!seated) {
      const reported = new Date(now).toISOString();
      return HttpResponse.json({
        left: { ...presence.left, lastUpdatedAt: reported, stateChangedAt: reported },
        right: { ...presence.right, lastUpdatedAt: reported, stateChangedAt: reported },
      });
    }
    const since = now - (seated === 'fresh' ? 12 * 60_000 : 20_000);
    return HttpResponse.json({
      ...presence,
      left: { present: true, lastUpdatedAt: new Date(now).toISOString(), stateChangedAt: new Date(since).toISOString() },
    });
  }),
  http.get('/api/calibration', () => HttpResponse.json(mockCalibration)),
  http.get('/api/metrics/vitals/summary', async ({ request }) => {
    const filters = toFilters(request);
    const records = filterByQuery(listVitalsRecords(), filters, record => record.timestamp * 1000);
    await delay(120);
    if (records.length === 0) {
      return HttpResponse.json({ avgHeartRate: 0, minHeartRate: 0, maxHeartRate: 0, avgHRV: 0, avgBreathingRate: 0 });
    }
    const heartRates = records.map(record => record.heart_rate);
    const mean = (values: number[]) => Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
    return HttpResponse.json({
      avgHeartRate: mean(heartRates),
      minHeartRate: Math.min(...heartRates),
      maxHeartRate: Math.max(...heartRates),
      avgHRV: mean(records.map(record => record.hrv)),
      avgBreathingRate: mean(records.map(record => record.breathing_rate)),
    });
  }),
  // The real route fires the alarm and returns the schedules; the demo has no
  // bed to vibrate, so it only returns them.
  http.post('/api/alarm', async () => {
    await delay(150);
    return HttpResponse.json(deepClone(getSchedules()));
  }),
  http.get('/api/alarms/missed', () => HttpResponse.json({ missed: missedAlarmsForDemo() })),
  http.post('/api/alarms/missed/dismiss', async ({ request }) => {
    const { ids } = await request.json() as { ids: string[] };
    demoMissedAlarms = missedAlarmsForDemo().filter(item => !ids.includes(item.id));
    return new HttpResponse(null, { status: 204 });
  }),
  http.post('/api/update/switch-to-upstream', async ({ request }) => (await refuseWhileInUse(request)) ?? HttpResponse.json({ success: true })),
  http.post('/api/update/rollback', async ({ request }) => (await refuseWhileInUse(request)) ?? HttpResponse.json({ success: true })),
  http.post('/api/jobs', async ({ request }) => {
    const jobs = (await request.json()) as Jobs;
    handleJobs(jobs);
    await delay(150);
    return new HttpResponse(null, { status: 204 });
  }),
  http.get('/api/logs', async () => {
    await delay(120);
    return HttpResponse.json({ logs: getLogFiles() });
  }),
  // Live tail of one log file, as the server streams it over SSE. MSW can only
  // mock SSE where EventSource exists, so jsdom unit tests skip this handler.
  ...(typeof EventSource === 'undefined' ? [] : [sse('/api/logs/:filename', ({ client, params, request }) => {
    const filename = params.filename as string;
    const logStore = listLogs();
    if (!logStore[filename]) {
      client.send({ data: JSON.stringify({ message: 'Log file not found' }) });
      client.close();
      return;
    }

    const initialLogs = deepClone(logStore[filename]);
    initialLogs.forEach((entry) => {
      client.send({ data: JSON.stringify({ message: entry }) });
    });
    let lastIndex = initialLogs.length;
    const interval = setInterval(() => {
      const latest = listLogs()[filename] ?? [];
      if (latest.length > lastIndex) {
        latest.slice(lastIndex).forEach((entry) => {
          client.send({ data: JSON.stringify({ message: entry }) });
        });
        lastIndex = latest.length;
      }
    }, 2000);
    request.signal.addEventListener('abort', () => clearInterval(interval));
  })]),

  // The pod has no WAN, so these three files only ever resolve in the browser;
  // mocking them keeps the demo and the tests offline and deterministic.
  http.get('https://raw.githubusercontent.com/LTimothy/nightstand/main/releases.json', () =>
    HttpResponse.json(getReleasesManifest())),
  http.get('https://raw.githubusercontent.com/LTimothy/nightstand/main/server/src/serverInfo.json', () =>
    HttpResponse.json(getRemoteServerInfo())),
  http.get('https://raw.githubusercontent.com/LTimothy/nightstand/main/CHANGELOG.md', () =>
    HttpResponse.text(getRemoteChangelogMarkdown())),
];
