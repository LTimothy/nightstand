import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { waitFor } from '@testing-library/react';
import { renderWithProviders } from '@test/renderWithProviders';
import { useEventStreamStore } from './eventStream';
import { useDeviceStatus } from './deviceStatus';
import type { DeviceStatus } from './deviceStatusSchema';

// Minimal scriptable stand-in for the browser WebSocket. eventStream.ts only
// uses the constructor, onopen/onmessage/onerror/onclose and close().
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;

  public readyState = 0;
  public onopen: (() => void) | null = null;
  public onclose: (() => void) | null = null;
  public onerror: (() => void) | null = null;
  public onmessage: ((ev: { data: string }) => void) | null = null;
  public closeCalls = 0;

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  close() {
    this.closeCalls += 1;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }

  simulateOpen() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  simulateDrop() {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }

  simulateMessage(data: string) {
    this.onmessage?.({ data });
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const g = globalThis as any;
let realWebSocket: unknown;

function Probe() {
  useDeviceStatus();
  return <div>probe</div>;
}

beforeEach(() => {
  realWebSocket = g.WebSocket;
  FakeWebSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeWebSocket);
  // vitest.config.ts pins VITE_ENV to 'demo' for the whole suite, which makes
  // useEventStream() a no-op. Undo that here so the socket path actually runs.
  vi.stubEnv('VITE_ENV', 'test');
  useEventStreamStore.setState({ state: 'idle' });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  void realWebSocket;
});

const latest = () => FakeWebSocket.instances[FakeWebSocket.instances.length - 1];

describe('eventStream reconnect lifecycle', () => {
  it('clears the reconnecting state once the socket comes back', async () => {
    renderWithProviders(<Probe />);

    await waitFor(() => expect(FakeWebSocket.instances.length).toBe(1));
    latest().simulateOpen();
    await waitFor(() => expect(useEventStreamStore.getState().state).toBe('open'));

    latest().simulateDrop();
    await waitFor(() => expect(useEventStreamStore.getState().state).toBe('reconnecting'));

    // Backoff starts at 500ms.
    await waitFor(() => expect(FakeWebSocket.instances.length).toBe(2), { timeout: 3000 });
    latest().simulateOpen();
    await waitFor(() => expect(useEventStreamStore.getState().state).toBe('open'));
  });

  it('stops reconnecting after the subscriber unmounts', async () => {
    const { unmount } = renderWithProviders(<Probe />);

    await waitFor(() => expect(FakeWebSocket.instances.length).toBe(1));
    latest().simulateOpen();
    latest().simulateDrop();
    await waitFor(() => expect(useEventStreamStore.getState().state).toBe('reconnecting'));

    unmount();
    const countAtUnmount = FakeWebSocket.instances.length;
    await new Promise((r) => setTimeout(r, 1200));
    expect(FakeWebSocket.instances.length).toBe(countAtUnmount);
  });

  it('survives a malformed frame and keeps processing later good frames', async () => {
    const { queryClient } = renderWithProviders(<Probe />);
    await waitFor(() => expect(queryClient.getQueryData(['useDeviceStatus'])).toBeTruthy());
    await waitFor(() => expect(FakeWebSocket.instances.length).toBe(1));
    latest().simulateOpen();

    expect(() => latest().simulateMessage('not json at all')).not.toThrow();
    const current = queryClient.getQueryData(['useDeviceStatus']) as DeviceStatus;
    const next: DeviceStatus = { ...current, left: { ...current.left, targetTemperatureF: 97 } };
    latest().simulateMessage(JSON.stringify({ channel: 'device-status', payload: next }));
    await waitFor(() => expect((queryClient.getQueryData(['useDeviceStatus']) as DeviceStatus).left.targetTemperatureF).toBe(97));
  });
});

// The socket is an unauthenticated network boundary and every consumer reads
// device status with optional chaining and defaults, so a bad frame written to
// the cache shows the bed as off at 55F instead of as an error, and the 60s
// refetch leaves it that way for up to a minute. Bad frames are dropped.
describe('eventStream device-status payload handling', () => {
  it('does not let a null device-status frame wipe the cached status', async () => {
    const { queryClient } = renderWithProviders(<Probe />);

    await waitFor(() => expect(queryClient.getQueryData(['useDeviceStatus'])).toBeTruthy());
    await waitFor(() => expect(FakeWebSocket.instances.length).toBe(1));
    latest().simulateOpen();

    latest().simulateMessage(JSON.stringify({ channel: 'device-status', payload: null }));

    const cached = queryClient.getQueryData(['useDeviceStatus']);
    expect(cached).toBeTruthy();
  });

  it('does not let a garbage device-status frame replace a good cached status', async () => {
    const { queryClient } = renderWithProviders(<Probe />);

    await waitFor(() => expect(queryClient.getQueryData(['useDeviceStatus'])).toBeTruthy());
    await waitFor(() => expect(FakeWebSocket.instances.length).toBe(1));
    latest().simulateOpen();

    latest().simulateMessage(JSON.stringify({ channel: 'device-status', payload: { nonsense: true } }));

    const cached = queryClient.getQueryData(['useDeviceStatus']) as Record<string, unknown>;
    expect(cached.left).toBeDefined();
  });

  it('accepts future fields and missing optional sensor temperatures in pushes', async () => {
    const { queryClient } = renderWithProviders(<Probe />);
    await waitFor(() => expect(queryClient.getQueryData(['useDeviceStatus'])).toBeTruthy());
    const current = queryClient.getQueryData(['useDeviceStatus']) as DeviceStatus;
    const next = { ...current, sensorTemps: undefined, future: true,
      left: { ...current.left, targetTemperatureF: 98, future: true } };
    latest().simulateMessage(JSON.stringify({ channel: 'device-status', payload: next }));
    const cached = queryClient.getQueryData(['useDeviceStatus']) as DeviceStatus;
    expect(cached.left.targetTemperatureF).toBe(98);
    expect(cached).not.toHaveProperty('future');
    expect(cached.left).not.toHaveProperty('future');
  });

  it('writes a valid device-status frame straight to the cache', async () => {
    const { queryClient } = renderWithProviders(<Probe />);

    await waitFor(() => expect(queryClient.getQueryData(['useDeviceStatus'])).toBeTruthy());
    await waitFor(() => expect(FakeWebSocket.instances.length).toBe(1));
    latest().simulateOpen();

    const current = queryClient.getQueryData(['useDeviceStatus']) as DeviceStatus;
    const next: DeviceStatus = { ...current, left: { ...current.left, targetTemperatureF: 99 } };
    latest().simulateMessage(JSON.stringify({ channel: 'device-status', payload: next }));

    await waitFor(() => {
      const cached = queryClient.getQueryData(['useDeviceStatus']) as DeviceStatus;
      expect(cached.left.targetTemperatureF).toBe(99);
    });
  });
});
