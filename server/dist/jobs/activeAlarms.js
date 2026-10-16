import memoryDB from '../db/memoryDB.js';
export const activeAlarms = new Map();
const snoozes = new Map();
// When each side's last alarm stopped ringing, by dismissal or on its own.
export const alarmEndedAt = new Map();
export function hasSnooze(side) {
    return snoozes.has(side);
}
export function cancelSnooze(side) {
    clearTimeout(snoozes.get(side));
    snoozes.delete(side);
}
// Replaces any snooze already waiting on this side.
export function setSnooze(side, delayMs, ring) {
    cancelSnooze(side);
    const timer = setTimeout(() => {
        if (snoozes.get(side) !== timer)
            return;
        snoozes.delete(side);
        ring();
    }, delayMs);
    snoozes.set(side, timer);
}
// A dismissed alarm also ends its snooze.
export function forgetActiveAlarm(side) {
    if (activeAlarms.has(side) || snoozes.has(side))
        alarmEndedAt.set(side, Date.now());
    activeAlarms.delete(side);
    cancelSnooze(side);
}
// Records only an accepted start; each expiry belongs to that particular alarm.
export async function recordActiveAlarm(side, alarm, durationSeconds = alarm.duration) {
    const activeAlarm = { ...alarm };
    activeAlarms.set(side, activeAlarm);
    cancelSnooze(side);
    await memoryDB.read();
    memoryDB.data[side].isAlarmVibrating = true;
    await memoryDB.write();
    setTimeout(async () => {
        if (activeAlarms.get(side) !== activeAlarm)
            return;
        await memoryDB.read();
        if (activeAlarms.get(side) !== activeAlarm)
            return;
        activeAlarms.delete(side);
        alarmEndedAt.set(side, Date.now());
        memoryDB.data[side].isAlarmVibrating = false;
        await memoryDB.write();
    }, durationSeconds * 1_000);
}
//# sourceMappingURL=activeAlarms.js.map