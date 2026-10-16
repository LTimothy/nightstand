import { expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { renderWithProviders } from '@test/renderWithProviders';
import { server } from '@test/setup';
import { getServerStatus, getServices, getSettings } from '../../mocks/mockData';
import SettingsPage from './SettingsPage';

it('exposes four named categories without loading every control into the index', async () => {
  renderWithProviders(<SettingsPage/>, { initialRoute: '/settings' });
  for (const name of ['Bed and sides', 'Features', 'Software', 'Pod and diagnostics', 'About and license']) {
    expect(await screen.findByRole('link', { name: new RegExp(name) })).toBeInTheDocument();
  }
  expect(screen.queryByRole('switch')).not.toBeInTheDocument();
});

it('reports a rejected settings save and lets the user try again', async () => {
  server.use(http.post('*/api/settings', () => new HttpResponse(null, { status: 500 })));
  const { user } = renderWithProviders(<SettingsPage/>, { initialRoute: '/settings/bed' });
  const toggle = await screen.findByRole('switch', { name: 'Left away mode' });
  await waitFor(() => expect(toggle).toBeEnabled());
  await user.click(toggle);
  expect(await screen.findByText(/Could not save settings/)).toBeVisible();
  expect(toggle).not.toBeChecked();
  expect(toggle).toBeEnabled();
});

it('keeps software actions on Software without repeating its link on Device', async () => {
  renderWithProviders(<SettingsPage/>, { initialRoute: '/settings/device' });
  expect(await screen.findByRole('link', { name: /System status/ })).toHaveAttribute('href', '/settings/system');
  expect(screen.queryByRole('link', { name: 'Software and updates' })).not.toBeInTheDocument();
  expect(screen.queryByRole('switch', { name: 'Reboot once a day' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /^Update(?: to.*)?$/ })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Go back|Switch to upstream/ })).not.toBeInTheDocument();
});

