// Browser-side WebSocket client for the server's /ws/events stream.
//
// Hooks the WS into React Query: device-status pushes update the cached query
// directly (no HTTP refetch), service-health and job-events invalidate the
// relevant cache keys so the next render sees fresh data.
//
// Reconnects with exponential backoff capped at 30s. While disconnected the
// app falls back to React Query's default polling, set in each hook.
import { useEffect } from 'react';
import { create } from 'zustand';
import { useQueryClient, QueryClient } from '@tanstack/react-query';
import { baseURL } from './api';
import { deviceStatusResponseSchema } from './responseValidation';

type ConnectionState = 'idle' | 'connecting' | 'open' | 'reconnecting';

interface EventEnvelope {
  channel: 'device-status' | 'job-event' | 'service-health' | 'hello';
  payload: unknown;
  ts?: string;
}

interface EventStreamState {
  state: ConnectionState;
  setState: (s: ConnectionState) => void;
}

export const useEventStreamStore = create<EventStreamState>((set) => ({
  state: 'idle',
  setState: (s) => set({ state: s }),
}));

function wsUrl(): string {
  // baseURL is `http://...:3000` (or `${window.location.origin}` in prod).
  const url = new URL(baseURL);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  // baseURL does NOT include `/api/`, so append the WS path directly.
  url.pathname = '/ws/events';
  return url.toString();
}

const MAX_BACKOFF_MS = 30_000;
const INITIAL_BACKOFF_MS = 500;

function applyEvent(env: EventEnvelope, qc: QueryClient): void {
  switch (env.channel) {
  case 'device-status': {
    // Server sends the full DeviceStatus payload; write directly to cache
    // so the UI reflects the change without a follow-up GET. Validate first:
    // consumers read this with optional chaining and defaults, so a null or
    // garbage frame would quietly show the bed as off rather than as broken,
    // and the 60s refetch would leave it that way for a minute. Ignoring the
    // frame keeps the last good status until the next valid push or poll.
    const parsed = deviceStatusResponseSchema.safeParse(env.payload);
    if (!parsed.success) {
      console.warn('[eventStream] ignoring invalid device-status payload');
      break;
    }
    qc.setQueryData(['useDeviceStatus'], parsed.data);
    break;
  }
  case 'service-health':
    void qc.invalidateQueries({ queryKey: ['firmware'] });
    // Partial server status patch: easiest path is to invalidate so the
    // next read fetches the canonical full snapshot.
    void qc.invalidateQueries({ queryKey: ['useServerStatus'] });
    break;
  case 'job-event':
    // Jobs touch device state (alarm vibration, scheduled temps, prime).
    // Invalidate device + status caches so the UI catches up.
    void qc.invalidateQueries({ queryKey: ['useDeviceStatus'] });
    void qc.invalidateQueries({ queryKey: ['useServerStatus'] });
    break;
  case 'hello':
    // Server greeting, connection is live.
    break;
  }
}

interface ConnectionHandle {
  close(): void;
}

function connect(qc: QueryClient): ConnectionHandle {
  let stopped = false;
  let socket: WebSocket | null = null;
  let backoff = INITIAL_BACKOFF_MS;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  const store = useEventStreamStore.getState();

  const scheduleRetry = () => {
    if (stopped) return;
    if (retryTimer) clearTimeout(retryTimer);
    const delay = Math.min(backoff, MAX_BACKOFF_MS);
    retryTimer = setTimeout(() => {
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      // eslint-disable-next-line no-use-before-define
      open();
    }, delay);
  };

  const open = () => {
    if (stopped) return;
    store.setState('connecting');
    try {
      socket = new WebSocket(wsUrl());
    } catch (err) {
      // Synchronous failure, schedule retry.
      console.warn('[eventStream] WebSocket constructor failed:', err);
      scheduleRetry();
      return;
    }

    socket.onopen = () => {
      backoff = INITIAL_BACKOFF_MS;
      useEventStreamStore.getState().setState('open');
    };

    socket.onmessage = (msg) => {
      try {
        const env = JSON.parse(msg.data as string) as EventEnvelope;
        applyEvent(env, qc);
      } catch (err) {
        console.warn('[eventStream] bad frame:', err);
      }
    };

    socket.onerror = () => {
      // onerror is followed by onclose; handle reconnect there.
    };

    socket.onclose = () => {
      socket = null;
      if (stopped) return;
      useEventStreamStore.getState().setState('reconnecting');
      scheduleRetry();
    };
  };

  open();

  return {
    close() {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (socket) {
        // Clear handlers first so the close handler doesn't reschedule.
        socket.onclose = null;
        socket.close();
        socket = null;
      }
      useEventStreamStore.getState().setState('idle');
    },
  };
}

// Mounted once at the React tree root so a single WebSocket serves the whole
// app. StrictMode double-invokes effects in dev; the cleanup in the closer
// handles that without leaking sockets.
export function useEventStream(): void {
  const qc = useQueryClient();
  useEffect(() => {
    // The hosted demo is static (GitHub Pages) with no WebSocket server, and
    // MSW's service worker only intercepts HTTP, not WS. Opening the socket
    // there just fails instantly and loops connecting -> reconnecting forever,
    // flashing the Navbar's "Reconnecting…" tag. The demo runs fine on React
    // Query's polling fallback, so skip the socket entirely.
    if (import.meta.env.VITE_ENV === 'demo') return;
    const handle = connect(qc);
    return () => handle.close();
  }, [qc]);
}
