import { describe, expect, it } from 'vitest';
import { actionOf, tapFor } from './tapActions';

const snooze = { type: 'alarm', behavior: 'snooze', snoozeDuration: 120, inactiveAlarmBehavior: 'power' } as const;

describe('tap actions', () => {
  it('names each stored action', () => {
    expect(actionOf({ type: 'temperature', change: 'increment', amount: 2 })).toBe('warmer');
    expect(actionOf({ type: 'temperature', change: 'decrement', amount: 2 })).toBe('cooler');
    expect(actionOf({ type: 'set_temperature', temperatureF: 80 })).toBe('set');
    expect(actionOf(snooze)).toBe('snooze');
    expect(actionOf({ ...snooze, behavior: 'dismiss' })).toBe('stop');
    expect(actionOf({ type: 'base_control', behavior: 'toggle_preset' })).toBe('base');
  });

  it('builds whole actions and carries over what the old one shares', () => {
    const cooler = { type: 'temperature', change: 'decrement', amount: 4 } as const;
    const set = { type: 'set_temperature', temperatureF: 70 } as const;
    expect(tapFor('warmer', cooler)).toEqual({ type: 'temperature', change: 'increment', amount: 4 });
    expect(tapFor('warmer', snooze)).toEqual({ type: 'temperature', change: 'increment', amount: 2 });
    expect(tapFor('set', cooler)).toEqual({ type: 'set_temperature', temperatureF: 80 });
    expect(tapFor('set', set)).toEqual(set);
    expect(tapFor('stop', snooze)).toEqual({ ...snooze, behavior: 'dismiss' });
    expect(tapFor('snooze', cooler)).toEqual({
      type: 'alarm', behavior: 'snooze', snoozeDuration: 300, inactiveAlarmBehavior: 'none',
    });
    expect(tapFor('cooler', snooze, 'level')).toEqual({ type: 'temperature', change: 'decrement', amount: 2.75 });
    expect(tapFor('base', cooler)).toEqual({ type: 'base_control', behavior: 'toggle_preset' });
  });
});
