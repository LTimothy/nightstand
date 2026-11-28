import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { renderWithProviders } from '@test/renderWithProviders';
import { server } from '@test/setup';
import { useAppStore } from '@state/appStore.tsx';
import { getSettings } from '../../mocks/mockData';
import SwapSidesButton from './SwapSidesButton';

beforeEach(() => {
  useAppStore.getState().setSide('left');
  localStorage.removeItem('sideSwapsSeen');
});

describe('Swap sides', () => {
  it('asks first, swaps once, and keeps this device on the same person', async () => {
    let posts = 0;
    server.use(
      http.post('*/settings/swap-sides', () => { posts += 1; return HttpResponse.json({}); }),
      http.get('*/settings/swap-count', () => HttpResponse.json({ count: posts })),
    );
    const { user } = renderWithProviders(<SwapSidesButton/>);
    await waitFor(() => expect(localStorage.getItem('sideSwapsSeen')).toBe('0'));
    await user.click(screen.getByRole('button', { name: /Swap sides/ }));
    expect(screen.getByText('Swap sides?')).toBeInTheDocument();
    const copy = 'Names, schedules, rhythms, alarms, tap and button settings move to the other side. '
      + 'Past nights follow each person on the Sleep page. Sensor calibration stays with each side.';
    expect(screen.getByRole('dialog')).toHaveTextContent(copy);
    const second = "Swap before getting into bed, so tonight's night is filed under the right name. "
      + 'If a schedule is running tonight, each side turns back on with its new settings.';
    expect(screen.getByRole('dialog')).toHaveTextContent(second);
    const { left, right } = getSettings();
    await screen.findByText(left.name);
    expect(screen.getByRole('dialog')).toHaveTextContent(`${left.name} moves to the right side.`);
    expect(screen.getByRole('dialog')).toHaveTextContent(`${right.name} moves to the left side.`);
    await user.click(screen.getByRole('button', { name: 'Swap' }));
    await screen.findByRole('button', { name: /Swap sides/ });
    expect(posts).toBe(1);
    await waitFor(() => expect(useAppStore.getState().side).toBe('right'));
  });

  it('shows why the server refused, and changes nothing here', async () => {
    server.use(http.post('*/settings/swap-sides', () => HttpResponse.json({ error: 'Turn both sides off first.' }, { status: 409 })));
    const { user } = renderWithProviders(<SwapSidesButton/>);
    await user.click(screen.getByRole('button', { name: /Swap sides/ }));
    await user.click(screen.getByRole('button', { name: 'Swap' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Turn both sides off first.');
    expect(screen.getByRole('alert').className).toMatch(/Warning/);
    expect(useAppStore.getState().side).toBe('left');
  });

  it('asks for a check after any other failure', async () => {
    server.use(http.post('*/settings/swap-sides', () => HttpResponse.json({}, { status: 500 })));
    const { user } = renderWithProviders(<SwapSidesButton/>);
    await user.click(screen.getByRole('button', { name: /Swap sides/ }));
    await user.click(screen.getByRole('button', { name: 'Swap' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not confirm the swap. Check the names above before trying again.');
    expect(screen.getByRole('alert').className).toMatch(/Error/);
  });

  it('describes a default-named side by its settings', async () => {
    server.use(http.get('*/settings', () => HttpResponse.json({ ...getSettings(), left: { ...getSettings().left, name: 'Left' } })));
    const { user } = renderWithProviders(<SwapSidesButton/>);
    await user.click(screen.getByRole('button', { name: /Swap sides/ }));
    await waitFor(() => expect(screen.getByRole('dialog')).toHaveTextContent("The left side's settings move to the right side."));
  });

  it('closes on Cancel without swapping', async () => {
    let posts = 0;
    server.use(http.post('*/settings/swap-sides', () => { posts += 1; return HttpResponse.json({}); }));
    const { user } = renderWithProviders(<SwapSidesButton/>);
    await user.click(screen.getByRole('button', { name: /Swap sides/ }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(posts).toBe(0);
  });
});
