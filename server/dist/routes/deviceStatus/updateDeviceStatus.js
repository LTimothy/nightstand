import _ from 'lodash';
import cbor from 'cbor';
import { MAX_ON_DURATION_SECONDS, MIN_TEMPERATURE_F, MAX_TEMPERATURE_F } from './deviceStatusSchema.js';
import { executeFunction } from '../../8sleep/deviceApi.js';
import { dismissAlarm } from '../../8sleep/dismissAlarm.js';
import { FrankenSupersededError } from '../../8sleep/frankenErrors.js';
import logger from '../../logger.js';
import settingsDB from '../../db/settings.js';
import memoryDB from '../../db/memoryDB.js';
import { INVERTED_SETTINGS_KEY_MAPPING } from '../../8sleep/loadDeviceStatus.js';
import { forgetKeptAlarms } from '../../jobs/rhythms/keptAlarms.js';
import { forgetActiveAlarm } from '../../jobs/activeAlarms.js';
import { firmwareSecondsUntil } from '../../jobs/firmwareTimer.js';
// Inverse of loadDeviceStatus.ts's calculateTempInF. Same fixed firmware
// level scale, so the two files must be changed together.
const calculateLevelFromF = (temperatureF) => {
    const level = (temperatureF - 82.5) / 27.5 * 100;
    return Math.round(level).toString();
};
const updateSide = async (side, sideStatus, options, onUntil) => {
    await settingsDB.read();
    const settings = settingsDB.data;
    if (side === 'left') {
        if (settings.left.awayMode) {
            logger.warn('Left side is in away mode, not updating side');
        }
    }
    else {
        if (settings.right.awayMode) {
            logger.warn('Right side is in away mode, not updating side');
        }
    }
    const controlBothSides = settings.left.awayMode || settings.right.awayMode;
    const updateLeft = side === 'left' || controlBothSides;
    const updateRight = side === 'right' || controlBothSides;
    const { isOn, targetTemperatureF, secondsRemaining, isAlarmVibrating } = sideStatus;
    // Scheduled power and set point changes stay correct when applied late, so
    // they wait out an outage; only the newest one per setting is applied.
    const stateOptions = { ...options, latest: true };
    if (controlBothSides) {
        logger.debug('One side is in away mode, updating both sides...');
    }
    if (onUntil && !Number.isFinite(onUntil.getTime())) {
        logger.warn(`Ignoring an invalid end for the ${side} side, using the ${MAX_ON_DURATION_SECONDS} s default`);
        onUntil = undefined;
    }
    if (isOn && onUntil) {
        const until = onUntil.getTime();
        const onDuration = () => String(firmwareSecondsUntil(onUntil, new Date()));
        const timedOptions = { ...stateOptions, notAfter: Math.min(until, stateOptions.notAfter ?? until) };
        if (updateLeft)
            await executeFunction('LEFT_TEMP_DURATION', onDuration, timedOptions);
        if (updateRight)
            await executeFunction('RIGHT_TEMP_DURATION', onDuration, timedOptions);
    }
    else if (isOn !== undefined) {
        const onDuration = isOn ? String(MAX_ON_DURATION_SECONDS) : '0';
        if (updateLeft)
            await executeFunction('LEFT_TEMP_DURATION', onDuration, stateOptions);
        if (updateRight)
            await executeFunction('RIGHT_TEMP_DURATION', onDuration, stateOptions);
        // A side turned off ends the sleep it was kept on for.
        if (!isOn) {
            if (updateLeft)
                forgetKeptAlarms('left');
            if (updateRight)
                forgetKeptAlarms('right');
        }
    }
    if (targetTemperatureF !== undefined) {
        const boundedTemperatureF = Math.max(MIN_TEMPERATURE_F, Math.min(MAX_TEMPERATURE_F, targetTemperatureF));
        const level = calculateLevelFromF(boundedTemperatureF);
        if (updateLeft)
            await executeFunction('TEMP_LEVEL_LEFT', level, stateOptions);
        if (updateRight)
            await executeFunction('TEMP_LEVEL_RIGHT', level, stateOptions);
    }
    if (secondsRemaining) {
        const seconds = Math.round(secondsRemaining).toString();
        if (updateLeft)
            await executeFunction('LEFT_TEMP_DURATION', seconds, stateOptions);
        if (updateRight)
            await executeFunction('RIGHT_TEMP_DURATION', seconds, stateOptions);
    }
    if (isAlarmVibrating !== undefined) {
        logger.debug('Can only set isAlarmVibrating to false for now...');
        if (!isAlarmVibrating) {
            await dismissAlarm(side, options);
            forgetActiveAlarm(side);
        }
        await memoryDB.read();
        memoryDB.data[side].isAlarmVibrating = false;
        await memoryDB.write();
    }
};
const updateSettings = async (settings, options) => {
    const renamedSettings = _.mapKeys(settings, (value, key) => INVERTED_SETTINGS_KEY_MAPPING[key] || key);
    const encodedBuffer = cbor.encode(renamedSettings);
    const hexString = encodedBuffer.toString('hex');
    await executeFunction('SET_SETTINGS', hexString, options);
};
// Scheduled callers pass { background: true } to wait longer for the hardware. Resolves false when a newer update replaced it.
export const updateDeviceStatus = async (deviceStatus, updateOptions = {}) => {
    logger.info(`Updating device status..`);
    const { onUntil, ...options } = updateOptions;
    try {
        if (deviceStatus.isPriming === true)
            await executeFunction('PRIME', 'empty', options);
        if (deviceStatus?.left)
            await updateSide('left', deviceStatus.left, options, onUntil);
        if (deviceStatus?.right)
            await updateSide('right', deviceStatus.right, options, onUntil);
        if (deviceStatus?.settings)
            await updateSettings(deviceStatus.settings, options);
    }
    catch (error) {
        if (!(error instanceof FrankenSupersededError))
            throw error;
        logger.info('Dropped an update replaced by a newer one while the Pod was unreachable');
        return false;
    }
    logger.info('Finished updating device status');
    return true;
};
//# sourceMappingURL=updateDeviceStatus.js.map