import { isAxiosError } from 'axios';
import moment from 'moment-timezone';
import { useQuery, type QueryClient, type QueryFunctionContext } from '@tanstack/react-query';
import { z } from 'zod';
import { serverMessage } from '@lib/requestError';
import axios, { HARDWARE_REQUEST_TIMEOUT_MS } from './api';
import { useSettings } from './settings';
import {
  IsoDateSchema, NightExcludeSchema, RhythmsUpdateSchema, SuggestionDismissResponseSchema, SuggestionDismissSchema, SuggestionRestoreSchema,
  type NightExclude, type RhythmsUpdate, type SuggestionDismiss, type SuggestionsResponse,
} from './rhythmsSchema';
import {
  EnableResponseSchema, HandoffReportSchema, type HandoffReport, type ResolvedSleepResponse, type RhythmsLive, type RhythmsResponse,
} from './rhythmsResponse';

// One definition, the server's; the body stays strict.
export { RhythmsUpdateSchema, type RhythmsUpdate };

export const rhythmsQuery = {
  queryKey: ['useRhythms'],
  queryFn: async ({ signal }: QueryFunctionContext): Promise<RhythmsResponse> =>
    (await axios.get<RhythmsResponse>('/rhythms', { signal })).data,
};

export const useRhythms = ({ enabled = true }: { enabled?: boolean } = {}) => useQuery({ ...rhythmsQuery, enabled });

export const useResolvedSleeps = (side: 'left' | 'right', from: string, to: string, enabled = true) => useQuery({
  queryKey: ['useResolvedSleeps', side, from, to],
  queryFn: async ({ signal }) =>
    (await axios.get<ResolvedSleepResponse[]>('/rhythms/sleeps', { params: { side, from, to }, signal })).data,
  enabled,
  // While a moved window loads, the same side's last answer stands in; another side's never does.
  placeholderData: (previous, previousQuery) => (previousQuery?.queryKey[1] === side ? previous : undefined),
});

// The running Smart Schedule night; a manual hold lives only here.
export const useRhythmsLive = (side: 'left' | 'right', enabled = true) => useQuery({
  queryKey: ['useRhythmsLive', side],
  queryFn: async ({ signal }) => (await axios.get<RhythmsLive | null>('/rhythms/live', { params: { side }, signal })).data,
  enabled,
  refetchInterval: 30_000,
});

// Hand-change notes and suggestions for a side; mounted only while the feature is on.
export const useSuggestions = (side: 'left' | 'right', enabled: boolean) => useQuery({
  queryKey: ['useSuggestions', side],
  queryFn: async ({ signal }) =>
    (await axios.get<SuggestionsResponse>('/rhythms/suggestions', { params: { side }, signal })).data,
  enabled,
});

export const postNightExclude = (body: NightExclude) => axios.post('/rhythms/suggestions/exclude', NightExcludeSchema.parse(body));

export const postSuggestionsForget = () => axios.post('/rhythms/suggestions/forget', {});

// The ids let the undo bring back exactly what was hidden.
export async function postSuggestionDismiss(body: SuggestionDismiss): Promise<string[]> {
  const response = await axios.post('/rhythms/suggestions/dismiss', SuggestionDismissSchema.parse(body));
  return SuggestionDismissResponseSchema.parse(response.data).ids;
}

export const postSuggestionRestore = (body: { side: 'left' | 'right'; ids: string[] }) =>
  axios.post('/rhythms/suggestions/restore', SuggestionRestoreSchema.parse(body));

export type RhythmsState = 'unknown' | 'off' | 'loading' | 'error' | 'active' | 'inactive';

