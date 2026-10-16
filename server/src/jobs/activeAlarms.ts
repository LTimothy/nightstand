import memoryDB from '../db/memoryDB.js';
import type { AlarmJob, Side } from '../db/schedulesSchema.js';

// What a ringing alarm was started with. Each start stores a new object, so
// the object also tells one ring apart from the next.
export type ActiveAlarm = Pick<AlarmJob, 'vibrationIntensity' | 'duration' | 'vibrationPattern'>;

export const activeAlarms = new Map<Side, ActiveAlarm>();

const snoozes = new Map<Side, ReturnType<typeof setTimeout>>();

// When each side's last alarm stopped ringing, by dismissal or on its own.
export const alarmEndedAt = new Map<Side, number>();

export function hasSnooze(side: Side): boolean {
  return snoozes.has(side);
}

export function cancelSnooze(side: Side): void {
  clearTimeout(snoozes.get(side));
  snoozes.delete(side);
}

// Replaces any snooze already waiting on this side.
export function setSnooze(side: Side, delayMs: number, ring: () => void): void {
  cancelSnooze(side);
  const timer = setTimeout(() => {
    if (snoozes.get(side) !== timer) return;
    snoozes.delete(side);
    ring();
  }, delayMs);
  snoozes.set(side, timer);
}

// A dismissed alarm also ends its snooze.
export function forgetActiveAlarm(side: Side): void {
  if (activeAlarms.has(side) || snoozes.has(side)) alarmEndedAt.set(side, Date.now());
  activeAlarms.delete(side);
  cancelSnooze(side);
}


// Records only an accepted start; each expiry belongs to that particular alarm.
export async function recordActiveAlarm(side: Side, alarm: ActiveAlarm, durationSeconds = alarm.duration): Promise<void> {
  const activeAlarm = { ...alarm };
  activeAlarms.set(side, activeAlarm);
  cancelSnooze(side);
  await memoryDB.read();
  memoryDB.data[side].isAlarmVibrating = true;
  await memoryDB.write();
  setTimeout(async () => {
    if (activeAlarms.get(side) !== activeAlarm) return;
    await memoryDB.read();
    if (activeAlarms.get(side) !== activeAlarm) return;
    activeAlarms.delete(side);
    alarmEndedAt.set(side, Date.now());
    memoryDB.data[side].isAlarmVibrating = false;
    await memoryDB.write();
  }, durationSeconds * 1_000);
}
