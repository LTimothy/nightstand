import { beforeEach, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { renderWithProviders } from '@test/renderWithProviders';
import { server } from '@test/setup';
import { useAppStore } from '@state/appStore';
import { useScheduleStore } from './scheduleStore';
import { getSettings } from '../../mocks/mockData';
import SchedulePage from './SchedulePage';

beforeEach(() => {
  useAppStore.setState({ side: 'left', isUpdating: false });
  useScheduleStore.setState(useScheduleStore.getInitialState(), true);
  const settings = structuredClone(getSettings());
  settings.features.oneOffAlarms = true;
  server.use(http.get('*/settings', () => HttpResponse.json(settings)));
});

it('gives the night and timeline sections consistent level-two headings', async () => {
  renderWithProviders(<SchedulePage/>);
  await screen.findByRole('heading', { name: 'Bedtime' });
  for (const name of [/^[A-Z][a-z]+ night/, 'Bedtime', 'Through the night', 'Wake up']) {
    const heading = screen.getByRole('heading', { level: 2, name });
    expect(heading).toHaveStyle({ fontSize: '1.125rem', fontWeight: 600 });
  }
});

it('keeps schedule accordion labels out of nested headings', async () => {
  renderWithProviders(<SchedulePage/>);
  for (const name of ['Apply settings to other days', 'Add one-time alarm']) {
    const button = await screen.findByRole('button', { name });
    expect(within(button).queryByRole('heading')).not.toBeInTheDocument();
  }
});

it('names the pending one-time alarm in the accordion header and keeps it collapsed', async () => {
  const settings = structuredClone(getSettings());
  settings.features.oneOffAlarms = true;
  settings.left.oneOffAlarm.enabled = true;
  settings.left.oneOffAlarm.fireAt = '2099-01-02T07:00:00Z';
  settings.timeZone = 'UTC';
  server.use(http.get('*/settings', () => HttpResponse.json(settings)));
  renderWithProviders(<SchedulePage/>);
  const button = await screen.findByRole('button', { name: 'One-time alarm: Fri, Jan 2 at 7:00 AM' });
  expect(button).toHaveAttribute('aria-expanded', 'false');
});
