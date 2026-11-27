import { expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@test/renderWithProviders';
import SleepFitnessCard from './SleepFitnessCard';

const record = {
  id: 1, side: 'left', entered_bed_at: '2026-09-28T00:00:00Z', left_bed_at: '2026-09-28T07:30:00Z',
  sleep_period_seconds: 27000, times_exited_bed: 0, present_intervals: [], not_present_intervals: [],
};
it('shows time in bed, the in and out times, and the trip count', () => {
  renderWithProviders(<SleepFitnessCard sleepRecord={ record } timeZone="UTC"/>);
  expect(screen.getByText('7h 30m')).toBeInTheDocument();
  expect(screen.getByText('In bed')).toBeInTheDocument();
  expect(screen.getByText('Trips out of bed')).toBeInTheDocument();
  expect(screen.getByText('0')).toBeInTheDocument();
});
it('shows the record\'s trip count as a number', () => {
  renderWithProviders(<SleepFitnessCard sleepRecord={ { ...record, times_exited_bed: 3 } } timeZone="UTC"/>);
  expect(screen.getByText('3')).toBeInTheDocument();
});
it('shows no score, estimate note, info button, contributor bars or range verdict', () => {
  renderWithProviders(<SleepFitnessCard sleepRecord={ { ...record, sleep_period_seconds: 18000 } } timeZone="UTC"/>);
  expect(screen.queryByText(/Sleep score|Loading score|Score /)).not.toBeInTheDocument();
  expect(screen.queryByText('Estimate from bed sensors')).not.toBeInTheDocument();
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
  expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  expect(screen.queryByText('Duration')).not.toBeInTheDocument();
  expect(screen.queryByText(/range/)).not.toBeInTheDocument();
});
