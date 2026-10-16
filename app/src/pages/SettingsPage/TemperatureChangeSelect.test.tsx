import { expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@test/renderWithProviders';
import TemperatureChangeSelect from './TemperatureChangeSelect';

it('lists whole degrees in the user\'s format and sends Fahrenheit', async () => {
  const onChange = vi.fn();
  renderWithProviders(<TemperatureChangeSelect
    label="Step per click"
    valueF={ 2 }
    format="celsius"
    disabled={ false }
    onChange={ onChange }/>);
  const select = screen.getByRole('combobox', { name: 'Step per click' });
  expect(select).toHaveTextContent('1.1°C');
  await userEvent.click(select);
  expect(screen.getAllByRole('option')).toHaveLength(10);
  await userEvent.click(screen.getByRole('option', { name: '2.8°C' }));
  expect(onChange).toHaveBeenCalledWith(5);
});

it('offers whole levels only in level mode and sends Fahrenheit', async () => {
  const onChange = vi.fn();
  renderWithProviders(<TemperatureChangeSelect
    label="Step"
    valueF={ 2.75 }
    format="level"
    disabled={ false }
    onChange={ onChange }/>);
  const select = screen.getByRole('combobox', { name: 'Step' });
  expect(select).toHaveTextContent('1 level');
  await userEvent.click(select);
  expect(screen.getAllByRole('option').map(option => option.textContent)).toEqual(['1 level', '2 levels', '3 levels']);
  await userEvent.click(screen.getByRole('option', { name: '3 levels' }));
  expect(onChange).toHaveBeenCalledWith(8.25);
});

it('keeps a stored step that is not a whole degree or level', async () => {
  renderWithProviders(<TemperatureChangeSelect
    label="Step"
    valueF={ 2.5 }
    format="fahrenheit"
    disabled={ false }
    onChange={ vi.fn() }/>);
  expect(screen.getByRole('combobox', { name: 'Step' })).toHaveTextContent('2.5°F');
});

it('lists a stored Fahrenheit step as its nearest level in level mode', async () => {
  renderWithProviders(<TemperatureChangeSelect
    label="Step"
    valueF={ 2 }
    format="level"
    disabled={ false }
    onChange={ vi.fn() }/>);
  const select = screen.getByRole('combobox', { name: 'Step' });
  expect(select).toHaveTextContent('0.7 levels');
  await userEvent.click(select);
  expect(screen.getAllByRole('option')).toHaveLength(4);
});
