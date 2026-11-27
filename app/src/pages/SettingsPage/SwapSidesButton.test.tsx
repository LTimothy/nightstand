import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { renderWithProviders } from '@test/renderWithProviders';
import { server } from '@test/setup';
import { useAppStore } from '@state/appStore.tsx';
import SwapSidesButton from './SwapSidesButton';

beforeEach(() => useAppStore.getState().setSide('left'));

describe('Swap sides', () => {
  it('asks first, swaps once, and keeps this device on the same person', async () => {
    let posts = 0;
    server.use(http.post('*/settings/swap-sides', () => { posts += 1; return HttpResponse.json({}); }));
    const { user } = renderWithProviders(<SwapSidesButton/>);
    await user.click(screen.getByRole('button', { name: 'Swap sides' }));
    expect(screen.getByText('Swap sides?')).toBeInTheDocument();
    const copy = 'Names, schedules, rhythms, alarms, tap and button settings move to the other side. '
      + 'Past nights follow each person on the Sleep page. Sensor calibration stays with each side.';
    expect(screen.getByRole('dialog')).toHaveTextContent(copy);
    await user.click(screen.getByRole('button', { name: 'Swap' }));
    await screen.findByRole('button', { name: 'Swap sides' });
    expect(posts).toBe(1);
    expect(useAppStore.getState().side).toBe('right');
  });

  it('shows why the server refused, and changes nothing here', async () => {
    server.use(http.post('*/settings/swap-sides', () => HttpResponse.json({ error: 'Turn both sides off first.' }, { status: 409 })));
    const { user } = renderWithProviders(<SwapSidesButton/>);
    await user.click(screen.getByRole('button', { name: 'Swap sides' }));
    await user.click(screen.getByRole('button', { name: 'Swap' }));
    expect(await screen.findByText('Turn both sides off first.')).toBeInTheDocument();
    expect(useAppStore.getState().side).toBe('left');
  });

  it('closes on Cancel without swapping', async () => {
    let posts = 0;
    server.use(http.post('*/settings/swap-sides', () => { posts += 1; return HttpResponse.json({}); }));
    const { user } = renderWithProviders(<SwapSidesButton/>);
    await user.click(screen.getByRole('button', { name: 'Swap sides' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(posts).toBe(0);
  });
});
