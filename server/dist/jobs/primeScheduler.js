import schedule from 'node-schedule';
import logger from '../logger.js';
import { updateDeviceStatus } from '../routes/deviceStatus/updateDeviceStatus.js';
import { executeCalibrateSensors } from './calibrateSensors.js';
import moment from 'moment-timezone';
import settingsDB from '../db/settings.js';
import serverStatus from '../serverStatus.js';
import servicesDB from '../db/services.js';
import reboot from './reboot.js';
import { rebootClock } from './rebootTime.js';
import { connectFrankenWithin } from '../8sleep/frankenServer.js';
import { wait } from '../8sleep/promises.js';
import eventBus from '../events/eventBus.js';
import { OperationCheckError, PrivilegedCommandError } from './privilegedCommand.js';
import { runMetricsRetention } from './runMetricsRetention.js';
const scheduleRebootJob = (onHour, onMinute, timeZone) => {
    const dailyRule = new schedule.RecurrenceRule();
    dailyRule.hour = onHour;
    dailyRule.minute = onMinute;
    dailyRule.tz = timeZone;
    const time = `${String(onHour).padStart(2, '0')}:${String(onMinute).padStart(2, '0')}`;
    logger.debug(`Scheduling daily reboot job at ${time}`);
    schedule.scheduleJob(`daily-reboot-${time}`, dailyRule, async () => {
        try {
            await settingsDB.read();
            if (!settingsDB.data.rebootDaily) {
                logger.info('Daily reboot job is disabled, skipping...');
                return;
            }
            logger.info(`Executing scheduled reboot job`);
            await reboot();
            serverStatus.status.rebootSchedule.status = 'healthy';
            serverStatus.status.rebootSchedule.message = '';
        }
        catch (error) {
            if (error instanceof PrivilegedCommandError) {
                if (error instanceof OperationCheckError)
                    logger.warn(`Skipping daily reboot: ${error.message}`);
                else
                    logger.info(`Skipping daily reboot: ${error.message}`);
                return;
            }
            serverStatus.status.rebootSchedule.status = 'failed';
            const message = error instanceof Error ? error.message : String(error);
            serverStatus.status.rebootSchedule.message = message;
            logger.error(error);
        }
    });
};
const scheduleCalibrationJob = (onHour, onMinute, timeZone, side) => {
    const dailyRule = new schedule.RecurrenceRule();
    dailyRule.hour = onHour;
    dailyRule.minute = onMinute;
    dailyRule.tz = timeZone;
    const time = `${String(onHour).padStart(2, '0')}:${String(onMinute).padStart(2, '0')}`;
    logger.debug(`Scheduling daily calibration job at ${time} for ${side}`);
    schedule.scheduleJob(`daily-calibration-${time}-${side}`, dailyRule, async () => {
        await servicesDB.read();
        if (!servicesDB.data.biometrics.enabled) {
            logger.debug('Not executing calibration job, biometrics is disabled');
            return;
        }
        logger.info(`Executing scheduled calibration job for ${side}`);
        executeCalibrateSensors(side, moment().subtract(6, 'hours').toISOString(), moment().toISOString());
    });
};
// Retention can take minutes on a low-disk day, so it runs an hour before calibration.
// It steps back an hour at a time until it is 30+ minutes from the reboot and prime times.
const retentionClock = (primeTime) => {
    const busy = primeTime ? [primeTime, `${rebootClock(primeTime).hour}:${rebootClock(primeTime).minute}`] : [];
    const minutes = busy.map((t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; });
    for (let hour = 17; hour >= 0; hour--) {
        const at = hour * 60 + 30;
        if (minutes.every((m) => Math.min(Math.abs(m - at), 1440 - Math.abs(m - at)) >= 30))
            return { hour, minute: 30 };
    }
    return { hour: 17, minute: 30 };
};
const scheduleRetentionJob = (timeZone, primeTime) => {
    const dailyRule = new schedule.RecurrenceRule();
    const { hour, minute } = retentionClock(primeTime);
    dailyRule.hour = hour;
    dailyRule.minute = minute;
    dailyRule.tz = timeZone;
    schedule.scheduleJob('daily-metrics-retention', dailyRule, () => runMetricsRetention());
};
// Calibration runs at a fixed time of day, decoupled from the prime time.
// 18:30 / 19:00 was empirically chosen because it's reliably bed-empty for
// this user. The presence guard in calibrate_sensor_thresholds.py also
// aborts if anyone is on the bed at the scheduled time.
const CALIBRATE_LEFT_HOUR = 18;
const CALIBRATE_LEFT_MINUTE = 30;
const CALIBRATE_RIGHT_HOUR = 19;
const CALIBRATE_RIGHT_MINUTE = 0;
export const schedulePrimingRebootAndCalibration = (settingsData) => {
    const { timeZone, primePodDaily } = settingsData;
    if (timeZone === null)
        return;
    // Calibration does not depend on priming; each run checks that biometrics
    // is on and that the bed is empty.
    scheduleCalibrationJob(CALIBRATE_LEFT_HOUR, CALIBRATE_LEFT_MINUTE, timeZone, 'left');
    scheduleCalibrationJob(CALIBRATE_RIGHT_HOUR, CALIBRATE_RIGHT_MINUTE, timeZone, 'right');
    scheduleRetentionJob(timeZone, primePodDaily.enabled ? primePodDaily.time : undefined);
    if (!primePodDaily.enabled)
        return;
    const dailyRule = new schedule.RecurrenceRule();
    const { time } = primePodDaily;
    const [onHour, onMinute] = time.split(':').map(Number);
    dailyRule.hour = onHour;
    dailyRule.minute = onMinute;
    dailyRule.tz = timeZone;
    const restart = rebootClock(time);
    scheduleRebootJob(restart.hour, restart.minute, timeZone);
    logger.debug(`Scheduling daily prime job at ${primePodDaily.time}`);
    schedule.scheduleJob(`daily-priming-${time}`, dailyRule, async () => {
        try {
            logger.info(`Executing scheduled prime job`);
            serverStatus.status.primeSchedule.status = 'started';
            serverStatus.status.primeSchedule.message = 'Waiting for priming confirmation';
            eventBus.emit('service-health', { primeSchedule: serverStatus.status.primeSchedule });
            await updateDeviceStatus({ isPriming: true }, { background: true });
            await wait(30_000);
            const connection = await connectFrankenWithin();
            const status = await connection.getDeviceStatus();
            if (!status.isPriming)
                throw new Error('The Pod did not report priming after the daily prime command');
            serverStatus.status.primeSchedule.status = 'healthy';
            serverStatus.status.primeSchedule.message = '';
        }
        catch (error) {
            serverStatus.status.primeSchedule.status = 'failed';
            const message = error instanceof Error ? error.message : String(error);
            serverStatus.status.primeSchedule.message = message;
            logger.error(error);
        }
        finally {
            eventBus.emit('service-health', { primeSchedule: serverStatus.status.primeSchedule });
        }
    });
};
//# sourceMappingURL=primeScheduler.js.map