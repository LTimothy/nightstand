import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '@test/setup';
import { useUpdateProgress, migrationsApplied } from './useUpdateProgress';

// An install is judged done when the pod reports a different version. A
// reinstall of the running version never does, so it needs its own test of
// done, or a successful reinstall would sit for ten minutes and then report
// that it may have rolled back.

const originalLocation = window.location;
let reload: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  reload = vi.fn();
  Object.defineProperty(window, 'location', { configurable: true, value: { ...originalLocation, reload } });
});

afterEach(() => {
  vi.useRealTimers();
  Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
});

const deviceVersion = (version: string) =>
  server.use(http.get('*/deviceStatus', () => HttpResponse.json({ freeSleep: { version } })));

const unapplied = (names: string[]) =>
  server.use(http.get('*/serverStatus', () => HttpResponse.json({
    database: {
      name: 'Database',
      status: names.length ? 'failed' : 'healthy',
      description: '',
      message: '',
      unappliedMigrations: names.length ? names : undefined,
    },
  })));

async function startAndPoll(hook: { current: ReturnType<typeof useUpdateProgress> }) {
  await act(async () => { await hook.current.start(async () => undefined); });
  await act(async () => { await vi.advanceTimersByTimeAsync(5_100); });
}

describe('useUpdateProgress', () => {
  it('reloads once the pod reports a different version', async () => {
    deviceVersion('3.2.1');
    const { result } = renderHook(() => useUpdateProgress('3.2.0'));
    await startAndPoll(result);
    expect(reload).toHaveBeenCalled();
  });

  it('keeps waiting while the pod still reports the version it started on', async () => {
    deviceVersion('3.2.0');
    const { result } = renderHook(() => useUpdateProgress('3.2.0'));
    await startAndPoll(result);
    expect(reload).not.toHaveBeenCalled();
    expect(result.current.phase).toBe('updating');
  });

  it('uses the caller\'s test of done instead of the version when given one', async () => {
    // A reinstall: same version throughout, done when the database is.
    deviceVersion('3.2.0');
    unapplied([]);
    const { result } = renderHook(() => useUpdateProgress('3.2.0', migrationsApplied));
    await startAndPoll(result);
    expect(reload).toHaveBeenCalled();
  });

  it('does not finish a reinstall while migrations are still unapplied', async () => {
    unapplied(['20260825052500_calibration_run_payload']);
    const { result } = renderHook(() => useUpdateProgress('3.2.0', migrationsApplied));
    await startAndPoll(result);
    expect(reload).not.toHaveBeenCalled();
  });

  it('times out rather than polling forever', async () => {
    unapplied(['20260825052500_calibration_run_payload']);
    const { result } = renderHook(() => useUpdateProgress('3.2.0', migrationsApplied));
    await act(async () => { await result.current.start(async () => undefined); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 10_000); });
    expect(result.current.phase).toBe('timed_out');
    expect(reload).not.toHaveBeenCalled();
  });
});
