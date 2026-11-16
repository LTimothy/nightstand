import { expect, it } from 'vitest';
import { friendlyTimeZone } from './timeZone';

it('names British Columbia rather than the browser zone name', () =>
  expect(friendlyTimeZone('America/Vancouver')).toBe('British Columbia (Vancouver)'));
it('preserves unknown time zones', () => expect(friendlyTimeZone('Unknown/Zone')).toBe('Unknown/Zone'));
