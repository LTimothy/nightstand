import { expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import SmartResearchSheet from './SmartResearchSheet';

it('lists what each study tested, with links, and ends with the medical line', async () => {
  const onClose = vi.fn();
  const user = userEvent.setup();
  render(<SmartResearchSheet onClose={ onClose }/>);
  const dialog = screen.getByRole('dialog', { name: 'The research behind it' });
  expect(within(dialog).queryAllByRole('link')).toHaveLength(0);
  for (const button of within(dialog).getAllByRole('button', { name: /^Studies \(\d+\)$/ })) await user.click(button);
  const links = within(dialog).getAllByRole('link');
  expect(links).toHaveLength(6);
  for (const link of links) expect(link).toHaveAttribute('href', expect.stringMatching(/^https:\/\/doi\.org\/10\./));
  expect(dialog).toHaveTextContent(
    'Comfortable when you lie down, a little cooler once you have settled in bed, and warming gently before your wake time');
  expect(within(dialog).getByRole('heading', { name: 'Once you have settled in' })).toBeInTheDocument();
  expect(within(dialog).getByText(/In a shared bed it can mistake the other sleeper for you/)).toBeInTheDocument();
  expect(dialog).toHaveTextContent(
    'In one lab study, a mattress that drew heat away during sleep was linked with a little more deep sleep and '
    + "a slightly lower heart rate. The Pod's curve has not been tested for this.");
  expect(dialog.textContent).not.toMatch(/Once you are asleep|Based on sleep research/);
  expect(dialog).toHaveTextContent('off for a sleep that is mostly during the day or shorter than 3 hours');
  expect(dialog.textContent).not.toMatch(/minutes a night|beats a minute|about \d/);
  expect(dialog.textContent).not.toMatch(/insomnia|menopause|shift work|grogginess/i);
  const paragraphs = within(dialog).getAllByText(/./, { selector: 'p' });
  expect(paragraphs[paragraphs.length - 1]).toHaveTextContent(/not a medical recommendation/);
  await user.click(within(dialog).getByRole('button', { name: 'Close' }));
  expect(onClose).toHaveBeenCalled();
});
