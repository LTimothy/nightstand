import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import { renderWithProviders } from '@test/renderWithProviders';
import { server } from '@test/setup';
import { getDeviceStatus, getServices, getSettings } from '../../../mocks/mockData';
import FeaturesSection from './FeaturesSection';

const BIOMETRICS_ESTIMATES = 'Time in bed and heart rate estimated from the bed\'s sensors. Estimates, not medical measurements.';
const NEW_SLEEP_TRACKING = 'Tells the two sides apart with the capacitance sensors. '
  + 'It changes the nightly sleep records and the heart rate and breathing estimates.';
const CAP_PRESENCE = 'Capacitance presence (beta)';
const UNCHECKED_CAP_PRESENCE = 'Schedules, auto-off and the in-bed indicator follow capacitance presence once both sides are learned. '
  + 'Checked on one Pod 3.';
const biometricsOff = () => {
  const services = getServices();
  server.use(http.get('*/api/services', () => HttpResponse.json({ ...services, biometrics: { ...services.biometrics, enabled: false } })));
};
// The mock Pod is a Pod 5, which has no capacitance presence switch.
const onPod4 = () => server.use(http.get('*/deviceStatus', () => HttpResponse.json({ ...getDeviceStatus(), hubVersion: 'Pod 4' })));
const switchNames = (region: HTMLElement) => within(region).getAllByRole('switch').map(control => control.getAttribute('aria-label'));

