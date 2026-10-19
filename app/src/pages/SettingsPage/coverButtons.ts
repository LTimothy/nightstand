import type { DeepPartial } from 'ts-essentials';
import { Version } from '@api/deviceStatusSchema.ts';
import type { SideSettings, TapAction } from '@api/settingsSchema.ts';

export type CoverButtonsPath = 'buttons' | 'taps';

// A Pod 4 hub ignores short clicks on a Pod 5 cover and Nightstand reads them from RAW files (buttons).
// A Pod 5 hub handles them itself and, offline, only bumps tap counters (taps); a Pod 5 cover is required for that too.
export function coverButtonsPath(hub?: string, cover?: string): CoverButtonsPath | null {
  if (hub === Version.Pod5 && cover === Version.Pod5) return 'taps';
  if (hub === Version.Pod4 && cover === Version.Pod5) return 'buttons';
  return null;
}

// Which tap counter each button bumps on a Pod 5 hub, read from the Pod's logs.
export const POD5_HUB_GESTURES = { plus: 'tripleTap', minus: 'doubleTap', logo: 'quadTap' } as const;
export const DEFAULT_LOGO_F = 80;
const DEFAULT_QUAD_TAP: TapAction = { type: 'base_control', behavior: 'toggle_preset' };

export type CoverButtonValues = {
  // Null when plus and minus are not opposite temperature steps of the same amount.
  stepF: number | null;
  swapped: boolean;
  // Null when the logo does not set a temperature.
  logoF: number | null;
  // True when the logo is set to an action other than a temperature or the default toggle.
  logoOther: boolean;
};

export function readCoverButtons(path: CoverButtonsPath, side: SideSettings): CoverButtonValues | null {
  if (path === 'buttons') {
    const buttons = side.buttons;
    return buttons ? { stepF: buttons.stepF, swapped: buttons.invertButtons, logoF: buttons.favoriteTemperatureF, logoOther: false } : null;
  }
  if (!side.taps) return null;
  const plus = side.taps[POD5_HUB_GESTURES.plus];
  const minus = side.taps[POD5_HUB_GESTURES.minus];
  const logo = side.taps[POD5_HUB_GESTURES.logo];
  const paired = plus.type === 'temperature' && minus.type === 'temperature' && plus.change !== minus.change && plus.amount === minus.amount;
  return {
    stepF: paired ? plus.amount : null,
    swapped: paired && plus.change === 'decrement',
    logoF: logo.type === 'set_temperature' ? logo.temperatureF : null,
    logoOther: logo.type !== 'set_temperature' && !(logo.type === 'base_control' && logo.behavior === 'toggle_preset'),
  };
}

// What one control's change saves for its side. Tap actions are sent whole.
export function coverButtonsPatch(
  path: CoverButtonsPath, current: CoverButtonValues, change: Partial<CoverButtonValues>,
): DeepPartial<SideSettings> {
  const next = { ...current, ...change };
  if (path === 'buttons') {
    if ('stepF' in change) return { buttons: { stepF: next.stepF ?? 1 } };
    if ('swapped' in change) return { buttons: { invertButtons: next.swapped } };
    return { buttons: { favoriteTemperatureF: next.logoF ?? DEFAULT_LOGO_F } };
  }
  const { plus, minus, logo } = POD5_HUB_GESTURES;
  if ('logoF' in change) {
    return { taps: { [logo]: next.logoF === null ? DEFAULT_QUAD_TAP : { type: 'set_temperature', temperatureF: next.logoF } } };
  }
  const amount = next.stepF ?? 1;
  return { taps: {
    [plus]: { type: 'temperature', change: next.swapped ? 'decrement' : 'increment', amount },
    [minus]: { type: 'temperature', change: next.swapped ? 'increment' : 'decrement', amount },
  } };
}
