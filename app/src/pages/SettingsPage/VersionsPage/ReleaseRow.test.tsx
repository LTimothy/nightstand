import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '@test/renderWithProviders';
import { server } from '@test/setup';
import ReleaseRow from './ReleaseRow';
import { serveInUse } from '@test/inUse';

const release = { kind: 'agent', version: '3.4.0', channel: 'stable', date: '2026-07-01' } as const;

describe('ReleaseRow', () => {
  it('posts an install request with the target version on confirm', async () => {
    let posted: any;
    server.use(
      http.post('*/update', async ({ request }) => {
        posted = await request.json();
        return HttpResponse.json({});
      }),
    );

    const { user } = renderWithProviders(
      <ReleaseRow release={ release } runningVersion="3.3.0"/>,
    );

    await user.click(screen.getByRole('button', { name: 'Install' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Install now' }));

    await waitFor(() => expect(posted).toEqual({ targetVersion: '3.4.0', allowDowngrade: false }));
  });

  it('closes the dialog on Cancel and fires no install', async () => {
    let installed = false;
    server.use(
      http.post('*/update', () => {
        installed = true;
        return HttpResponse.json({});
      }),
    );

    const { user } = renderWithProviders(
      <ReleaseRow release={ release } runningVersion="3.3.0"/>,
    );

    await user.click(screen.getByRole('button', { name: 'Install' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(installed).toBe(false);
  });

  it('offers nothing on the running version by default', () => {
    renderWithProviders(<ReleaseRow release={ release } runningVersion="3.4.0"/>);
    expect(screen.queryByRole('button', { name: /install/i })).not.toBeInTheDocument();
  });

  it('offers a reinstall of the running version when the database has unfinished changes', async () => {
    // An earlier update that could not migrate leaves this version running
    // without tables it needs. Reinstalling it runs an updater that finishes
    // the job, and nothing else on the page can.
    let posted: any;
    server.use(
      http.post('*/update', async ({ request }) => {
        posted = await request.json();
        return HttpResponse.json({});
      }),
    );

    const { user } = renderWithProviders(
      <ReleaseRow release={ release } runningVersion="3.4.0" offerReinstall/>,
    );

    await user.click(screen.getByRole('button', { name: 'Reinstall' }));
    expect(await screen.findByRole('dialog')).toHaveTextContent('Reinstall v3.4.0?');
    await user.click(screen.getByRole('button', { name: 'Reinstall now' }));

    await waitFor(() => expect(posted).toEqual({ targetVersion: '3.4.0', allowDowngrade: false }));
  });

  it('lays the downgrade warnings out as a compact list inside the alert', async () => {
    const { user } = renderWithProviders(
      <ReleaseRow release={ { ...release, version: '3.2.0' } } runningVersion="3.5.0"/>,
    );

    await user.click(screen.getByRole('button', { name: 'Install (downgrade)' }));
    const list = (await screen.findByRole('dialog')).querySelector('ul');
    expect(list).not.toBeNull();
    const style = getComputedStyle(list!);
    expect(style.marginTop).toMatch(/^0(px)?$/);
    expect(style.paddingLeft).toBe('16px');
  });

  it('only changes the running row: other versions still say Install', () => {
    renderWithProviders(<ReleaseRow release={ release } runningVersion="3.3.0" offerReinstall/>);
    expect(screen.getByRole('button', { name: 'Install' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reinstall' })).not.toBeInTheDocument();
  });
});

describe('ReleaseRow channel', () => {
  const beta = { kind: 'agent', version: '3.6.0', channel: 'beta', date: '2026-10-01' } as const;

  it('marks a release Stable or Beta', () => {
    const { unmount } = renderWithProviders(<ReleaseRow release={ release } runningVersion="3.3.0"/>);
    expect(screen.getByText('Stable')).toBeInTheDocument();
    unmount();
    renderWithProviders(<ReleaseRow release={ beta } runningVersion="3.3.0"/>);
    expect(screen.getByText('Beta')).toBeInTheDocument();
  });

  it('says so when installing a beta, and not for a stable release', async () => {
    const view = renderWithProviders(<ReleaseRow release={ beta } runningVersion="3.3.0"/>);
    await view.user.click(screen.getByRole('button', { name: 'Install' }));
    expect(await screen.findByText('v3.6.0 is a beta release. It has had less testing than stable.')).toBeInTheDocument();
    view.unmount();
    const stable = renderWithProviders(<ReleaseRow release={ release } runningVersion="3.3.0"/>);
    await stable.user.click(screen.getByRole('button', { name: 'Install' }));
    await screen.findByRole('dialog');
    expect(screen.queryByText(/is a beta release/)).not.toBeInTheDocument();
  });
});

describe('ReleaseRow when the bed may be in use', () => {
  const open = async () => {
    const view = renderWithProviders(<ReleaseRow release={ release } runningVersion="3.3.0"/>);
    await view.user.click(screen.getByRole('button', { name: 'Install' }));
    return view;
  };

  it('asks again after a refusal and confirms the same request on Continue anyway', async () => {
    const bodies = serveInUse('*/update', ['status-unknown']);
    const { user } = await open();
    await user.click(await screen.findByRole('button', { name: 'Install now' }));
    expect(await screen.findByText("Nightstand cannot read the bed's state right now, so someone may be using it.")).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Continue anyway' }));
    await waitFor(() => expect(bodies).toEqual([
      { targetVersion: '3.4.0', allowDowngrade: false },
      { targetVersion: '3.4.0', allowDowngrade: false, confirmInUse: true },
    ]));
  });

  it('sends no confirmation when the bed is idle', async () => {
    const bodies = serveInUse('*/update', []);
    const { user } = await open();
    await user.click(await screen.findByRole('button', { name: 'Install now' }));
    await waitFor(() => expect(bodies).toEqual([{ targetVersion: '3.4.0', allowDowngrade: false }]));
  });
});
