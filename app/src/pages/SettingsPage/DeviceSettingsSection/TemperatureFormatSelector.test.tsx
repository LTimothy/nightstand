import { expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@test/renderWithProviders';
import { getSettings } from '../../../mocks/mockData';
import TemperatureFormatSelector from './TemperatureFormatSelector';

it('offers Level even when the retired Level switch is stored off', () => {
  const settings = getSettings();
  settings.features.levelTemps = false;
  renderWithProviders(<TemperatureFormatSelector settings={ settings } updateSettings={ () => {} } />);
  expect(screen.getByRole('button', { name: 'Level' })).toBeInTheDocument();
});
