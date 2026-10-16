import { describe, it, expect, beforeEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '@test/renderWithProviders';
import { server } from '@test/setup';
import RevertToStockRow from './RevertToStockRow';
import targetFixtures from '../../../../../scripts/tests/fixtures/upstream_targets.json';
import { ReleasesManifestSchema } from '@api/releases';
import { SIDE_ON, serveInUse } from '@test/inUse';

const target = targetFixtures[1].expected!;
const manifest = ReleasesManifestSchema.parse(targetFixtures[1].manifest);

beforeEach(() => {
  server.use(http.get('https://raw.githubusercontent.com/LTimothy/nightstand/main/releases.json',
    () => HttpResponse.json(manifest)));
});

async function openDialog() {
  const view = renderWithProviders(<RevertToStockRow runningVersion="3.0.0"/>);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Switch to upstream free-sleep' })).toBeEnabled());
  await view.user.click(screen.getByRole('button', { name: 'Switch to upstream free-sleep' }));
  return view;
}

describe('RevertToStockRow', () => {
  it('closes the confirm dialog on Cancel and fires no request', async () => {
    let reverted = false;
    server.use(
      http.post('*/update/switch-to-upstream', () => {
        reverted = true;
        return HttpResponse.json({});
      }),
    );

    const { user } = await openDialog();
    expect(await screen.findByRole('dialog')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(reverted).toBe(false);
  });
});

it('exposes recovery as a keyboard-accessible button', () => {
  renderWithProviders(<RevertToStockRow runningVersion="3.0.0"/>);
  expect(screen.getByRole('button', { name: 'Switch to upstream free-sleep' })).toBeInTheDocument();
});

describe('RevertToStockRow when the bed may be in use', () => {
  const open = async () => {
    return openDialog();
  };

  it('asks again after a refusal and sends a confirmed request only on Continue anyway', async () => {
    const bodies = serveInUse('*/update/switch-to-upstream', ['left-on']);
    const { user } = await open();
    await user.click(await screen.findByRole('button', { name: 'Switch to upstream free-sleep' }));
    expect(await screen.findByText(SIDE_ON)).toBeInTheDocument();
    expect(bodies).toEqual([{ target }]);
    await user.click(screen.getByRole('button', { name: 'Continue anyway' }));
    await waitFor(() => expect(bodies).toEqual([{ target }, { target, confirmInUse: true }]));
  });

  it('sends no confirmation when the bed is idle', async () => {
    const bodies = serveInUse('*/update/switch-to-upstream', []);
    const { user } = await open();
    await user.click(await screen.findByRole('button', { name: 'Switch to upstream free-sleep' }));
    await waitFor(() => expect(bodies).toEqual([{ target }]));
    expect(screen.queryByRole('button', { name: 'Continue anyway' })).not.toBeInTheDocument();
  });
});

describe('RevertToStockRow target confirmation', () => {
  it.each(['legacy only', 'legacy plus V2'])('sends the confirmed record for a %s manifest', async variant => {
    const releases = variant === 'legacy only'
      ? { channels: ['stable'], releases: [], upstreamSwitch: manifest.upstreamSwitch } : manifest;
    const expected = variant === 'legacy only' ? manifest.upstreamSwitch : target;
    server.use(http.get('https://raw.githubusercontent.com/LTimothy/nightstand/main/releases.json',
      () => HttpResponse.json(releases)));
    const bodies = serveInUse('*/update/switch-to-upstream', []);
    const { user } = await openDialog();
    if (variant === 'legacy only') {
      expect(screen.getByText(
        `Switch to upstream installs the pinned pre-3.0 commit ${manifest.upstreamSwitch!.commit}, not upstream 3.0.3.`
        + ' The full switch has not been tested on hardware. Support for switching to 3.0.x is being prepared.',
      )).toBeInTheDocument();
    } else {
      expect(screen.getByText(
        `Installs upstream free-sleep ${target.version}, commit ${target.commit}, validated ${target.date}.`,
      )).toBeInTheDocument();
    }
    expect(screen.getByRole('button', { name: 'Switch to upstream free-sleep' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Switch to upstream free-sleep' }));
    await waitFor(() => expect(bodies).toEqual([{ target: expected }]));
  });

  it.each(['legacy only', 'legacy plus V2'])('keeps conversion and recovery information for a %s manifest', async variant => {
    const releases = variant === 'legacy only'
      ? { channels: ['stable'], releases: [], upstreamSwitch: manifest.upstreamSwitch } : manifest;
    server.use(http.get('https://raw.githubusercontent.com/LTimothy/nightstand/main/releases.json',
      () => HttpResponse.json(releases)));
    await openDialog();

    const conversion = screen.getByText(/first enabled alarm per day, limits vibration to 180 seconds/);
    expect(conversion).toHaveTextContent('does not run one-time alarms. Level temperatures become Fahrenheit,');
    expect(conversion).toHaveTextContent(
      'base-control and set-temperature taps become alarm-dismiss actions. The original settings remain in the backup.',
    );
    expect(screen.getByText(/timestamped prerevert-to-stock directory/))
      .toHaveTextContent('/persistent/free-sleep-backups/');
    expect(screen.getByText(/timestamped prerevert-to-stock directory/))
      .toHaveTextContent('/persistent/free-sleep-database-backups/');
    expect(screen.getByText(/Returning to Nightstand requires the migration tool from a computer with SSH access/))
      .toHaveTextContent('Recovery may require SSH.');
    expect(screen.getByText(/Remote access through Tailscale ends at upstream's first update/))
      .toHaveTextContent('arrange local or SSH access first.');
  });

  it('sends no switch request when the V2 target is malformed', async () => {
    const bodies = serveInUse('*/update/switch-to-upstream', []);
    server.use(http.get('https://raw.githubusercontent.com/LTimothy/nightstand/main/releases.json', () =>
      HttpResponse.json({ ...manifest, upstreamSwitchV2: { ...target, commit: 'main' } })));
    await openDialog();
    const confirm = screen.getByRole('button', { name: 'Switch to upstream free-sleep' });
    expect(confirm).toBeDisabled();
    fireEvent.click(confirm);
    expect(bodies).toEqual([]);
    expect(screen.getByText(/No validated target/)).toBeInTheDocument();
  });

  it('shows the exact target, and refuses a manifest change while confirmation is open', async () => {
    const { queryClient } = await openDialog();
    expect(screen.getByText(new RegExp(target.commit))).toBeInTheDocument();
    queryClient.setQueryData(['useReleases'], {
      ...manifest, upstreamSwitchV2: { ...target, commit: 'b'.repeat(40) },
    });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Switch to upstream free-sleep' })).toBeDisabled());
    expect(screen.getByText(/target changed/)).toBeInTheDocument();
    expect(screen.getByText(new RegExp(target.commit))).toBeInTheDocument();
    expect(screen.queryByText(new RegExp('b'.repeat(40)))).not.toBeInTheDocument();
  });

  it('does not substitute a new target after a bed-use refusal', async () => {
    const bodies = serveInUse('*/update/switch-to-upstream', ['left-on']);
    const { user, queryClient } = await openDialog();
    await user.click(screen.getByRole('button', { name: 'Switch to upstream free-sleep' }));
    expect(await screen.findByText(SIDE_ON)).toBeInTheDocument();
    queryClient.setQueryData(['useReleases'], { ...manifest, upstreamSwitchV2: undefined });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Continue anyway' })).toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'Continue anyway' }));
    expect(bodies).toEqual([{ target }]);
  });
});

describe('RevertToStockRow with a failed manifest fetch', () => {
  beforeEach(() => {
    server.use(http.get('https://raw.githubusercontent.com/LTimothy/nightstand/main/releases.json',
      () => new HttpResponse(null, { status: 503 })));
  });

  it('allows the legacy switch without a target and uses the legacy wording', async () => {
    const bodies = serveInUse('*/update/switch-to-upstream', []);
    const { user } = await openDialog();
    expect(screen.getByText("Installs upstream free-sleep's newest code, which this switch has not been checked with."))
      .toBeInTheDocument();
    expect(screen.queryByText(/No validated target/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Switch to upstream free-sleep' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Switch to upstream free-sleep' }));
    await waitFor(() => expect(bodies).toEqual([{}]));
  });

  it('keeps the bed-use confirmation on an untargeted legacy switch', async () => {
    const bodies = serveInUse('*/update/switch-to-upstream', ['left-on']);
    const { user } = await openDialog();
    await user.click(screen.getByRole('button', { name: 'Switch to upstream free-sleep' }));
    expect(await screen.findByText(SIDE_ON)).toBeInTheDocument();
    expect(bodies).toEqual([{}]);
    await user.click(screen.getByRole('button', { name: 'Continue anyway' }));
    await waitFor(() => expect(bodies).toEqual([{}, { confirmInUse: true }]));
  });

  it('requires a new confirmation if the manifest loads while the legacy dialog is open', async () => {
    const bodies = serveInUse('*/update/switch-to-upstream', []);
    const { queryClient } = await openDialog();
    queryClient.setQueryData(['useReleases'], manifest);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Switch to upstream free-sleep' })).toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'Switch to upstream free-sleep' }));
    expect(bodies).toEqual([]);
  });
});
