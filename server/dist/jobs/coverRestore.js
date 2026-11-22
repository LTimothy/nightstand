// Decides when the cover service may be restarted, and restarts it.
import fsp from 'fs/promises';
import moment from 'moment-timezone';
import config from '../config.js';
import logger from '../logger.js';
import settingsDB from '../db/settings.js';
import { Version } from '../routes/deviceStatus/deviceStatusSchema.js';
import { lastDeviceStatus } from '../8sleep/lastDeviceStatus.js';
import { isFrankenConnected } from '../8sleep/frankenServer.js';
import { SILENT_MS, coverVerdict } from '../8sleep/coverHealth.js';
import { activeAlarms, hasSnooze } from './activeAlarms.js';
import { alarmStarting } from './alarmScheduler.js';
import { alarmActivityWithin } from './alarmActivity.js';
import { alarmsDueWithin } from './alarmLedger.js';
import { OperationBusyError, assertOperationsIdle, holdOperations, rebootPending, runPrivilegedCommand } from './privilegedCommand.js';
export const COVER_RESTORE_STAMP = '/persistent/nightstand-logs/cover-restore.stamp';
export const ALARM_GUARD_MS = 10 * 60_000;
export const RESTORE_INTERVAL_MS = 60 * 60_000;
const clock = (at) => moment(at).format('h:mm A');
// One silent episode lasts until the side reports again.
let triedAt = null;
// The reason a restart may not run now, or null when it may. '' blocks with no note.
export function restoreBlocker(context) {
    const { verdict, now, lastAttemptAt, triedThisEpisode } = context;
    if (!context.podFive || !context.frankenConnected)
        return 'Restarting the cover service is not offered on this Pod.';
    if (verdict.kind !== 'silent')
        return '';
    if (context.alarmNear !== false)
        return 'Not while an alarm is ringing or due in the next 10 minutes.';
    if (context.priming !== false)
        return 'Not while the Pod is priming.';
    if (context.operationBusy)
        return 'Not while an update, rollback or restart is under way.';
    const ago = lastAttemptAt === null ? Infinity : now - lastAttemptAt;
    // Still silent well after a restart: another one is unlikely to help.
    const didNotHelp = lastAttemptAt === null
        ? 'The restart did not bring it back. Restart the Pod from Settings.'
        : `The restart at ${clock(lastAttemptAt)} did not bring it back. Restart the Pod from Settings.`;
    if (triedThisEpisode && ago >= SILENT_MS)
        return didNotHelp;
    if (lastAttemptAt !== null && ago < RESTORE_INTERVAL_MS) {
        return `Restarted at ${clock(lastAttemptAt)}. It can run again after ${clock(lastAttemptAt + RESTORE_INTERVAL_MS)}.`;
    }
    if (context.source === 'auto' && triedThisEpisode)
        return didNotHelp;
    return null;
}
const SIDES = ['left', 'right'];
async function stampTime() {
    try {
        return (await fsp.stat(COVER_RESTORE_STAMP)).mtimeMs;
    }
    catch {
        return null;
    }
}
export async function gatherContext(verdict, source) {
    const now = Date.now();
    const status = lastDeviceStatus();
    const until = new Date(now + ALARM_GUARD_MS);
    const due = alarmsDueWithin(new Date(now), ALARM_GUARD_MS);
    const ringing = SIDES.some(side => activeAlarms.has(side) || hasSnooze(side) || alarmStarting(side) || alarmActivityWithin(side, until));
    let operationBusy = rebootPending();
    try {
        await assertOperationsIdle();
    }
    catch {
        operationBusy = true;
    }
    const stamped = await stampTime();
    return {
        verdict, now, source,
        podFive: status?.hubVersion === Version.Pod5,
        frankenConnected: isFrankenConnected(),
        alarmNear: ringing || due.alarms.length > 0 ? true : due.known ? false : 'unknown',
        priming: status ? status.isPriming : 'unknown',
        operationBusy,
        lastAttemptAt: stamped,
        triedThisEpisode: false,
    };
}
// The episode is this process's memory; the stamp outlives a server restart.
const withEpisode = (context) => ({
    ...context, lastAttemptAt: context.lastAttemptAt ?? triedAt, triedThisEpisode: triedAt !== null,
});
// Literal command, so setupServicesScript.test.ts can match it to its sudo rule.
const runScript = async () => {
    if (config.remoteDevMode)
        return;
    await runPrivilegedCommand(['/bin/bash', '/usr/local/lib/nightstand/live/scripts/cover_restore.sh'], 'frank.service', { timeout: 60_000, action: 'restart' });
};
const autoOn = async () => {
    await settingsDB.read();
    return settingsDB.data.features.coverAutoRestore;
};
const defaultDeps = { gather: gatherContext, run: runScript, autoOn, hold: holdOperations };
export async function restoreCover(source, deps = {}, verdict = coverVerdict()) {
    const { gather, run, hold } = { ...defaultDeps, ...deps };
    if (verdict.kind !== 'silent' && verdict.kind !== 'bothSilent') {
        throw new OperationBusyError('Both sides of the cover are reporting, so there is nothing to restart.');
    }
    const blocker = restoreBlocker(withEpisode(await gather(verdict, source)));
    if (blocker !== null) {
        logger.info(`[coverHealth] restart refused (${source}): ${blocker || 'both sides silent'}`);
        throw new OperationBusyError(blocker || 'Restarting the cover service does not help when both sides are silent.');
    }
    if (verdict.kind !== 'silent')
        return;
    logger.info(`[coverHealth] restarting frank (${source}): ${verdict.side} side silent since ${clock(verdict.since)}`);
    try {
        // Re-checked under the hold, so an update that started after gather cannot overlap the restart.
        await hold(async () => {
            triedAt = Date.now();
            await run();
        });
    }
    catch (error) {
        logger.warn(`[coverHealth] restart failed (${source}): ${error instanceof Error ? error.message : String(error)}`);
        throw error;
    }
}
// What the Cover sensors row offers, after an automatic restart when that is on and allowed.
export async function evaluateRestore(verdict, deps = {}) {
    const all = { ...defaultDeps, ...deps };
    // Only real readings from both sides end the episode; a gap in the records does not.
    if (verdict.kind === 'ok' && !verdict.stale)
        triedAt = null;
    if (verdict.kind !== 'silent' && verdict.kind !== 'bothSilent')
        return null;
    let context = withEpisode(await all.gather(verdict, 'button'));
    if (verdict.kind === 'silent' && restoreBlocker({ ...context, source: 'auto' }) === null && await all.autoOn()) {
        // restoreCover logs a failure; the row then shows the hourly note.
        await restoreCover('auto', all, verdict).catch(() => { });
        context = withEpisode(await all.gather(verdict, 'button'));
    }
    const note = restoreBlocker(context);
    return { available: note === null, note: note ?? '' };
}
// Test isolation only.
export function resetCoverRestore() {
    triedAt = null;
}
//# sourceMappingURL=coverRestore.js.map