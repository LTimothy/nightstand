import { describe, it, expect } from 'vitest';
import { delay, http, HttpResponse } from 'msw';
import { QueryClient } from '@tanstack/react-query';
import { screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '@test/renderWithProviders';
import { server } from '@test/setup';
import { getDeviceStatus, getSettings, mockCalibration } from '../../../mocks/mockData';
import { EXPERIMENTAL_ON_THIS_POD } from '@api/sleepTrackingValidation.ts';
import FeaturesSection from './FeaturesSection';

const BIOMETRICS_ESTIMATES = 'Detects time in bed and estimates heart rate from the bed\'s sensors. '
  + 'These are estimates, not medical measurements, and have only been checked on a Pod 5.';
const BIOMETRICS_UNCHECKED_MODEL = 'Not checked on this Pod model. Numbers may be further off than on a Pod 5.';
const NEW_SLEEP_TRACKING_CHECKED = 'Tells the two sides apart with the bed\'s capacitance sensors, for bed times, '
  + 'the in-bed indicator, auto-off and Smart Schedule; that part has been checked on one Pod 5. '
  + 'Heart rate and breathing use newer estimates.';

describe('FeaturesSection', () => {
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
    expect(screen.getByText(/Below 150 MiB/)).toHaveTextContent('does not shrink');
    expect(screen.getByText(/Below 150 MiB/)).toHaveTextContent('last 2 nights');
    expect(screen.getByText(/Opt-in/)).toHaveTextContent('Never deletes nightly summaries, sleep records or scores');
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

  it('posts coverButtons when the cover buttons toggle is switched on', async () => {
    let posted: unknown;
    server.use(
      http.post('*/api/settings', async ({ request }) => {
        posted = await request.json();
        return HttpResponse.json({});
      }),
    );

    const { user } = renderWithProviders(<FeaturesSection />);

    const toggle = await screen.findByRole('switch', { name: 'Cover buttons' });
    expect(toggle).not.toBeChecked();
    await user.click(toggle);

    expect(posted).toEqual({ features: { coverButtons: true } });
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

it.each([
  ['Firmware target', 'firmwareTargetReadout'], ['Firmware health', 'firmwareHealth'],
  ['Tap diagnostics', 'tapDiagnostics'], ['Cooling warning', 'coolingWarning'],
])('starts %s off and posts only its feature flag', async (label, flag) => {
  let posted: unknown;
  server.use(http.post('*/api/settings', async ({ request }) => {
    posted = await request.json(); return HttpResponse.json({});
  }));
  const { user } = renderWithProviders(<FeaturesSection />);
  const toggle = await screen.findByRole('switch', { name: label });
  expect(toggle).not.toBeChecked();
  await user.click(toggle);
  await waitFor(() => expect(posted).toEqual({ features: { [flag]: true } }));
});
