import moment from 'moment-timezone';
import type { Settings } from '@api/settingsSchema';
import type { Side } from '@state/appStore';

// Rings through a schedule pause and Alarms off, so neither hides it.
export function pendingOneOffText(settings: Settings, side: Side, now: Date): string | null {
  const alarm = settings[side]?.oneOffAlarm;
  if (!settings.features?.oneOffAlarms || !alarm?.enabled || settings[side].awayMode) return null;
  const at = moment.tz(alarm.fireAt, settings.timeZone ?? 'UTC');
  if (!alarm.fireAt || !at.isValid() || !at.isAfter(now)) return null;
  const today = moment.tz(now, settings.timeZone ?? 'UTC');
  const day = at.isSame(today, 'day') ? 'today' : at.isSame(today.clone().add(1, 'day'), 'day') ? 'tomorrow' : at.format('ddd, MMM D');
  return `${day} at ${at.format('h:mm A')}`;
}
