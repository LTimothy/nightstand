import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@test/renderWithProviders';
import { server } from '@test/setup';
import { getSettings, getServices } from '../../../mocks/mockData';
import FeaturesSection from './FeaturesSection';

// A degraded settings/services response (partially written lowdb during an
// update swap, a proxy error page, version skew) used to throw straight out of
// render here. The section had no local ErrorBoundary, so the throw escalated
// to the root boundary and blanked the whole app.
// Injected failures produce rejected promises inside react-query; without this
// the whole vitest run reds out on an unhandled rejection.
function swallowRejection(event: PromiseRejectionEvent) {
  event.preventDefault();
}

describe('FeaturesSection partial payload handling', () => {
  beforeEach(() => window.addEventListener('unhandledrejection', swallowRejection));
  afterEach(() => window.removeEventListener('unhandledrejection', swallowRejection));

  it('keeps older settings readable with unsupported feature controls disabled', async () => {
    const settingsWithoutFeatures: Record<string, unknown> = { ...getSettings() };
    delete settingsWithoutFeatures.features;
    server.use(
      http.get('*/api/settings', () => HttpResponse.json(settingsWithoutFeatures)),
    );

    renderWithProviders(<FeaturesSection />);

    expect(await screen.findByRole('switch', { name: 'Biometrics' })).toBeEnabled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    for (const name of ['Presence auto-off', 'New sleep tracking (beta)',
      'Level temperature display', 'One-time alarm']) {
      expect(screen.getByRole('switch', { name })).toBeDisabled();
    }
  });

  it('reports an error when the settings payload is an empty object', async () => {
    server.use(
      http.get('*/api/settings', () => HttpResponse.json({})),
    );

    renderWithProviders(<FeaturesSection />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load features.');
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('reports an error when the services payload is missing biometrics', async () => {
    const servicesWithoutBiometrics: Record<string, unknown> = { ...getServices() };
    delete servicesWithoutBiometrics.biometrics;
    server.use(
      http.get('*/api/services', () => HttpResponse.json(servicesWithoutBiometrics)),
    );

    renderWithProviders(<FeaturesSection />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load features.');
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();

    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
  });
});

it.each([
  ['presenceAutoOff', 'Presence auto-off'],
  ['biometricsV2', 'New sleep tracking (beta)'],
  ['levelTemps', 'Level temperature display'], ['oneOffAlarms', 'One-time alarm'],
  ['targetTemperatureLabels', 'Show the Pod\'s target temperatures'],
])('disables only the missing feature %s', async (key, name) => {
  const settings = getSettings();
  const features: Record<string, unknown> = { ...settings.features };
  delete features[key];
  server.use(http.get('*/api/settings', () => HttpResponse.json({ ...settings, features })));
  renderWithProviders(<FeaturesSection />);
  expect(await screen.findByRole('switch', { name })).toBeDisabled();
  expect(screen.getByRole('switch', { name: 'Biometrics' })).toBeEnabled();
  if (key !== 'oneOffAlarms') expect(screen.getByRole('switch', { name: 'One-time alarm' })).toBeEnabled();
});
