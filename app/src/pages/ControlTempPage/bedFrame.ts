// Two missed 60 s polls.
export const STALE_AFTER_MS = 120_000;
// A healthy Pod answers a status request within the server's 5 s per-command timeout, so a refresh still pending that
// long after it started is not one to wait for.
export const REFRESH_GRACE_MS = 5_000;

export type DialStatus = { isOn: boolean; targetTemperatureF: number; currentTemperatureF: number; currentTemperatureLevel?: number };

export type BedFrame =
  | { kind: 'loading' }
  | { kind: 'live'; status: DialStatus }
  | { kind: 'stale'; since: Date; status?: DialStatus };

export type BedFrameInput = {
  // The selected side from the last good status, if there is one.
  status?: DialStatus;
  hasData: boolean;
  isError: boolean;
  // When the refresh under way started; undefined when none is.
  refreshStartedAt?: number;
  failureCount: number;
  dataUpdatedAt: number;
  // When the page first asked, for a first load that fails.
  requestedAt: number;
  now: number;
};

// Live only while the last status is at most two minutes old and the last request did not fail. An older status is
// not shown; the frame waits, empty, for a refresh, and says the Pod is not responding only once a request fails or
// a refresh has gone unanswered for its grace, never merely because the app was away.
export function bedFrame(input: BedFrameInput): BedFrame {
  if (!input.hasData && !input.isError) return { kind: 'loading' };
  if (!input.hasData || !input.status) return { kind: 'stale', since: new Date(input.requestedAt) };
  const stale = { kind: 'stale', since: new Date(input.dataUpdatedAt), status: input.status } as const;
  if (input.isError) return stale;
  if (input.now - input.dataUpdatedAt <= STALE_AFTER_MS) return { kind: 'live', status: input.status };
  const unanswered = input.refreshStartedAt !== undefined && input.now - input.refreshStartedAt > REFRESH_GRACE_MS;
  return input.failureCount > 0 || unanswered ? stale : { kind: 'loading' };
}
