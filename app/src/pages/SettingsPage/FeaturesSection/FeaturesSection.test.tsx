import { describe, it, expect } from 'vitest';
import { delay, http, HttpResponse } from 'msw';
import { QueryClient } from '@tanstack/react-query';
import { screen, waitFor, within } from '@testing-library/react';
import { renderWithProviders } from '@test/renderWithProviders';
import { server } from '@test/setup';
import { getDeviceStatus, getServices, getSettings, mockCalibration } from '../../../mocks/mockData';
import { EXPERIMENTAL_ON_THIS_POD } from '@api/sleepTrackingValidation.ts';
import FeaturesSection from './FeaturesSection';

const BIOMETRICS_ESTIMATES = 'Time in bed and heart rate estimated from the bed\'s sensors. Estimates, not medical measurements.';
const BIOMETRICS_UNCHECKED_MODEL = 'Not checked on this Pod model.';
const NEW_SLEEP_TRACKING_CHECKED = 'Tells the two sides apart with the capacitance sensors. Checked on one Pod 5.';
const biometricsOff = () => {
  const services = getServices();
  server.use(http.get('*/api/services', () => HttpResponse.json({ ...services, biometrics: { ...services.biometrics, enabled: false } })));
};
const switchNames = (region: HTMLElement) => within(region).getAllByRole('switch').map(control => control.getAttribute('aria-label'));

