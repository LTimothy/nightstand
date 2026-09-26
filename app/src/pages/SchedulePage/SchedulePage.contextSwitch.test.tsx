import { describe, it, expect, beforeEach } from 'vitest';
import _ from 'lodash';
import { screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { renderWithProviders } from '@test/renderWithProviders';
import { server } from '@test/setup';
import { useAppStore } from '@state/appStore.tsx';
import { useScheduleStore } from './scheduleStore';
import SchedulePage from './SchedulePage';

const loaded = async () => {
  await waitFor(() => expect(useScheduleStore.getState().originalSchedules).toBeTruthy());
};

// These render tests drive the module-singleton Zustand stores through the real
// page. Reset the singletons (and the persisted side) up front so the suite is
// deterministic regardless of what ran before it in the same worker.
beforeEach(() => {
  localStorage.removeItem('side');
  useAppStore.setState({ side: 'left', isUpdating: false });
  useScheduleStore.setState({ originalSchedules: undefined, changesPresent: false });
});

// ---------------------------------------------------------------------------
// Hypothesis 1 + 5: switching side with unsaved edits must discard them and
// load the OTHER side's saved data - never leak the edit to the wrong side.
// ---------------------------------------------------------------------------
describe('side switch with unsaved edits (full page)', () => {
  it('discards the edit and loads the target side without leaking', async () => {
    const { user } = renderWithProviders(<SchedulePage />, { initialRoute: '/schedules' });
    await loaded();

    const day = useScheduleStore.getState().selectedDay;
    const orig = _.cloneDeep(useScheduleStore.getState().originalSchedules) as any;

    // Make a pending, unsaved alarm edit on the left side.
    useScheduleStore.getState().updateSelectedAlarm({ time: '03:33' });
    expect(useScheduleStore.getState().changesPresent).toBe(true);

    // Switch to the right side. The buttons are named by the settings query,
    // which answers independently of the schedules one loaded() waited for, so
    // look them up by waiting rather than assuming settings has already landed.
    await user.click(await screen.findByRole('button', { name: /Right side/ }));
    await waitFor(() => expect(useAppStore.getState().side).toBe('right'));
    await waitFor(() =>
      expect(useScheduleStore.getState().selectedSchedule?.alarm.time).toBe(orig.right[day].alarm.time),
    );

    const afterRight = useScheduleStore.getState();
    expect(afterRight.selectedSchedule).toEqual(orig.right[day]); // no leak of the '03:33' edit
    expect(afterRight.changesPresent).toBe(false);

    // Switch back to the left side: the earlier edit must be gone.
    await user.click(await screen.findByRole('button', { name: /Left side/ }));
    await waitFor(() => expect(useAppStore.getState().side).toBe('left'));
    await waitFor(() =>
      expect(useScheduleStore.getState().selectedSchedule?.alarm.time).toBe(orig.left[day].alarm.time),
    );
    expect(useScheduleStore.getState().selectedSchedule?.alarm.time).not.toBe('03:33');
  });
});

// ---------------------------------------------------------------------------
// Hypothesis 3: Apply-to-other-days must write the current edited schedule to
// exactly (current day + checked days) - no extra days, correct days.
// ---------------------------------------------------------------------------
describe('Apply to other days save targeting (full page)', () => {
  it('posts the current schedule to exactly the current day plus the checked day', async () => {
    let posted: any;
    server.use(
      http.post('*/schedules', async ({ request }) => {
        posted = await request.json();
        return HttpResponse.json({});
      }),
    );

    const { user } = renderWithProviders(<SchedulePage />, { initialRoute: '/schedules' });
    await loaded();

    const currentDay = useScheduleStore.getState().selectedDay;
    const allDays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const targetDay = allDays.find(d => d !== currentDay)!;
    const targetLabel = targetDay[0].toUpperCase() + targetDay.slice(1);

    // Expand the accordion and check the target day.
    await user.click(screen.getByText('Apply settings to other days'));
    const checkbox = await screen.findByRole('checkbox', { name: targetLabel });
    await user.click(checkbox);

    const save = await screen.findByRole('button', { name: 'Save' });
    await user.click(save);

    await waitFor(() => expect(posted).toBeTruthy());

    // Exactly the current day and the one checked day, nothing else.
    expect(Object.keys(posted)).toEqual(['left']);
    expect(Object.keys(posted.left).sort()).toEqual([currentDay, targetDay].sort());

    await waitFor(() => expect(useAppStore.getState().isUpdating).toBe(false), { timeout: 3000 });
  });
});
