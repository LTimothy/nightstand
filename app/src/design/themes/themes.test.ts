import { describe, expect, it } from 'vitest';
import { distance, flatten, ratio, spread } from '@test/colour';
import { fahrenheitToLevel, levelToFahrenheit } from '@lib/temperatureConversions';
import { NIGHT_OPACITY } from '../../pages/SchedulePage/rhythms/rhythmOverlay';
import { THEMES } from '.';
import { DEFAULT_THEME_ID, THEME_IDS, isThemeId } from './ids';
import { scaleColor } from './scale';
import type { ThemePalette, ThemeTokens } from './types';

const LEVELS = Array.from({ length: 21 }, (_, i) => i - 10);
const COLOUR = /^(#[0-9A-F]{6}|rgba\(\d{1,3},\d{1,3},\d{1,3},(0|1|0?\.\d+)\))$/i;
// Text needs 4.5:1; control boundaries and marks need 3:1.
const TEXT = 4.5;
const MARK = 3;

// The token tree with every leaf replaced by its type, and the scale by its kind.
const shape = (value: unknown): unknown => value && typeof value === 'object' && !Array.isArray(value)
  ? Object.fromEntries(Object.entries(value).map(([key, leaf]) => [key, shape(leaf)]))
  : typeof value;
const outline = (tokens: ThemeTokens) => shape({ ...tokens, palette: { ...tokens.palette, scale: tokens.palette.scale.kind } });
// Every string in the palette except the scale's kind; numbers (opacities, band limits) are skipped.
const colours = (value: unknown): string[] => typeof value === 'string' ? [value]
  : value && typeof value === 'object'
    ? Object.entries(value).flatMap(([key, leaf]) => key === 'kind' ? [] : colours(leaf))
    : [];

type Pair = { name: string; top: string; below: string; min: number };

// Every colour the app draws over another, with the contrast it needs. Add a pair here when a screen draws a new one.
function drawnPairs(p: ThemePalette): Pair[] {
  const pairs: Pair[] = [];
  const add = (name: string, top: string, belows: Record<string, string>, min: number) => {
    for (const [surface, below] of Object.entries(belows)) pairs.push({ name: `${name} on ${surface}`, top, below, min });
  };
  const page = { base: p.bg.base, elevated: p.bg.elevated };
  const allSurfaces = {
    ...page, ember: p.ember, selected: p.bg.selected, raised: p.bg.raised, appBar: p.appBar,
  };

  add('text.primary', p.text.primary, allSurfaces, TEXT);
  add('text.secondary', p.text.secondary, allSurfaces, TEXT);
  add('text.tertiary', p.text.tertiary, { ...page, appBar: p.appBar }, TEXT);
  add('accent', p.accent, { ...allSurfaces, nightBg: p.power.nightBg }, TEXT);
  for (const [key, status] of Object.entries(p.status)) add(`status.${key}`, status, page, TEXT);
  add('power.offText', p.power.offText, { offBg: p.power.offBg }, TEXT);
  // Turn on's label, and the value marker on the dial, charts and bars.
  add('lamp', p.lamp, { nightBg: p.power.nightBg }, TEXT);
  add('lamp', p.lamp, page, MARK);

  add('border.control', p.border.control, page, MARK);
  add('step.cool', p.step.cool, { base: p.bg.base }, MARK);
  add('step.warm', p.step.warm, { base: p.bg.base }, MARK);
  // The nights chart draws these lines on a sheet.
  add('step.cool', p.step.cool, { sheet: p.bg.elevated }, MARK);
  add('step.warm', p.step.warm, { sheet: p.bg.elevated }, MARK);
  // A rhythm card's chart: its dimmest night line, text.primary faded, on the card.
  const solid = flatten(p.text.primary, p.bg.elevated);
  const faded = `rgba(${[1, 3, 5].map(i => parseInt(solid.slice(i, i + 2), 16)).join(',')},${NIGHT_OPACITY.older})`;
  add('dimmest night line', faded, { card: p.bg.elevated }, MARK);
  add('dial.tickZero', p.dial.tickZero, { base: p.bg.base }, MARK);
  add('stage.awake', p.stage.awake, { elevated: p.bg.elevated }, MARK);
  add('stage.light', p.stage.light, { elevated: p.bg.elevated }, MARK);
  // A control's outline is its boundary, so it stands apart from the control's own fill and from the page around it.
  const outlined = (name: string, outline: string, fill: string) => add(name, outline, { fill, page: p.bg.base }, MARK);
  outlined('Turn off: power.offBorder', p.power.offBorder, p.power.offBg);
  outlined('Turn on: tile.selectedBorder', p.tile.selectedBorder, p.power.nightBg);
  outlined('selected tile: tile.selectedBorder', p.tile.selectedBorder, p.ember);
  return pairs;
}

it('registers every id once, in picker order, with a valid default', () => {
  // Stored on devices, so the ids and their order are pinned here.
  expect(THEME_IDS).toEqual(['lamp', 'classic', 'glass']);
  expect(DEFAULT_THEME_ID).toBe('lamp');
  expect(Object.keys(THEMES).sort()).toEqual([...THEME_IDS].sort());
  expect(isThemeId(DEFAULT_THEME_ID)).toBe(true);
  expect(isThemeId('neon')).toBe(false);
  expect(isThemeId(undefined)).toBe(false);
});

describe.each(THEME_IDS)('the %s look', id => {
  const tokens = THEMES[id];
  const p = tokens.palette;
  const valueSurfaces = [p.bg.base, p.bg.elevated, p.ember, p.bg.selected];

  it('defines every token the other looks define', () => {
    expect(tokens.id).toBe(id);
    expect(outline(tokens)).toEqual(outline(THEMES.lamp));
  });

  it('writes every colour as a plain hex or rgba value, so nothing is a gradient or a shadow', () => {
    for (const colour of colours(p)) expect(colour).toMatch(COLOUR);
  });

  it('uses a whole corner radius from 0 to 24 px', () => {
    expect(Number.isInteger(tokens.radius) && tokens.radius >= 0 && tokens.radius <= 24).toBe(true);
  });

  it('keeps every pair the app draws at its contrast', () => {
    for (const { name, top, below, min } of drawnPairs(p)) {
      expect(ratio(top, below), name).toBeGreaterThanOrEqual(min);
    }
  });

  it('keeps every whole level of the scale readable where a value is shown', () => {
    for (const level of LEVELS) {
      for (const surface of valueSurfaces) expect(ratio(scaleColor(p.scale, level), surface)).toBeGreaterThanOrEqual(TEXT);
    }
  });

  it('draws stale, off and loading in grey, and marks values in a neutral', () => {
    for (const grey of [p.text.tertiary, p.text.disabled, p.dial.trackOff, p.lamp]) {
      expect(spread(grey, p.bg.base)).toBeLessThanOrEqual(24);
    }
  });

  it('keeps level zero neutral and apart from the levels beside it', () => {
    const zero = scaleColor(p.scale, 0);
    expect(spread(zero, p.bg.base)).toBeLessThanOrEqual(24);
    expect(scaleColor(p.scale, fahrenheitToLevel(levelToFahrenheit(0)))).toBe(zero);
    expect(scaleColor(p.scale, 1)).not.toBe(zero);
    expect(scaleColor(p.scale, -1)).not.toBe(zero);
  });

  it('never draws a live value in a colour close to the stale ring or the off track', () => {
    for (const level of LEVELS) {
      for (const stale of [p.text.tertiary, p.dial.trackOff]) {
        expect(distance(scaleColor(p.scale, level), stale, p.bg.base)).toBeGreaterThanOrEqual(80);
      }
    }
  });

  // Last known, away and unconfirmed numerals are drawn in text.secondary.
  it('never draws a live value in a colour close to the stale numeral', () => {
    for (const level of LEVELS) expect(distance(scaleColor(p.scale, level), p.text.secondary, p.bg.base)).toBeGreaterThanOrEqual(80);
  });
});
