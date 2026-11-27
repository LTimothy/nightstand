import { screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import moment from 'moment-timezone';
import { renderWithProviders } from '@test/renderWithProviders';
import { server } from '@test/setup';
import { getSettings, getServices } from '../../../mocks/mockData';
import { useAppStore } from '@state/appStore';
import type { SleepRecord } from '@api/sleepSchema';
import SleepPage from './SleepPage';

const record = (hours: number, exits: number): SleepRecord => ({
  id: 1, side: 'left', entered_bed_at: moment.tz('2026-09-23 07:00', 'America/Los_Angeles').subtract(hours, 'hours').format(),
  left_bed_at: moment.tz('2026-09-23 07:00', 'America/Los_Angeles').format(),
  sleep_period_seconds: hours * 3600, times_exited_bed: exits, present_intervals: [], not_present_intervals: [],
});
let requested: string[];
let records: SleepRecord[];
beforeEach(() => {
  vi.spyOn(moment, 'now').mockReturnValue(Date.parse('2026-09-24T20:00:00Z'));
  moment.tz.setDefault('UTC');
  useAppStore.setState({ side: 'left' });
  requested = [];
  const services = structuredClone(getServices());
  services.biometrics.jobs.analyzeSleepLeft.timestamp = '2026-09-24T19:00:00Z';
  server.use(
    http.get('*/services', () => HttpResponse.json(services)),
    http.get('*/settings', () => HttpResponse.json({ ...getSettings(), timeZone: 'America/Los_Angeles' })),
    http.get('*/metrics/sleep', ({ request }) => HttpResponse.json(
      new URL(request.url).searchParams.get('side') === 'right' ? [] : records)),
    http.get('*/metrics/sleep-stages', () => { requested.push('sleep-stages'); return HttpResponse.json({}); }),
    http.get('*/metrics/sleep-score', () => { requested.push('sleep-score'); return HttpResponse.json({}); }),
  );
});
afterEach(() => { vi.restoreAllMocks(); moment.tz.setDefault(); });

it('shows trips out of bed and no score, stages request or range verdict for a short night', async () => {
  records = [record(5, 2)];
  renderWithProviders(<SleepPage />);
  expect(await screen.findByText('5h')).toBeInTheDocument();
  expect(screen.getByText('Trips out of bed')).toBeInTheDocument();
  expect(screen.getByText('2')).toBeInTheDocument();
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(requested).toEqual([]);
  expect(screen.queryByText(/Sleep score|Score /)).not.toBeInTheDocument();
  expect(screen.queryByText(/7h to 9h|range/)).not.toBeInTheDocument();
});

it('shows a zero trip count and no range verdict for a long night', async () => {
  records = [record(10, 0)];
  renderWithProviders(<SleepPage />);
  expect(await screen.findByText('10h')).toBeInTheDocument();
  expect(screen.getByText('Trips out of bed')).toBeInTheDocument();
  expect(screen.getByText('0')).toBeInTheDocument();
  expect(screen.queryByText(/7h to 9h|range/)).not.toBeInTheDocument();
});

it('shows no range verdict or score request in the week view', async () => {
  records = [record(5, 0)];
  const { user } = renderWithProviders(<SleepPage />);
  await screen.findByText('5h');
  await user.click(screen.getByRole('tab', { name: 'Week' }));
  expect(await screen.findByText('Weekly time in bed')).toBeInTheDocument();
  expect(await screen.findByText(/5h average on recorded nights/)).toBeInTheDocument();
  expect(screen.queryByText(/7h to 9h|range/)).not.toBeInTheDocument();
  await waitFor(() => expect(requested).toEqual([]));
});
