import logger from '../../logger.js';
import { levelToF } from '../../db/smartCurve.js';
import { getPresenceData } from '../../routes/metrics/presence.js';
import { updateDeviceStatus } from '../../routes/deviceStatus/updateDeviceStatus.js';
import { recordSet } from './handChanges.js';
import { isSchedulePaused } from '../schedulePause.js';
import { applyAlarmsEnabled, resolveSleeps } from './resolve.js';
import { isAlarmOverridden } from './gates.js';
import { appendHistory } from './history.js';
import { estimateOnset, ONSET_BASELINE_DAYS } from './onsetEstimate.js';
import { smartResolveHooks, startCurveController, stopCurveController, } from './curveController.js';
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
export const CURVE_TICK_MS = MINUTE;
let plan = null;
let timer = null;
let retimeJobs = () => { };
async function loadHeartRatesFromDb(side, from, to) {
    const { prisma } = await import('../../db/prisma.js');
    const rows = await prisma.vitals.findMany({
        where: { side, timestamp: { gte: Math.floor(from.getTime() / 1000), lte: Math.floor(to.getTime() / 1000) } },
        orderBy: { timestamp: 'asc' },
        select: { timestamp: true, heart_rate: true },
    });
    return rows.map(row => ({ at: row.timestamp * 1000, hr: row.heart_rate }));
}
// Adds the onset estimate, then appends. Never throws.
export async function recordSleepHistory(summary, loadHeartRates = loadHeartRatesFromDb, historyFile) {
    let onsetEstimate = null;
    let onsetNote = 'no-vitals';
    try {
        const bedtime = Date.parse(summary.plannedBedtime);
        const nightFrom = new Date(bedtime - 60 * MINUTE);
        const night = await loadHeartRates(summary.side, nightFrom, new Date(summary.plannedWake));
        const baseline = await loadHeartRates(summary.side, new Date(bedtime - ONSET_BASELINE_DAYS * DAY), nightFrom);
        const result = estimateOnset(night, baseline);
        onsetEstimate = result.at === null ? null : new Date(result.at).toISOString();
        onsetNote = result.note;
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(`smart schedule: onset estimate skipped: ${message}`);
        onsetNote = 'vitals-error';
    }
    await appendHistory({ ...summary, onsetEstimate, onsetNote }, historyFile ? { path: historyFile } : {});
}
// Alarms that will not ring, off for the side or skipped by an override, do
// not hold back an early off. An override's replacement time is its own job.
export function ringableAlarms(sleeps, settings, side, now) {
    return applyAlarmsEnabled(sleeps, settings[side].alarmsEnabled !== false).map(sleep => (isAlarmOverridden(settings, side, sleep, now)
        ? { ...sleep, events: sleep.events.filter(event => event.kind !== 'alarm') }
        : sleep));
}
export function curveDeps(retime, smartOff) {
    return {
        now: () => new Date(),
        presence: () => getPresenceData(),
        awayMode: () => ({ left: !!plan?.settings.left.awayMode, right: !!plan?.settings.right.awayMode }),
        isPaused: (side, now) => (plan ? isSchedulePaused(plan.settings, side, now) : false),
        sleeps: (side, from, to) => {
            if (!plan?.settings.timeZone)
                return [];
            const sleeps = resolveSleeps({ db: plan.db, side, timeZone: plan.settings.timeZone, from, to, ...smartResolveHooks });
            return ringableAlarms(sleeps, plan.settings, side, new Date());
        },
        // Scheduled work: waits out a reconnect, where a newer set point for the
        // side replaces it. Not awaited, so a waiting write never stalls the tick.
        applyLevel: async (side, level, reason) => {
            const update = { [side]: { targetTemperatureF: levelToF(level) } };
            void updateDeviceStatus(update, { background: true })
                .then(written => { if (written !== false)
                recordSet(side, null, levelToF(level), reason); })
                .catch((error) => {
                const message = error instanceof Error ? error.message : String(error);
                logger.warn(`smart schedule: could not set the ${side} level: ${message}`);
            });
        },
        retime,
        recordHistory: summary => recordSleepHistory(summary),
        ...(smartOff ? { smartOff } : {}),
    };
}
// The job scheduler registers its rebuild here once at load.
export function setCurveRetime(retime) {
    retimeJobs = retime;
}
export function syncCurvePlan(settings, db) {
    plan = { settings, db };
}
export function startCurveRuntime(smartOff) {
    if (timer)
        return;
    const controller = startCurveController(curveDeps(() => retimeJobs(), smartOff));
    // A slow tick (the history append at power off) must not overlap the next.
    let ticking = false;
    timer = setInterval(() => {
        if (ticking)
            return;
        ticking = true;
        controller.tick().catch((error) => {
            const message = error instanceof Error ? error.message : String(error);
            logger.error(`smart schedule: tick failed: ${message}`);
        }).finally(() => { ticking = false; });
    }, CURVE_TICK_MS);
    // The server stays up for its own reasons; this timer must not keep a process alive.
    timer.unref();
    logger.info('smart schedule: controller started');
}
export function stopCurveRuntime() {
    if (!timer)
        return;
    clearInterval(timer);
    timer = null;
    plan = null;
    stopCurveController();
    logger.info('smart schedule: controller stopped');
}
//# sourceMappingURL=curveRuntime.js.map