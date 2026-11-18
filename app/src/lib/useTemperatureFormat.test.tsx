import { expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@test/renderWithProviders';
import { server } from '@test/setup';
import { Version } from '@api/deviceStatusSchema.ts';
import { getDeviceStatus, getSettings } from '../mocks/mockData';
import useTemperatureFormat from './useTemperatureFormat';

function Show() {
  return <span data-testid="format">{ useTemperatureFormat() }</span>;
}
let served = { settings: false, status: false };
function serve(opts: { stored?: string; flag?: boolean; hub?: string }) {
  served = { settings: false, status: false };
  const settings = getSettings();
  server.use(
    http.get('*/api/settings', () => {
      served.settings = true;
      return HttpResponse.json({
        ...settings, temperatureFormat: opts.stored ?? 'fahrenheit', features: { ...settings.features, targetTemperatureLabels: !!opts.flag },
      });
    }),
    http.get('*/api/deviceStatus', () => {
      if (!opts.hub) return new Promise<Response>(() => {});
      served.status = true;
      return HttpResponse.json({ ...getDeviceStatus(), hubVersion: opts.hub });
    }),
  );
  renderWithProviders(<Show/>);
}
// Waits until the served responses have been requested, then for the format to settle.
const settled = async (expected: string, hub = true) => {
  await expect.poll(() => served.settings && (!hub || served.status)).toBe(true);
  const node = await screen.findByTestId('format');
  await expect.poll(() => node.textContent).toBe(expected);
};

it.each([
  ['fahrenheit', 'fahrenheitTarget'], ['celsius', 'celsiusTarget'], ['level', 'level'],
])('relabels stored %s as %s on a Pod 5 with the option on', async (stored, expected) => {
  serve({ stored, flag: true, hub: Version.Pod5 });
  await settled(expected);
});
it('keeps the stored unit on a Pod 4', async () => {
  serve({ flag: true, hub: Version.Pod4 });
  await settled('fahrenheit');
});
it('keeps the stored unit until the device status loads', async () => {
  serve({ flag: true });
  await settled('fahrenheit', false);
});
it('keeps the stored unit with the option off', async () => {
  serve({ stored: 'celsius', hub: Version.Pod5 });
  await settled('celsius');
});
