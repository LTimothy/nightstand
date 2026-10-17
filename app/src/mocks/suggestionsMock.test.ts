import { afterEach, beforeEach, expect, it } from 'vitest';
import { createDemoRhythms, resetMockRhythms } from './rhythmsMock';
import { getSettings, updateSettings } from './mockData';
import {
  dismissMockSuggestion, excludeMockNight, forgetMockSuggestions, getMockSuggestions, resetMockSuggestions, restoreMockSuggestions,
} from './suggestionsMock';

const NOW = new Date('2026-10-14T19:00:00Z');

beforeEach(() => {
  resetMockRhythms(createDemoRhythms(NOW), true);
  updateSettings({ features: { ...getSettings().features, rhythmSuggestions: true } });
  resetMockSuggestions();
});
afterEach(() => {
  updateSettings({ features: { ...getSettings().features, rhythmSuggestions: false } });
  resetMockRhythms();
});

it('shows a two-row suggestion with a return, notes of every kind and one hidden entry on the right', () => {
  const right = getMockSuggestions('right', NOW);
  const [entry] = right.suggestions;
  expect(entry.rhythmId).toBe('off-days');
  expect(entry.near).toBe(false);
  expect(entry.rows).toHaveLength(2);
  expect(entry.rows[0].kind === 'step' && entry.rows[0].thenBack).toBeTruthy();
  const notes = right.log.filter(night => night.rhythmId === 'off-days');
  expect(notes.some(night => !night.tonight && night.changes.length === 0)).toBe(true);
  expect(notes.some(night => night.changes.some(change => change.held))).toBe(true);
  expect(notes.some(night => night.changes.some(change => change.source === 'tap'))).toBe(true);
  expect(notes.some(night => night.excluded)).toBe(true);
  expect(notes.some(night => night.tonight)).toBe(true);
  expect(right.dismissed).toHaveLength(1);
  expect(right.nights['night-shift']).toMatchObject({ counted: 3, needed: 5, reason: 'few-nights' });
});

it('offers a Smart base near miss on the left', () => {
  const left = getMockSuggestions('left', NOW);
  expect(left.suggestions).toEqual([expect.objectContaining({ rhythmId: 'workday', near: true })]);
  expect(left.suggestions[0].rows[0].kind).toBe('base');
  expect(left.nights.weekend).toMatchObject({ counted: 3, reason: 'few-nights' });
});

it('hides, restores, leaves a night out and forgets', () => {
  const [id] = dismissMockSuggestion({ scope: 'later', side: 'right', rhythmId: 'off-days' });
  expect(id).toMatch(/^[0-9a-f]{12}$/);
  let right = getMockSuggestions('right', NOW);
  expect(right.suggestions).toEqual([]);
  expect(right.nights['off-days'].reason).toBe('dismissed');
  expect(restoreMockSuggestions('right', [id])).toBe(true);
  expect(restoreMockSuggestions('right', ['0123456789ab'])).toBe(false);
  expect(getMockSuggestions('right', NOW).suggestions).toHaveLength(1);
  const night = getMockSuggestions('right', NOW).log.find(entry => entry.rhythmId === 'off-days' && !entry.tonight && !entry.excluded)!;
  excludeMockNight({ side: 'right', rhythmId: 'off-days', date: night.date, excluded: true });
  right = getMockSuggestions('right', NOW);
  expect(right.log.find(entry => entry.date === night.date && entry.rhythmId === 'off-days')?.excluded).toBe(true);
  forgetMockSuggestions();
  right = getMockSuggestions('right', NOW);
  expect(right.log).toEqual([]);
  expect(right.suggestions).toEqual([]);
  expect(right.nights['off-days'].counted).toBe(0);
});

it('answers off while the feature or Rhythms is off', () => {
  updateSettings({ features: { ...getSettings().features, rhythmSuggestions: false } });
  expect(getMockSuggestions('right', NOW).enabled).toBe(false);
});
