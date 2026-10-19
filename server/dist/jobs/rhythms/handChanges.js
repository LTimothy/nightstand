// Notes for suggestions from hand changes: one JSON line per hand change
// during a Rhythms sleep and per Rhythms power-on. Kept next to the lowdb
// folder, never inside it, so the job watcher ignores it.
import { createHash, randomUUID } from 'node:crypto';
import { appendFile, readFile, rm } from 'node:fs/promises';
import moment from 'moment-timezone';
import config from '../../config.js';
import logger from '../../logger.js';
import settingsDB from '../../db/settings.js';
import { levelAt, levelToF, phaseAt } from '../../db/smartCurve.js';
import { minutesAfterOn } from '../../db/rhythmWake.js';
import { NOTE_DAYS } from '../../db/suggestionRules.js';
import { MAX_TEMPERATURE_F, MIN_TEMPERATURE_F } from '../../routes/deviceStatus/deviceStatusSchema.js';
import { isSchedulePaused } from '../schedulePause.js';
import { isTempScheduleOverridden } from '../scheduleOverride.js';
import { currentSleep, drivingSide, engineActivation, scheduledTemperatureNow } from '../scheduleQueries.js';
import { smartCurveStatus, smartTemperatureGate } from './curveController.js';
import { appendPruned } from './history.js';
import { canonicalJson } from './night.js';
import { parseLine, } from './learn.js';
export const CHANGES_FILE_NAME = 'rhythms-changes.jsonl';
export const changesPath = () => `${config.dbFolder}${CHANGES_FILE_NAME}`;
const DAY = 24 * 60 * 60 * 1000;
// Any edit to the bedtime, the on temperature, a step or the Smart base gives a new key, and the evidence restarts.
export function planKeyOf(night, mode, baseLevel) {
    const plan = { on: night.power.on, onF: night.power.onTemperature, t: night.temperatures, base: mode === 'smart' ? baseLevel : null };
    return createHash('sha256').update(canonicalJson(plan)).digest('hex').slice(0, 12);
}
export const rhythmPlanKey = (rhythm) => planKeyOf(rhythm.night, rhythm.temperatureMode, rhythm.smart.baseLevel);
export const noteId = () => randomUUID().replace(/-/g, '').slice(0, 12);
const messageOf = (error) => (error instanceof Error ? error.message : String(error));
const warn = (error) => logger.warn(`suggestions: notes not written: ${messageOf(error)}`);
// Every write and the delete go through one queue, so they never interleave.
let chain = Promise.resolve();
function enqueue(task) {
    const run = chain.then(task);
    chain = run.catch(() => { });
    return run;
}
export const flushHandChanges = () => chain;
const appendLines = (lines) => appendFile(changesPath(), lines.map(line => `${JSON.stringify(line)}\n`).join(''), 'utf8');
export function appendNoteLines(lines) {
    return enqueue(() => appendLines(lines));
}
export function forgetHandChanges() {
    return enqueue(async () => {
        await rm(changesPath(), { force: true });
        await rm(`${changesPath()}.tmp`, { force: true });
    });
}
export async function readChanges() {
    let text = '';
    try {
        text = await readFile(changesPath(), 'utf8');
    }
    catch (error) {
        if (error.code !== 'ENOENT')
            throw error;
    }
    return text.split('\n').flatMap(line => {
        const parsed = line.trim() ? parseLine(line) : null;
        return parsed ? [parsed] : [];
    });
}
// A line this version cannot read may belong to a later release, so only non-JSON is dropped.
function isJsonObject(text) {
    try {
        const value = JSON.parse(text);
        return typeof value === 'object' && value !== null && !Array.isArray(value);
    }
    catch {
        return false;
    }
}
// A refusal must not quietly expire, so dismissals stay while their rhythm exists.
function keepFor(now) {
    const cutoff = now.getTime() - NOTE_DAYS * DAY;
    const engine = engineActivation();
    return text => {
        const line = parseLine(text);
        if (!line)
            return isJsonObject(text);
        if (line.kind === 'dismiss' || line.kind === 'restore') {
            return !engine.active || Object.hasOwn(engine.db[line.side].rhythms, line.rhythmId);
        }
        return Date.parse(line.at) >= cutoff;
    };
}
export function recordNight(side, sleep, now = new Date()) {
    try {
        if (settingsDB.data.features?.rhythmSuggestions !== true || !sleep.rhythmId)
            return;
        const line = {
            v: 1, kind: 'night', at: now.toISOString(), side, rhythmId: sleep.rhythmId, mode: sleep.mode,
            planKey: planKeyOf(sleep.night, sleep.mode, sleep.smart?.baseLevel ?? 0), date: sleep.date,
            sleepStart: sleep.start.toISOString(), sleepEnd: sleep.end.toISOString(),
        };
        void enqueue(() => appendPruned(changesPath(), keepFor(now), [JSON.stringify(line)])).catch(warn);
    }
    catch (error) {
        warn(error);
    }
}
// What the scheduler wrote during a Rhythms sleep, so the cards can draw what the bed was set to. The Smart
// controller's writes pass no sleep and are matched to the one in progress. Never throws.
export function recordSet(side, sleep, targetF, reason, now = new Date()) {
    try {
        const settings = settingsDB.data;
        if (settings.features?.rhythmSuggestions !== true || !settings.timeZone || !engineActivation().active)
            return;
        if (isSchedulePaused(settings, side, now))
            return;
        const night = sleep ?? currentSleep(side, now);
        if (!night?.rhythmId)
            return;
        const line = {
            v: 1, kind: 'set', at: now.toISOString(), side, rhythmId: night.rhythmId,
            planKey: planKeyOf(night.night, night.mode, night.smart?.baseLevel ?? 0), date: night.date,
            targetF: targetF === null ? null : Math.round(Math.min(MAX_TEMPERATURE_F, Math.max(MIN_TEMPERATURE_F, targetF))), reason,
        };
        void enqueue(() => appendLines([line])).catch(warn);
    }
    catch (error) {
        warn(error);
    }
}
// The level a Smart vote is measured against: the first hold point, else the last cool-down point.
function nightLevelF(points, baseLevel) {
    const level = points.find(point => point.phase === 'hold') ?? points.filter(point => point.phase === 'cooldown').at(-1);
    return levelToF(level?.level ?? baseLevel);
}
function changeLine(settings, side, change, now) {
    if (settings.features?.rhythmSuggestions !== true || !settings.timeZone)
        return null;
    const driver = drivingSide(settings, side);
    if (!driver || isSchedulePaused(settings, driver, now) || !engineActivation().active)
        return null;
    const sleep = currentSleep(driver, now);
    if (!sleep?.rhythmId || change.on === false)
        return null;
    const targetF = Math.round(Math.min(MAX_TEMPERATURE_F, Math.max(MIN_TEMPERATURE_F, change.targetF)));
    const baseLevel = sleep.smart?.baseLevel ?? 0;
    const curve = sleep.mode === 'smart' && sleep.smartCurve ? sleep.smartCurve.points : null;
    const curveF = curve ? levelToF(levelAt(curve, now) ?? baseLevel) : null;
    const plannedF = curve === null ? scheduledTemperatureNow(driver, now)
        : smartTemperatureGate(driver, sleep.date, now) === 'base' ? levelToF(baseLevel) : curveF;
    if (plannedF === null)
        return null;
    // The app's power button sends the schedule's own temperature with the power-on.
    if (change.setsOn && (targetF === plannedF || targetF === curveF))
        return null;
    const holdUntil = curve ? smartCurveStatus(driver, now)?.holdUntil ?? null : null;
    return {
        v: 1, kind: 'change', at: now.toISOString(), side: driver, rhythmId: sleep.rhythmId, mode: sleep.mode,
        planKey: planKeyOf(sleep.night, sleep.mode, baseLevel), date: sleep.date,
        sleepStart: sleep.start.toISOString(), sleepEnd: sleep.end.toISOString(),
        // On the bedtime clock, as suggestedTime reads it, so a clock change does not shift the hour.
        offsetMin: minutesAfterOn(moment.tz(now, settings.timeZone).format('HH:mm'), sleep.night.power.on),
        plannedF,
        holdF: curve ? nightLevelF(curve, baseLevel) : null,
        fromF: change.fromF === null ? null : Math.round(change.fromF),
        targetF,
        phase: curve ? phaseAt(curve, now) : null,
        held: curve ? holdUntil !== null && holdUntil.getTime() > now.getTime() : isTempScheduleOverridden(driver),
        source: change.source,
    };
}
// Builds the line now and writes it later, so the device write never waits on the file.
export function recordHandChange(side, change, now = new Date()) {
    try {
        const line = changeLine(settingsDB.data, side, change, now);
        if (line)
            void enqueue(() => appendLines([line])).catch(warn);
    }
    catch (error) {
        warn(error);
    }
}
//# sourceMappingURL=handChanges.js.map