// The one place that decides whether Rhythms drives the Schedule and Bed pages.
export function useRhythmsState() {
  const { data: settings } = useSettings();
  const flag = !!settings?.features?.rhythms;
  const query = useRhythms({ enabled: flag });
  // A failed refetch keeps the last answer, so an open draft stays. Running, but this app cannot read
  // the file: an error, so the weekly editor never stands in for Rhythms.
  const state: RhythmsState = !settings ? 'unknown' : !flag ? 'off' : query.isError && !query.data ? 'error' : !query.data ? 'loading'
    : !query.data.status.active ? 'inactive' : query.data.data ? 'active' : 'error';
  return { state, response: query.data, refetch: query.refetch };
}

export const postRhythms = (body: RhythmsUpdate) => axios.post('/rhythms', RhythmsUpdateSchema.parse(body));

// Turning on writes files and waits for the job rebuild, with no hardware command.
export async function enableRhythms() {
  const response = await axios.post('/rhythms/enable', {});
  return EnableResponseSchema.parse(response.data);
}

// After the rebuild the handoff can turn a side off or move its firmware timer.
export async function disableRhythms(options: { powerOffNow: boolean }): Promise<HandoffReport> {
  const response = await axios.post('/rhythms/disable', { powerOffNow: options.powerOffNow }, { timeout: HARDWARE_REQUEST_TIMEOUT_MS });
  const parsed = HandoffReportSchema.safeParse(response.data);
  return parsed.success ? parsed.data : { sides: [] };
}

export async function refreshRhythms(queryClient: QueryClient) {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ['useRhythms'] }),
    queryClient.invalidateQueries({ queryKey: ['useResolvedSleeps'] }),
    queryClient.invalidateQueries({ queryKey: ['useRhythmsLive'] }),
    queryClient.invalidateQueries({ queryKey: ['useSuggestions'] }),
    queryClient.invalidateQueries({ queryKey: ['useSettings'] }),
  ]);
}

const OverlapSchema = z.object({ overlaps: z.array(z.object({ first: IsoDateSchema, second: IsoDateSchema })).min(1) });
// "Invalid rhythms" lists its reasons as text in details.
const DetailsSchema = z.object({ details: z.array(z.string().min(1)).min(1) });
const SET_POINT_CAP = /can have at most (\d+) temperature changes$/;
const sentence = (text: string) => (/[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`);

// Within the coming week a sleep is named by its day ("Saturday"), further out by its date.
export function sleepDayName(date: string, today: string): string {
  const offset = moment(date, 'YYYY-MM-DD').diff(moment(today, 'YYYY-MM-DD'), 'days');
  if (offset === -1) return 'yesterday';
  if (offset === 0) return 'today';
  if (offset === 1) return 'tomorrow';
  return moment(date, 'YYYY-MM-DD').format(offset > 0 && offset < 7 ? 'dddd' : 'ddd, MMM D');
}

export function rhythmsSaveMessage(error: unknown, today: string): string {
  const data = isAxiosError(error) ? error.response?.data : undefined;
  const parsed = OverlapSchema.safeParse(data);
  if (parsed.success) {
    const { first, second } = parsed.data.overlaps[0];
    return `The sleeps starting ${sleepDayName(first, today)} and ${sleepDayName(second, today)} would overlap. `
      + 'Check when each one turns off, or pick another rhythm for one of those days.';
  }
  // "Invalid rhythms" details are written for developers ("left: Rhythm workday ..."); only the set point cap reaches the editor.
  const details = DetailsSchema.safeParse(data);
  if (details.success) {
    const cap = details.data.details.map(detail => SET_POINT_CAP.exec(detail)).find(Boolean);
    return cap ? `Could not save Rhythms. A rhythm can have at most ${cap[1]} temperature changes. Your changes were not saved.`
      : 'Could not save Rhythms. Your changes were not saved. Try again.';
  }
  // A 400 without details is a body the server could not read, with no reason worth showing.
  const reason = isAxiosError(error) && error.response?.status === 400 ? undefined : serverMessage(error);
  return reason ? `Could not save Rhythms. ${sentence(reason)} Your changes were not saved.`
    : 'Could not save Rhythms. Your changes were not saved. Try again.';
}
