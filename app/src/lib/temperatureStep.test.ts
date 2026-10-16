import { expect, it } from 'vitest';
import { stepTemperature } from './temperatureStep';

it.each([1, -1] as const)('reverses multiple level steps exactly in direction %s', direction => {
  const first = stepTemperature(60, 'level', direction);
  const second = stepTemperature(first.value, 'level', direction, first);
  const opposite = direction === 1 ? -1 : 1;
  const undoSecond = stepTemperature(second.value, 'level', opposite, second);
  const undoFirst = stepTemperature(undoSecond.value, 'level', opposite, undoSecond);
  expect(undoSecond.value).toBe(first.value);
  expect(undoFirst.value).toBe(60);
});

it.each([[109, 1, 110], [56, -1, 55]] as const)('preserves the inverse after clamping %s F', (value, direction, limit) => {
  const first = stepTemperature(value, 'level', direction);
  expect(first.value).toBe(limit);
  const repeated = stepTemperature(first.value, 'level', direction, first);
  expect(repeated.value).toBe(limit);
  expect(stepTemperature(repeated.value, 'level', direction === 1 ? -1 : 1, repeated).value).toBe(value);
});

it('discards history when the source value or format changes', () => {
  const first = stepTemperature(60, 'level', 1);
  expect(stepTemperature(70, 'level', -1, first).value).toBe(66);
  expect(stepTemperature(first.value, 'fahrenheit', -1, first).value).toBe(62);
});

it.each(['fahrenheit', 'celsius'] as const)('keeps one Fahrenheit degree steps in %s', format => {
  const first = stepTemperature(60, format, 1);
  expect(first.value).toBe(61);
  expect(stepTemperature(first.value, format, -1, first).value).toBe(60);
});

it.each(['fahrenheit', 'celsius', 'level'] as const)('only ever steps to whole Fahrenheit values in range in %s mode', (format) => {
  for (const direction of [1, -1] as const) {
    let state = stepTemperature(80, format, direction);
    for (let i = 0; i < 80; i++) {
      expect(Number.isInteger(state.value)).toBe(true);
      expect(state.value).toBeGreaterThanOrEqual(55);
      expect(state.value).toBeLessThanOrEqual(110);
      state = stepTemperature(state.value, format, direction, state);
    }
  }
});
