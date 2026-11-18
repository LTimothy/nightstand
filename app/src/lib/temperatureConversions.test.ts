import { describe, expect, it } from 'vitest';
import {
  displayBounds, displayTemperature, fahrenheitToDisplay, fahrenheitToLevel, firmwareLevelToDisplay, formatDisplayValue, isTargetFormat,
  levelToFahrenheit, formatTemperature, seriesValueFormatter, formatTemperatureChange, targetFormatOf, unitOf,
} from './temperatureConversions';
it('round trips each supported level through the stored Fahrenheit value', () => {
  for (let level = -10; level <= 10; level++) {
    expect(fahrenheitToLevel(levelToFahrenheit(level))).toBe(level);
  }
  expect(formatTemperature(83, 'level')).toBe('0');
});

it('pins all canonical legacy Fahrenheit values independently of the firmware readout', () => {
  expect(Array.from({ length: 21 }, (_, index) => levelToFahrenheit(index - 10))).toEqual([
    55, 58, 61, 63, 66, 69, 72, 74, 77, 80, 83, 85, 88, 91, 94, 96, 99, 102, 105, 107, 110,
  ]);
});

it('shows a true minus sign for negative levels on display text', () => {
  expect(displayTemperature(levelToFahrenheit(-3), 'level')).toBe('\u22123');
  expect(displayTemperature(levelToFahrenheit(-10), 'level')).toBe('\u221210');
  expect(displayTemperature(levelToFahrenheit(2), 'level')).toBe('+2');
  expect(displayTemperature(levelToFahrenheit(0), 'level')).toBe('0');
  expect(displayTemperature(82, 'fahrenheit')).toBe('82°F');
  expect(displayTemperature(82, 'celsius')).toBe('28°C');
});

it('shows a true minus sign for negative Fahrenheit and Celsius too', () => {
  expect(displayTemperature(-4, 'fahrenheit')).toBe('\u22124°F');
  expect(displayTemperature(14, 'celsius')).toBe('\u221210°C');
  expect(displayTemperature(31, 'celsius')).toBe('\u22120.5°C');
});

describe('formatTemperatureChange', () => {
  it.each([
    [2, 'fahrenheit', '2°F'], [2.5, 'fahrenheit', '2.5°F'], [1, 'celsius', '0.6°C'], [2, 'celsius', '1.1°C'],
    [10, 'celsius', '5.6°C'], [2.75, 'level', '1 level'], [5.5, 'level', '2 levels'], [8.25, 'level', '3 levels'],
    [2, 'level', '2°F (0.7 levels)'], [10, 'level', '10°F (3.6 levels)'],
  ] as const)('shows %s F in %s as %s', (deltaF, format, text) => {
    expect(formatTemperatureChange(deltaF, format)).toBe(text);
  });
});

describe('firmwareLevelToDisplay', () => {
  it.each([[-99, 59], [-100, 50], [-98, 59], [0, 81], [50, 97]])('shows level %s as %s°F', (level, shown) => {
    expect(firmwareLevelToDisplay(level, 'fahrenheitTarget')).toBe(shown);
  });

  it.each([[0, 27], [-100, 10]])('shows level %s as %s°C', (level, shown) => {
    expect(firmwareLevelToDisplay(level, 'celsiusTarget')).toBe(shown);
  });
});

describe('target formats', () => {
  it.each([
    [55, 50], [56, 60], [57, 61], [58, 61], [81, 80], [82, 80], [83, 81], [90, 89], [110, 108],
  ])('shows %s stored as %s°F', (stored, shown) => {
    expect(fahrenheitToDisplay(stored, 'fahrenheitTarget')).toBe(shown);
  });

  it.each([[55, 10], [83, 27.5], [110, 42], [75, 24], [76, 24]])('shows %s stored as %s°C', (stored, shown) => {
    expect(fahrenheitToDisplay(stored, 'celsiusTarget')).toBe(shown);
  });

  it('reads the firmware target at the coldest stop', () => {
    expect(formatTemperature(55, 'fahrenheitTarget')).toBe('50°F');
    expect(formatTemperature(55, 'celsiusTarget')).toBe('10°C');
    expect(formatTemperature(55, 'level')).toBe('-10');
  });

  it('formats labels with optional decimals', () => {
    expect(formatTemperature(83, 'fahrenheitTarget')).toBe('81°F');
    expect(formatTemperature(83, 'celsiusTarget')).toBe('27.5°C');
    expect(formatTemperature(81, 'fahrenheitTarget', 1)).toBe('79.5°F');
    expect(formatTemperature(82, 'fahrenheitTarget', 1)).toBe('80.2°F');
  });

  it('handles values off the stored grid', () => {
    expect(fahrenheitToDisplay(82.75, 'fahrenheitTarget')).toBe(81);
    expect(Number.isFinite(fahrenheitToDisplay(79.75, 'fahrenheitTarget'))).toBe(true);
  });

  it('has bounds and display values', () => {
    expect(displayBounds('fahrenheitTarget')).toEqual({ min: 50, max: 108 });
    expect(displayBounds('celsiusTarget')).toEqual({ min: 10, max: 42 });
    expect(formatDisplayValue(81, 'fahrenheitTarget')).toBe('81°F');
  });

  it('formats changes as steps', () => {
    expect(formatTemperatureChange(1, 'fahrenheitTarget')).toBe('1 step');
    expect(formatTemperatureChange(3, 'celsiusTarget')).toBe('3 steps');
    expect(formatTemperatureChange(2.75, 'fahrenheitTarget')).toBe('2.8 steps');
  });

  it('maps between formats and units', () => {
    expect(unitOf('fahrenheitTarget')).toBe('fahrenheit');
    expect(unitOf('celsiusTarget')).toBe('celsius');
    expect(unitOf('level')).toBe('level');
    expect(isTargetFormat('celsiusTarget')).toBe(true);
    expect(isTargetFormat('celsius')).toBe(false);
    expect(targetFormatOf('fahrenheit')).toBe('fahrenheitTarget');
    expect(targetFormatOf('celsius')).toBe('celsiusTarget');
    expect(targetFormatOf('level')).toBe('level');
  });
});

it('labels a tooltip from the stored value', () => {
  expect(seriesValueFormatter([55, 83], 'fahrenheitTarget')(0, { dataIndex: 0 })).toBe('50°F');
  expect(seriesValueFormatter([55, 83], 'fahrenheitTarget')(81, { dataIndex: 1 })).toBe('81°F');
  expect(seriesValueFormatter([55, 83], 'fahrenheit')(55, { dataIndex: 0 })).toBe('55°F');
});

it('keeps a firmware level outside -100..100 on the curve ends', () => {
  expect(firmwareLevelToDisplay(120, 'fahrenheitTarget')).toBe(firmwareLevelToDisplay(100, 'fahrenheitTarget'));
  expect(firmwareLevelToDisplay(-150, 'celsiusTarget')).toBe(10);
});
