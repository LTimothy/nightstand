import { getDeviceStatus, getSettings } from '../../../mocks/mockData';
import { beforeEach, describe, it, expect } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';
import { renderApp, renderWithProviders } from '@test/renderWithProviders';
import { http, HttpResponse } from 'msw';
import { server } from '@test/setup';
import VersionsPage from './VersionsPage';
import { useUpdateAttentionStore } from '@state/updateAttentionStore';

beforeEach(() => useUpdateAttentionStore.getState().setUpdateAttention(false));

// The demo saves the running release's channel, which may be beta.
const savedOnStable = () => http.get('*/api/settings', () => HttpResponse.json({ ...getSettings(), updateChannel: 'stable' }));

describe('VersionsPage', () => {
  it('renders the versions page', async () => {
    renderWithProviders(<VersionsPage />, { initialRoute: '/settings/versions' });
    expect(await screen.findByText('Software')).toBeInTheDocument();
  });
});

it('shows a failed channel save and retains the saved channel', async () => {
  server.use(savedOnStable(), http.post('*/settings', () => new HttpResponse(null, { status: 500 })));
  const { user } = renderWithProviders(<VersionsPage />);
  await user.click(await screen.findByRole('button', { name: /Update channel Stable/ }));
  expect(screen.getByRole('dialog', { name: 'Update channel' })).toBeInTheDocument();
  await waitFor(() => expect(screen.getByRole('radio', { name: 'Beta' })).toBeEnabled());
  await user.click(screen.getByRole('radio', { name: 'Beta' }));
  expect(await screen.findByText(/Could not save the update channel/)).toBeInTheDocument();
  expect(screen.getByRole('radio', { name: 'Stable' })).toBeChecked();
});

it('does not present Stable as the channel when settings fail to load', async () => {
  server.use(http.get('*/api/settings', () => new HttpResponse(null, { status: 500 })));
  renderWithProviders(<VersionsPage />);
  expect(await screen.findByRole('button', { name: /Update channel Unavailable/ })).toBeInTheDocument();
  expect(screen.queryByText('Stable')).not.toBeInTheDocument();
});

it('keeps recovery actions collapsed until requested', async () => {
  const { user } = renderWithProviders(<VersionsPage />);
  const recovery = await screen.findByRole('button', { name: 'Recovery' });
  expect(recovery).toHaveAttribute('aria-expanded', 'false');
  expect(screen.queryByRole('button', { name: 'Switch to upstream free-sleep' })).not.toBeInTheDocument();
  await user.click(recovery);
  expect(await screen.findByRole('button', { name: 'Switch to upstream free-sleep' })).toBeVisible();
});

it('explains how to go back to Eight Sleep, without offering an action', async () => {
  const { user } = renderWithProviders(<VersionsPage/>);
  await user.click(await screen.findByRole('button', { name: 'Recovery' }));
  expect(await screen.findByText('Go back to Eight Sleep')).toBeInTheDocument();
  expect(screen.getByText(/On Pod 5 no reset procedure has been checked yet\./)).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Read the steps' })).toHaveAttribute(
    'href',
    'https://github.com/LTimothy/nightstand/blob/main/INSTALLATION.md#going-back-to-the-eight-sleep-app',
  );
  expect(screen.queryByRole('button', { name: /Eight Sleep/ })).toBeNull();
});

it('surfaces a rejected update on Software after closing the dialog', async () => {
  server.use(
    http.get('*/api/deviceStatus', () => HttpResponse.json({
      ...getDeviceStatus(), freeSleep: { ...getDeviceStatus().freeSleep, version: '3.0.0' },
    })),
    http.get('https://raw.githubusercontent.com/LTimothy/nightstand/main/releases.json', () => HttpResponse.json({
      channels: ['stable', 'beta'],
      releases: [{ kind: 'agent', version: '3.2.0', channel: 'stable', date: '2026-09-28' }],
    })),
    http.get('*/update/rollback-info', () => HttpResponse.json({ available: true, version: '2.9.0' })),
    http.post('*/api/update', () => new HttpResponse(null, { status: 500 })),
  );
  const { user } = renderWithProviders(<VersionsPage/>);
  await user.click(await screen.findByRole('button', { name: 'Update to v3.2.0' }));
  await user.click(await screen.findByRole('button', { name: 'Update now' }));
  await user.click(await screen.findByRole('button', { name: 'Close' }));
  expect(await screen.findByText(/Nightstand did not accept the update request. Nothing was installed./)).toBeVisible();
  expect(await screen.findByRole('button', { name: 'Try again' })).toBeVisible();
  expect(screen.queryByRole('button', { name: /Go back/ })).not.toBeInTheDocument();
  expect(await screen.findByRole('link', { name: 'Open update logs' })).toHaveAttribute('href', '/settings/logs?file=free-sleep-update.log');
});

