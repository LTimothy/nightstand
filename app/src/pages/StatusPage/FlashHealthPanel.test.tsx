import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@test/renderWithProviders';
import { server } from '@test/setup';
import FlashHealthPanel from './FlashHealthPanel';

const storage = (flash?: object) => ({
  mountPath: '/persistent/free-sleep-data/', totalBytes: 100, usedBytes: 10, availableBytes: 90, usedPercent: 10,
  breakdown: { logsBytes: 1, biometricsArchiveBytes: 0, databaseBytes: 1 },
  ...(flash ? { flash } : {}),
});

describe('FlashHealthPanel', () => {
  it('shows the chip wear estimate, spare blocks and daily writes', async () => {
    server.use(http.get('*/api/storage', () => HttpResponse.json(storage({
      lifeTimeA: 1, lifeTimeB: 2, preEolInfo: 1, writtenBytesPerDay: 3 * 1024 ** 3,
    }))));
    renderWithProviders(<FlashHealthPanel />);
    expect(await screen.findByText('Main storage: 10 to 20% of rated life used')).toBeInTheDocument();
    expect(screen.getByText('Fast area: 0 to 10% of rated life used')).toBeInTheDocument();
    expect(screen.getByText('Spare blocks: Normal')).toBeInTheDocument();
    expect(screen.getByText('Writes since the last restart: about 3.0 GB a day')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('warns when the chip is near the end of its life', async () => {
    server.use(http.get('*/api/storage', () => HttpResponse.json(storage({
      lifeTimeA: 3, lifeTimeB: 1, preEolInfo: 2, writtenBytesPerDay: null,
    }))));
    renderWithProviders(<FlashHealthPanel />);
    expect(await screen.findByRole('alert')).toHaveTextContent('near the end of its rated life');
    expect(screen.getByText('Spare blocks: Warning, 80% of spare blocks used')).toBeInTheDocument();
    expect(screen.queryByText(/Writes since/)).not.toBeInTheDocument();
  });

  it('shows nothing when the Pod gives no flash values', async () => {
    server.use(http.get('*/api/storage', () => HttpResponse.json(storage())));
    renderWithProviders(<FlashHealthPanel />);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(screen.queryByText('Flash memory')).not.toBeInTheDocument();
  });
});
