import schedule from 'node-schedule';
import moment from 'moment-timezone';
import settingsDB from '../db/settings.js';
import schedulesDB from '../db/schedules.js';
import type { Side } from '../db/schedulesSchema.js';
import { connectFrankenWithin, getDeviceStatusCoalesced } from '../8sleep/frankenServer.js';
import logger from '../logger.js';
import { lastManualPowerChange } from './manualPowerChange.js';
import { engineActivation } from './scheduleQueries.js';
import { runningNight } from './nightBounds.js';
import { weeklyPowerOnJob } from './powerScheduler.js';
import { resolveSleeps } from './rhythms/resolve.js';
import { hasRunningRhythmStart } from './rhythms/scheduleRhythms.js';
import { smartResolveHooks } from './rhythms/curveController.js';
import { handedBack, runRhythmEvent } from './rhythms/runEvent.js';

function resumePlan(side: Side) {
  const settings = settingsDB.data;
  const timeZone = settings.timeZone;
  if (!timeZone || settings[side].awayMode || settings[side].scheduleOverrides.pause.active || handedBack()) return null;
  const now = new Date();
  const engine = engineActivation();
  if (settings.features.rhythms && engine.active) {
    const sleep = resolveSleeps({ db: engine.db, side, timeZone, from: now, to: now, ...smartResolveHooks })
      .filter(candidate => candidate.start <= now && now < candidate.end).pop();
    if (!sleep || now >= (sleep.setOff ?? sleep.end)) return null;
    const powerOn = sleep.events.find(event => event.kind === 'power-on');
    return powerOn ? { kind: 'rhythms' as const, date: sleep.date, sleep, powerOn, now } : null;
  }
  const night = runningNight(schedulesDB.data, side, now, timeZone);
  if (!night) return null;
  return {
    kind: 'weekly' as const, date: moment.tz(night.start, timeZone).format('YYYY-MM-DD'),
    night, power: schedulesDB.data[side][night.day].power, timeZone, now,
  };
}

function scheduledStartWillResume(side: Side, plan: NonNullable<ReturnType<typeof resumePlan>>): boolean {
  const running = plan.kind === 'rhythms' && hasRunningRhythmStart(side, plan.date);
  const imminent = running || Object.entries(schedule.scheduledJobs).some(([name, job]) => {
    const matches = plan.kind === 'weekly'
      ? name === `${side}-${plan.night.day}-${plan.power.on}-power-on`
      : name.startsWith(`rhythm-${side}-${plan.sleep.date}-power-on-`);
    if (!matches) return false;
    // node-schedule exposes running at runtime, but its types omit it.
    if ((job as schedule.Job & { running?: number }).running) return true;
    const next = job.nextInvocation();
    if (!next) return false;
    const delay = next.getTime() - plan.now.getTime();
    return delay >= 0 && delay <= 120_000;
  });
  if (imminent) logger.info(`Delaying resume: checking the ${side} side after its scheduled start`);
  return imminent;
}

type Resume = {
  endedAt: number;
  generation: number;
  engine?: 'weekly' | 'rhythms';
  date?: string;
  timer?: ReturnType<typeof setTimeout>;
};
const resumes = new Map<Side, Resume>();
let shutdownGeneration = 0;

export function stopScheduleResumes(): void {
  shutdownGeneration++;
  for (const resume of resumes.values()) {
    if (resume.timer) clearTimeout(resume.timer);
  }
  resumes.clear();
}

function stillEligible(side: Side, resume: Resume): boolean {
  return shutdownGeneration === resume.generation && resumes.get(side) === resume
    && (lastManualPowerChange(side) ?? -Infinity) < resume.endedAt;
}

async function checkResume(side: Side, resume: Resume, followUp: boolean): Promise<void> {
  try {
    if (!stillEligible(side, resume)) return;
    await settingsDB.read();
    if (!stillEligible(side, resume)) return;
    await schedulesDB.read();
    if (!stillEligible(side, resume)) return;
    const beforeStatus = resumePlan(side);
    if (!beforeStatus || !stillEligible(side, resume)) return;
    if (resume.engine && (resume.engine !== beforeStatus.kind || resume.date !== beforeStatus.date)) return;
    resume.engine = beforeStatus.kind;
    resume.date = beforeStatus.date;
    const yieldToStart = (plan: NonNullable<ReturnType<typeof resumePlan>>) => {
      if (followUp || !scheduledStartWillResume(side, plan)) return false;
      // Rebuilds cancel scheduler jobs, so this check has its own timer.
      resume.timer = setTimeout(() => checkResume(side, resume, true), 180_000);
      resume.timer.unref?.();
      return true;
    };
    if (yieldToStart(beforeStatus)) return;
    await connectFrankenWithin({ background: true });
    if (!stillEligible(side, resume)) return;
    const status = await getDeviceStatusCoalesced();
    if (!stillEligible(side, resume) || status[side].isOn) return;
    await settingsDB.read();
    if (!stillEligible(side, resume)) return;
    await schedulesDB.read();
    if (!stillEligible(side, resume)) return;
    const plan = resumePlan(side);
    if (!plan || !stillEligible(side, resume) || plan.kind !== resume.engine || plan.date !== resume.date || yieldToStart(plan)) return;
    logger.info(`Resuming the ${side} schedule during its night`);
    if (!stillEligible(side, resume)) return;
    if (plan.kind === 'rhythms') {
      await runRhythmEvent(side, plan.sleep, { ...plan.powerOn, at: plan.now });
    } else {
      await weeklyPowerOnJob(side, plan.night.day, plan.power, plan.timeZone)(plan.now);
    }
  } catch (error: unknown) {
    logger.error(`Failed to resume the ${side} schedule: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if ((followUp || !resume.timer) && resumes.get(side) === resume) resumes.delete(side);
  }
}

// Resume an off side through its normal power-on job, without replaying alarms.
export async function resumeSchedule(side: Side, endedAt = new Date()): Promise<void> {
  if (shutdownGeneration !== 0) return;
  const previous = resumes.get(side);
  if (previous?.timer) clearTimeout(previous.timer);
  const resume: Resume = { endedAt: endedAt.getTime(), generation: shutdownGeneration };
  resumes.set(side, resume);
  await checkResume(side, resume, false);
}