it('keeps a known failure and the Settings badge when navigating away and back', async () => {
  server.use(
    http.get('*/api/deviceStatus', () => HttpResponse.json({
      ...getDeviceStatus(), freeSleep: { ...getDeviceStatus().freeSleep, version: '3.0.0' },
    })),
    http.get('https://raw.githubusercontent.com/LTimothy/nightstand/main/releases.json', () => HttpResponse.json({
      channels: ['stable', 'beta'],
      releases: [{ kind: 'agent', version: '3.2.0', channel: 'stable', date: '2026-09-28' }],
    })),
    http.get('*/update/rollback-info', () => HttpResponse.json({ available: true, version: '2.9.0' })),
    http.post('*/api/update', () => new HttpResponse(null, { status: 500 })),
  );
  const { user } = renderApp('/settings/versions');
  await user.click(await screen.findByRole('button', { name: 'Update to v3.2.0' }));
  await user.click(await screen.findByRole('button', { name: 'Update now' }));
  await user.click(await screen.findByRole('button', { name: 'Close' }));
  const settingsLinks = await screen.findAllByRole('link', { name: 'Settings, update needs attention' });
  await user.click(settingsLinks[0]);
  expect(await screen.findByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
  expect(screen.queryByText(/Nightstand did not accept the update request. Nothing was installed./)).not.toBeInTheDocument();
  await user.click(await screen.findByRole('link', { name: /Software/ }));
  expect(await screen.findByText(/Nightstand did not accept the update request. Nothing was installed./)).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Dismiss update notice' }));
  expect(screen.queryByRole('link', { name: 'Settings, update needs attention' })).not.toBeInTheDocument();
  expect(screen.queryByText(/Nightstand did not accept the update request. Nothing was installed./)).not.toBeInTheDocument();
});

it('clears known update attention only when a retry actually starts', async () => {
  server.use(
    http.get('*/api/deviceStatus', () => HttpResponse.json({
      ...getDeviceStatus(), freeSleep: { ...getDeviceStatus().freeSleep, version: '3.0.0' },
    })),
    http.get('https://raw.githubusercontent.com/LTimothy/nightstand/main/releases.json', () => HttpResponse.json({
      channels: ['stable', 'beta'],
      releases: [{ kind: 'agent', version: '3.2.0', channel: 'stable', date: '2026-09-28' }],
    })),
    http.post('*/api/update', () => new HttpResponse(null, { status: 204 })),
  );
  useUpdateAttentionStore.setState({ updateAttention: true });
  const { user } = renderWithProviders(<VersionsPage/>);
  await user.click(await screen.findByRole('button', { name: 'Update to v3.2.0' }));
  expect(useUpdateAttentionStore.getState().updateAttention).toBe(true);
  await user.click(await screen.findByRole('button', { name: 'Update now' }));
  expect(useUpdateAttentionStore.getState().updateAttention).toBe(false);
});

it('clears a timed out notice when a later check reports another running version', async () => {
  server.use(http.get('*/deviceStatus', () => HttpResponse.json({
    ...getDeviceStatus(), freeSleep: { ...getDeviceStatus().freeSleep, version: '3.0.0' },
  })));
  useUpdateAttentionStore.setState({ updateAttention: true, updateOutcome: 'timed_out', updateStartVersion: '3.0.0' });
  const { queryClient } = renderApp('/settings/versions');
  expect(await screen.findByText(/The last update did not finish/)).toBeVisible();
  act(() => queryClient.setQueryData(['useDeviceStatus'], { freeSleep: { version: '3.2.0' } }));
  await waitFor(() => expect(screen.queryByText(/The last update did not finish/)).not.toBeInTheDocument());
  expect(useUpdateAttentionStore.getState().updateAttention).toBe(false);
});

it('keeps recovery available after an accepted update times out', async () => {
  server.use(
    http.get('*/deviceStatus', () => HttpResponse.json({
      ...getDeviceStatus(), freeSleep: { ...getDeviceStatus().freeSleep, version: '3.0.0' },
    })),
    http.get('*/update/rollback-info', () => HttpResponse.json({ available: true, version: '2.9.0' })),
  );
  useUpdateAttentionStore.getState().setUpdateAttention(true, 'timed_out', '3.0.0');
  renderWithProviders(<VersionsPage/>);
  expect(await screen.findByText(/The last update did not finish/)).toBeVisible();
  expect(await screen.findByRole('button', { name: 'Go back to v2.9.0 Instant, no download' })).toBeVisible();
});

it('disables update channel selection when the server omits the setting', async () => {
  server.use(http.get('*/api/settings', () => HttpResponse.json({ ...getSettings(), updateChannel: undefined })));
  const { user, queryClient } = renderWithProviders(<VersionsPage />);
  await waitFor(() => expect(queryClient.getQueryData(['useSettings'])).toBeTruthy());
  await user.click(await screen.findByRole('button', { name: /Update channel Unavailable/ }));
  expect(await screen.findByRole('radio', { name: 'Beta' })).toBeDisabled();
});

it('describes the channels in the channel drawer', async () => {
  server.use(savedOnStable());
  const { user } = renderWithProviders(<VersionsPage />);
  await user.click(await screen.findByRole('button', { name: /Update channel Stable/ }));
  expect(await screen.findByText(
    'Stable gets a release after it has been used for a while without problems. ' +
    'Beta gets each release right away, with less testing.'
  )).toBeInTheDocument();
});

it('tells someone running a beta on the stable channel, and switches them', async () => {
  let posted: unknown;
  server.use(
    savedOnStable(),
    http.get('*/api/deviceStatus', () => HttpResponse.json({
      ...getDeviceStatus(), freeSleep: { ...getDeviceStatus().freeSleep, version: '3.5.1' },
    })),
    http.get('https://raw.githubusercontent.com/LTimothy/nightstand/main/releases.json', () => HttpResponse.json({
      channels: ['stable', 'beta'],
      releases: [
        { kind: 'agent', version: '3.5.1', channel: 'beta', date: '2026-10-01' },
        { kind: 'agent', version: '3.3.2', channel: 'stable', date: '2026-09-29' },
      ],
    })),
    http.post('*/settings', async ({ request }) => { posted = await request.json(); return HttpResponse.json({}); }),
  );
  const { user } = renderWithProviders(<VersionsPage />);
  expect(await screen.findByText(/You are running v3.5.1, a beta release/)).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Switch to Beta' }));
  await waitFor(() => expect(posted).toEqual({ updateChannel: 'beta' }));
});

describe('beta on stable notice waits for the saved channel', () => {
  const betaRunning = (settings: Parameters<typeof http.get>[1]) => server.use(
    http.get('*/api/deviceStatus', () => HttpResponse.json({
      ...getDeviceStatus(), freeSleep: { ...getDeviceStatus().freeSleep, version: '3.5.1' },
    })),
    http.get('https://raw.githubusercontent.com/LTimothy/nightstand/main/releases.json', () => HttpResponse.json({
      channels: ['stable', 'beta'],
      releases: [{ kind: 'agent', version: '3.5.1', channel: 'beta', date: '2026-10-01' }],
    })),
    http.get('*/api/settings', settings),
  );

  it('shows nothing while settings are loading', async () => {
    betaRunning(() => new Promise(() => undefined));
    renderWithProviders(<VersionsPage />);
    await screen.findByRole('button', { name: /Update channel Loading/ });
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(screen.queryByText(/a beta release/)).not.toBeInTheDocument();
  });

  it('shows nothing when settings fail to load', async () => {
    betaRunning(() => new HttpResponse(null, { status: 500 }));
    renderWithProviders(<VersionsPage />);
    await screen.findByRole('button', { name: /Update channel Unavailable/ });
    expect(screen.queryByText(/a beta release/)).not.toBeInTheDocument();
  });

  it('shows nothing when the server omits the channel', async () => {
    betaRunning(() => HttpResponse.json({ ...getSettings(), updateChannel: undefined }));
    renderWithProviders(<VersionsPage />);
    await screen.findByRole('button', { name: /Update channel Unavailable/ });
    expect(screen.queryByText(/a beta release/)).not.toBeInTheDocument();
  });

  it('moves focus to the Update channel row after the switch', async () => {
    let channel = 'stable';
    betaRunning(() => HttpResponse.json({ ...getSettings(), updateChannel: channel }));
    server.use(http.post('*/settings', () => { channel = 'beta'; return HttpResponse.json({}); }));
    const { user } = renderWithProviders(<VersionsPage />);
    await user.click(await screen.findByRole('button', { name: 'Switch to Beta' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Switch to Beta' })).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole('button', { name: /Update channel Beta/ })).toHaveFocus());
  });
});

it('lists the five newest versions in Recovery, then all on request', async () => {
  server.use(
    savedOnStable(),
    http.get('*/api/deviceStatus', () => HttpResponse.json({
      ...getDeviceStatus(), freeSleep: { ...getDeviceStatus().freeSleep, version: '3.0.0' },
    })),
    http.get('https://raw.githubusercontent.com/LTimothy/nightstand/main/releases.json', () => HttpResponse.json({
      channels: ['stable', 'beta'],
      releases: [1, 2, 3, 4, 5, 6, 7].map(minor => ({ kind: 'agent', version: `3.${minor}.0`, channel: 'stable', date: '2026-09-28' })),
    })),
  );
  const { user } = renderWithProviders(<VersionsPage />);
  await user.click(await screen.findByRole('button', { name: 'Recovery' }));
  const showAll = await screen.findByRole('button', { name: 'Show all 7 versions' });
  expect(screen.getAllByRole('button', { name: 'Install' })).toHaveLength(5);
  await user.click(showAll);
  expect(screen.getAllByRole('button', { name: 'Install' })).toHaveLength(7);
});
