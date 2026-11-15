import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { renderWithProviders } from '@test/renderWithProviders';
import { server } from '@test/setup';
import { useAppStore } from '@state/appStore';
import type { SideRhythms } from '@api/rhythmsSchema';
import { getDeviceStatus } from '../../../mocks/mockData';
import { createDemoRhythms } from '../../../mocks/rhythmsMock';
import { useScheduleStore } from '../scheduleStore';
import RhythmEditor from './RhythmEditor';

vi.mock('@mui/x-charts/LineChart', () => ({
  LineChart: () => <div data-testid="chart"/>,
  lineElementClasses: { root: 'line' },
  areaElementClasses: { root: 'area' },
}));

const NOW = new Date('2026-09-28T19:00:00Z');
const OVERLAP = 'The sleeps starting Sat, Oct 3 and Sun, Oct 4 would overlap. Change a time, or pick another rhythm for one of those dates.';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  useAppStore.setState({ side: 'left', isUpdating: false });
  useScheduleStore.setState(useScheduleStore.getInitialState(), true);
});
afterEach(() => vi.useRealTimers());

function renderEditor(rhythmId: string | null, saveError = '', sideData = createDemoRhythms(NOW).left, trackingOn = false) {
  const onSave = vi.fn<(next: SideRhythms) => Promise<boolean>>().mockResolvedValue(true);
  const onDelete = vi.fn<(id: string, replacement: string | null) => Promise<boolean>>().mockResolvedValue(true);
  const onClose = vi.fn();
  const view = renderWithProviders(<RhythmEditor
    sideData={ sideData }
    rhythmId={ rhythmId }
    sideLabel="Alex"
    format="level"
    timeZone="America/Los_Angeles"
    today="2026-09-28"
    trackingOn={ trackingOn }
    saveError={ saveError }
    onSave={ onSave }
    onDelete={ onDelete }
    onClose={ onClose }/>);
  return { ...view, onSave, onDelete, onClose };
}

it('loads the rhythm night into the night editor', async () => {
  renderEditor('weekend');
  expect(await screen.findByLabelText('Name')).toHaveValue('Weekend');
  expect(screen.getByLabelText('Turn on at')).toHaveValue('23:30');
  expect(screen.getByRole('button', { name: 'Set by hand', pressed: true })).toBeInTheDocument();
  expect(screen.getByRole('region', { name: 'Through the night' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
});

it('saves the renamed rhythm with its night and closes', async () => {
  const { user, onSave, onClose } = renderEditor('weekend');
  const name = await screen.findByLabelText('Name');
  await user.clear(name);
  await user.type(name, 'Late weekend');
  await user.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(onClose).toHaveBeenCalledWith('weekend'));
  const next = onSave.mock.calls[0][0];
  expect(next.rhythms.weekend.name).toBe('Late weekend');
  expect(next.rhythms.weekend.night.power.on).toBe('23:30');
  expect(next.rhythms.workday).toBeDefined();
});

it('switches to Smart Schedule, hides temperature rows and keeps them for later', async () => {
  const { user, onSave } = renderEditor('weekend');
  await user.click(await screen.findByRole('button', { name: 'Smart Schedule' }));
  expect(screen.getByRole('spinbutton', { name: 'Base temperature' })).toBeInTheDocument();
  expect(screen.getByLabelText('Bedtime', { selector: 'input' })).toHaveValue('23:30');
  expect(screen.getByText('When you usually get into bed')).toBeInTheDocument();
  expect(screen.getByText('The bed starts warming at 11:00 PM.')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Gentle' }));
  expect(screen.getByText('The bed starts warming at 11:10 PM.')).toBeInTheDocument();
  expect(screen.queryByRole('region', { name: 'Through the night' })).not.toBeInTheDocument();
  expect(screen.queryByRole('spinbutton', { name: 'Bedtime temperature' })).not.toBeInTheDocument();
  expect(screen.getByRole('figure', { name: /^Smart Schedule preview: / })).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(onSave).toHaveBeenCalled());
  const saved = onSave.mock.calls[0][0].rhythms.weekend;
  expect(saved.temperatureMode).toBe('smart');
  expect(saved.night.temperatures).toEqual({ '02:00': 77, '08:00': 85 });
});

it('links the research sheet as the research behind Smart Schedule', async () => {
  const { user } = renderEditor('weekend');
  await user.click(await screen.findByRole('button', { name: 'Smart Schedule' }));
  expect(screen.queryByRole('button', { name: 'Based on sleep research' })).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'The research behind it' }));
  expect(screen.getByRole('dialog', { name: 'The research behind it' })).toBeInTheDocument();
});

it('asks where the days go before deleting a rhythm that is in use', async () => {
  const { user, onDelete, onClose } = renderEditor('workday');
  await user.click(await screen.findByRole('button', { name: 'Delete rhythm' }));
  const dialog = await screen.findByRole('dialog', { name: 'Delete Workday?' });
  expect(dialog).toHaveTextContent('Sun to Thu will use:');
  expect(within(dialog).getByRole('combobox', { name: 'Use instead' })).toHaveTextContent('Weekend');
  await user.click(within(dialog).getByRole('button', { name: 'Move and delete' }));
  // The page closes the editor once the delete is saved.
  await waitFor(() => expect(onDelete).toHaveBeenCalledWith('workday', 'weekend'));
  expect(onClose).not.toHaveBeenCalled();
});

