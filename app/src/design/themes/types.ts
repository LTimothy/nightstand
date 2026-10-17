import type { ThemeId } from './ids';

export type TemperatureScale =
  | { kind: 'continuous'; stops: ReadonlyArray<readonly [number, string]> }
  // Bands keyed by whole degrees F, as the older apps drew them, with a neutral zero.
  | { kind: 'stepped'; neutral: string; bands: ReadonlyArray<readonly [number, string]>; above: string };

export type ThemeFont = 'system' | 'roboto' | 'geist';
export type TextCase = 'none' | 'uppercase';

export interface ThemePalette {
  bg: { base: string; elevated: string; raised: string; selected: string; hover: string };
  /** accent: an outlined accent button's border, 3:1 on the page, cards and the undo bar. */
  border: { subtle: string; control: string; medium: string; accent: string };
  text: { primary: string; secondary: string; tertiary: string; disabled: string; onAccent: string; onError: string };
  /** Controls only: buttons, switches, tabs, focus, selection. Never a value. */
  accent: string;
  /** The neutral marker for values: the now notch, chart lines and bars. */
  lamp: string;
  ember: string;
  appBar: string;
  dial: {
    trackOff: string; tick: string; tickMajor: string; tickZero: string; tickOff: string; tickMajorOff: string;
    ghostOpacity: number; haloOpacity: number;
  };
  // The schedule line drawn over past nights.
  step: { cool: string; warm: string; disabled: string; plan: string };
  power: { offBg: string; offText: string; offBorder: string; nightBg: string };
  tile: { selectedBorder: string };
  status: { ok: string; warn: string; error: string; info: string };
  stage: { awake: string; rem: string; light: string; deep: string };
  scale: TemperatureScale;
}

export interface ThemeType {
  fontFamily: string;
  font: ThemeFont;
  bodyLetterSpacing: string;
  headingWeight: number;
  mediumWeight: number;
  numeralWeight: number;
  numeralTrackingEm: number;
  controlCase: { textTransform: TextCase; letterSpacing: string };
  sectionLabel: { fontWeight: number; letterSpacing: string; textTransform: TextCase };
}

export interface ThemeTokens {
  id: ThemeId;
  radius: number;
  palette: ThemePalette;
  type: ThemeType;
}
