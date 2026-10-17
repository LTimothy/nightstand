const minuteOf = (time) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
// Minutes from power on to a clock time, wrapping past midnight.
export const minutesAfterOn = (time, on) => (minuteOf(time) - minuteOf(on) + 1440) % 1440;
export const nightMinutes = (power) => (power.off === power.on ? 1440 : minutesAfterOn(power.off, power.on));
// Same rule as the app's timeInPowerWindow: from power on up to power off.
export function wakeInNight(wake, power) {
    return minutesAfterOn(wake, power.on) <= nightMinutes(power);
}
// The wake time a weekly night implies: its earliest enabled alarm inside the night, else its turn off.
export function wakeFromNight(night) {
    const { power } = night;
    const alarms = (night.alarms.length ? night.alarms : [night.alarm])
        .filter(alarm => alarm.enabled && minutesAfterOn(alarm.time, power.on) > 0 && wakeInNight(alarm.time, power))
        .sort((a, b) => minutesAfterOn(a.time, power.on) - minutesAfterOn(b.time, power.on));
    return alarms[0]?.time ?? power.off;
}
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;
// Same rule as the app's set point check: after power on and before power off, never at either.
export function temperatureInPowerWindow(time, power) {
    if (!CLOCK.test(time))
        return false;
    const offset = minutesAfterOn(time, power.on);
    return offset > 0 && offset < nightMinutes(power);
}
//# sourceMappingURL=rhythmWake.js.map