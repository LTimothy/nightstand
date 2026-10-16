import axios from './api';
import { useQuery } from '@tanstack/react-query';

export type PresenceSide = {
  present: boolean;
  lastUpdatedAt?: string;
  stateChangedAt?: string;
  lastPresenceAt?: string;
};

export type PresenceData = {
  left: PresenceSide;
  right: PresenceSide;
};

export const usePresence = (refetchInterval: number = 10_000, enabled = true) => {
  return useQuery<PresenceData>({
    queryKey: ['usePresence'],
    queryFn: async ({ signal }) => {
      const response = await axios.get<PresenceData>('/metrics/presence', { signal });
      return response.data;
    },
    refetchInterval,
    enabled,
  });
};

// The server stops trusting presence after five minutes without a report, and so does the app.
export const PRESENCE_STALE_MS = 5 * 60_000;
// The report carries the Pod's clock and the phone's may run behind it; further ahead is not trusted.
const CLOCK_SKEW_MS = 60_000;

export function isPresenceFresh(observation: PresenceSide | undefined, now = Date.now()): boolean {
  const age = now - Date.parse(observation?.lastUpdatedAt ?? '');
  return Number.isFinite(age) && age >= -CLOCK_SKEW_MS && age <= PRESENCE_STALE_MS;
}
