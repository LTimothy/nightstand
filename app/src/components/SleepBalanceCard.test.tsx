import { afterEach, describe, it, expect, vi } from 'vitest';
import moment from 'moment-timezone';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@test/renderWithProviders';
import type { SleepRecord } from '@api/sleepSchema';
import SleepBalanceCard from './SleepBalanceCard';
const timeZone = 'America/Los_Angeles';
const weekStart = moment.tz('2026-09-21', timeZone);
const base: SleepRecord = {
  id: 1, side: 'left', entered_bed_at: '2026-09-22T06:00:00Z', left_bed_at: '2026-09-22T14:00:00Z',
  sleep_period_seconds: 28800, times_exited_bed: 0, present_intervals: [], not_present_intervals: [],
};
describe('Sleep balance coverage', () => {
  it('compares one recorded night only and excludes fetched adjacent-week records', async () => {
    renderWithProviders(<SleepBalanceCard
      records={ [base, { ...base, id: 2, left_bed_at: '2026-09-20T14:00:00Z' }] }
      weekStart={ weekStart }
      timeZone={ timeZone }/>);
    expect(screen.getByText('1 of 7 nights recorded')).toBeInTheDocument();
    expect(await screen.findByText('8h average on recorded nights')).toBeInTheDocument();
  });
  it('keeps an observed zero duration distinct from no recording', async () => {
    renderWithProviders(<SleepBalanceCard records={ [{ ...base, sleep_period_seconds: 0 }] } weekStart={ weekStart } timeZone={ timeZone }/>);
    expect(screen.getByText('1 of 7 nights recorded')).toBeInTheDocument();
    expect(await screen.findByText('0h average on recorded nights')).toBeInTheDocument();
    expect(screen.queryByText(/7h to 9h range/)).not.toBeInTheDocument();
  });
  it('uses the same longest session as Night when a day has multiple sessions', async () => {
    renderWithProviders(<SleepBalanceCard
      records={ [base, {
        ...base, id: 2, entered_bed_at: '2026-09-22T21:00:00Z', left_bed_at: '2026-09-22T22:00:00Z', sleep_period_seconds: 3600,
      }] }
      weekStart={ weekStart }
      timeZone={ timeZone }/>);
    expect(screen.getByText('1 of 7 nights recorded')).toBeInTheDocument();
    expect(await screen.findByText('8h average on recorded nights')).toBeInTheDocument();
  });
});


afterEach(() => vi.restoreAllMocks());
it('shows no coverage note for upcoming nights', async () => {
  vi.spyOn(moment, 'now').mockReturnValue(Date.parse('2026-09-21T20:00:00Z'));
  renderWithProviders(<SleepBalanceCard
    records={ [{ ...base, left_bed_at: '2026-09-21T14:00:00Z' }] }
    weekStart={ weekStart }
    timeZone={ timeZone }/>);
  expect(await screen.findByText('8h average on recorded nights')).toBeInTheDocument();
  expect(screen.queryByText(/coverage|Upcoming nights/)).not.toBeInTheDocument();
});
