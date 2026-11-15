import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithProviders } from '@test/renderWithProviders';
import { useAppStore } from '@state/appStore';
import { RhythmSchema, SideRhythmsSchema, type SideRhythms } from '@api/rhythmsSchema';
import { fuzzCase, FUZZ_EDITOR_RUNS, FUZZ_SEED, clock, random, sleepInput, SLEEP_CASES } from '../../../../../server/src/testing/smartFuzz';
import { useScheduleStore } from '../scheduleStore';
import RhythmEditor from './RhythmEditor';

vi.mock('@mui/x-charts/LineChart', () => ({
  LineChart: () => <div/>, lineElementClasses: { root: 'line' }, areaElementClasses: { root: 'area' },
}));
afterEach(cleanup);

it(`fuzzes editor conversion, toggles and reload (${FUZZ_EDITOR_RUNS} runs, seed ${FUZZ_SEED})`, () => {
  const next = random();
  for (let run = 0; run < FUZZ_EDITOR_RUNS; run++) {
    const { rhythm: original, date, timeZone } = sleepInput(next, SLEEP_CASES[run]);
    const plan: SideRhythms = { rhythms: { generated: original }, changes: [],
      week: { sunday: null, monday: null, tuesday: null, wednesday: null, thursday: null, friday: null, saturday: null } };
    useAppStore.setState({ side: 'right', isUpdating: false });
    useScheduleStore.setState(useScheduleStore.getInitialState(), true);
    const saved: SideRhythms[] = [];
    const render = (sideData: SideRhythms) => renderWithProviders(<RhythmEditor
      sideData={ sideData }
      rhythmId="generated"
      sideLabel="Right side"
      format="level"
      timeZone={ timeZone }
      today={ date }
      trackingOn
      saveError=""
      onSave={ async data => { saved.push(structuredClone(data)); return true; } }
      onDelete={ async () => true }
      onClose={ () => undefined }/>);
    const actions: string[] = [];
    const verify = () => {
      actions.push('save');
      const button = screen.queryByRole('button', { name: 'Save' });
      if (button) {
        expect(button).toBeEnabled();
        fireEvent.click(button);
        const draft = saved[saved.length - 1].rhythms.generated;
        expect(RhythmSchema.parse(JSON.parse(JSON.stringify(draft)))).toEqual(draft);
        expect(draft.night.temperatures).toEqual(original.night.temperatures);
      }
    };
    fuzzCase({ original, date, timeZone, actions }, run, () => {
      const view = render(plan);
      fireEvent.click(screen.getByRole('button', { name: 'Smart Schedule' }));
      verify();
      for (let step = 0; step < 10; step++) {
        const action = next(0, 6);
        const label = ['Warm start', 'Warm-up before wake', 'Skip the warm-up if I get up early', 'Gentle', 'Standard',
          'Increase base temperature', 'Decrease base temperature'][action];
        actions.push(label);
        const control = screen.getByRole(action < 3 ? 'switch' : 'button', { name: label });
        const baseBefore = saved[saved.length - 1].rhythms.generated.smart.baseLevel;
        const enabled = !(control as HTMLButtonElement).disabled;
        const checked = (control as HTMLInputElement).checked;
        if (enabled) fireEvent.click(control);
        verify();
        if (enabled && action < 3) {
          const key = (['warmStart', 'warmUp', 'upEarly'] as const)[action];
          expect(saved[saved.length - 1].rhythms.generated.smart[key]).toBe(!checked);
        }
        if (enabled && action >= 5) {
          expect(saved[saved.length - 1].rhythms.generated.smart.baseLevel).toBe(baseBefore + (action === 5 ? 1 : -1));
        }
        if (action === 3 || action === 4) {
          expect(saved[saved.length - 1].rhythms.generated.smart.intensity).toBe(action === 3 ? 'gentle' : 'standard');
        }
      }
      const turnOff = screen.getByRole('combobox', { name: 'Turn off' });
      for (const label of ['At wake time', '30 min after', 'At a set time', 'When I get up']) {
        actions.push(label);
        fireEvent.mouseDown(turnOff);
        fireEvent.click(screen.getByRole('option', { name: label }));
        const wakeMinutes = Number(original.wake.slice(0, 2)) * 60 + Number(original.wake.slice(3));
        const customOff = clock(wakeMinutes + 45);
        if (label === 'At a set time') {
          actions.push(`set off ${customOff}`);
          fireEvent.change(screen.getByLabelText('Turn off at'), { target: { value: customOff } });
        }
        verify();
        const draft = saved[saved.length - 1].rhythms.generated;
        expect(draft.smart.offWhenUp).toBe(label === 'When I get up' ? true : undefined);
        expect(draft.offWhenUp).toBe(label === 'When I get up' ? true : undefined);
        expect(draft.night.power.off).toBe(label === 'At wake time' ? original.wake
          : label === '30 min after' ? clock(wakeMinutes + 30) : customOff);
        if (label === 'At a set time') {
          const onMinutes = Number(original.night.power.on.slice(0, 2)) * 60 + Number(original.night.power.on.slice(3));
          const earlierOff = clock(onMinutes + 1);
          actions.push(`invalid off ${earlierOff}`);
          fireEvent.change(screen.getByLabelText('Wake at'), { target: { value: clock(onMinutes + 2) } });
          fireEvent.change(screen.getByLabelText('Turn off at'), { target: { value: earlierOff } });
          expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
          expect(screen.getByText(/before this wake time/)).toBeInTheDocument();
          const count = saved.length;
          fireEvent.click(screen.getByRole('button', { name: 'Save' }));
          expect(saved).toHaveLength(count);
          fireEvent.change(screen.getByLabelText('Wake at'), { target: { value: original.wake } });
          fireEvent.change(screen.getByLabelText('Turn off at'), { target: { value: customOff } });
          verify();
        }
      }
      const smartDraft = saved[saved.length - 1];
      view.unmount();
      const reloaded = render(SideRhythmsSchema.parse(JSON.parse(JSON.stringify(smartDraft))));
      expect(screen.getByRole('button', { name: 'Smart Schedule', pressed: true })).toBeInTheDocument();
      expect(useScheduleStore.getState().selectedSchedule).toEqual(smartDraft.rhythms.generated.night);
      fireEvent.click(screen.getByRole('button', { name: 'Set by hand' }));
      verify();
      const restored = saved[saved.length - 1].rhythms.generated;
      expect(restored.temperatureMode).toBe('manual');
      expect(restored.night.temperatures).toEqual(original.night.temperatures);
      expect(restored.offWhenUp).toBe(true);
      reloaded.unmount();
    });
  }
}, Math.max(300_000, FUZZ_EDITOR_RUNS * 10_000));