it('keeps optional toggles together and bed maintenance with the sides', async () => {
  const { unmount } = renderWithProviders(<SettingsPage/>, { initialRoute: '/settings/features' });
  for (const label of ['Biometrics', 'Presence auto-off', 'New sleep tracking (beta)',
    'Low-disk protection', 'Prune detail after 30 days', 'Level temperature display', 'One-time alarm', 'Cover buttons', 'Rhythms',
    'Firmware target', 'Firmware health', 'Tap diagnostics', 'Cooling warning']) {
    expect(await screen.findByRole('switch', { name: label })).toBeInTheDocument();
  }
  expect(screen.queryByRole('switch', { name: 'Sleep score' })).not.toBeInTheDocument();
  expect(screen.queryByText('Priming')).not.toBeInTheDocument();
  unmount();
  renderWithProviders(<SettingsPage/>, { initialRoute: '/settings/bed' });
  expect(await screen.findByRole('switch', { name: 'Left away mode' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Priming' })).toBeInTheDocument();
  expect(screen.queryByRole('switch', { name: 'Biometrics' })).not.toBeInTheDocument();
});

it('counts every visible feature switch', async () => {
  const features = renderWithProviders(<SettingsPage/>, { initialRoute: '/settings/features' });
  await screen.findByRole('switch', { name: 'Biometrics' });
  const total = screen.getAllByRole('switch').length;
  features.unmount();
  renderWithProviders(<SettingsPage/>, { initialRoute: '/settings' });
  expect(await screen.findByText(`5 of ${total} on`)).toBeVisible();
  expect(screen.queryByText(`${total} of ${total} on`)).not.toBeInTheDocument();
});

it('counts new sleep tracking once it is on', async () => {
  const settings = getSettings();
  server.use(http.get('*/settings', () => HttpResponse.json({ ...settings, features: { ...settings.features, biometricsV2: true } })));
  renderWithProviders(<SettingsPage/>, { initialRoute: '/settings' });
  expect(await screen.findByText('6 of 13 on')).toBeVisible();
});

it('counts cover buttons when Biometrics is off', async () => {
  const settings = getSettings();
  const services = getServices();
  server.use(
    http.get('*/settings', () => HttpResponse.json({ ...settings, features: { ...settings.features, coverButtons: true } })),
    http.get('*/services', () => HttpResponse.json({ ...services, biometrics: { ...services.biometrics, enabled: false } })),
  );
  renderWithProviders(<SettingsPage/>, { initialRoute: '/settings' });
  expect(await screen.findByText('4 of 13 on')).toBeVisible();
});

it('does not claim the Pod is running before all core services are ready', async () => {
  const data = getServerStatus();
  server.use(http.get('*/serverStatus', () => HttpResponse.json({
    ...data, frankenMonitor: { ...data.frankenMonitor, status: 'not_started' },
  })));
  renderWithProviders(<SettingsPage/>, { initialRoute: '/settings' });
  expect(await screen.findByText('Waiting for core services')).toBeVisible();
  expect(screen.queryByText('Everything running')).not.toBeInTheDocument();
});

it('does not count dependent feature switches while biometrics is off', async () => {
  const services = getServices();
  server.use(http.get('*/services', () => HttpResponse.json({ ...services, biometrics: { ...services.biometrics, enabled: false } })));
  renderWithProviders(<SettingsPage/>, { initialRoute: '/settings' });
  expect(await screen.findByText('3 of 13 on')).toBeVisible();
});

it.each(['firmwareTargetReadout', 'firmwareHealth', 'tapDiagnostics', 'coolingWarning'] as const)(
  'counts %s when monitoring is available', async flag => {
    const settings = getSettings();
    server.use(http.get('*/settings', () => HttpResponse.json({ ...settings, features: { ...settings.features, [flag]: true } })));
    renderWithProviders(<SettingsPage/>, { initialRoute: '/settings' });
    expect(await screen.findByText('6 of 13 on')).toBeVisible();
  },
);

it('excludes firmware monitoring switches from the enabled count when Biometrics is off', async () => {
  const settings = getSettings();
  const services = getServices();
  server.use(
    http.get('*/settings', () => HttpResponse.json({ ...settings, features: { ...settings.features,
      firmwareTargetReadout: true, firmwareHealth: true, tapDiagnostics: true, coolingWarning: true,
    } })),
    http.get('*/services', () => HttpResponse.json({ ...services, biometrics: { ...services.biometrics, enabled: false } })),
  );
  renderWithProviders(<SettingsPage/>, { initialRoute: '/settings' });
  expect(await screen.findByText('3 of 13 on')).toBeVisible();
});

it('counts retention as off when future deletions are disabled', async () => {
  const settings = getSettings();
  server.use(http.get('*/settings', () => HttpResponse.json({
    ...settings, features: { ...settings.features, metricsLowDiskProtection: false },
  })));
  renderWithProviders(<SettingsPage/>, { initialRoute: '/settings' });
  expect(await screen.findByText('4 of 13 on')).toBeVisible();
});


it('links the original free-sleep project in About', async () => {
  renderWithProviders(<SettingsPage/>, { initialRoute: '/settings/about' });
  expect(await screen.findByText(/community project/)).toBeVisible();
  expect(screen.getByRole('link', { name: 'free-sleep' })).toHaveAttribute('href', 'https://github.com/throwaway31265/free-sleep');
  expect(screen.queryByText(/Built on/)).not.toBeInTheDocument();
  expect(screen.queryByText(/Jailbreak/)).not.toBeInTheDocument();
});

it('isolates names from the surrounding settings summary', async () => {
  const settings = getSettings();
  server.use(http.get('*/settings', () => HttpResponse.json({ ...settings,
    left: { ...settings.left, name: '\u202eAlex' },
  })));
  renderWithProviders(<SettingsPage/>, { initialRoute: '/settings' });
  expect((await screen.findByText('\u202eAlex')).tagName).toBe('BDI');
});
