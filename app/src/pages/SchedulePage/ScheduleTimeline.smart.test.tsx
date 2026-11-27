import { beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import moment from 'moment-timezone';
import { MAX_TEMPERATURES_PER_DAY } from '@api/schedulesSchema';
import ScheduleTimeline from './ScheduleTimeline';
import { useScheduleStore } from './scheduleStore';
import { useAppStore } from '@state/appStore';
import { getSchedules } from '../../mocks/mockData';

beforeEach(() => {
  useAppStore.setState({ side: 'right', isUpdating: false });
  useScheduleStore.setState(useScheduleStore.getInitialState(), true);
  const night = structuredClone(getSchedules().right.monday);
  night.power = { ...night.power, enabled: true, on: '21:00', off: '08:30' };
  night.temperatures = { '01:00': 70, '06:00': 80, '07:00': 90 };
  useScheduleStore.getState().editNight(night);
});

it('keeps every temperature control when temperatures are set by hand', () => {
  render(<ScheduleTimeline format="level"/>);
  expect(screen.getByRole('region', { name: 'Through the night' })).toBeInTheDocument();
  expect(screen.getByRole('spinbutton', { name: 'Bedtime temperature' })).toBeInTheDocument();
});

it('hides temperature rows and steppers when temperatures come from Smart Schedule', () => {
  render(<ScheduleTimeline format="level" hideTemperatures/>);
  expect(screen.queryByRole('region', { name: 'Through the night' })).not.toBeInTheDocument();
  expect(screen.queryByRole('spinbutton', { name: 'Bedtime temperature' })).not.toBeInTheDocument();
  expect(screen.queryByRole('spinbutton', { name: /^Temperature at/ })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Add warm-up' })).not.toBeInTheDocument();
  expect(screen.getByLabelText('Turn on at')).toHaveValue('21:00');
  const wake = screen.getByRole('region', { name: 'Wake up' });
  expect(within(wake).getByLabelText('Wake at')).toHaveValue('06:30');
});

it('asks for the bedtime and says when the bed starts warming under Smart Schedule', () => {
  render(<ScheduleTimeline format="level" hideTemperatures bedtimeNote="The bed starts warming at 8:30 PM."/>);
  // The section is labelled "Bedtime" too, so ask for the input.
  expect(screen.getByLabelText('Bedtime', { selector: 'input' })).toHaveValue('21:00');
  expect(screen.getByText('The bed starts warming at 8:30 PM.')).toBeInTheDocument();
  expect(screen.queryByLabelText('Turn on at')).not.toBeInTheDocument();
});

it('stops adding temperature changes at the daily limit on a rhythm night', () => {
  useScheduleStore.getState().updateSelectedTemperatures(Object.fromEntries(Array.from({ length: MAX_TEMPERATURES_PER_DAY }, (_, index) =>
    [moment('21:00', 'HH:mm').add((index + 1) * 10, 'minutes').format('HH:mm'), 80])));
  render(<ScheduleTimeline format="level"/>);
  expect(screen.getByRole('button', { name: 'Add temperature change' })).toBeDisabled();
  expect(screen.getByRole('status')).toHaveTextContent('A day holds at most 48 temperature changes. Remove one to add another.');
});

it('keeps Wake up and an enabled Wake at when the rhythm has no alarm', () => {
  useScheduleStore.getState().updateSelectedAlarm({ enabled: false });
  render(<ScheduleTimeline format="level" wake={ { time: '07:00', onChange: vi.fn() } }/>);
  const wake = screen.getByRole('region', { name: 'Wake up' });
  expect(within(wake).getByLabelText('Wake at')).toHaveValue('07:00');
  expect(within(wake).getByLabelText('Wake at')).toBeEnabled();
});

it('moves an alarm set at the old wake time and a following turn off with the wake time', () => {
  const onChange = vi.fn();
  useScheduleStore.getState().updateSelectedSchedule({ power: { off: '07:00' } });
  useScheduleStore.getState().selectAlarm(0);
  useScheduleStore.getState().updateSelectedAlarm({ enabled: true, time: '06:30' });
  render(<ScheduleTimeline format="level" wake={ { time: '06:30', onChange } }/>);
  fireEvent.change(screen.getByLabelText('Wake at'), { target: { value: '07:15' } });
  expect(onChange).toHaveBeenCalledWith('07:15');
  expect(useScheduleStore.getState().getEditedAlarms()[0].time).toBe('07:15');
  expect(useScheduleStore.getState().selectedSchedule?.power.off).toBe('07:45');
});

it('says when a very long night turns off', () => {
  useScheduleStore.getState().updateSelectedSchedule({ power: { on: '23:30', off: '23:00' } });
  render(<ScheduleTimeline format="level" wake={ { time: '07:00', onChange: vi.fn() } }/>);
  expect(screen.getByText(/Turns off the next day at 11:00 PM, 23 h 30 min after bedtime/)).toBeInTheDocument();
});