describe('FeaturesSection', () => {
  it('groups the switches into Everyday, Sleep tracking and Storage cards', async () => {
    onPod4();
    renderWithProviders(<FeaturesSection />);
    const everyday = await screen.findByRole('region', { name: 'Everyday' });
    const tracking = screen.getByRole('region', { name: 'Sleep tracking' });
    const storage = screen.getByRole('region', { name: 'Storage' });
    expect(screen.getAllByRole('heading', { level: 2 }).map(heading => heading.textContent))
      .toEqual(['Everyday', 'Sleep tracking', 'Storage']);
    expect(switchNames(everyday)).toEqual(['Rhythms', 'Suggestions from your changes', 'One-time alarm', 'Ring alarms when the side is off']);
    expect(within(everyday).getByRole('button', { name: 'Delete notes' })).toBeVisible();
    expect(switchNames(tracking)).toEqual(['Biometrics', 'Presence auto-off', 'New sleep tracking (beta)',
      'Capacitance presence (beta)', 'Cooling warning']);
    expect(within(tracking).getByRole('combobox', { name: 'Keep raw sensor recordings' })).toBeVisible();
    expect(within(tracking).getByText('Sleep analysis reads these. About 0.4 GB a day. '
      + 'Oldest removed first if storage runs low.')).toBeVisible();
    expect(switchNames(storage)).toEqual([
      'Low-disk protection', 'Delete detail after 30 days', 'Keep the system log in memory', 'Write flash less often',
    ]);
  });

  it.each([['Presence auto-off'], ['New sleep tracking (beta)'], ['Capacitance presence (beta)'], ['Cooling warning']])(
    'disables %s while Biometrics is off and links to it', async label => {
      onPod4();
      biometricsOff();
      renderWithProviders(<FeaturesSection />);
      const tracking = await screen.findByRole('region', { name: 'Sleep tracking' });
      await waitFor(() => expect(within(tracking).getAllByRole('link', { name: 'Turn on Biometrics first' })).toHaveLength(4));
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
    const age = screen.getByRole('switch', { name: 'Delete detail after 30 days' });
    expect(lowDisk).toBeChecked();
    expect(age).not.toBeChecked();
    expect(screen.getByText('Below 150 MiB free, deletes the oldest detailed vitals, then movement for nights already summarized. '
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

  it('keeps the system log on flash by default and posts journalInMemory when it is switched on', async () => {
    let posted: unknown;
    server.use(http.post('*/api/settings', async ({ request }) => {
      posted = await request.json();
      return HttpResponse.json({});
    }));
    const { user } = renderWithProviders(<FeaturesSection />);
    const toggle = await screen.findByRole('switch', { name: 'Keep the system log in memory' });
    expect(toggle).not.toBeChecked();
    expect(screen.getByText('Cuts flash writes. Starts at the next Pod restart; the system log then clears on each restart. '
      + 'Nightstand\'s logs are kept. Older system log files on flash are removed after that restart.')).toBeVisible();
    await user.click(toggle);
    expect(posted).toEqual({ features: { journalInMemory: true } });
  });

  it('commits flash at the stock interval by default and posts longFlashCommit when it is switched on', async () => {
    let posted: unknown;
    server.use(http.post('*/api/settings', async ({ request }) => {
      posted = await request.json();
      return HttpResponse.json({});
    }));
    const { user } = renderWithProviders(<FeaturesSection />);
    const toggle = await screen.findByRole('switch', { name: 'Write flash less often' });
    expect(toggle).not.toBeChecked();
    expect(screen.getByText('Fewer flash writes. A power cut can lose up to the last minute of sensor recordings and logs.')).toBeVisible();
    await user.click(toggle);
    expect(posted).toEqual({ features: { longFlashCommit: true } });
  });

  it("offers the Pod's target temperatures on a Pod 5 only", async () => {
    let posted: unknown;
    server.use(http.post('*/api/settings', async ({ request }) => {
      posted = await request.json();
      return HttpResponse.json({});
    }));
    const { user } = renderWithProviders(<FeaturesSection />);
    const toggle = await screen.findByRole('switch', { name: "Show the Pod's target temperatures" });
    expect(toggle).not.toBeChecked();
    await user.click(toggle);
    expect(posted).toEqual({ features: { targetTemperatureLabels: true } });
  });

  it('offers the automatic cover service restart on a Pod 5, off by default', async () => {
    let posted: unknown;
    server.use(http.post('*/api/settings', async ({ request }) => {
      posted = await request.json();
      return HttpResponse.json({});
    }));
    const { user } = renderWithProviders(<FeaturesSection />);
    const toggle = await screen.findByRole('switch', { name: 'Restart the cover service on its own' });
    expect(toggle).not.toBeChecked();
    expect(screen.getByText('When one side of the cover sends no readings for 10 minutes, Nightstand restarts the Pod\'s cover service. '
      + 'At most once an hour, never near an alarm.')).toBeVisible();
    await user.click(toggle);
    expect(posted).toEqual({ features: { coverAutoRestore: true } });
  });

  it.each(['Pod 3', 'Pod 4'])('hides the automatic cover service restart on a %s hub', async model => {
    server.use(http.get('*/deviceStatus', () => HttpResponse.json({ ...getDeviceStatus(), hubVersion: model })));
    renderWithProviders(<FeaturesSection />);
    await screen.findByRole('switch', { name: 'One-time alarm' });
    expect(screen.queryByRole('switch', { name: 'Restart the cover service on its own' })).toBeNull();
  });

  it("hides the Pod's target temperatures on a Pod 4", async () => {
    onPod4();
    renderWithProviders(<FeaturesSection />);
    await screen.findByRole('switch', { name: 'One-time alarm' });
    expect(screen.queryByRole('switch', { name: "Show the Pod's target temperatures" })).toBeNull();
  });

  it('lists the target temperatures switch after One-time alarm on a Pod 5 and no Level switch', async () => {
    renderWithProviders(<FeaturesSection />);
    const everyday = await screen.findByRole('region', { name: 'Everyday' });
    expect(switchNames(everyday)).toEqual(['Rhythms', 'Suggestions from your changes', 'One-time alarm',
      'Ring alarms when the side is off', "Show the Pod's target temperatures", 'Restart the cover service on its own']);
    expect(within(everyday).getByText('Shows the Pod 5 firmware\'s own target curve instead of the usual straight-line scale. '
      + 'Schedules are unchanged. No effect in Level format.')).toBeVisible();
    expect(within(everyday).getByText('Adds a one-time alarm to Schedule, separate from the daily wake-up. '
      + 'Off, a set one-time alarm does not ring.')).toBeVisible();
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

  it('offers ringing alarms on an off side, off by default, on every Pod', async () => {
    onPod4();
    let posted: unknown;
    server.use(http.post('*/settings', async ({ request }) => {
      posted = await request.json();
      return HttpResponse.json({});
    }));
    const { user } = renderWithProviders(<FeaturesSection />);
    const toggle = await screen.findByRole('switch', { name: 'Ring alarms when the side is off' });
    expect(toggle).not.toBeChecked();
    expect(screen.getByText('Alarms vibrate even if the side is off.')).toBeVisible();
    await user.click(toggle);
    expect(posted).toEqual({ features: { alarmsWhenOff: true } });
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
    expect(await screen.findByText(NEW_SLEEP_TRACKING)).toBeVisible();
    await user.click(toggle);

    expect(posted).toEqual({ features: { biometricsV2: true } });
  });

  it('keeps capacitance presence on other Pods off and waiting until new sleep tracking is on', async () => {
    onPod4();
    renderWithProviders(<FeaturesSection />);
    const toggle = await screen.findByRole('switch', { name: CAP_PRESENCE });
    expect(toggle).not.toBeChecked();
    expect(toggle).toBeDisabled();
    expect(screen.getByRole('link', { name: 'Turn on New sleep tracking first' })).toHaveAttribute('href', '#biometrics');
    expect(screen.queryByText(UNCHECKED_CAP_PRESENCE)).not.toBeInTheDocument();
  });

  it('posts uncheckedCapPresence alone when it is switched on under new sleep tracking', async () => {
    onPod4();
    let posted: unknown;
    const settings = getSettings();
    server.use(
      http.get('*/settings', () => HttpResponse.json({ ...settings, features: { ...settings.features, biometricsV2: true } })),
      http.post('*/api/settings', async ({ request }) => {
        posted = await request.json();
        return HttpResponse.json({});
      }),
    );

    const { user } = renderWithProviders(<FeaturesSection />);

    const toggle = await screen.findByRole('switch', { name: CAP_PRESENCE });
    await waitFor(() => expect(toggle).toBeEnabled());
    expect(toggle).not.toBeChecked();
    expect(screen.getByText(UNCHECKED_CAP_PRESENCE)).toBeVisible();
    await user.click(toggle);

    await waitFor(() => expect(posted).toEqual({ features: { uncheckedCapPresence: true } }));
  });

  it('leaves out the capacitance presence switch on a Pod 5', async () => {
    renderWithProviders(<FeaturesSection />);
    const tracking = await screen.findByRole('region', { name: 'Sleep tracking' });
    expect(switchNames(tracking)).toEqual(['Biometrics', 'Presence auto-off', 'New sleep tracking (beta)', 'Cooling warning']);
  });

  it('shows the root-owned installer path when biometrics is not installed', async () => {
    const services = structuredClone(getServices());
    services.biometrics.jobs.installation.status = 'not_started';
    server.use(http.get('*/api/services', () => HttpResponse.json(services)));
    const { user } = renderWithProviders(<FeaturesSection />);
    const command = 'sh /usr/local/lib/nightstand/live/scripts/enable_biometrics.sh';
    await user.click(await screen.findByText('How to install'));
    expect(screen.getByText(command)).toBeInTheDocument();
  });
});

describe('FeaturesSection sleep tracking copy', () => {
  it.each(['Pod 3', 'Pod 4', 'Pod 5'])('describes biometrics and new sleep tracking plainly on a %s', async model => {
    server.use(http.get('*/deviceStatus', () => HttpResponse.json({ ...getDeviceStatus(), coverVersion: model, hubVersion: model })));
    renderWithProviders(<FeaturesSection />);
    expect(await screen.findByText(BIOMETRICS_ESTIMATES)).toBeVisible();
    expect(screen.getByText(NEW_SLEEP_TRACKING)).toBeVisible();
    expect(screen.queryByText(/checked|experimental/i)).not.toBeInTheDocument();
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
