import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { renderWithProviders } from '@test/renderWithProviders';
import { server } from '@test/setup';
import { getServices, getSettings } from '../../mocks/mockData';
import SettingsPage from './SettingsPage';

const SWITCHES = [
  ['Firmware health', 'firmwareHealth'], ['Firmware target', 'firmwareTargetReadout'], ['Tap diagnostics', 'tapDiagnostics'],
] as const;
const biometricsOff = () => {
  const services = getServices();
  server.use(http.get('*/services', () => HttpResponse.json({ ...services, biometrics: { ...services.biometrics, enabled: false } })));
};
const card = () => screen.findByRole('region', { name: 'Diagnostics' });

describe('Diagnostics card', () => {
  it('sits under Pod and diagnostics, after the System status link, with its three switches', async () => {
    renderWithProviders(<SettingsPage/>, { initialRoute: '/settings/device' });
    const diagnostics = await card();
    expect(within(diagnostics).getByRole('heading', { level: 2, name: 'Diagnostics' })).toBeInTheDocument();
    expect(within(diagnostics).getByText('Shown on System status.')).toBeVisible();
    expect(within(diagnostics).getAllByRole('switch').map(control => control.getAttribute('aria-label')))
      .toEqual(SWITCHES.map(([label]) => label));
    const status = screen.getByRole('link', { name: /System status/ });
    expect(status.compareDocumentPosition(diagnostics) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it.each(SWITCHES)('starts %s at its default and posts only its flag', async (label, flag) => {
    const posted: unknown[] = [];
    server.use(http.post('*/api/settings', async ({ request }) => { posted.push(await request.json()); return HttpResponse.json({}); }));
    const on = getSettings().features[flag];
    const { user } = renderWithProviders(<SettingsPage/>, { initialRoute: '/settings/device' });
    const toggle = within(await card()).getByRole('switch', { name: label });
    await waitFor(() => expect(toggle).toBeEnabled());
    expect((toggle as HTMLInputElement).checked).toBe(on);
    await user.click(toggle);
    await waitFor(() => expect(posted).toEqual([{ features: { [flag]: !on } }]));
  });

  it('disables each switch while Biometrics is off and says why with a link to it', async () => {
    biometricsOff();
    renderWithProviders(<SettingsPage/>, { initialRoute: '/settings/device' });
    const diagnostics = await card();
    await waitFor(() => expect(within(diagnostics).getAllByRole('link', { name: 'Turn on Biometrics first' })).toHaveLength(3));
    for (const [label] of SWITCHES) expect(within(diagnostics).getByRole('switch', { name: label })).toBeDisabled();
    for (const link of within(diagnostics).getAllByRole('link', { name: 'Turn on Biometrics first' })) {
      expect(link).toHaveAttribute('href', '/settings/features#biometrics');
    }
  });

  it('keeps the switches disabled without the link while Biometrics is unknown', async () => {
    server.use(http.get('*/services', () => new HttpResponse(null, { status: 500 })));
    const { queryClient } = renderWithProviders(<SettingsPage/>, { initialRoute: '/settings/device' });
    const diagnostics = await card();
    await waitFor(() => expect(queryClient.getQueryState(['useServices'])?.status).toBe('error'));
    for (const [label] of SWITCHES) expect(within(diagnostics).getByRole('switch', { name: label })).toBeDisabled();
    expect(within(diagnostics).queryByRole('link', { name: 'Turn on Biometrics first' })).not.toBeInTheDocument();
  });

  it('takes the link to Biometrics on Features', async () => {
    biometricsOff();
    const scrolled: Element[] = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element) { scrolled.push(this); };
    try {
      const { user } = renderWithProviders(<SettingsPage/>, { initialRoute: '/settings/device' });
      const diagnostics = await card();
      await waitFor(() => expect(within(diagnostics).getAllByRole('link', { name: 'Turn on Biometrics first' })).toHaveLength(3));
      await user.click(within(diagnostics).getAllByRole('link', { name: 'Turn on Biometrics first' })[0]);
      await screen.findByRole('switch', { name: 'Biometrics' });
      await waitFor(() => expect(scrolled.map(element => element.id)).toContain('biometrics'));
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });
});
