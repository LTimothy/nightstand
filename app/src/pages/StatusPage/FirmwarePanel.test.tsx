import { screen, waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { renderWithProviders } from '@test/renderWithProviders';
import { server } from '@test/setup';
import { getSettings } from '../../mocks/mockData';
import FirmwareReadout from './FirmwareReadout';
import FirmwarePanel from './FirmwarePanel';
import type { FirmwareSnapshot } from '@api/firmware';

const cooling = { state: 'unavailable', active: false, notice: false, message: '', since: undefined };
function snapshot(availability: string, sensorFresh: boolean, targets: FirmwareSnapshot['targets']): FirmwareSnapshot {
  return { availability, sensorFresh, targets, interrupted: false, incidents: [], taps: [], cooling: { left: cooling, right: cooling } };
}

it('shows an independent firmware target to a tenth in Fahrenheit', () => {
  renderWithProviders(<FirmwareReadout
    data={ snapshot('Monitoring active', true, {
      left: { state: 'available', targetC: 25.08 }, right: { state: 'disabled', targetC: 25 },
    }) }
    format="fahrenheit"
  />);
  expect(screen.getByText('Left firmware target: 77.1°F')).toBeInTheDocument();
  expect(screen.getByText('Right firmware target: Disabled')).toBeInTheDocument();
});
it('distinguishes stale, unavailable and monitoring off', () => {
  renderWithProviders(<FirmwareReadout
    data={ snapshot('Monitoring unavailable', false, {
      left: { state: 'stale', targetC: 25 }, right: { state: 'unavailable' },
    }) }
    format="celsius"
  />);
  expect(screen.getByText('Monitoring unavailable')).toBeInTheDocument();
  expect(screen.getByText('Left firmware target: 25.0°C (stale)')).toBeInTheDocument();
  expect(screen.getByText('Right firmware target: Unavailable')).toBeInTheDocument();
});

it.each([['Monitoring active', true], ['Monitoring unavailable', false]] as const)(
  'with only Firmware health on and %s, shows its details: %s', async (availability, shown) => {
    const settings = getSettings();
    let served = 0;
    server.use(
      http.get('*/api/settings', () => HttpResponse.json({ ...settings, features: { ...settings.features,
        firmwareHealth: true, firmwareTargetReadout: false, tapDiagnostics: false, coolingWarning: false } })),
      http.get('*/api/services/firmware', () => {
        served += 1;
        return HttpResponse.json(snapshot(availability, true, { left: { state: 'unavailable' }, right: { state: 'unavailable' } }));
      }),
    );
    renderWithProviders(<FirmwarePanel/>);
    if (shown) expect(await screen.findByText('Firmware health details')).toBeInTheDocument();
    else {
      await waitFor(() => expect(served).toBeGreaterThan(0));
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(screen.queryByText('Firmware health details')).not.toBeInTheDocument();
      expect(screen.queryByText('Monitoring unavailable')).not.toBeInTheDocument();
    }
  },
);
