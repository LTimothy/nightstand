import { afterEach, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import { renderWithProviders } from '@test/renderWithProviders';
import { server } from '@test/setup';
import { getSettings } from '../../../mocks/mockData';
import { createDemoRhythms, enableMockRhythms, getMockRhythms, resetMockRhythms } from '../../../mocks/rhythmsMock';
import FeaturesSection from './FeaturesSection';

afterEach(() => resetMockRhythms());

it('shows why the Pod refused to turn Rhythms on', async () => {
  const reason = 'Rhythms data is from a newer version of Nightstand. Update Nightstand to turn Rhythms on.';
  server.use(http.post('*/rhythms/enable', () => HttpResponse.json({ error: reason }, { status: 409 })));
  const { user } = renderWithProviders(<FeaturesSection/>);
  await user.click(await screen.findByRole('switch', { name: 'Rhythms' }));
  const confirm = await screen.findByRole('dialog', { name: 'Turn on Rhythms?' });
  await waitFor(() => expect(within(confirm).getByRole('button', { name: 'Turn on Rhythms' })).toBeEnabled());
  await user.click(within(confirm).getByRole('button', { name: 'Turn on Rhythms' }));
  expect(await within(confirm).findByText(`Could not turn on Rhythms. ${reason} Your weekly schedule is unchanged.`)).toBeInTheDocument();
  expect(getSettings().features.rhythms).toBe(false);
});

it('describes Rhythms and starts off', async () => {
  renderWithProviders(<FeaturesSection/>);
  expect(await screen.findByRole('switch', { name: 'Rhythms' })).not.toBeChecked();
  expect(screen.getByText('Rhythms (beta)')).toBeInTheDocument();
  expect(screen.getByText('Plan sleep by day and date, with an optional smart temperature curve. '
    + 'Your weekly schedule is kept.')).toBeInTheDocument();
});

it('turns Rhythms on and saves new names for the converted rhythms', async () => {
  const { user } = renderWithProviders(<FeaturesSection/>);
  await user.click(await screen.findByRole('switch', { name: 'Rhythms' }));
  const confirm = await screen.findByRole('dialog', { name: 'Turn on Rhythms?' });
  expect(confirm).toHaveTextContent('Your weekly schedule is kept as it is and comes back if you turn Rhythms off.');
  expect(await within(confirm).findByText(/^Rhythms copies your weekly schedule into named rhythms\./)).toBeInTheDocument();
  await user.click(within(confirm).getByRole('button', { name: 'Turn on Rhythms' }));
  const summary = await screen.findByRole('dialog', { name: 'Rhythms is on' });
  expect(within(summary).getAllByRole('heading', { level: 3 }).length).toBeGreaterThan(0);
  const [first] = within(summary).getAllByRole('textbox');
  await user.clear(first);
  await user.type(first, 'School night');
  await user.click(within(summary).getByRole('button', { name: 'Save and open Schedule' }));
  await waitFor(() => expect(Object.values(getMockRhythms()?.left.rhythms ?? {}).map(rhythm => rhythm.name)).toContain('School night'));
  expect(getSettings().features.rhythms).toBe(true);
});

it('says saved rhythms come back when Rhythms is turned on again', async () => {
  resetMockRhythms(createDemoRhythms(), false);
  const { user } = renderWithProviders(<FeaturesSection/>);
  await user.click(await screen.findByRole('switch', { name: 'Rhythms' }));
  const confirm = await screen.findByRole('dialog', { name: 'Turn on Rhythms?' });
  expect(await within(confirm).findByText(
    /^Your saved rhythms come back\. Changes to the weekly schedule since then are not added\./)).toBeInTheDocument();
  expect(confirm).not.toHaveTextContent('copies your weekly schedule');
  await user.click(within(confirm).getByRole('button', { name: 'Turn on Rhythms' }));
  expect(await screen.findByText('Rhythms is on. Your saved rhythms are back on the Schedule tab.')).toBeInTheDocument();
  expect(screen.queryByRole('dialog', { name: 'Rhythms is on' })).not.toBeInTheDocument();
});

it('previews the handoff and turns Rhythms off', async () => {
  enableMockRhythms();
  const { user } = renderWithProviders(<FeaturesSection/>);
  const toggle = await screen.findByRole('switch', { name: 'Rhythms' });
  await waitFor(() => expect(toggle).toBeChecked());
  await user.click(toggle);
  const dialog = await screen.findByRole('dialog', { name: 'Turn off Rhythms?' });
  expect(await within(dialog).findAllByText(/^(Today|Tonight|Tomorrow|\w{3}): weekly schedule, /)).not.toHaveLength(0);
  await user.click(within(dialog).getByRole('button', { name: 'Turn off Rhythms' }));
  expect(await screen.findByText(/^Rhythms is off\./)).toBeInTheDocument();
  expect(getSettings().features.rhythms).toBe(false);
});
