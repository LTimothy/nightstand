import path from 'path';
import chokidar from 'chokidar';
import moment from 'moment-timezone';
import schedule from 'node-schedule';

import config from '../config.js';
import logger from '../logger.js';
import schedulesDB from '../db/schedules.js';
import serverStatus from '../serverStatus.js';
import settingsDB from '../db/settings.js';
import { SCHEDULE_SIDES, SCHEDULE_DAYS } from '../db/scheduleKeys.js';
import { isSystemDateValid } from './isSystemDateValid.js';
import { readNtpSynchronization } from './clockSynchronization.js';
import { scheduleAlarm, scheduleAlarmOverride, scheduleOneOffAlarm } from './alarmScheduler.js';
import { schedulePowerOff, schedulePowerOn, scheduleSleepAnalysis } from './powerScheduler.js';
import { schedulePrimingRebootAndCalibration } from './primeScheduler.js';
import { scheduleWeeklyRearm } from './weeklyRearm.js';
import { scheduleTemperatures } from './temperatureScheduler.js';
import { schedulePauseResume } from './pauseResume.js';
import eventBus from '../events/eventBus.js';
import { emitJobEvent } from './jobEvents.js';
import { isScheduleDbChange } from './isScheduleDbChange.js';
import { setRebuilding } from './rebuildState.js';
import { loadRhythms, type RhythmsLoad } from '../db/rhythms.js';
import type { Side } from '../db/schedulesSchema.js';
import { activation, type Activation } from './rhythms/activation.js';
import { dropKeptAlarms, keptAlarmsGeneration } from './rhythms/keptAlarms.js';
import { scheduleKeptAlarms, scheduleRhythms, type RhythmsPlan } from './rhythms/scheduleRhythms.js';
import { reportRhythmsStatus } from './rhythms/rhythmsStatus.js';
import { setCurveRetime, startCurveRuntime, stopCurveRuntime, syncCurvePlan } from './rhythms/curveRuntime.js';
import { smartOffRuntime } from './rhythms/smartOffRuntime.js';
import { setEngineActivation, sleepAround } from './scheduleQueries.js';
import { startAlarmLedger, alarmLedgerHeartbeat } from './alarmLedger.js';


// Under Rhythms a replacement alarm belongs to the resolved sleep around it.
const rhythmSleepAt = (side: Side) => (at: Date) => sleepAround(side, at);