it('creates a new rhythm with a default night', async () => {
  const { user, onSave } = renderEditor(null);
  expect(await screen.findByLabelText('Name')).toHaveValue('Rhythm 3');
  expect(screen.getByRole('status', { name: 'Unsaved: Alex, Rhythm 3' })).toHaveTextContent('Unsaved: Alex, Rhythm 3');
  await user.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(onSave).toHaveBeenCalled());
  const created = onSave.mock.calls[0][0].rhythms['rhythm-3'];
  expect(created).toMatchObject({ id: 'rhythm-3', name: 'Rhythm 3', temperatureMode: 'smart', wake: '07:00' });
  expect(created.night.power.on).toBe('22:00');
});

it('confirms before leaving with edits and leaves at once without them', async () => {
  const first = renderEditor('weekend');
  await first.user.click(await screen.findByRole('button', { name: 'Rhythms' }));
  expect(first.onClose).toHaveBeenCalledTimes(1);
  first.unmount();
  const second = renderEditor('weekend');
  await second.user.type(await screen.findByLabelText('Name'), ' 2');
  await second.user.click(screen.getByRole('button', { name: 'Rhythms' }));
  const dialog = await screen.findByRole('dialog', { name: 'Discard changes to Weekend?' });
  expect(second.onClose).not.toHaveBeenCalled();
  await second.user.click(within(dialog).getByRole('button', { name: 'Discard' }));
  expect(second.onClose).toHaveBeenCalledTimes(1);
});

it('shows a save error and releases the night editor when it unmounts', async () => {
  const { unmount } = renderEditor('weekend', OVERLAP);
  expect(await screen.findByText(OVERLAP)).toBeInTheDocument();
  expect(useScheduleStore.getState().nightBaseline).toBeDefined();
  unmount();
  expect(useScheduleStore.getState().nightBaseline).toBeUndefined();
});

it('points at the name when it is empty', async () => {
  const { user } = renderEditor('weekend');
  await user.clear(await screen.findByLabelText('Name'));
  expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: 'Fix name' }));
  expect(screen.getByLabelText('Name')).toHaveFocus();
});

it('moves focus to the rhythm heading after Discard', async () => {
  const { user } = renderEditor('weekend');
  await user.type(await screen.findByLabelText('Name'), ' 2');
  await user.click(screen.getByRole('button', { name: 'Discard' }));
  expect(screen.getByRole('heading', { level: 2, name: 'Weekend' })).toHaveFocus();
  expect(screen.getByLabelText('Name')).toHaveValue('Weekend');
  expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
});

it('closes the delete dialog when deleting fails, so the error on the page shows', async () => {
  const { user, onDelete, onClose } = renderEditor('weekend');
  onDelete.mockResolvedValue(false);
  await user.click(await screen.findByRole('button', { name: 'Delete rhythm' }));
  const dialog = await screen.findByRole('dialog', { name: 'Delete Weekend?' });
  await user.click(within(dialog).getByRole('button', { name: 'Move and delete' }));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Delete Weekend?' })).not.toBeInTheDocument());
  expect(onClose).not.toHaveBeenCalled();
});

it('shows Builds up for a rise alarm only on a Pod 5', async () => {
  const pod5 = renderEditor('weekend');
  expect(await screen.findByRole('button', { name: /^Vibrate: Builds up,/ })).toBeInTheDocument();
  pod5.unmount();
  server.use(http.get('*/deviceStatus', () => HttpResponse.json({ ...getDeviceStatus(), hubVersion: 'Pod 4' })));
  renderEditor('weekend');
  expect(await screen.findByRole('button', { name: /^Vibrate: Double pulse,/ })).toBeInTheDocument();
  expect(screen.queryByText(/Builds up/)).not.toBeInTheDocument();
});

it('names the wake time, not an alarm, when it falls after a set turn-off', async () => {
  const { user } = renderEditor('weekend');
  await user.click(await screen.findByRole('switch', { name: 'Enable alarm 1' }));
  fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Turn off' }));
  fireEvent.click(screen.getByRole('option', { name: 'At a set time' }));
  fireEvent.change(screen.getByLabelText('Wake at'), { target: { value: '09:30' } });
  expect(screen.getByText('Turn off is at 8:45 AM, before this wake time. Move Turn off later or pick an earlier time.'))
    .toBeInTheDocument();
  expect(screen.queryByText(/before this alarm/)).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: 'Fix 1 time' }));
  expect(screen.getByLabelText('Wake at')).toHaveFocus();
});

