import schedule from 'node-schedule';
import moment from 'moment-timezone';
import { getDayIndexForTime, logJob } from './utils.js';
import { scheduleZone } from '../db/timeZones.js';
import { updateDeviceStatus } from '../routes/deviceStatus/updateDeviceStatus.js';
import serverStatus from '../serverStatus.js';
import logger from '../logger.js';
import { isTempScheduleOverridden } from './scheduleOverride.js';
import settingsDB from '../db/settings.js';
import { describePause, isSchedulePaused } from './schedulePause.js';
const scheduleAdjustment = (timeZone, side, day, time, temperature, powerOn) => {
    const onRule = new schedule.RecurrenceRule();
    const dayOfWeekIndex = getDayIndexForTime(day, time, powerOn);
    const [onHour, onMinute] = time.split(':').map(Number);
    logJob('Scheduling temperature adjustment job', side, day, dayOfWeekIndex, time);
    onRule.dayOfWeek = dayOfWeekIndex;
    onRule.hour = onHour;
    onRule.minute = onMinute;
    onRule.tz = scheduleZone(timeZone);
    schedule.scheduleJob(`${side}-${day}-${time}-${temperature}-temperature-adjustment`, onRule, async (fireDate) => {
        try {
            await settingsDB.read();
            if (isSchedulePaused(settingsDB.data, side, fireDate ?? moment().toDate())) {
                logger.info(`Skipping ${side} ${day} temperature change at ${time}, schedule paused ${describePause(settingsDB.data, side)}`);
                return;
            }
            if (isTempScheduleOverridden(side)) {
                const expiresAt = settingsDB.data[side].scheduleOverrides.temperatureSchedules.expiresAt;
                logJob(`Skipping temperature adjustment, schedule overridden until ${expiresAt}`, side, day, dayOfWeekIndex, time);
                return;
            }
            logJob('Executing temperature adjustment job', side, day, dayOfWeekIndex, time);
            await updateDeviceStatus({
                [side]: {
                    targetTemperatureF: temperature,
                }
            }, { background: true });
            serverStatus.status.temperatureSchedule.status = 'healthy';
            serverStatus.status.temperatureSchedule.message = '';
        }
        catch (error) {
            serverStatus.status.temperatureSchedule.status = 'failed';
            const message = error instanceof Error ? error.message : String(error);
            serverStatus.status.temperatureSchedule.message = message;
            logger.error(error);
        }
    });
};
export const scheduleTemperatures = (settingsData, side, day, temperatures, power) => {
    if (!power.enabled)
        return;
    if (settingsData[side].awayMode)
        return;
    const { timeZone } = settingsData;
    if (timeZone === null)
        return;
    Object.entries(temperatures).forEach(([time, temperature]) => {
        scheduleAdjustment(timeZone, side, day, time, temperature, power.on);
    });
};
//# sourceMappingURL=temperatureScheduler.js.map