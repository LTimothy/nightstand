import {
  F_PER_LEVEL, NEUTRAL_F, fahrenheitToLevel, formatTemperature, isTargetFormat, levelToFahrenheit, MAX_TEMP_F, MIN_TEMP_F, TemperatureFormat,
} from './temperatureConversions';

export type TemperatureStepState = {
  value: number;
  format: TemperatureFormat;
  history: { direction: 1 | -1; value: number }[];
};

// Remember visited values so reversing level steps restores exact off-grid degrees.
export function stepTemperature(
  value: number, format: TemperatureFormat, direction: 1 | -1, previous?: TemperatureStepState,
): TemperatureStepState {
  const history = previous?.value === value && previous.format === format ? previous.history : [];
  if (!Number.isFinite(value)) return { value, format, history: [] };
  if (isTargetFormat(format)) {
    // Neighbouring stops can share a label, so walk until the label changes.
    let next = value;
    do next += direction; while (next > MIN_TEMP_F && next < MAX_TEMP_F && formatTemperature(next, format) === formatTemperature(value, format));
    return { value: Math.max(MIN_TEMP_F, Math.min(MAX_TEMP_F, next)), format, history: [] };
  }
  const last = history[history.length - 1];
  const reversing = format === 'level' && last?.direction === -direction;
  const requested = reversing ? last.value : format === 'level'
    ? levelToFahrenheit(fahrenheitToLevel(value) + direction) : value + direction;
  const next = Math.max(MIN_TEMP_F, Math.min(MAX_TEMP_F, requested));
  return {
    value: next,
    format,
    history: next === value ? history : reversing ? history.slice(0, -1)
      : format === 'level' ? [...history, { direction, value }] : [],
  };
}

// The step that brings a target closer to a dragged level, or 0 when no step does.
export function stepToward(value: number, format: TemperatureFormat, level: number): 1 | -1 | 0 {
  // Unrounded, so a 1 degree step always counts as a move.
  const exact = (f: number) => (f - NEUTRAL_F) / F_PER_LEVEL;
  const direction = level > exact(value) ? 1 : -1;
  const next = stepTemperature(value, format, direction).value;
  return Math.abs(exact(next) - level) < Math.abs(exact(value) - level) ? direction : 0;
}
