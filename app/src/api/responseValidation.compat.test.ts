import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateResponse } from './responseValidation';
import { getDeviceStatus, getSchedules, getServices, getSettings } from '../mocks/mockData';
import { SettingsSchema, type Settings } from './settingsSchema';
import { DailyScheduleSchema } from './schedulesSchema';

it.each([
  ['/settings', getSettings], ['/schedules', getSchedules], ['/services', getServices], ['/deviceStatus', getDeviceStatus],
] as const)('strips future keys from %s without changing the source', (path, fixture) => {
  const data = structuredClone(fixture());
  const addUnknown = (value: unknown) => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(addUnknown); return; }
    Object.values(value).forEach(addUnknown);
    // Records have meaningful keys, so only add to objects with named fields.
    if (Object.keys(value).some(key => /^[a-z]/i.test(key))) Object.assign(value, { futureField: true });
  };
  addUnknown(data);
  expect(validateResponse(path, data)).toEqual(fixture());
  expect(data).toHaveProperty('futureField', true);
});

it('accepts upstream status without sensor temperatures', () => {
  const status: Record<string, unknown> = { ...getDeviceStatus() };
  delete status.sensorTemps;
  expect(validateResponse('/deviceStatus', status)).toEqual(status);
});

it('accepts legacy alarm counts and keeps request limits', () => {
  const schedules = structuredClone(getSchedules());
  schedules.left.monday.alarms = Array.from({ length: 12 }, () => ({ ...schedules.left.monday.alarm }));
  expect(validateResponse('/schedules', schedules)).toEqual(schedules);
  expect(DailyScheduleSchema.safeParse(schedules.left.monday).success).toBe(false);
});

it('keeps known-value bounds and strict requests', () => {
  const settings = { ...getSettings(), future: true };
  expect(SettingsSchema.safeParse(settings).success).toBe(false);
  expect(() => validateResponse('/deviceStatus', {
    ...getDeviceStatus(), left: { ...getDeviceStatus().left, targetTemperatureF: 500 },
  })).toThrow();
});

it('accepts fields absent from older settings and services', () => {
  const settings = structuredClone(getSettings()) as unknown as Record<string, unknown>;
  for (const key of ['features', 'rebootDaily', 'rawArchiveRetentionDays', 'updateChannel']) delete settings[key];
  for (const side of ['left', 'right']) {
    delete (settings[side] as Record<string, unknown>).oneOffAlarm;
    delete (settings[side] as Record<string, unknown>).alarmsEnabled;
    delete ((settings[side] as Record<string, unknown>).scheduleOverrides as Record<string, unknown>).pause;
  }
  expect(() => validateResponse('/settings', settings)).not.toThrow();
  const services = structuredClone(getServices());
  const jobs = services.biometrics.jobs as unknown as Record<string, unknown>;
  for (const key of ['calibrateLeft', 'calibrateRight', 'pumpLeft', 'pumpRight']) delete jobs[key];
  expect(() => validateResponse('/services', services)).not.toThrow();
});

it('reads settings whose cover buttons are absent or out of range', () => {
  const settings = structuredClone(getSettings());
  const left = settings.left as unknown as Record<string, unknown>;
  delete left.buttons;
  settings.right.buttons = { ...settings.right.buttons, stepF: 50 };
  const parsed = validateResponse('/settings', settings) as typeof settings;
  expect(parsed.left.buttons).toBeUndefined();
  expect(parsed.right.buttons).toBeUndefined();
  expect(validateResponse('/settings', getSettings())).toMatchObject({ right: { buttons: getSettings().right.buttons } });
});

it('accepts settings from a version without the new sleep tracking switch', () => {
  const settings = structuredClone(getSettings());
  const features: Record<string, unknown> = { ...settings.features };
  delete features.biometricsV2;
  const parsed = validateResponse('/settings', { ...settings, features }) as typeof settings;
  expect(parsed.features).not.toHaveProperty('biometricsV2');
  expect(parsed.features?.sleepScore).toBe(true);
});

it('strips future compatibility fixtures after defaults are backfilled', async () => {
  const { default: merge } = await import('lodash/merge');
  const settings = await import('../../../fixtures/compat/future/settingsDB.json');
  const schedules = await import('../../../fixtures/compat/future/schedulesDB.json');
  const services = await import('../../../fixtures/compat/future/servicesDB.json');
  for (const [path, defaults, fixture] of [
    ['/settings', getSettings(), settings.default],
    ['/schedules', getSchedules(), schedules.default],
    ['/services', getServices(), services.default],
  ] as const) {
    const input = merge({}, defaults, fixture);
    const result = validateResponse(path, input);
    const text = JSON.stringify(result);
    for (const key of [
      'futureTop', 'futureSide', 'futureDay', 'futureFeature', 'strayScalar', 'futureService', 'sentryLogging', 'futurePause',
    ]) {
      expect(text).not.toContain(`"${key}"`);
    }
    expect(input).toEqual(merge({}, defaults, fixture));
  }
  const saved = validateResponse('/settings', merge({}, getSettings(), settings.default)) as Settings;
  expect(saved.left.scheduleOverrides.pause).toEqual({ active: true, expiresAt: '' });
});

