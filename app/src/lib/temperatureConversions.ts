// All temperatures are stored internally as legacy whole-degree Fahrenheit
// stops (55..110). This module is the display layer: it converts and formats
// a stored value into the user's chosen format: Fahrenheit, Celsius, or level.
// The two target formats relabel the same stored stops with the temperature
// the Pod 5 aims for at that firmware level; stored values do not change.
//
// 'level' is the -10..+10 scale used by the official Pod app: -10 is the
// coldest setting (55°F), 0 is neutral (~82.5°F), +10 is the warmest
// setting (110°F). The mapping is linear.

export type TemperatureUnit = 'fahrenheit' | 'celsius' | 'level';
export type TemperatureFormat = TemperatureUnit | 'fahrenheitTarget' | 'celsiusTarget';


export function unitOf(format: TemperatureFormat): TemperatureUnit {
  if (format === 'fahrenheitTarget') return 'fahrenheit';
  if (format === 'celsiusTarget') return 'celsius';
  return format;
}

export function isTargetFormat(format: TemperatureFormat): format is 'fahrenheitTarget' | 'celsiusTarget' {
  return format === 'fahrenheitTarget' || format === 'celsiusTarget';
}

export function targetFormatOf(unit: TemperatureUnit): TemperatureFormat {
  if (unit === 'fahrenheit') return 'fahrenheitTarget';
  if (unit === 'celsius') return 'celsiusTarget';
  return unit;
}

export const MIN_TEMP_F = 55;
export const MAX_TEMP_F = 110;
export const NEUTRAL_F = 82.5; // F at level 0
export const F_PER_LEVEL = 27.5 / 10; // 2.75°F per level step

// Level-format bounds (Pod-app -10..+10 scale)
export const MIN_TEMP_LEVEL = -10;
export const MAX_TEMP_LEVEL = 10;

export function fahrenheitToLevel(f: number): number {
  return Math.round((f - NEUTRAL_F) / F_PER_LEVEL);
}

export function levelToFahrenheit(level: number): number {
  return Math.round(level * F_PER_LEVEL + NEUTRAL_F);
}

export function farenheitToCelcius(farenheit: number): number {
  const celcius = (farenheit - 32) * 5 / 9;
  return Math.round(celcius * 2) / 2;
}

// Pod target in °C by firmware level, linear between points.
const TARGET_CURVE: ReadonlyArray<readonly [number, number]> = [[-100, 10], [-99, 15.12], [0, 27], [50, 36], [100, 42]];

function firmwareLevel(f: number): number {
  return Math.round((f - NEUTRAL_F) / 27.5 * 100);
}

function roundTo(value: number, decimals: number, step = 1): number {
  const scale = 10 ** decimals;
  return Math.round(value * scale / step) * step / scale;
}

function curveCelsius(level: number): number {
  const i = Math.max(1, TARGET_CURVE.findIndex(([l]) => l >= level));
  const [l0, c0] = TARGET_CURVE[i - 1];
  const [l1, c1] = TARGET_CURVE[i];
  return c0 + (level - l0) / (l1 - l0) * (c1 - c0);
}

function targetCelsius(f: number): number {
  return curveCelsius(Math.min(100, Math.max(-100, firmwareLevel(f))));
}

// The number a target format shows for a raw firmware level, such as the current reading.
export function firmwareLevelToDisplay(level: number, format: 'fahrenheitTarget' | 'celsiusTarget'): number {
  const celsius = curveCelsius(Math.min(100, Math.max(-100, level)));
  return format === 'fahrenheitTarget' ? roundTo(celsius * 9 / 5 + 32, 0) : roundTo(celsius, 0, 0.5);
}

// Convert an internal Fahrenheit value to the number shown in a given format.
export function fahrenheitToDisplay(tempF: number, format: TemperatureFormat, decimals = 0): number {
  if (format === 'fahrenheitTarget') return roundTo(targetCelsius(tempF) * 9 / 5 + 32, decimals);
  if (format === 'celsiusTarget') return decimals ? roundTo(targetCelsius(tempF), decimals) : roundTo(targetCelsius(tempF), 0, 0.5);
  if (format === 'level') return fahrenheitToLevel(tempF);
  if (format === 'celsius') return farenheitToCelcius(tempF);
  return Math.round(tempF);
}

// The axis/slider bounds for a format, derived from the F operating range.
export function displayBounds(format: TemperatureFormat): { min: number; max: number } {
  return {
    min: fahrenheitToDisplay(MIN_TEMP_F, format),
    max: fahrenheitToDisplay(MAX_TEMP_F, format),
  };
}

// Add the unit or sign to a value already expressed in the format's units.
// Use this when the caller already holds a converted value (e.g. chart axis
// ticks); use formatTemperature when the caller holds a raw Fahrenheit value.
export function formatDisplayValue(value: number, format: TemperatureFormat): string {
  if (format === 'level') {
    const sign = value > 0 ? '+' : '';
    return `${sign}${value}`;
  }
  if (format === 'celsius' || format === 'celsiusTarget') return `${value}°C`;
  return `${value}°F`;
}

/**
 * Convert a Fahrenheit value to the chosen format and format it for display.
 *
 * @param temperature  Internal Fahrenheit value
 * @param format       User's chosen display format
 */
export function formatTemperature(temperature: number, format: TemperatureFormat, decimals = 0): string {
  return formatDisplayValue(fahrenheitToDisplay(temperature, format, decimals), format);
}

// Chart tooltips: label the stored value behind each point, not the plotted display value.
export const seriesValueFormatter = (stored: number[], format: TemperatureFormat) =>
  (_value: number | null, { dataIndex }: { dataIndex: number }) => formatTemperature(stored[dataIndex], format);

// For text people read, on Bed and in the side tiles other pages share: a negative level takes a true minus sign (U+2212).
export function displayTemperature(temperature: number, format: TemperatureFormat): string {
  return formatTemperature(temperature, format).replace(/^-/, '\u2212');
}

// A change of temperature, such as a tap's step. A step stored in degrees can be a fraction of a level.
export function formatTemperatureChange(deltaF: number, format: TemperatureFormat): string {
  const round = (value: number) => Math.round(value * 10) / 10;
  if (isTargetFormat(format)) return `${round(deltaF)} ${round(deltaF) === 1 ? 'step' : 'steps'}`;
  if (format === 'celsius') return `${round(deltaF * 5 / 9)}°C`;
  if (format === 'level') {
    const levels = round(deltaF / F_PER_LEVEL);
    const text = `${levels} ${levels === 1 ? 'level' : 'levels'}`;
    return Math.abs(deltaF / F_PER_LEVEL - Math.round(deltaF / F_PER_LEVEL)) < 1e-9 ? text : `${round(deltaF)}°F (${text})`;
  }
  return `${round(deltaF)}°F`;
}
