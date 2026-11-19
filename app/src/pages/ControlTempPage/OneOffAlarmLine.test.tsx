import { beforeEach, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import OneOffAlarmLine from './OneOffAlarmLine';

const fixture = vi.hoisted(() => ({ text: null as string | null }));
vi.mock('@state/appStore.tsx', () => ({ useAppStore: () => ({ side: 'left' }) }));
vi.mock('@api/settings.ts', () => ({ useSettings: () => ({ data: { timeZone: 'UTC' } }) }));
vi.mock('../SchedulePage/oneOffAlarm', () => ({ pendingOneOffText: () => fixture.text }));

beforeEach(() => { fixture.text = null; });

it('shows the pending alarm with an Edit link to the schedules page', () => {
  fixture.text = 'tomorrow at 7:00 AM';
  render(<MemoryRouter><OneOffAlarmLine/></MemoryRouter>);
  expect(screen.getByText('One-time alarm tomorrow at 7:00 AM')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Edit' })).toHaveAttribute('href', '/schedules');
});

it('renders nothing when none is pending', () => {
  const { container } = render(<MemoryRouter><OneOffAlarmLine/></MemoryRouter>);
  expect(container).toBeEmptyDOMElement();
});
