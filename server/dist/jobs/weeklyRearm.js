import schedule from 'node-schedule';
import settingsDB from '../db/settings.js';
import schedulesDB from '../db/schedules.js';
import { connectFrankenWithin } from '../8sleep/frankenServer.js';
import { updateDeviceStatus } from '../routes/deviceStatus/updateDeviceStatus.js';
import logger from '../logger.js';
import serverStatus from '../serverStatus.js';
import { MAX_ON_DURATION_SECONDS } from '../routes/deviceStatus/deviceStatusSchema.js';
import { armedNight, forgetWeeklyArmed, nextScheduledOff, noteWeeklyArmed, weeklyFirmwareEnd } from './firmwareTimer.js';
import { isRebuilding } from './rebuildState.js';
import { engineActivation } from './scheduleQueries.js';
import { runningNight } from './nightBounds.js';
import { isSchedulePaused } from './schedulePause.js';
const MANUAL_ON_MS = MAX_ON_DURATION_SECONDS * 1000;
// The firmware end a side on in tonight's weekly night should now have, or
// null when what it was given still holds.
export function planWeeklyRearm(settings, schedules, side, now) {
    const timeZone = settings.timeZone;
    if (!timeZone || settings[side].awayMode || isSchedulePaused(settings, side, now))
        return null;
    let armed = armedNight(side);
    if (armed && armed.until <= now.getTime()) {
        forgetWeeklyArmed(side);
        armed = undefined;
    }
    const night = armed ?? runningNight(schedules, side, now, timeZone);
    if (!night)
        return null;
    const power = schedules[side]?.[night.day]?.power;
    let until;
    let notAfter;
    if (power?.enabled) {
        const offAt = nextScheduledOff(night.start, power.off, timeZone);
        until = weeklyFirmwareEnd(side, offAt);
        notAfter = offAt;
    }
    else {
        // Tonight's power schedule was turned off: the side runs out the 12
        // hours a manual power-on at the night's start would have had.
        if (!armed)
            return null;
        until = new Date(night.start.getTime() + MANUAL_ON_MS);
        notAfter = until;
    }
    if (!Number.isFinite(until.getTime()) || !Number.isFinite(notAfter.getTime()))
        return null;
    if (now.getTime() >= notAfter.getTime() || until.getTime() === armed?.until)
        return null;
    return { night, until, notAfter };
}
// Rhythms took over, or a rebuild is replacing this job.
const weeklyLost = (rhythmsAtStart) => isRebuilding() || engineActivation().active || settingsDB.data.features.rhythms !== rhythmsAtStart;
export async function rearmWeeklyNight(side) {
    const label = `weekly off time for ${side}`;
    const rhythmsAtStart = settingsDB.data.features.rhythms;
    await settingsDB.read();
    await schedulesDB.read();
    if (weeklyLost(rhythmsAtStart))
        return;
    const plan = planWeeklyRearm(settingsDB.data, schedulesDB.data, side, new Date());
    if (!plan)
        return;
    let isOn;
    try {
        const franken = await connectFrankenWithin({ background: true });
        if (weeklyLost(rhythmsAtStart))
            return;
        isOn = (await franken.getDeviceStatus())[side].isOn;
    }
    catch (error) {
        logger.warn(`Skipping ${label}: could not read the Pod: ${error instanceof Error ? error.message : String(error)}`);
        return;
    }
    if (weeklyLost(rhythmsAtStart)) {
        logger.info(`Skipping ${label}: the weekly schedule no longer runs this side`);
        return;
    }
    if (!isOn) {
        logger.info(`Skipping ${label}: the side is off`);
        return;
    }
    logger.info(`Executing ${label}`);
    try {
        await updateDeviceStatus({ [side]: { isOn: true } }, {
            background: true, onUntil: plan.until, notAfter: plan.notAfter.getTime(),
        });
        noteWeeklyArmed(side, plan.night.day, plan.night.start, plan.until);
    }
    catch (error) {
        if (Date.now() > plan.notAfter.getTime()) {
            logger.info(`Skipping ${label}: the Pod answered only after the off time`);
            return;
        }
        serverStatus.status.powerSchedule.status = 'failed';
        serverStatus.status.powerSchedule.message = error instanceof Error ? error.message : String(error);
        logger.error(error);
    }
}
const REARM_DELAY_MS = 1000;
// After a rebuild, a side on in tonight's weekly night gets the end the
// edited schedule now gives it. Runs as a job so the next rebuild cancels it.
export function scheduleWeeklyRearm(settings, schedules, side, now = new Date()) {
    if (!planWeeklyRearm(settings, schedules, side, now))
        return false;
    schedule.scheduleJob(`${side}-weekly-rearm`, new Date(now.getTime() + REARM_DELAY_MS), () => rearmWeeklyNight(side));
    return true;
}
//# sourceMappingURL=weeklyRearm.js.map