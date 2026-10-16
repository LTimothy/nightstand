// All temperatures are stored internally in Fahrenheit. This module is the
// display layer: it converts and formats an F value into the user's chosen
// format, one of Fahrenheit, Celsius, or level.
//
// 'level' is the -10..+10 scale used by the official Pod app: -10 is the
// coldest setting (55°F), 0 is neutral (~82.5°F), +10 is the warmest
// setting (110°F). The mapping is linear.

export type TemperatureFormat = 'fahrenheit' | 'celsius' | 'level';

export const MIN_TEMP_F = 55;
export const MAX_TEMP_F = 110;
const NEUTRAL_F = 82.5; // F at level 0
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

// Convert an internal Fahrenheit value to the number shown in a given format.
export function fahrenheitToDisplay(tempF: number, format: TemperatureFormat): number {
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
  if (format === 'celsius') return `${value}°C`;
  return `${value}°F`;
}

/**
 * Convert a Fahrenheit value to the chosen format and format it for display.
 *
 * @param temperature  Internal Fahrenheit value
 * @param format       User's chosen display format
 */
export function formatTemperature(temperature: number, format: TemperatureFormat): string {
  return formatDisplayValue(fahrenheitToDisplay(temperature, format), format);
}

// For text people read, on Bed and in the side tiles other pages share: a negative level takes a true minus sign (U+2212).
export function displayTemperature(temperature: number, format: TemperatureFormat): string {
  return formatTemperature(temperature, format).replace(/^-/, '\u2212');
}

// A change of temperature, such as a tap's step. A step stored in degrees can be a fraction of a level.
export function formatTemperatureChange(deltaF: number, format: TemperatureFormat): string {
  const round = (value: number) => Math.round(value * 10) / 10;
  if (format === 'celsius') return `${round(deltaF * 5 / 9)}°C`;
  if (format === 'level') {
    const levels = round(deltaF / F_PER_LEVEL);
    return `${levels} ${levels === 1 ? 'level' : 'levels'}`;
  }
  return `${round(deltaF)}°F`;
}