it('locks Warm start for a sleep shorter than 3 hours', async () => {
  const { user } = renderEditor('weekend');
  await user.click(await screen.findByRole('button', { name: 'Smart Schedule' }));
  expect(screen.getByRole('switch', { name: 'Warm start' })).toBeEnabled();
  fireEvent.change(screen.getByLabelText('Wake at'), { target: { value: '01:30' } });
  expect(screen.getByRole('switch', { name: 'Warm start' })).toBeDisabled();
  expect(screen.getByRole('switch', { name: 'Warm start' })).not.toBeChecked();
  expect(screen.getByRole('note')).toHaveTextContent('This sleep is shorter than 3 hours, so there is no warm start.');
});

it('reads exactly 3 hours as long enough for a warm start', async () => {
  const { user } = renderEditor('weekend');
  await user.click(await screen.findByRole('button', { name: 'Smart Schedule' }));
  fireEvent.change(screen.getByLabelText('Wake at'), { target: { value: '02:30' } });
  expect(screen.getByRole('switch', { name: 'Warm start' })).toBeEnabled();
  expect(screen.queryByRole('note')).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Wake at'), { target: { value: '02:29' } });
  expect(screen.getByRole('switch', { name: 'Warm start' })).toBeDisabled();
});

it('does not save a new rhythm once the side has 12', async () => {
  const side = createDemoRhythms(NOW).left;
  for (let index = 1; index <= 10; index++) {
    side.rhythms[`extra-${index}`] = { ...side.rhythms.workday, id: `extra-${index}`, name: `Extra ${index}` };
  }
  const { onSave } = renderEditor(null, '', side);
  expect(await screen.findByText('This side already has 12 rhythms, the most it can have. Delete one to add another.')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  expect(onSave).not.toHaveBeenCalled();
});

it('saves "When I get up" on a Smart Schedule rhythm with its usual turn off', async () => {
  const { user, onSave, onClose } = renderEditor('workday', '', createDemoRhythms(NOW).left, true);
  fireEvent.mouseDown(await screen.findByLabelText('Turn off'));
  fireEvent.click(screen.getByRole('option', { name: 'When I get up' }));
  expect(screen.getByLabelText('Usually off at')).toHaveValue('06:45');
  await user.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(onClose).toHaveBeenCalledWith('workday'));
  const saved = onSave.mock.calls[0][0].rhythms.workday;
  expect(saved.smart.offWhenUp).toBe(true);
  expect(saved.offWhenUp).toBe(true);
  expect(saved.night.power.off).toBe('06:45');
});

it('keeps "When I get up" when the rhythm switches to Set by hand', async () => {
  const sideData = createDemoRhythms(NOW).left;
  sideData.rhythms.workday.smart = { ...sideData.rhythms.workday.smart, offWhenUp: true };
  const { user, onSave, onClose } = renderEditor('workday', '', sideData, true);
  await user.click(await screen.findByRole('button', { name: 'Set by hand' }));
  await user.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(onClose).toHaveBeenCalledWith('workday'));
  const saved = onSave.mock.calls[0][0].rhythms.workday;
  expect(saved.temperatureMode).toBe('manual');
  expect(saved.offWhenUp).toBe(true);
  expect(saved.smart.offWhenUp).toBe(true);
});

it('offers "When I get up" on a rhythm set by hand', async () => {
  const { user, onSave, onClose } = renderEditor('weekend', '', createDemoRhythms(NOW).left, true);
  const before = createDemoRhythms(NOW).left.rhythms.weekend.night.power.off;
  fireEvent.mouseDown(await screen.findByLabelText('Turn off'));
  fireEvent.click(screen.getByRole('option', { name: 'When I get up' }));
  await user.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(onClose).toHaveBeenCalledWith('weekend'));
  const saved = onSave.mock.calls[0][0].rhythms.weekend;
  expect(saved.temperatureMode).toBe('manual');
  expect(saved.offWhenUp).toBe(true);
  expect(saved.smart.offWhenUp).toBe(true);
  expect(saved.night.power.off).toBe(before);
});

it('shows a stray Smart Schedule flag on a rhythm set by hand as off', async () => {
  const sideData = createDemoRhythms(NOW).left;
  sideData.rhythms.weekend.smart = { ...sideData.rhythms.weekend.smart, offWhenUp: true };
  renderEditor('weekend', '', sideData, true);
  expect(await screen.findByLabelText('Turn off')).not.toHaveTextContent('When I get up');
  expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
});

it('drops "When I get up" from a rhythm switched back to a time', async () => {
  const sideData = createDemoRhythms(NOW).left;
  sideData.rhythms.workday.smart = { ...sideData.rhythms.workday.smart, offWhenUp: true };
  const { user, onSave, onClose } = renderEditor('workday', '', sideData, true);
  expect(await screen.findByLabelText('Turn off')).toHaveTextContent('When I get up');
  fireEvent.mouseDown(screen.getByLabelText('Turn off'));
  fireEvent.click(screen.getByRole('option', { name: '30 min after' }));
  await user.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(onClose).toHaveBeenCalledWith('workday'));
  const saved = onSave.mock.calls[0][0].rhythms.workday;
  expect('offWhenUp' in saved.smart).toBe(false);
  expect('offWhenUp' in saved).toBe(false);
  expect(saved.night.power.off).toBe('07:00');
});
