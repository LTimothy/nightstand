import { describe, expect, it, beforeEach, vi } from 'vitest';
import { waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { renderWithProviders } from '@test/renderWithProviders';
import { server } from '@test/setup';
import { getSettings } from '../mocks/mockData';
import { swapFlipsSide, useAppStore } from './appStore';

describe('swapFlipsSide', () => {
  it('flips on an odd change only', () => {
    expect(swapFlipsSide(2, 3)).toBe(true);
    expect(swapFlipsSide(1, 3)).toBe(false);
    expect(swapFlipsSide(4, 1)).toBe(true);
  });
});

describe('a phone that did not press Swap', () => {
  beforeEach(() => {
    useAppStore.getState().setSide('left');
    localStorage.setItem('sideSwapsSeen', '2');
  });

  it('moves to the other side when it sees one more swap', async () => {
    server.use(http.get('*/settings/swap-count', () => HttpResponse.json({ count: 3 })));
    renderWithProviders(<div/>);
    await waitFor(() => expect(localStorage.getItem('sideSwapsSeen')).toBe('3'));
    expect(useAppStore.getState().side).toBe('right');
  });

  it('counts a phone that never saw a count as having seen none', async () => {
    localStorage.removeItem('sideSwapsSeen');
    server.use(http.get('*/settings/swap-count', () => HttpResponse.json({ count: 1 })));
    renderWithProviders(<div/>);
    await waitFor(() => expect(localStorage.getItem('sideSwapsSeen')).toBe('1'));
    expect(useAppStore.getState().side).toBe('right');
  });

  it("reloads its data when it flips, so the other person's name and schedule are not shown from cache", async () => {
    let settingsReads = 0;
    server.use(
      http.get('*/settings/swap-count', () => HttpResponse.json({ count: 3 })),
      http.get('*/api/settings', () => { settingsReads += 1; return HttpResponse.json(getSettings()); }),
    );
    renderWithProviders(<div/>);
    await waitFor(() => expect(settingsReads).toBeGreaterThanOrEqual(2));
  });

  it('follows a side change saved by another tab in this browser', async () => {
    server.use(http.get('*/settings/swap-count', () => HttpResponse.json({ count: 2 })));
    renderWithProviders(<div/>);
    window.dispatchEvent(new StorageEvent('storage', { key: 'side', newValue: 'right' }));
    await waitFor(() => expect(useAppStore.getState().side).toBe('right'));
  });

  it('stays put after an even number of swaps', async () => {
    server.use(http.get('*/settings/swap-count', () => HttpResponse.json({ count: 4 })));
    renderWithProviders(<div/>);
    await waitFor(() => expect(localStorage.getItem('sideSwapsSeen')).toBe('4'));
    expect(useAppStore.getState().side).toBe('left');
  });

  it('does nothing when the server does not know the count', async () => {
    server.use(http.get('*/settings/swap-count', () => new HttpResponse(null, { status: 404 })));
    renderWithProviders(<div/>);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(useAppStore.getState().side).toBe('left');
    expect(localStorage.getItem('sideSwapsSeen')).toBe('2');
  });

  it('stays put when this browser will not save the count, so it cannot flip on every poll', async () => {
    let reads = 0;
    server.use(http.get('*/settings/swap-count', () => { reads += 1; return HttpResponse.json({ count: 3 }); }));
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });
    renderWithProviders(<div/>);
    await waitFor(() => expect(reads).toBeGreaterThan(0));
    await new Promise(resolve => setTimeout(resolve, 50));
    setItem.mockRestore();
    expect(useAppStore.getState().side).toBe('left');
  });
});
