import { afterEach, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import moment from 'moment-timezone';
import { ThemeProvider } from '@mui/material/styles';
import { theme } from '../../theme';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import UpcomingNight from './UpcomingNight';
import ScheduleOverrideBanner from './ScheduleOverrideBanner';

const fixture = vi.hoisted(() => ({ expiresAt: '2026-09-28T20:00:00Z', on: '19:00' }));
vi.mock('@state/appStore.tsx', () => ({ useAppStore: () => ({ side: 'left' }) }));
vi.mock('@api/settings.ts', () => ({ useSettings: () => ({ data: {
  timeZone: 'UTC', temperatureFormat: 'fahrenheit', left: { awayMode: false,
    scheduleOverrides: { temperatureSchedules: { disabled: true, expiresAt: fixture.expiresAt },
      pause: { active: false, expiresAt: '' } },
  },
} }) }));
vi.mock('@api/schedules.ts', () => ({ useSchedules: () => ({ data: { left: { monday: {
  power: { enabled: true, on: fixture.on, off: '09:00', onTemperature: 82 }, temperatures: { '22:00': 70 },
} } } }) }));
vi.mock('./AlarmNotification', () => ({ default: () => null }));
vi.mock('./useBedSleeps', () => ({ useBedSleeps: () => ({ state: 'legacy' }) }));
afterEach(() => vi.restoreAllMocks());

it('does not label future events as paused after an override expires', () => {
  vi.spyOn(moment, 'now').mockReturnValue(Date.parse('2026-09-28T21:00:00Z'));
  fixture.on = '19:00';
  fixture.expiresAt = '2026-09-28T20:00:00Z';
  render(<MemoryRouter><UpcomingNight/></MemoryRouter>);
  expect(screen.getByText(/Changes to/)).not.toHaveTextContent('paused');
});

it('marks a change the hand hold covers as on hold, not paused', () => {
  vi.spyOn(moment, 'now').mockReturnValue(Date.parse('2026-09-28T20:00:00Z'));
  fixture.on = '19:00';
  fixture.expiresAt = '2026-09-29T08:00:00Z';
  render(<MemoryRouter><UpcomingNight/></MemoryRouter>);
  const line = screen.getByText(/Changes to/);
  expect(line.textContent).toMatch(/\(on hold\)$/);
  expect(line).not.toHaveTextContent('paused');
});

it('shows the hold banner next to the Pause schedule button', () => {
  vi.spyOn(moment, 'now').mockReturnValue(Date.parse('2026-09-28T20:00:00Z'));
  fixture.on = '19:00';
  fixture.expiresAt = '2026-09-29T08:00:00Z';
  render(
    <QueryClientProvider client={ new QueryClient() }>
      <MemoryRouter><ScheduleOverrideBanner/><UpcomingNight/></MemoryRouter>
    </QueryClientProvider>,
  );
  expect(screen.getByText('Holding your temperature')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Pause schedule' })).toBeInTheDocument();
});

it('explains that an active manual override keeps the manual target at power-on', () => {
  vi.spyOn(moment, 'now').mockReturnValue(Date.parse('2026-09-28T20:00:00Z'));
  fixture.on = '21:00';
  fixture.expiresAt = '2026-09-29T08:00:00Z';
  render(<MemoryRouter><UpcomingNight/></MemoryRouter>);
  expect(screen.getByText('Turns on tonight at 9:00 PM and keeps your manual temperature')).toBeInTheDocument();
});

it('leads with the next start while the side is off', () => {
  vi.spyOn(moment, 'now').mockReturnValue(Date.parse('2026-09-28T20:00:00Z'));
  fixture.on = '21:00';
  fixture.expiresAt = '2026-09-28T19:00:00Z';
  render(<MemoryRouter><UpcomingNight/></MemoryRouter>);
  expect(screen.getByText('Turns on tonight at 9:00 PM, set to 82°F')).toBeInTheDocument();
  expect(screen.queryByText(/Changes to/)).not.toBeInTheDocument();
});

it('uses the shared section hierarchy for upcoming events', () => {
  vi.spyOn(moment, 'now').mockReturnValue(Date.parse('2026-09-28T12:00:00Z'));
  fixture.on = '21:00';
  render(<ThemeProvider theme={ theme }><MemoryRouter><UpcomingNight/></MemoryRouter></ThemeProvider>);
  expect(screen.getByRole('heading', { level: 2, name: 'Upcoming' }))
    .toHaveStyle({ fontSize: '1.125rem', fontWeight: 600 });
});

it('draws the card at the shared 12 px radius with its actions as 44 px lamp links', () => {
  vi.spyOn(moment, 'now').mockReturnValue(Date.parse('2026-09-28T20:00:00Z'));
  fixture.on = '21:00';
  fixture.expiresAt = '2026-09-28T19:00:00Z';
  const { container } = render(<ThemeProvider theme={ theme }><MemoryRouter><UpcomingNight/></MemoryRouter></ThemeProvider>);
  expect(container.querySelector('[data-tonight]')).toHaveStyle({ borderRadius: '12px' });
  expect(screen.getByRole('link', { name: 'Edit schedule' })).toHaveStyle({ minHeight: '44px', fontSize: '15px' });
  expect(screen.getByText('Turns on tonight at 9:00 PM, set to 82°F')).toHaveStyle({ fontSize: '15px' });
});