describe('FeaturesSection', () => {
  it('groups the switches into Everyday, Sleep tracking and Storage cards', async () => {
    renderWithProviders(<FeaturesSection />);
    const everyday = await screen.findByRole('region', { name: 'Everyday' });
    const tracking = screen.getByRole('region', { name: 'Sleep tracking' });
    const storage = screen.getByRole('region', { name: 'Storage' });
    expect(screen.getAllByRole('heading', { level: 2 }).map(heading => heading.textContent))
      .toEqual(['Everyday', 'Sleep tracking', 'Storage']);
    expect(switchNames(everyday)).toEqual(['Rhythms', 'Suggestions from your changes', 'One-time alarm', 'Level temperature display']);
    expect(within(everyday).getByRole('button', { name: 'Delete notes' })).toBeVisible();
    expect(switchNames(tracking)).toEqual(['Biometrics', 'Presence auto-off', 'New sleep tracking (beta)', 'Cooling warning']);
    expect(within(tracking).getByRole('combobox', { name: 'Keep raw sensor recordings' })).toBeVisible();
    expect(within(tracking).getByText('Sleep analysis reads these. About 0.4 GB a day. '
      + 'Oldest removed first if storage runs low.')).toBeVisible();
    expect(switchNames(storage)).toEqual(['Low-disk protection', 'Prune detail after 30 days']);
  });

  it.each([['Presence auto-off'], ['New sleep tracking (beta)'], ['Cooling warning']])(
    'disables %s while Biometrics is off and links to it', async label => {
      biometricsOff();
      renderWithProviders(<FeaturesSection />);
      const tracking = await screen.findByRole('region', { name: 'Sleep tracking' });
      await waitFor(() => expect(within(tracking).getAllByRole('link', { name: 'Turn on Biometrics first' })).toHaveLength(3));
      const toggle = within(tracking).getByRole('switch', { name: label });
      expect(toggle).toBeDisabled();
      const row = toggle.closest('.MuiBox-root')!.parentElement!;
      expect(within(row).getByRole('link', { name: 'Turn on Biometrics first' })).toHaveAttribute('href', '#biometrics');
      expect(document.getElementById('biometrics')).not.toBeNull();
    },
  );

  it.each([['Presence auto-off'], ['New sleep tracking (beta)'], ['Cooling warning']])(
    'enables %s once Biometrics is on', async label => {
      renderWithProviders(<FeaturesSection />);
      const toggle = await screen.findByRole('switch', { name: label });
      await waitFor(() => expect(toggle).toBeEnabled());
      expect(screen.queryByRole('link', { name: 'Turn on Biometrics first' })).not.toBeInTheDocument();
    },
  );

  it('defaults to low-disk protection, keeps age pruning opt-in and saves each separately', async () => {
    const posted: unknown[] = [];
    server.use(http.post('*/api/settings', async ({ request }) => {
      posted.push(await request.json());
      return HttpResponse.json({});
    }));
    const { user } = renderWithProviders(<FeaturesSection />);
    const lowDisk = await screen.findByRole('switch', { name: 'Low-disk protection' });
    const age = screen.getByRole('switch', { name: 'Prune detail after 30 days' });
    expect(lowDisk).toBeChecked();
    expect(age).not.toBeChecked();
    expect(screen.getByText('Below 150 MiB free, deletes the oldest detailed vitals. '
      + 'Keeps 2 nights of detail and every nightly summary.')).toBeVisible();
    expect(screen.getByText('Deletes detailed vitals older than 30 days. Summaries, scores and movement stay. '
      + 'Cannot be undone.')).toBeVisible();
    await user.click(age);
    await waitFor(() => expect(age).toBeEnabled());
    await user.click(lowDisk);
    expect(posted).toEqual([
      { features: { metricsRetention: true } }, { features: { metricsLowDiskProtection: false } },
    ]);
  });

  it('posts the flag change when a feature toggle is switched', async () => {
    let posted: unknown;
    server.use(
      http.post('*/api/settings', async ({ request }) => {
        posted = await request.json();
        return HttpResponse.json({});
      }),
    );

    const { user } = renderWithProviders(<FeaturesSection />);

    const toggle = await screen.findByRole('switch', { name: 'One-time alarm' });
    await user.click(toggle);

    // Default mock oneOffAlarms is true, so the first click posts false.
    expect(posted).toEqual({ features: { oneOffAlarms: false } });
  });

  it('does not offer a sleep score switch', async () => {
    renderWithProviders(<FeaturesSection />);
    await screen.findByRole('switch', { name: 'One-time alarm' });
    expect(screen.queryByRole('switch', { name: 'Sleep score' })).not.toBeInTheDocument();
  });

  it('posts presenceAutoOff when the presence auto-off toggle is switched', async () => {
    let posted: unknown;
    server.use(
      http.post('*/api/settings', async ({ request }) => {
        posted = await request.json();
        return HttpResponse.json({});
      }),
    );

    const { user } = renderWithProviders(<FeaturesSection />);

    const toggle = await screen.findByRole('switch', { name: 'Presence auto-off' });
    expect(toggle).toBeChecked();
    await user.click(toggle);

    expect(posted).toEqual({ features: { presenceAutoOff: false } });
  });

  it('posts biometricsV2 when new sleep tracking is switched on', async () => {
    let posted: unknown;
    server.use(
      http.post('*/api/settings', async ({ request }) => {
        posted = await request.json();
        return HttpResponse.json({});
      }),
    );

    const { user } = renderWithProviders(<FeaturesSection />);

    const toggle = await screen.findByRole('switch', { name: 'New sleep tracking (beta)' });
    expect(toggle).not.toBeChecked();
    expect(await screen.findByText(NEW_SLEEP_TRACKING_CHECKED)).toBeVisible();
    await user.click(toggle);

    expect(posted).toEqual({ features: { biometricsV2: true } });
  });

  it('shows and copies the root-owned installer path when biometrics is not installed', async () => {
    const services = structuredClone(getServices());
    services.biometrics.jobs.installation.status = 'not_started';
    server.use(http.get('*/api/services', () => HttpResponse.json(services)));
    const { user } = renderWithProviders(<FeaturesSection />);
    const command = 'sh /usr/local/lib/nightstand/live/scripts/enable_biometrics.sh';
    await user.click(await screen.findByText('How to install'));
    expect(screen.getByText(command)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Copy command' }));
    expect(await navigator.clipboard.readText()).toBe(command);
  });
});

describe('FeaturesSection experimental label', () => {
  const switchedOn = () => {
    const settings = getSettings();
    return { ...settings, features: { ...settings.features, biometricsV2: true } };
  };
  const formats = (left: string | null, right: string | null) => http.get('*/calibration', () => HttpResponse.json({
    left: { ...mockCalibration.left, capFormat: left },
    right: { ...mockCalibration.right, capFormat: right },
  }));
  const pod = (model: string) => http.get('*/deviceStatus', () => HttpResponse.json({
    ...getDeviceStatus(), coverVersion: model, hubVersion: model,
  }));

  const settled = (queryClient: QueryClient, status: 'success' | 'error' = 'success') => waitFor(() => {
    expect(queryClient.getQueryState(['useDeviceStatus'])?.status).toBe(status);
    expect(queryClient.getQueryState(['useCalibration'])?.status).toBe('success');
  });

  it('says nothing on a Pod 5 writing capSense2', async () => {
    server.use(http.get('*/api/settings', () => HttpResponse.json(switchedOn())), formats('capSense2', 'capSense2'));
    const { queryClient } = renderWithProviders(<FeaturesSection />);
    expect(await screen.findByRole('switch', { name: 'New sleep tracking (beta)' })).toBeChecked();
    await settled(queryClient);
    expect(screen.queryByText(EXPERIMENTAL_ON_THIS_POD)).not.toBeInTheDocument();
  });

  it('labels a Pod 4 as experimental', async () => {
    server.use(http.get('*/api/settings', () => HttpResponse.json(switchedOn())), pod('Pod 4'));
    renderWithProviders(<FeaturesSection />);
    expect(await screen.findByText(EXPERIMENTAL_ON_THIS_POD)).toBeVisible();
  });

  it('labels a Pod 4 writing capSense2 as experimental', async () => {
    server.use(
      http.get('*/api/settings', () => HttpResponse.json(switchedOn())), pod('Pod 4'), formats('capSense2', 'capSense2'),
    );
    renderWithProviders(<FeaturesSection />);
    expect(await screen.findByText(EXPERIMENTAL_ON_THIS_POD)).toBeVisible();
  });

  it('labels a Pod 5 writing the older format as experimental', async () => {
    server.use(http.get('*/api/settings', () => HttpResponse.json(switchedOn())), formats('capSense', null));
    renderWithProviders(<FeaturesSection />);
    expect(await screen.findByText(EXPERIMENTAL_ON_THIS_POD)).toBeVisible();
  });

  it('labels an unchecked format while the switch is off', async () => {
    server.use(pod('Pod 3'));
    renderWithProviders(<FeaturesSection />);
    expect(await screen.findByRole('switch', { name: 'New sleep tracking (beta)' })).not.toBeChecked();
    expect(await screen.findByText(EXPERIMENTAL_ON_THIS_POD)).toBeVisible();
  });

  it('says nothing on a Pod 5 while the switch is off', async () => {
    const { queryClient } = renderWithProviders(<FeaturesSection />);
    expect(await screen.findByRole('switch', { name: 'New sleep tracking (beta)' })).not.toBeChecked();
    await settled(queryClient);
    expect(screen.queryByText(EXPERIMENTAL_ON_THIS_POD)).not.toBeInTheDocument();
  });

  it('shows the not-checked lines while device status is loading', async () => {
    server.use(
      http.get('*/deviceStatus', async () => { await delay('infinite'); return HttpResponse.json(getDeviceStatus()); }),
      formats('capSense2', 'capSense2'),
    );
    const { queryClient } = renderWithProviders(<FeaturesSection />);
    expect(await screen.findByRole('switch', { name: 'New sleep tracking (beta)' })).not.toBeChecked();
    await waitFor(() => expect(queryClient.getQueryState(['useCalibration'])?.status).toBe('success'));
    expect(queryClient.getQueryState(['useDeviceStatus'])?.status).toBe('pending');
    expect(screen.getByText(BIOMETRICS_UNCHECKED_MODEL)).toBeVisible();
    expect(screen.getByText(EXPERIMENTAL_ON_THIS_POD)).toBeVisible();
    expect(screen.queryByText(NEW_SLEEP_TRACKING_CHECKED)).not.toBeInTheDocument();
  });

  it('shows the not-checked lines when device status fails', async () => {
    server.use(
      http.get('*/deviceStatus', () => new HttpResponse(null, { status: 500 })),
      formats('capSense2', 'capSense2'),
    );
    const { queryClient } = renderWithProviders(<FeaturesSection />);
    expect(await screen.findByRole('switch', { name: 'New sleep tracking (beta)' })).not.toBeChecked();
    await settled(queryClient, 'error');
    expect(screen.getByText(BIOMETRICS_UNCHECKED_MODEL)).toBeVisible();
    expect(screen.getByText(EXPERIMENTAL_ON_THIS_POD)).toBeVisible();
  });

  it('describes biometrics as estimates checked on a Pod 5', async () => {
    renderWithProviders(<FeaturesSection />);
    expect(await screen.findByText(BIOMETRICS_ESTIMATES, { exact: false })).toBeVisible();
  });

  it('shows the Pod 5 line and no not-checked line on a validated Pod 5', async () => {
    const { queryClient } = renderWithProviders(<FeaturesSection />);
    expect(await screen.findByText(NEW_SLEEP_TRACKING_CHECKED)).toBeVisible();
    await settled(queryClient);
    expect(screen.queryByText(BIOMETRICS_UNCHECKED_MODEL)).not.toBeInTheDocument();
    expect(screen.queryByText(EXPERIMENTAL_ON_THIS_POD)).not.toBeInTheDocument();
  });

  it('marks a Pod 4 as not checked on the biometrics row', async () => {
    server.use(pod('Pod 4'));
    renderWithProviders(<FeaturesSection />);
    expect(await screen.findByText(BIOMETRICS_UNCHECKED_MODEL)).toBeVisible();
    expect(screen.queryByText(NEW_SLEEP_TRACKING_CHECKED)).not.toBeInTheDocument();
  });

  it('does not call a Pod 5 writing the older format an unchecked model for biometrics', async () => {
    server.use(formats('capSense', null));
    const { queryClient } = renderWithProviders(<FeaturesSection />);
    expect(await screen.findByText(EXPERIMENTAL_ON_THIS_POD)).toBeVisible();
    await settled(queryClient);
    expect(screen.queryByText(BIOMETRICS_UNCHECKED_MODEL)).not.toBeInTheDocument();
  });

  it('does not claim the in-bed indicator or auto-off are unchanged', () => {
    expect(EXPERIMENTAL_ON_THIS_POD).toBe('Experimental on this Pod: checked only on one Pod 5 so far. '
      + 'It changes the nightly sleep records and the heart rate and breathing estimates.');
    expect(EXPERIMENTAL_ON_THIS_POD).not.toMatch(/accura|verified|reliab|in-bed|auto-off/i);
  });
});

it.each([null, ''])('reports invalid settings instead of leaving features loading for %s', async body => {
  server.use(http.get('*/settings', () => body === null ? HttpResponse.json(null) : new HttpResponse('')));
  renderWithProviders(<FeaturesSection/>);
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not load features.');
  expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
});

it.each([['Cooling warning', 'coolingWarning']] as const)('starts %s at its default and posts only its feature flag', async (label, flag) => {
  let posted: unknown;
  server.use(http.post('*/api/settings', async ({ request }) => {
    posted = await request.json(); return HttpResponse.json({});
  }));
  const on = getSettings().features[flag];
  const { user } = renderWithProviders(<FeaturesSection />);
  const toggle = await screen.findByRole('switch', { name: label });
  expect((toggle as HTMLInputElement).checked).toBe(on);
  await user.click(toggle);
  await waitFor(() => expect(posted).toEqual({ features: { [flag]: !on } }));
});

it.each(['biometrics', 'rhythms'])('scrolls to and focuses #%s when it opens with that hash', async id => {
  const scrolled: string[] = [];
  const original = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = function (this: Element) { scrolled.push(this.id); };
  try {
    renderWithProviders(<FeaturesSection />, { initialRoute: `/settings/features#${id}` });
    await screen.findByRole('switch', { name: 'Biometrics' });
    await waitFor(() => expect(document.activeElement).toBe(document.getElementById(id)));
    expect(scrolled).toContain(id);
    expect(document.getElementById(id)).toHaveAttribute('tabindex', '-1');
  } finally {
    Element.prototype.scrollIntoView = original;
  }
});

describe('Suggestions from your changes', () => {
  it('needs Rhythms first', async () => {
    renderWithProviders(<FeaturesSection />);
    const toggle = await screen.findByRole('switch', { name: 'Suggestions from your changes' });
    expect(toggle).toBeDisabled();
    expect(screen.getByRole('link', { name: 'Turn on Rhythms first' })).toHaveAttribute('href', '#rhythms');
    expect(document.getElementById('rhythms')).not.toBeNull();
  });

  it.each([[false, false], [true, true]])('shows checked only with Rhythms on too (Rhythms %s)', async (rhythms, checked) => {
    server.use(http.get('*/api/settings', () => HttpResponse.json({
      ...getSettings(), features: { ...getSettings().features, rhythms, rhythmSuggestions: true },
    })));
    renderWithProviders(<FeaturesSection />);
    const toggle = await screen.findByRole('switch', { name: 'Suggestions from your changes' });
    expect((toggle as HTMLInputElement).checked).toBe(checked);
  });

  it('saves its flag once Rhythms is on', async () => {
    let posted: unknown;
    server.use(
      http.get('*/api/settings', () => HttpResponse.json({ ...getSettings(), features: { ...getSettings().features, rhythms: true } })),
      http.post('*/api/settings', async ({ request }) => { posted = await request.json(); return HttpResponse.json({}); }),
    );
    const { user } = renderWithProviders(<FeaturesSection />);
    const toggle = await screen.findByRole('switch', { name: 'Suggestions from your changes' });
    await waitFor(() => expect(toggle).toBeEnabled());
    expect(screen.getByText(/suggests the ones you repeat/)).toBeInTheDocument();
    await user.click(toggle);
    await waitFor(() => expect(posted).toEqual({ features: { rhythmSuggestions: true } }));
  });

  it('deletes the notes after asking, with the feature off too', async () => {
    let forgot = 0;
    server.use(http.post('*/rhythms/suggestions/forget', () => { forgot += 1; return new HttpResponse(null, { status: 204 }); }));
    const { user } = renderWithProviders(<FeaturesSection />);
    await user.click(await screen.findByRole('button', { name: 'Delete notes' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete notes for both sides? Counting restarts tonight.' });
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(forgot).toBe(0);
    await user.click(screen.getByRole('button', { name: 'Delete notes' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete notes' }));
    await waitFor(() => expect(forgot).toBe(1));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('says when the notes could not be deleted', async () => {
    server.use(http.post('*/rhythms/suggestions/forget', () => HttpResponse.json({ error: 'nope' }, { status: 500 })));
    const { user } = renderWithProviders(<FeaturesSection />);
    await user.click(await screen.findByRole('button', { name: 'Delete notes' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete notes' }));
    expect(await screen.findByText('Could not delete notes. Try again.')).toBeInTheDocument();
  });
});
