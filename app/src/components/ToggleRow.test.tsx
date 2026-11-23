import { expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import ToggleRow from './ToggleRow';

it('puts the description in the label column and children in the indented box', () => {
  render(<ToggleRow
    label="Rhythms"
    checked={ false }
    onChange={ () => {} }
    description="Plan by day">
    <span>Child row</span>
  </ToggleRow>);
  const label = screen.getByText('Rhythms');
  expect(label.parentElement).toContainElement(screen.getByText('Plan by day'));
  expect(label.parentElement).not.toContainElement(screen.getByRole('switch'));
  expect(label.parentElement?.parentElement?.nextElementSibling).toContainElement(screen.getByText('Child row'));
});

it('names the switch from the label unless an aria-label is given', () => {
  const { rerender } = render(<ToggleRow label="Away mode" checked={ false } onChange={ () => {} }/>);
  expect(screen.getByRole('switch', { name: 'Away mode' })).toBeInTheDocument();
  rerender(<ToggleRow label="Away mode" ariaLabel="Left away mode" checked={ false } onChange={ () => {} }/>);
  expect(screen.getByRole('switch', { name: 'Left away mode' })).toBeInTheDocument();
});

it('passes the new checked state to onChange as a boolean', () => {
  const onChange = vi.fn();
  render(<ToggleRow label="Away mode" checked={ false } onChange={ onChange }/>);
  fireEvent.click(screen.getByRole('switch'));
  expect(onChange).toHaveBeenCalledWith(true);
});
