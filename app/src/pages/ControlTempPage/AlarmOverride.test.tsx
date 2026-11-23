import { afterEach, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import moment from 'moment-timezone';
import { renderWithProviders } from '@test/renderWithProviders';
import { server } from '@test/setup';
import { getSettings } from '../../mocks/mockData';
import AlarmOverride from './AlarmOverride';

afterEach(() => vi.restoreAllMocks());

const props = {
  open: true,
  alarmTimeLocalOverride: '',
  scheduledAlarmTimeHhMm: '06:30',
  nightStart: '2026-09-28T22:00:00Z',
  nightEnd: '2026-09-29T06:30:00Z',
  scope: 'Tonight',
  setAlarmTimeLocalOverride: vi.fn(),
  setOverrideOpen: vi.fn(),
};

it('opens on the scheduled alarm without an error, even when the night ends at that alarm', async () => {
  vi.spyOn(moment, 'now').mockReturnValue(Date.parse('2026-09-28T23:00:00Z'));
  server.use(http.get('*/api/settings', () => HttpResponse.json({ ...getSettings(), timeZone: 'UTC' })));
  renderWithProviders(<AlarmOverride { ...props }/>);

  await waitFor(() => expect(screen.getByLabelText('Alarm')).toHaveValue('06:30'));
  expect(screen.getByLabelText('Alarm')).toHaveAttribute('aria-invalid', 'false');
  expect(screen.queryByText(/Already past or too late/)).not.toBeInTheDocument();
});

it('still flags an edited time that falls after the night ends', async () => {
  vi.spyOn(moment, 'now').mockReturnValue(Date.parse('2026-09-28T23:00:00Z'));
  server.use(http.get('*/api/settings', () => HttpResponse.json({ ...getSettings(), timeZone: 'UTC' })));
  renderWithProviders(<AlarmOverride { ...props } alarmTimeLocalOverride="07:00"/>);

  expect(await screen.findByText(/Already past or too late/)).toBeInTheDocument();
});
