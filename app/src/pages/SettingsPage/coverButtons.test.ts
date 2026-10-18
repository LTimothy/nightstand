import { describe, expect, it } from 'vitest';
import { getSettings } from '../../mocks/mockData';
import { coverButtonsPatch, coverButtonsPath, POD5_HUB_GESTURES, readCoverButtons } from './coverButtons';

const pod5HubSide = () => ({
  ...structuredClone(getSettings().left),
  taps: {
    doubleTap: { type: 'temperature', change: 'decrement', amount: 2 },
    tripleTap: { type: 'temperature', change: 'increment', amount: 2 },
    quadTap: { type: 'base_control', behavior: 'toggle_preset' },
  },
} as ReturnType<typeof getSettings>['left']);

describe('cover buttons', () => {
  it('picks the path from the hub, never guessing', () => {
    expect(coverButtonsPath('Pod 5', 'Pod 5')).toBe('taps');
    expect(coverButtonsPath('Pod 5', 'Pod 4')).toBeNull();
    expect(coverButtonsPath('Pod 5', undefined)).toBeNull();
    expect(coverButtonsPath('Pod 4', 'Pod 5')).toBe('buttons');
    expect(coverButtonsPath('Pod 4', 'Pod 4')).toBeNull();
    expect(coverButtonsPath('Version not found', 'Pod 5')).toBeNull();
    expect(coverButtonsPath(undefined, undefined)).toBeNull();
  });

  it('maps a Pod 5 hub\'s plus to the triple tap, minus to the double tap and the logo to the quad tap', () => {
    // Inferred from the Pod's logs; the logo is not checked on hardware yet. Change both together.
    expect(POD5_HUB_GESTURES).toEqual({ plus: 'tripleTap', minus: 'doubleTap', logo: 'quadTap' });
  });

  it('reads and saves the buttons settings on a Pod 4 hub', () => {
    const side = getSettings().left;
    const values = readCoverButtons('buttons', side)!;
    expect(values).toEqual({ stepF: 1, swapped: false, logoF: 80, logoOther: false });
    expect(coverButtonsPatch('buttons', values, { stepF: 3 })).toEqual({ buttons: { stepF: 3 } });
    expect(coverButtonsPatch('buttons', values, { swapped: true })).toEqual({ buttons: { invertButtons: true } });
    expect(coverButtonsPatch('buttons', values, { logoF: 76 })).toEqual({ buttons: { favoriteTemperatureF: 76 } });
  });

  it('reads the tap actions on a Pod 5 hub', () => {
    expect(readCoverButtons('taps', pod5HubSide())).toEqual({ stepF: 2, swapped: false, logoF: null, logoOther: false });
    const swapped = pod5HubSide();
    swapped.taps.tripleTap = { type: 'temperature', change: 'decrement', amount: 2 };
    swapped.taps.doubleTap = { type: 'temperature', change: 'increment', amount: 2 };
    swapped.taps.quadTap = { type: 'set_temperature', temperatureF: 77 };
    expect(readCoverButtons('taps', swapped)).toEqual({ stepF: 2, swapped: true, logoF: 77, logoOther: false });
    const other = pod5HubSide();
    other.taps.doubleTap = { type: 'alarm', behavior: 'dismiss', snoozeDuration: 300, inactiveAlarmBehavior: 'none' };
    expect(readCoverButtons('taps', other)?.stepF).toBeNull();
    const unequal = pod5HubSide();
    unequal.taps.doubleTap = { type: 'temperature', change: 'decrement', amount: 3 };
    expect(readCoverButtons('taps', unequal)?.stepF).toBeNull();
    const logoOther = pod5HubSide();
    logoOther.taps.quadTap = { type: 'alarm', behavior: 'dismiss', snoozeDuration: 300, inactiveAlarmBehavior: 'none' };
    expect(readCoverButtons('taps', logoOther)).toMatchObject({ logoF: null, logoOther: true });
  });

  it('saves whole tap actions on a Pod 5 hub', () => {
    const values = { stepF: 2, swapped: false, logoF: null, logoOther: false };
    expect(coverButtonsPatch('taps', values, { stepF: 3 })).toEqual({ taps: {
      tripleTap: { type: 'temperature', change: 'increment', amount: 3 },
      doubleTap: { type: 'temperature', change: 'decrement', amount: 3 },
    } });
    expect(coverButtonsPatch('taps', values, { swapped: true })).toEqual({ taps: {
      tripleTap: { type: 'temperature', change: 'decrement', amount: 2 },
      doubleTap: { type: 'temperature', change: 'increment', amount: 2 },
    } });
    expect(coverButtonsPatch('taps', values, { logoF: 80 })).toEqual({ taps: { quadTap: { type: 'set_temperature', temperatureF: 80 } } });
    expect(coverButtonsPatch('taps', { ...values, logoF: 80 }, { logoF: null })).toEqual({
      taps: { quadTap: { type: 'base_control', behavior: 'toggle_preset' } },
    });
  });

  it('reads nothing from settings the app could not read', () => {
    expect(readCoverButtons('buttons', { ...getSettings().left, buttons: undefined } as never)).toBeNull();
    expect(readCoverButtons('taps', { ...getSettings().left, taps: undefined } as never)).toBeNull();
  });
});