async function rebuildJobs() {
  try {
    serverStatus.status.jobs.status = 'started';


    // Clear existing jobs
    logger.info('Canceling old jobs...');
    Object.keys(schedule.scheduledJobs).forEach((jobName) => {
      schedule.cancelJob(jobName);
    });

    // A turn off that saved after this read keeps its alarms for the next pass.
    const keptUpTo = keptAlarmsGeneration();
    await settingsDB.read();
    await schedulesDB.read();

    moment.tz.setDefault(settingsDB.data.timeZone || 'UTC');

    const schedulesData = schedulesDB.data;
    const settingsData = settingsDB.data;
    const load = settingsData.features.rhythms
      ? await loadRhythms().catch((error: unknown): RhythmsLoad => ({ state: 'invalid', error: String(error) }))
      : null;
    const engine: Activation = load ? activation(settingsData, load, schedulesData) : { active: false, reason: 'flag-off' };
    setEngineActivation(engine);
    // Before anything below can throw, so Smart Schedule follows the engine.
    if (engine.active) {
      startCurveRuntime(smartOffRuntime());
      syncCurvePlan(settingsData, engine.db);
    } else {
      stopCurveRuntime();
    }

    logger.info('Scheduling jobs...');
    schedulePauseResume(settingsData, 'left');
    schedulePauseResume(settingsData, 'right');
    scheduleAlarmOverride(settingsData, 'left', engine.active ? rhythmSleepAt('left') : undefined);
    scheduleAlarmOverride(settingsData, 'right', engine.active ? rhythmSleepAt('right') : undefined);
    if (settingsData.features.oneOffAlarms) {
      scheduleOneOffAlarm(settingsData, 'left');
      scheduleOneOffAlarm(settingsData, 'right');
    }
    let failedDays = 0;
    let plan: RhythmsPlan = { jobCount: 0, failedSides: [] };
    if (engine.active) {
      // Rhythms owns every per-day job and analyses each side after each sleep.
      plan = scheduleRhythms(settingsData, engine.db, new Date());
      logger.info(`Rhythms planned ${plan.jobCount} job(s)`);
    } else {
      // Sleep analysis runs daily per side, decoupled from power schedule:
      // a side that's being measured (biometrics on, person actually using
      // it) gets sleep records even when no temperature schedule is enabled
      // for that side. Was previously gated on power.enabled inside the
      // per-day loop, which silently skipped partners without heating
      // schedules.
      scheduleSleepAnalysis(settingsData, 'left');
      scheduleSleepAnalysis(settingsData, 'right');
      // Schedule each day independently. Old jobs are already cancelled by the
      // time we get here, so letting one malformed day throw would leave the pod
      // with no power, temperature or alarm jobs at all until something else
      // triggers a reschedule. Skip the bad day and keep the rest.
      SCHEDULE_SIDES.forEach(side => {
        SCHEDULE_DAYS.forEach(day => {
          try {
            const schedule = schedulesData[side][day];
            schedulePowerOn(settingsData, side, day, schedule.power);
            schedulePowerOff(settingsData, side, day, schedule.power);
            scheduleTemperatures(settingsData, side, day, schedule.temperatures, schedule.power);
            scheduleAlarm(settingsData, side, day, schedule);
          } catch (error: unknown) {
            failedDays += 1;
            const message = error instanceof Error ? error.message : String(error);
            logger.error(`Failed to schedule ${side} ${day}, skipping it: ${message}`);
          }
        });
        // The firmware end was set at power-on; an edit to tonight moves it.
        try {
          scheduleWeeklyRearm(settingsData, schedulesData, side);
        } catch (error: unknown) {
          logger.error(`Failed to plan the ${side} off time: ${error instanceof Error ? error.message : String(error)}`);
        }
      });
    }
    // A sleep left running when Rhythms was turned off keeps its alarms until
    // a rhythm engine is active again; that engine plans them itself.
    if (engine.active) dropKeptAlarms(keptUpTo);
    else scheduleKeptAlarms(new Date());
    schedulePrimingRebootAndCalibration(settingsData);
    reportRhythmsStatus(engine, plan, settingsData.timeZone);

    logger.info('Done scheduling jobs!');
    alarmLedgerHeartbeat(new Date());
    const failedSides = plan.failedSides.length;
    serverStatus.status.jobs.status = failedDays + failedSides > 0 ? 'failed' : 'healthy';
    if (failedSides > 0) {
      serverStatus.status.jobs.message = `Could not plan Rhythms for ${failedSides} side(s), check the Rhythms data`;
    } else {
      serverStatus.status.jobs.message = failedDays > 0
        ? `Skipped ${failedDays} unschedulable day(s), check the schedule data`
        : '';
    }
    // A fresh set of jobs starts clean, so drop any earlier failure text.
    const scheduleKeys = [
      'alarmSchedule', 'primeSchedule', 'powerSchedule', 'rebootSchedule', 'temperatureSchedule',
    ] as const;
    for (const key of scheduleKeys) {
      serverStatus.status[key].status = 'healthy';
      serverStatus.status[key].message = '';
    }
    emitJobEvent({ jobName: 'setupJobs', status: 'ok' });
    eventBus.emit('service-health', {
      jobs: serverStatus.status.jobs,
      alarmSchedule: serverStatus.status.alarmSchedule,
      primeSchedule: serverStatus.status.primeSchedule,
      powerSchedule: serverStatus.status.powerSchedule,
      rebootSchedule: serverStatus.status.rebootSchedule,
      temperatureSchedule: serverStatus.status.temperatureSchedule,
      rhythmsSchedule: serverStatus.status.rhythmsSchedule,
    });
  } catch (error: unknown) {
    serverStatus.status.jobs.status = 'failed';
    const message = error instanceof Error ? error.message : String(error);
    logger.error(error);
    serverStatus.status.jobs.message = message;
    emitJobEvent({ jobName: 'setupJobs', status: 'fail', message });
    eventBus.emit('service-health', { jobs: serverStatus.status.jobs });
  }
}

let setupRun: Promise<void> | null = null;
let setupRequested = false;
let clockReady = false;

