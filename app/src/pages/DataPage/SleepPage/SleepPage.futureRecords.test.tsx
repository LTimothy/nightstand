import { screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import moment from 'moment-timezone';
import { renderWithProviders } from '@test/renderWithProviders';
import { server } from '@test/setup';
import { getSettings, getServices } from '../../../mocks/mockData';
import { useAppStore } from '@state/appStore';
import type { SleepRecord } from '@api/sleepSchema';
import SleepPage from './SleepPage';

const record = (id: number, morning: string, hours: number): SleepRecord => ({
  id, side: 'left', entered_bed_at: moment.tz(`${morning} 07:00`, 'America/Los_Angeles').subtract(hours, 'hours').format(),
  left_bed_at: moment.tz(`${morning} 07:00`, 'America/Los_Angeles').format(),
  sleep_period_seconds: hours * 3600, times_exited_bed: 0, present_intervals: [], not_present_intervals: [],
});
let records: SleepRecord[];
beforeEach(() => {
  // Thursday, September 24, 2026, 1 PM in Los Angeles.
  vi.spyOn(moment, 'now').mockReturnValue(Date.parse('2026-09-24T20:00:00Z'));
  moment.tz.setDefault('UTC');
  useAppStore.setState({ side: 'left' });
  const services = structuredClone(getServices());
  services.biometrics.jobs.analyzeSleepLeft.timestamp = '2026-09-24T19:00:00Z';
  server.use(
    http.get('*/services', () => HttpResponse.json(services)),
    http.get('*/settings', () => HttpResponse.json({ ...getSettings(), timeZone: 'America/Los_Angeles' })),
    http.get('*/metrics/sleep', ({ request }) => HttpResponse.json(
      new URL(request.url).searchParams.get('side') === 'right' ? [] : records)),
    http.get('*/metrics/sleep-stages', () => HttpResponse.json({
      active: true, epochs: [], totalSeconds: 0, totals: { awake: 0, light: 0, rem: 0, deep: 0 },
      percentages: { awake: 0, light: 0, rem: 0, deep: 0 },
    })),
  );
});
afterEach(() => { vi.restoreAllMocks(); moment.tz.setDefault(); });

describe('Sleep records dated in the future', () => {
  it('opens on the newest night that has happened', async () => {
    records = [record(1, '2026-09-22', 6), record(2, '2026-09-23', 8), record(3, '2099-06-01', 5)];
    renderWithProviders(<SleepPage />);
    expect(await screen.findByText('8h')).toBeInTheDocument();
    expect(screen.getByText('Sep 21 - Sep 27')).toBeInTheDocument();
    expect(screen.getByText('Out of bed Wed, Sep 23')).toBeInTheDocument();
    expect(screen.queryByText(/2099|Jun 1/)).not.toBeInTheDocument();
  });

  it('does not count an upcoming night in the week', async () => {
    records = [record(1, '2026-09-22', 6), record(2, '2026-09-23', 8), record(3, '2026-09-27', 5)];
    const { user } = renderWithProviders(<SleepPage />);
    await screen.findByText('8h');
    await user.click(screen.getByRole('tab', { name: 'Week' }));
    expect(await screen.findByText('2 of 7 nights recorded')).toBeInTheDocument();
    expect(screen.getByText(/7h average on recorded nights/)).toBeInTheDocument();
  });

  it('keeps a record that ends within an hour of now, in case the phone clock runs behind the Pod', async () => {
    const soon = { ...record(3, '2026-09-24', 9), left_bed_at: '2026-09-24T20:40:00Z', entered_bed_at: '2026-09-24T11:40:00Z' };
    records = [record(1, '2026-09-22', 6), soon];
    renderWithProviders(<SleepPage />);
    expect(await screen.findByText('9h')).toBeInTheDocument();
  });

  it('ignores a record that ends more than an hour ahead', async () => {
    const later = { ...record(3, '2026-09-24', 6), left_bed_at: '2026-09-24T21:30:00Z', entered_bed_at: '2026-09-24T15:30:00Z' };
    records = [record(1, '2026-09-23', 8), later];
    renderWithProviders(<SleepPage />);
    expect(await screen.findByText('8h')).toBeInTheDocument();
    expect(screen.queryByText('6h')).not.toBeInTheDocument();
  });

  it('starts empty when every record is in the future', async () => {
    records = [record(1, '2099-06-01', 5)];
    renderWithProviders(<SleepPage />);
    expect((await screen.findAllByText(/Nothing recorded|Not ready yet/)).length).toBeGreaterThan(0);
    expect(screen.getByText('Sep 21 - Sep 27')).toBeInTheDocument();
  });
});

describe('Sleep dates outside the current year', () => {
  it('shows the year in the week and night titles', async () => {
    // Friday, January 2, 2026, so the week began in 2025.
    vi.spyOn(moment, 'now').mockReturnValue(Date.parse('2026-01-02T20:00:00Z'));
    records = [record(1, '2025-12-30', 7)];
    renderWithProviders(<SleepPage />);
    expect(await screen.findByText('Dec 29, 2025 - Jan 4, 2026')).toBeInTheDocument();
    expect(await screen.findByText('Out of bed Tue, Dec 30, 2025')).toBeInTheDocument();
  });

  it('leaves the year out for the current year', async () => {
    records = [record(1, '2026-09-23', 8)];
    renderWithProviders(<SleepPage />);
    expect(await screen.findByText('Out of bed Wed, Sep 23')).toBeInTheDocument();
    expect(screen.getByText('Sep 21 - Sep 27')).toBeInTheDocument();
  });
});
