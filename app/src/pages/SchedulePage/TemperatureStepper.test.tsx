import { useState } from 'react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import TemperatureStepper from './TemperatureStepper';
import { TemperatureFormat } from '@lib/temperatureConversions';

afterEach(() => vi.useRealTimers());

it.each<TemperatureFormat>(['fahrenheit', 'celsius', 'level'])('steps in %s using the same increment as the bed control', format => {
  const onChange = vi.fn();
  render(<TemperatureStepper value={ 79 } format={ format } label="Temperature" disabled={ false } onChange={ onChange }/>);
  expect(onChange).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Increase temperature' }));
  expect(onChange).toHaveBeenLastCalledWith(format === 'level' ? 83 : 80);
  fireEvent.click(screen.getByRole('button', { name: 'Decrease temperature' }));
  expect(onChange).toHaveBeenLastCalledWith(79);
});

it.each<TemperatureFormat>(['fahrenheit', 'celsius', 'level'])('clamps both bounds in %s using actual stored limits', format => {
  const onChange = vi.fn();
  const { rerender } = render(
    <TemperatureStepper value={ 109 } format={ format } label="Temperature" disabled={ false } onChange={ onChange }/>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Increase temperature' }));
  expect(onChange).toHaveBeenLastCalledWith(110);
  fireEvent.keyDown(screen.getByRole('spinbutton'), { key: 'ArrowUp' });
  expect(onChange).toHaveBeenCalledTimes(1);
  rerender(<TemperatureStepper value={ 56 } format={ format } label="Temperature" disabled={ false } onChange={ onChange }/>);
  fireEvent.click(screen.getByRole('button', { name: 'Decrease temperature' }));
  expect(onChange).toHaveBeenLastCalledWith(55);
  fireEvent.keyDown(screen.getByRole('spinbutton'), { key: 'ArrowDown' });
  expect(onChange).toHaveBeenCalledTimes(2);
});

it('preserves an existing off-grid temperature until edited', () => {
  const onChange = vi.fn();
  render(<TemperatureStepper value={ 80 } format="level" label="Temperature" disabled={ false } onChange={ onChange }/>);
  expect(screen.getByRole('spinbutton')).toHaveTextContent('-1');
  fireEvent.focus(screen.getByRole('spinbutton'));
  expect(onChange).not.toHaveBeenCalled();
  fireEvent.keyDown(screen.getByRole('spinbutton'), { key: 'ArrowUp' });
  expect(onChange).toHaveBeenLastCalledWith(83);
});

it('stops repeat writes when a held control reaches its limit', () => {
  vi.useFakeTimers();
  const onChange = vi.fn();
  render(<TemperatureStepper value={ 107 } format="level" label="Temperature" disabled={ false } onChange={ onChange }/>);
  fireEvent.pointerDown(screen.getByRole('button', { name: 'Increase temperature' }));
  act(() => vi.advanceTimersByTime(2000));
  expect(onChange).toHaveBeenCalledTimes(1);
  expect(onChange).toHaveBeenCalledWith(110);
  expect(vi.getTimerCount()).toBe(0);
});

it('cancels the previous hold before starting another press', () => {
  vi.useFakeTimers();
  const onChange = vi.fn();
  render(<TemperatureStepper value={ 83 } format="level" label="Temperature" disabled={ false } onChange={ onChange }/>);
  const increase = screen.getByRole('button', { name: 'Increase temperature' });
  fireEvent.pointerDown(increase);
  act(() => vi.advanceTimersByTime(100));
  fireEvent.pointerDown(increase);
  act(() => vi.advanceTimersByTime(450));
  fireEvent.pointerUp(increase);
  const writes = onChange.mock.calls.length;
  act(() => vi.advanceTimersByTime(2000));
  expect(writes).toBe(1);
  expect(onChange).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it('accepts the first keyboard activation of the opposite control after a hold reaches its limit', () => {
  vi.useFakeTimers();
  const onChange = vi.fn();
  render(<TemperatureStepper value={ 109 } format="fahrenheit" label="Temperature" disabled={ false } onChange={ onChange }/>);
  fireEvent.pointerDown(screen.getByRole('button', { name: 'Increase temperature' }));
  act(() => vi.advanceTimersByTime(450));
  expect(onChange).toHaveBeenLastCalledWith(110);
  fireEvent.click(screen.getByRole('button', { name: 'Decrease temperature' }), { detail: 0 });
  expect(onChange).toHaveBeenLastCalledWith(109);
});

it.each(['increase', 'decrease'])('repeats a held %s after clicking the opposite button', async direction => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  function ControlledStepper() {
    const [value, setValue] = useState(83);
    return <TemperatureStepper value={ value } format="fahrenheit" label="Temperature" disabled={ false } onChange={ setValue }/>;
  }
  render(<ControlledStepper/>);
  const increase = screen.getByRole('button', { name: 'Increase temperature' });
  const decrease = screen.getByRole('button', { name: 'Decrease temperature' });
  const held = direction === 'increase' ? increase : decrease;
  await user.click(direction === 'increase' ? decrease : increase);
  await user.pointer({ target: held, keys: '[MouseLeft>]' });
  expect(held).toHaveFocus();
  act(() => vi.advanceTimersByTime(760));
  expect(screen.getByRole('spinbutton')).toHaveAttribute('aria-valuenow', direction === 'increase' ? '85' : '81');
  await user.pointer({ keys: '[/MouseLeft]' });
  act(() => vi.advanceTimersByTime(1000));
  expect(screen.getByRole('spinbutton')).toHaveAttribute('aria-valuenow', direction === 'increase' ? '85' : '81');
});

it.each(Array.from({ length: 55 }, (_, index) => index + 55))('restores the exact stored %s F after a level increase and decrease', value => {
  const onChange = vi.fn();
  render(<TemperatureStepper value={ value } format="level" label="Temperature" disabled={ false } onChange={ onChange }/>);
  fireEvent.click(screen.getByRole('button', { name: 'Increase temperature' }));
  fireEvent.keyDown(screen.getByRole('spinbutton'), { key: 'ArrowDown' });
  expect(onChange).toHaveBeenLastCalledWith(value);
});

it.each<[TemperatureFormat, string]>([['celsius', '80px'], ['fahrenheit', '62px']])('%s uses min-width %s', (format, width) => {
  render(<TemperatureStepper value={ 79 } format={ format } label="Temperature" disabled={ false } onChange={ vi.fn() }/>);
  expect(screen.getByRole('spinbutton')).toHaveStyle({ minWidth: width });
});