// Coalesce changes during a rebuild, then read the latest files in another
// pass. A caller that awaits gets the pass that saw its change.
export function setupJobs(): Promise<void> {
  if (!clockReady) return Promise.resolve();
  setupRequested = true;
  if (setupRun) return setupRun;
  setupRun = (async () => {
    setRebuilding(true);
    try {
      do {
        setupRequested = false;
        await rebuildJobs();
      } while (setupRequested);
    } finally {
      setupRun = null;
      setRebuilding(false);
    }
  })();
  return setupRun;
}

let RETRY_COUNT = 0;
let alarmLedgerStarted = false;
let clockCheck: Promise<void> | null = null;
let clockRetry: ReturnType<typeof setTimeout> | undefined;
const FAST_RETRIES = 20;
const FAST_RETRY_MS = 5_000;
// The pod boots before NTP has corrected the clock, and a sync can take much
// longer than the fast retries cover. Giving up permanently left the pod with
// no jobs at all until someone edited a schedule, so keep checking slowly.
const SLOW_RETRY_MS = 5 * 60 * 1000;

// Clock synchronization is reported independently of the year floor that arms jobs.
async function checkClockAndSetupJobs() {
  if (isSystemDateValid()) {
    RETRY_COUNT = 0;
    if (!clockReady) {
      clockReady = true;
      logger.info('System date is valid. Setting up jobs...');
      if (!alarmLedgerStarted) {
        alarmLedgerStarted = true;
        startAlarmLedger(new Date());
      }
      await setupJobs();
    }
    const synchronized = config.remoteDevMode ? true : await readNtpSynchronization();
    let warning = '';
    if (synchronized === false) {
      warning = 'The Pod clock is not synchronized with NTP. Schedules are armed, but may run at the wrong time.';
    } else if (synchronized === undefined) {
      warning = 'NTP synchronization status is unavailable. Jobs are using the system date.';
    }
    if (warning && warning !== serverStatus.status.systemDate.message) logger.warn(warning);
    serverStatus.status.systemDate.status = 'healthy';
    serverStatus.status.systemDate.message = warning;
    eventBus.emit('service-health', { systemDate: serverStatus.status.systemDate });
    // eslint-disable-next-line no-use-before-define -- The retry callback calls a hoisted function.
    clockRetry = setTimeout(waitForValidDateAndSetupJobs, SLOW_RETRY_MS);
    clockRetry.unref?.();
    return;
  }

  const withinFastRetries = RETRY_COUNT < FAST_RETRIES;
  const delay = withinFastRetries ? FAST_RETRY_MS : SLOW_RETRY_MS;
  serverStatus.status.systemDate.status = 'retrying';
  const message = `System date is invalid (year ${new Date().getFullYear()}). `
    + `No jobs scheduled yet, retrying in ${delay / 1000}s (attempt #${RETRY_COUNT})`;
  serverStatus.status.systemDate.message = message;
  RETRY_COUNT++;
  if (withinFastRetries) {
    logger.debug(message);
  } else {
    logger.warn(message);
  }
  // eslint-disable-next-line no-use-before-define -- The retry callback calls a hoisted function.
  clockRetry = setTimeout(waitForValidDateAndSetupJobs, delay);
  clockRetry.unref?.();
}

// File changes and retries share one check while waiting for the year floor.
function waitForValidDateAndSetupJobs() {
  if (clockCheck) return;
  clearTimeout(clockRetry);
  clockCheck = checkClockAndSetupJobs().finally(() => { clockCheck = null; });
}

// Monitor the JSON file and refresh jobs on change
chokidar.watch(config.lowDbFolder).on('change', (changedPath) => {
  const fileName = path.basename(changedPath);
  if (!isScheduleDbChange(fileName)) {
    // Only settings, schedules and Rhythms data affect these jobs.
    logger.debug(`Skipping restarting jobs for DB change: ${fileName}`);
    return;
  } else {
    logger.info(`Detected DB change, reloading... ${fileName}`);
  }

  if (clockReady) {
    void setupJobs();
  } else {
    waitForValidDateAndSetupJobs();
  }
});

// A Smart Schedule start that moves rebuilds the in-memory jobs, never a file.
setCurveRetime(() => { void setupJobs(); });

// Initial job setup
waitForValidDateAndSetupJobs();
