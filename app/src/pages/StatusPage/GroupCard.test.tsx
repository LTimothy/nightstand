import { expect, it } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderWithProviders } from '@test/renderWithProviders';
import { getServerStatus } from '../../mocks/mockData';
import { Status } from '@api/serverStatusSchema';
import GroupCard from './GroupCard';
import { CORE_KEYS, statusName } from './statusMeta';

it('counts every service state in its collapsed summary', () => {
  const data = { ...getServerStatus() };
  const states: Status[] = ['healthy', 'not_started', 'started', 'waiting_for_data', 'retrying', 'restarting', 'failed'];
  CORE_KEYS.forEach((key, index) => { data[key] = { ...data[key]!, status: states[index] ?? 'healthy' }; });
  renderWithProviders(<GroupCard label="Core services" keys={ CORE_KEYS } data={ data }/>);
  expect(screen.getByRole('button', {
    name: 'Core services · 5 healthy, 1 starting, 1 running, 1 waiting for data, 1 retrying, 1 restarting, 1 failed',
  })).toBeVisible();
});

it('puts each group under an h2 so the page outline does not skip a level', () => {
  renderWithProviders(<GroupCard label="Core services" keys={ CORE_KEYS } data={ getServerStatus() }/>);
  const heading = screen.getByRole('heading', { level: 2 });
  expect(heading).toContainElement(screen.getByRole('button', { name: /^Core services/ }));
});

const withStates = (states: Partial<Record<string, Status>>) => {
  const data = { ...getServerStatus() };
  for (const [key, status] of Object.entries(states)) {
    data[key as keyof typeof data] = { ...data[key as keyof typeof data]!, status: status! };
  }
  return data;
};
// Unlike renderWithProviders, a rerender keeps the providers.
const renderCard = (ui: ReactNode) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) =>
    <QueryClientProvider client={ client }><MemoryRouter>{ children }</MemoryRouter></QueryClientProvider>;
  return { ...render(ui, { wrapper }), user: userEvent.setup() };
};
const rowNames = () => {
  const region = screen.getByRole('region');
  return CORE_KEYS.map(key => statusName(key, getServerStatus()[key]))
    .map(name => ({ name, at: within(region).queryAllByText(name)[0] }))
    .filter(row => row.at)
    .sort((a, b) => (a.at!.compareDocumentPosition(b.at!) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))
    .map(row => row.name);
};

it('keeps a group the user collapsed closed when a row changes', async () => {
  const [first, second] = CORE_KEYS;
  const { user, rerender } = renderCard(
    <GroupCard label="Core services" keys={ CORE_KEYS } data={ withStates({ [first!]: 'failed' }) }/>);
  const group = screen.getByRole('button', { name: /^Core services/ });
  expect(group).toHaveAttribute('aria-expanded', 'true');
  await user.click(group);
  expect(group).toHaveAttribute('aria-expanded', 'false');
  rerender(<GroupCard label="Core services" keys={ CORE_KEYS } data={ withStates({ [first!]: 'failed', [second!]: 'failed' }) }/>);
  expect(group).toHaveAttribute('aria-expanded', 'false');
});

it('keeps the rows in their first order as their states change', () => {
  const [first, second] = CORE_KEYS;
  const { rerender } = renderCard(
    <GroupCard label="Core services" keys={ CORE_KEYS } data={ withStates({ [first!]: 'retrying', [second!]: 'started' }) }/>);
  const before = rowNames();
  expect(before.slice(0, 2)).toEqual([statusName(first!, getServerStatus()[first!]), statusName(second!, getServerStatus()[second!])]);
  rerender(<GroupCard label="Core services" keys={ CORE_KEYS } data={ withStates({ [first!]: 'started', [second!]: 'failed' }) }/>);
  expect(rowNames()).toEqual(before);
});

it('does not hide rows already on screen when another row starts needing attention', async () => {
  const [first] = CORE_KEYS;
  const { user, rerender } = renderCard(<GroupCard label="Core services" keys={ CORE_KEYS } data={ withStates({}) }/>);
  await user.click(screen.getByRole('button', { name: /^Core services/ }));
  const before = rowNames();
  expect(before).toHaveLength(CORE_KEYS.length);
  rerender(<GroupCard label="Core services" keys={ CORE_KEYS } data={ withStates({ [first!]: 'failed' }) }/>);
  expect(rowNames()).toEqual(before);
});

it('keeps healthy rows folded, and the choice to show them, after the last failure recovers', async () => {
  const [first] = CORE_KEYS;
  const { user, rerender } = renderCard(<GroupCard label="Core services" keys={ CORE_KEYS } data={ withStates({ [first!]: 'failed' }) }/>);
  expect(rowNames()).toEqual([statusName(first!, getServerStatus()[first!])]);
  rerender(<GroupCard label="Core services" keys={ CORE_KEYS } data={ withStates({}) }/>);
  expect(rowNames()).toEqual([statusName(first!, getServerStatus()[first!])]);
  const show = screen.getByRole('button', { name: `Show ${CORE_KEYS.length - 1} healthy` });
  await user.click(show);
  expect(rowNames()).toHaveLength(CORE_KEYS.length);
  await user.click(screen.getByRole('button', { name: 'Hide healthy services' }));
  expect(rowNames()).toHaveLength(1);
});
