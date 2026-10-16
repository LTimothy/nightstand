import type { Gesture, TapAction } from '@api/settingsSchema.ts';
import { F_PER_LEVEL, type TemperatureFormat } from '@lib/temperatureConversions';

export const GESTURE_LABELS: Record<Gesture, string> = { doubleTap: 'Double tap', tripleTap: 'Triple tap', quadTap: 'Quad tap' };

export type ActionKey = 'warmer' | 'cooler' | 'set' | 'snooze' | 'stop' | 'base';

export const ACTIONS: Record<ActionKey, string> = {
  warmer: 'Warmer', cooler: 'Cooler', set: 'Set temperature', snooze: 'Snooze alarm', stop: 'Stop alarm', base: 'Switch base position',
};

export const DEFAULT_SET_F = 80;

export function actionOf(tap: TapAction): ActionKey {
  switch (tap.type) {
  case 'temperature': return tap.change === 'increment' ? 'warmer' : 'cooler';
  case 'set_temperature': return 'set';
  case 'alarm': return tap.behavior === 'snooze' ? 'snooze' : 'stop';
  case 'base_control': return 'base';
  }
}

// The whole action a choice saves. The step and the alarm settings carry over from the old action.
export function tapFor(action: ActionKey, current: TapAction, format: TemperatureFormat = 'fahrenheit'): TapAction {
  // Level users only pick whole levels, so a new step starts at one level.
  const amount = current.type === 'temperature' ? current.amount : format === 'level' ? F_PER_LEVEL : 2;
  const { snoozeDuration, inactiveAlarmBehavior } = current.type === 'alarm'
    ? current : { snoozeDuration: 300, inactiveAlarmBehavior: 'none' as const };
  switch (action) {
  case 'warmer': return { type: 'temperature', change: 'increment', amount };
  case 'cooler': return { type: 'temperature', change: 'decrement', amount };
  case 'set': return current.type === 'set_temperature' ? current : { type: 'set_temperature', temperatureF: DEFAULT_SET_F };
  case 'snooze': return { type: 'alarm', behavior: 'snooze', snoozeDuration, inactiveAlarmBehavior };
  case 'stop': return { type: 'alarm', behavior: 'dismiss', snoozeDuration, inactiveAlarmBehavior };
  case 'base': return { type: 'base_control', behavior: 'toggle_preset' };
  }
}
