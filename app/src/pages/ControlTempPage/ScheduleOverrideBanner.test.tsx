import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import moment from 'moment-timezone';
import ScheduleOverrideBanner from './ScheduleOverrideBanner';

const fixture = vi.hoisted(() => ({ pause: { active: false, expiresAt: '' }, tz: 'UTC', expiresAt: '2026-09-28T23:00:00Z' }));
vi.mock('@state/appStore.tsx', () => ({ useAppStore: () => ({ side: 'left' }) }));
vi.mock('@api/settings.ts', () => ({
  useSettings: () => ({ data: { timeZone: fixture.tz, left: { scheduleOverrides: {
    temperatureSchedules: { disabled: true, expiresAt: fixture.expiresAt },
    pause: fixture.pause,
  } } } }),
  postSettings: vi.fn(),
}));

const renderBanner = () => render(
  <QueryClientProvider client={ new QueryClient() }><ScheduleOverrideBanner/></QueryClientProvider>,
);

beforeEach(() => {
  vi.spyOn(moment, 'now').mockReturnValue(Date.parse('2026-09-28T20:00:00Z'));
  fixture.pause = { active: false, expiresAt: '' };
  fixture.tz = 'UTC';
  fixture.expiresAt = '2026-09-28T23:00:00Z';
});
afterEach(() => vi.restoreAllMocks());

it('names the manual temperature hold and when the schedule resumes', () => {
  renderBanner();
  expect(screen.getByText('Holding your temperature')).toBeInTheDocument();
  expect(screen.getByText('Scheduled temperature changes resume at 11:00 PM today')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Resume now' })).toBeInTheDocument();
  expect(screen.queryByText(/paused/i)).not.toBeInTheDocument();
});

it('reads the resume time in the Pod time zone and says tomorrow after midnight', () => {
  fixture.tz = 'America/Los_Angeles';
  fixture.expiresAt = '2026-09-29T07:00:00Z';
  renderBanner();
  expect(screen.getByText('Scheduled temperature changes resume at 12:00 AM tomorrow')).toBeInTheDocument();
});

it('steps aside while the whole schedule is paused', () => {
  fixture.pause = { active: true, expiresAt: '' };
  renderBanner();
  expect(screen.queryByText('Holding your temperature')).not.toBeInTheDocument();
});
