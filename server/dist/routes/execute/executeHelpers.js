// Pure helpers for the execute route, split out so they're testable without
// pulling in the Franken/config module chain (deviceApi.js requires env vars
// that aren't set in the test environment).
import cbor from 'cbor';
import { z } from 'zod';
// This route sends `arg` straight to hardware, bypassing the range checks
// the validated /api/deviceStatus path enforces (calculateLevelFromF's
// -100..100 level range, and the 12-hour max "on" duration in
// DeviceStatusUpdateSchema). Mirror those bounds here so the raw passthrough
// can't send hardware something the UI path would reject.
export const NUMERIC_ARG_BOUNDS = {
    TEMP_LEVEL_LEFT: [-100, 100],
    TEMP_LEVEL_RIGHT: [-100, 100],
    LEFT_TEMP_DURATION: [0, 43200],
    RIGHT_TEMP_DURATION: [0, 43200],
};
// The argument to send for a command, or undefined when it is not
// acceptable. Bounded commands take a plain whole number, sent in canonical
// form so the firmware never sees "1e2", "0x10" or padded text.
export const normalizeExecuteArg = (command, arg) => {
    const bounds = NUMERIC_ARG_BOUNDS[command];
    if (!bounds) {
        if (arg === undefined || arg === null || arg === '')
            return 'empty';
        return typeof arg === 'string' ? arg : undefined;
    }
    const text = typeof arg === 'number' ? String(arg) : arg;
    if (typeof text !== 'string' || !/^-?\d+$/.test(text))
        return undefined;
    const value = Number(text);
    const [min, max] = bounds;
    return value >= min && value <= max ? String(value) : undefined;
};
const rawAlarmSchema = z.object({
    pl: z.number().int().min(0).max(100),
    // Node timers must fit in a signed 32-bit millisecond delay.
    du: z.number().int().positive().max(2_147_483),
    pi: z.enum(['double', 'rise']),
    tt: z.number().int().nonnegative().safe(),
});
export function alarmFromExecuteArg(arg) {
    try {
        const alarm = rawAlarmSchema.safeParse(cbor.decodeFirstSync(Buffer.from(arg, 'hex')));
        // The in-memory tracker supports ringing alarms, not pending firmware starts.
        if (!alarm.success || alarm.data.tt > Math.floor(Date.now() / 1_000))
            return undefined;
        return { vibrationIntensity: alarm.data.pl, duration: alarm.data.du, vibrationPattern: alarm.data.pi };
    }
    catch {
        return undefined;
    }
}
//# sourceMappingURL=executeHelpers.js.map