// Shapes as the Pod serves them: times formatted in the Pod's timezone.
it('accepts sleep times with a timezone offset', () => {
  const sleep = [{ id: 1, side: 'left', entered_bed_at: '2026-09-28T23:45:30-07:00', left_bed_at: '2026-09-29T05:40:14-07:00',
    sleep_period_seconds: 20684, times_exited_bed: 1,
    present_intervals: [['2026-09-28T23:45:30-07:00', '2026-09-29T05:28:40-07:00']],
    not_present_intervals: [['2026-09-29T05:28:40-07:00', '2026-09-29T05:29:06-07:00']] }];
  expect(validateResponse('/metrics/sleep', sleep)).toEqual(sleep);
});

it('keeps the sleep-stages coverage flag and accepts servers that do not send it', () => {
  const stages = {
    active: true, epochs: [{ startUnix: 0, endUnix: 300, stage: 'light' }],
    totals: { awake: 0, rem: 0, light: 300, deep: 0 }, percentages: { awake: 0, rem: 0, light: 100, deep: 0 }, totalSeconds: 300,
  };
  expect(validateResponse('/metrics/sleep-stages', { ...stages, lowCoverage: true })).toEqual({ ...stages, lowCoverage: true });
  expect(validateResponse('/metrics/sleep-stages', stages)).toEqual(stages);
});

// A newer Pod may record fractional or higher heart rates and leave estimates
// empty; one such row must not fail the whole night after a rollback.
it('accepts vitals rows beyond today\'s recorder limits', () => {
  const vitals = [
    { side: 'left', timestamp: 1790664360, heart_rate: 92.4, hrv: null, breathing_rate: 0, rmssd: 41.2 },
    { side: 'right', timestamp: 1790664420, heart_rate: 64, hrv: 38, breathing_rate: 15 },
  ];
  expect(validateResponse('/metrics/vitals', vitals)).toEqual(vitals);
});

it('accepts vitals rows from every estimator and keeps the new fields', () => {
  const legacy = { side: 'left', timestamp: 1790600400, heart_rate: 61, hrv: 45, breathing_rate: 13 };
  const low = { ...legacy, timestamp: 1790600460, heart_rate: 24 };
  const v2 = {
    side: 'right', timestamp: 1790600520, heart_rate: 104, hrv: 0, breathing_rate: 0,
    hr_quality: null, rmssd: 41.3, sdnn: 38.4, hrv_coverage: 0.82, resp_rate: null, resp_quality: null, estimator: 2,
  };
  expect(validateResponse('/metrics/vitals', [legacy, low, v2])).toEqual([legacy, low, v2]);
});

const goodSleep = { id: 1, side: 'left', entered_bed_at: '2026-09-28T23:45:30-07:00', left_bed_at: '2026-09-29T05:40:14-07:00',
  sleep_period_seconds: 20684, times_exited_bed: 1, present_intervals: [], not_present_intervals: [] };

describe('row-level validation', () => {
  afterEach(() => vi.restoreAllMocks());

  it('drops invalid sleep records and keeps the rest', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const more = Array.from({ length: 5 }, (_, index) => ({ ...goodSleep, id: 20 + index }));
    const rows = [
      goodSleep,
      { ...goodSleep, id: 2, left_bed_at: '2026-09-28T20:00:00-07:00' },
      { ...goodSleep, id: 3, sleep_period_seconds: -5 },
      { ...goodSleep, id: 4, entered_bed_at: '2026-09-27T23:45:30' },
      { id: 5 },
      { ...goodSleep, id: 6 },
      ...more,
    ];
    expect(validateResponse('/metrics/sleep', rows)).toEqual([goodSleep, { ...goodSleep, id: 6 }, ...more]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('drops malformed vitals rows and keeps the rest', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const good = { side: 'left', timestamp: 1790664360, heart_rate: 58, hrv: 61, breathing_rate: 14 };
    const more = Array.from({ length: 4 }, (_, index) => ({ ...good, timestamp: 1790664420 + index * 60 }));
    const rows = [good, { ...good, side: 'middle' }, { ...good, hrv: 'x' }, { ...good, timestamp: 1.5 }, ...more];
    expect(validateResponse('/metrics/vitals', rows)).toEqual([good, ...more]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('does not warn when every row is valid', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    validateResponse('/metrics/sleep', [goodSleep]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('treats a list where most rows are invalid as a format error, not a partial history', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(() => validateResponse('/metrics/sleep', [{ id: 1 }, { id: 2 }])).toThrow();
    expect(() => validateResponse('/metrics/sleep', [goodSleep, { id: 2 }, { id: 3 }])).toThrow();
    expect(validateResponse('/metrics/sleep', [goodSleep, { ...goodSleep, id: 2 }, { id: 3 }])).toHaveLength(2);
    expect(validateResponse('/metrics/sleep', [])).toEqual([]);
  });

  it('rejects a body that is not a list', () => {
    expect(() => validateResponse('/metrics/vitals', {})).toThrow();
  });
});

it('keeps the rhythms feature flag now that settings know it', async () => {
  const { default: merge } = await import('lodash/merge');
  const settings = await import('../../../fixtures/compat/future/settingsDB.json');
  const result = validateResponse('/settings', merge({}, getSettings(), settings.default)) as { features: Record<string, boolean> };
  expect(result.features.rhythms).toBe(true);
  expect(getSettings().features.rhythms).toBe(false);
});
