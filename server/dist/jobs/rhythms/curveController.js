import { effectiveCoolStart, levelAt, phaseAt, } from '../../db/smartCurve.js';
import { PRESENCE_STALE_MS } from '../../8sleep/presenceStale.js';
import logger from '../../logger.js';
import { turnsOffWhenUp } from './resolve.js';
import { bridgeDropouts, CAP_MS, coolStartOverride, presenceRun, stepStart, upEarlyDue, WINDOW_BEFORE_MS, } from './confirmation.js';
import { latestOff, SMART_OFF } from '../../db/smartOff.js';
import { alarmAhead, decideAtSetOff, DECISION_GRACE_MS, nextStep, OFF_MEMORY_MS, stepStreak, upFor, } from './offWhenUp.js';
const MINUTE = 60_000;
export const MANUAL_HOLD_MAX_MS = 3 * 60 * MINUTE;
export const AFTER_WAKE_MS = 30 * MINUTE;
export const EXIT_COUNT_WINDOW_MS = 60 * MINUTE;
const LOOKBACK_MS = 24 * 60 * MINUTE;
const LOOKAHEAD_MS = MANUAL_HOLD_MAX_MS;
const SIDES = ['left', 'right'];
// How far past a set off the latest off and its walls can be.
const LATEST_REACH_MS = (SMART_OFF.extendMinutes + SMART_OFF.clearMinutes) * MINUTE;
const otherSide = (side) => (side === 'left' ? 'right' : 'left');
// The pre-warm and bedtime are one stretch at the bedtime level, up to the cool-down.
const stretchOf = (phase) => (phase === 'bedtime' ? 'prewarm' : phase);
// A manual change holds until the curve's next phase starts, at most 3 hours,
// and never past the power off.
export function holdEnd(points, from, powerOff) {
    const time = from.getTime();
    const current = phaseAt(points, from);
    const next = current === null
        ? undefined
        : points.find(point => point.at.getTime() > time && stretchOf(point.phase) !== stretchOf(current));
    return new Date(Math.min(next?.at.getTime() ?? Infinity, time + MANUAL_HOLD_MAX_MS, powerOff.getTime()));
}
const keyOf = (side, date) => `${side}-${date}`;
const alarmsOf = (sleep) => sleep.events.flatMap(event => (event.kind === 'alarm' ? [event.at.getTime()] : []));
export class CurveController {
    deps;
    states = new Map();
    offs = new Map();
    constructor(deps) {
        this.deps = deps;
    }
    coolStartFor(side, date) {
        const state = this.states.get(keyOf(side, date));
        return state ? coolStartOverride(state.start, state.bedtime) : undefined;
    }
    // The actual off the resolver should use.
    powerOffFor(side, date) {
        const record = this.offs.get(keyOf(side, date));
        if (!record)
            return undefined;
        return record.status === 'extended' ? record.latest : record.at;
    }
    extendedUntil(side) {
        for (const record of this.offs.values())
            if (record.side === side && record.status === 'extended')
                return record.latest;
        return undefined;
    }
    isExtended(side, date) {
        return this.offs.get(keyOf(side, date))?.status === 'extended';
    }
    // The power-off job asks at the set off, once an alarm due then has rung,
    // and again at the latest off. 'keep' leaves the side on.
    decideOff(side, sleep, now, dueAt = now) {
        const key = keyOf(side, sleep.date);
        const record = this.offs.get(key);
        if (record?.status === 'extended') {
            // A job that fires a moment early still turns the side off at the latest.
            if (Math.max(now.getTime(), dueAt.getTime()) < record.latest.getTime())
                return 'keep';
            this.endOff(key, record, record.latest, 'cap', { retime: false });
            return 'off';
        }
        if (record || !this.deps.smartOff || !turnsOffWhenUp(sleep))
            return 'off';
        const setOff = sleep.setOff ?? sleep.end;
        const target = { side, date: sleep.date };
        // An alarm that rang first can delay the job; the analyses then follow the later off.
        const late = now.getTime() - setOff.getTime() >= MINUTE;
        let latest;
        let decision;
        try {
            const run = presenceRun(this.deps.presence(), this.sidesFor(side), now.getTime(), PRESENCE_STALE_MS);
            latest = this.latestOffFor(side, sleep.date, setOff);
            decision = decideAtSetOff(run, setOff, latest);
        }
        catch (error) {
            // The job turns the side off at the set time.
            this.endOff(key, target, late ? now : setOff, 'decision-failed', { retime: late });
            throw error;
        }
        if (decision !== 'extend') {
            this.endOff(key, target, late ? now : setOff, decision, { retime: late });
            return 'off';
        }
        this.offs.set(key, { ...target, status: 'extended', latest, from: now, armedUntil: null, paused: false });
        logger.info(`smart schedule ${side} ${sleep.date}: in bed at the turn off, stays on until up, by ${latest.toISOString()}`);
        this.deps.retime();
        return 'keep';
    }
    gate(side, date, at) {
        const state = this.states.get(keyOf(side, date));
        if (!state)
            return 'run';
        const time = at.getTime();
        if (state.hold && time < state.hold.until.getTime())
            return 'hold';
        if (state.upEarlyAt && time >= state.upEarlyAt.getTime() && time <= state.wake.getTime())
            return 'base';
        if (state.outOfBedAt && time >= state.outOfBedAt.getTime() && time < state.wake.getTime() + AFTER_WAKE_MS)
            return 'base';
        return 'run';
    }
    noteManualChange(side, now) {
        const away = this.deps.awayMode();
        const driving = away[side] && !away[otherSide(side)] ? otherSide(side) : side;
        if (away[driving])
            return 'not-smart';
        const time = now.getTime();
        const sleeps = this.deps.sleeps(driving, new Date(time - LOOKBACK_MS), new Date(time + LOOKAHEAD_MS));
        const current = sleeps.find(sleep => sleep.start.getTime() <= time && time < sleep.end.getTime());
        if (!current) {
            const next = sleeps
                .filter(sleep => sleep.start.getTime() > time)
                .sort((a, b) => a.start.getTime() - b.start.getTime())[0];
            return next?.mode === 'smart' && next.start.getTime() - time <= MANUAL_HOLD_MAX_MS ? 'smart-ahead' : 'not-smart';
        }
        if (current.mode !== 'smart' || !current.smartCurve || !current.smart)
            return 'not-smart';
        const state = this.stateFor(current, current.smartCurve, current.smart);
        state.hold = { from: now, until: holdEnd(state.points, now, state.powerOff) };
        const phase = phaseAt(state.points, now) ?? 'prewarm';
        state.manualChanges[phase] = (state.manualChanges[phase] ?? 0) + 1;
        logger.info(`smart schedule ${driving} ${current.date}: manual change holds until ${state.hold.until.toISOString()}`);
        return 'held';
    }
    status(side, now) {
        const time = now.getTime();
        for (const state of this.states.values()) {
            if (state.side !== side)
                continue;
            const record = this.offs.get(keyOf(state.side, state.date));
            // A keep moves the end before the next tick refreshes the state.
            const end = record?.status === 'extended' ? record.latest : state.powerOff;
            if (time >= end.getTime() || record?.status === 'done')
                continue;
            // Only fresh presence can move the turn-off; otherwise it is the set time.
            const fresh = presenceRun(this.deps.presence(), this.sidesFor(state.side), time, PRESENCE_STALE_MS).known;
            const level = levelAt(state.points, now);
            const next = state.points.find(point => point.at.getTime() > time && point.level !== level
                && this.gate(state.side, state.date, point.at) === 'run');
            return {
                side,
                date: state.date,
                phase: phaseAt(state.points, now),
                start: state.start,
                coolStart: coolStartOverride(state.start, state.bedtime) ?? state.bedtime,
                holdUntil: state.hold?.until ?? null,
                baseSince: state.upEarlyAt ?? state.outOfBedAt,
                nextChange: next ? { at: next.at, level: next.level, phase: next.phase } : null,
                offBy: !state.offWhenUp || !fresh ? null
                    : record?.status === 'extended' ? record.latest : this.latestOffFor(state.side, state.date, state.setOff),
            };
        }
        return null;
    }
    async tick() {
        const now = this.deps.now();
        const time = now.getTime();
        const away = this.deps.awayMode();
        const snapshot = this.deps.presence();
        const seen = new Set();
        for (const side of SIDES) {
            if (away[side])
                continue;
            const sleeps = this.deps.sleeps(side, new Date(time - LOOKBACK_MS), new Date(time + LOOKAHEAD_MS));
            for (const sleep of sleeps) {
                const curve = sleep.smartCurve;
                if (sleep.mode !== 'smart' || !curve || !sleep.smart)
                    continue;
                if (time < curve.bedtime.getTime() - WINDOW_BEFORE_MS || time >= sleep.end.getTime())
                    continue;
                const key = keyOf(side, sleep.date);
                // A paused night is not tracked; once the pause ends it is, as not observed if past its bedtime.
                if (this.deps.isPaused(side, now)) {
                    if (this.states.has(key))
                        seen.add(key);
                    await this.pauseExtension(key);
                    continue;
                }
                seen.add(key);
                const state = this.stateFor(sleep, curve, sleep.smart);
                await this.step(state, snapshot, now);
            }
        }
        for (const [key, state] of this.states) {
            const record = this.offs.get(key);
            // A sleep kept on ends at its latest off, even when a pause kept this tick from refreshing its state.
            const end = record?.status === 'extended' ? record.latest : state.powerOff;
            if (record?.status === 'done' || time >= end.getTime()) {
                if (!record && this.awaitsOffDecision(state, time))
                    continue;
                this.states.delete(key);
                await this.closeExtension(key, state, now);
                await this.finish(state);
            }
            else if (!seen.has(key)) {
                this.states.delete(key);
                if (record?.status === 'extended') {
                    // Gone while kept on (away mode, an edit): the side's own timer ends it.
                    this.endOff(key, record, now, 'stopped', { retime: true });
                    await this.finish(state);
                    continue;
                }
                // Jobs planned before this tick still use its moved start.
                const override = coolStartOverride(state.start, state.bedtime);
                if (override && override.getTime() !== state.bedtime.getTime())
                    this.deps.retime();
            }
        }
        this.forgetOldOffs(time);
    }
    stateFor(sleep, curve, smart) {
        const key = keyOf(sleep.side, sleep.date);
        const existing = this.states.get(key);
        if (existing) {
            existing.rhythmId = sleep.rhythmId;
            existing.smart = smart;
            existing.daySleep = curve.daySleep;
            existing.wake = curve.wake;
            existing.powerOff = sleep.end;
            existing.setOff = sleep.setOff ?? sleep.end;
            existing.sleepStart = sleep.start;
            existing.offWhenUp = this.watchesOff(smart);
            existing.alarms = alarmsOf(sleep);
            existing.points = curve.points;
            if (existing.bedtime.getTime() !== curve.bedtime.getTime())
                this.moveBedtime(existing, curve);
            // A cool-down start that presence moved moves the end of a hold with it.
            if (existing.hold)
                existing.hold.until = holdEnd(existing.points, existing.hold.from, existing.powerOff);
            return existing;
        }
        const state = {
            side: sleep.side,
            date: sleep.date,
            rhythmId: sleep.rhythmId,
            smart,
            bedtime: curve.bedtime,
            wake: curve.wake,
            powerOff: sleep.end,
            setOff: sleep.setOff ?? sleep.end,
            sleepStart: sleep.start,
            daySleep: curve.daySleep,
            points: curve.points,
            start: { status: 'watching' },
            firstSight: true,
            presence: null,
            hold: null,
            upEarlyAt: null,
            outOfBedAt: null,
            manualChanges: {},
            bedExitsLastHour: 0,
            lastSeen: {},
            offWhenUp: this.watchesOff(smart),
            streak: null,
            alarms: alarmsOf(sleep),
        };
        this.states.set(key, state);
        return state;
    }
    // An edited bedtime keeps a decided start only when the new bedtime gives
    // the same one; otherwise presence decides again against the new bedtime.
    moveBedtime(state, curve) {
        const bedtime = curve.bedtime.getTime();
        const { start } = state;
        const keep = start.status === 'decided' && start.reason === 'confirmed' && start.confirmedAt !== null
            && start.confirmedAt.getTime() <= bedtime + CAP_MS
            && start.coolStart.getTime() === Math.max(bedtime, start.confirmedAt.getTime());
        state.bedtime = curve.bedtime;
        if (!keep)
            state.start = { status: 'watching' };
        // The jobs were planned with the old start, which curve.coolStart reflects.
        const coolStart = effectiveCoolStart(curve.bedtime, coolStartOverride(state.start, curve.bedtime) ?? curve.bedtime);
        if (coolStart.getTime() !== curve.coolStart.getTime())
            this.deps.retime();
    }
    sidesFor(side) {
        return this.deps.awayMode()[otherSide(side)] ? [...SIDES] : [side];
    }
    watchesOff(smart) {
        return smart.offWhenUp === true && !!this.deps.smartOff;
    }
    // The side's next sleep after this one's set off, within reach of the latest off.
    nextSleepFor(side, date, setOff) {
        return this.deps.sleeps(side, setOff, new Date(setOff.getTime() + LATEST_REACH_MS))
            .filter(sleep => sleep.date !== date && sleep.start.getTime() >= setOff.getTime())
            .sort((a, b) => a.start.getTime() - b.start.getTime())[0];
    }
    // Once the next sleep has powered on the side is its own, as the power-off
    // job's poweredOnSince check says: a cap reached late must not turn it off.
    nextStarted(side, date, setOff, time) {
        const next = this.nextSleepFor(side, date, setOff);
        return !!next && next.start.getTime() <= time;
    }
    latestOffFor(side, date, setOff) {
        const next = this.nextSleepFor(side, date, setOff);
        const restart = this.deps.smartOff?.nextRestart(new Date(setOff.getTime() - SMART_OFF.clearMinutes * MINUTE)) ?? null;
        return latestOff({ setOff, nextStart: next?.start ?? null, restart });
    }
    endOff(key, target, at, reason, options) {
        this.offs.set(key, { side: target.side, date: target.date, status: 'done', at, reason });
        logger.info(`smart schedule ${target.side} ${target.date}: off at ${at.toISOString()} (${reason})`);
        if (options.retime)
            this.deps.retime();
    }
    // Turns the side off and records it only once the Pod took the write, so
    // the next tick tries again. Until then the firmware timer still ends it.
    async turnOff(key, target, at, reason, options) {
        const smartOff = this.deps.smartOff;
        if (!smartOff || !(await this.write(target, 'turn off', () => smartOff.powerOff(target.side))))
            return false;
        // A job may have ended it while the write waited.
        if (this.offs.get(key)?.status !== 'done')
            this.endOff(key, target, at, reason, options);
        return true;
    }
    async write(target, what, write) {
        try {
            return await write();
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger.warn(`smart schedule ${target.side} ${target.date}: could not ${what}: ${message}`);
            return false;
        }
    }
    // A failed read counts as one that cannot be made now.
    async readSideOn(smartOff, target) {
        try {
            return await smartOff.sideIsOn(target.side);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger.warn(`smart schedule ${target.side} ${target.date}: could not read the side: ${message}`);
            return null;
        }
    }
    // Kept past the set off until the power-off job decides, or until it is
    // clear it will not (paused, the next sleep started, handed back).
    awaitsOffDecision(state, time) {
        return state.offWhenUp && time < state.setOff.getTime() + DECISION_GRACE_MS;
    }
    // At its latest off: the job there turns it off, and so does this, unless a
    // pause leaves it to the side's own timer. An edit can leave the latest in
    // the past. A write the Pod rejects is left to that job, which waits out a
    // reconnect, and to the firmware timer.
    async closeExtension(key, state, now) {
        const record = this.offs.get(key);
        if (record?.status !== 'extended')
            return;
        const paused = record.paused || this.deps.isPaused(record.side, now);
        const started = this.nextStarted(record.side, record.date, state.setOff, now.getTime());
        const late = now.getTime() - record.latest.getTime() >= MINUTE;
        const reason = started ? 'stopped' : paused ? 'paused' : 'cap';
        this.endOff(key, record, late ? now : record.latest, reason, { retime: late });
        const smartOff = this.deps.smartOff;
        if (smartOff && !paused && !started)
            await this.write(record, 'turn off', () => smartOff.powerOff(record.side));
    }
    forgetOldOffs(time) {
        for (const [key, record] of this.offs) {
            const end = record.status === 'extended' ? record.latest : record.at;
            if (time - end.getTime() > OFF_MEMORY_MS && !this.states.has(key))
                this.offs.delete(key);
        }
    }
    // Kept on past the set off for someone in bed. True once this tick turned the side off.
    async stepOff(state, run, now) {
        const smartOff = this.deps.smartOff;
        const key = keyOf(state.side, state.date);
        const record = this.offs.get(key);
        if (!smartOff || !state.offWhenUp) {
            // No longer a "When I get up" rhythm: the side's own timer ends it.
            if (record?.status === 'extended')
                this.endOff(key, record, now, 'stopped', { retime: true });
            return false;
        }
        const time = now.getTime();
        state.streak = stepStreak(state.streak, run, time);
        if (!record) {
            // After the wake, once up for 10 minutes, with no alarm of the night left.
            const setOff = state.setOff.getTime();
            const due = time >= state.wake.getTime() && time < setOff
                && upFor(state.streak, time, state.wake.getTime())
                && !alarmAhead(state.alarms, time, setOff)
                && !this.alarmPending(smartOff, state);
            if (due)
                await this.turnOff(key, state, now, 'got-up', { retime: true });
            return due;
        }
        if (record.status !== 'extended')
            return false;
        if (record.paused) {
            // The pause ended before the latest off: presence decides again and the steps resume.
            record.paused = false;
            record.armedUntil = null;
        }
        const latest = this.latestOffFor(state.side, state.date, state.setOff);
        if (latest.getTime() < record.latest.getTime()) {
            record.latest = latest;
            // The timer must never stay armed past the latest off.
            if (record.armedUntil !== null && record.armedUntil > latest.getTime())
                record.armedUntil = null;
            this.deps.retime();
        }
        if (time >= record.latest.getTime()) {
            const late = time - record.latest.getTime() >= MINUTE;
            const started = this.nextStarted(state.side, state.date, state.setOff, time);
            const at = late ? now : record.latest;
            if (started)
                this.endOff(key, record, at, 'stopped', { retime: late });
            else
                await this.turnOff(key, record, at, 'cap', { retime: late });
            return true;
        }
        if (!run.known) {
            await this.turnOff(key, record, now, 'stale', { retime: true });
            return true;
        }
        if (upFor(state.streak, time, record.from.getTime())) {
            await this.turnOff(key, record, now, 'got-up', { retime: true });
            return true;
        }
        const on = await this.readSideOn(smartOff, record);
        if (on === false) {
            this.endOff(key, record, now, 'side-off', { retime: true });
            return true;
        }
        const until = on ? nextStep(record.armedUntil, time, record.latest.getTime()) : null;
        // A step counts once the Pod took it; until then each tick tries again.
        if (until !== null && await this.write(record, 'move the timer', () => smartOff.armTimer(state.side, new Date(until), record.latest))) {
            record.armedUntil = until;
        }
        return false;
    }
    // A failed check counts as an alarm still to come, so an early off never strands one.
    alarmPending(smartOff, state) {
        try {
            return smartOff.alarmPending(state.side, { date: state.date, start: state.sleepStart, end: state.setOff }, state.setOff);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger.warn(`smart schedule ${state.side} ${state.date}: could not check the alarms: ${message}`);
            return true;
        }
    }
    // A pause leaves the bed to its own timer, as for any paused sleep: the
    // timer goes to the latest off, and presence no longer decides.
    async pauseExtension(key) {
        const record = this.offs.get(key);
        const smartOff = this.deps.smartOff;
        if (!smartOff || record?.status !== 'extended' || record.paused)
            return;
        const on = await this.readSideOn(smartOff, record);
        if (on === false)
            this.endOff(key, record, this.deps.now(), 'side-off', { retime: true });
        if (on !== true)
            return;
        // Paused once the Pod took the timer; until then each tick tries again.
        if (!(await this.write(record, 'move the timer', () => smartOff.armTimer(record.side, record.latest, record.latest))))
            return;
        record.paused = true;
        logger.info(`smart schedule ${record.side} ${record.date}: paused while kept on, its timer ends it by ${record.latest.toISOString()}`);
    }
    async step(state, snapshot, now) {
        const time = now.getTime();
        const sides = this.sidesFor(state.side);
        const run = presenceRun(snapshot, sides, time, PRESENCE_STALE_MS);
        const bridged = bridgeDropouts(state.presence, run, time);
        state.presence = bridged.kept;
        let moved = false;
        if (state.start.status !== 'decided') {
            const before = coolStartOverride(state.start, state.bedtime) ?? state.bedtime;
            state.start = stepStart(state.start, { run: bridged.run, bedtime: state.bedtime, now: time, firstSight: state.firstSight });
            const after = coolStartOverride(state.start, state.bedtime) ?? state.bedtime;
            if (state.start.status === 'decided') {
                logger.info(`smart schedule ${state.side} ${state.date}: cool-down from ${after.toISOString()} (${state.start.reason})`);
            }
            moved = before.getTime() !== after.getTime();
            if (moved)
                this.deps.retime();
        }
        state.firstSight = false;
        this.countExits(state, snapshot, sides, time);
        if (await this.stepOff(state, run, now))
            return;
        // A moved start leaves the points and hold end stale until the next tick re-resolves them.
        if (state.hold && !moved && time >= state.hold.until.getTime()) {
            state.hold = null;
            const level = levelAt(state.points, now);
            if (level !== null)
                await this.apply(state, level, 'manual hold ended', 'hold-end');
        }
        if (state.hold)
            return;
        if (state.smart.upEarly && !state.upEarlyAt && upEarlyDue(run, state.wake, time)) {
            state.upEarlyAt = now;
            await this.apply(state, state.smart.baseLevel, 'up early', 'base');
            return;
        }
        const wake = state.wake.getTime();
        // A sleep that turns off when up holds the wake level until it does.
        const outOfBed = !state.smart.offWhenUp && !state.upEarlyAt && !state.outOfBedAt && run.known && run.presentSince === null
            && time >= wake && time < wake + AFTER_WAKE_MS && wake < state.powerOff.getTime();
        if (outOfBed) {
            state.outOfBedAt = now;
            await this.apply(state, state.smart.baseLevel, 'out of bed after wake', 'base');
        }
    }
    countExits(state, snapshot, sides, time) {
        const wake = state.wake.getTime();
        const inWindow = time >= wake - EXIT_COUNT_WINDOW_MS && time <= wake;
        for (const side of sides) {
            const current = snapshot[side];
            const previous = state.lastSeen[side];
            const updated = current.lastUpdatedAt ? Date.parse(current.lastUpdatedAt) : Number.NaN;
            const fresh = Number.isFinite(updated) && time - updated <= PRESENCE_STALE_MS;
            if (inWindow && fresh && previous?.present
                && (!current.present || current.stateChangedAt !== previous.stateChangedAt)) {
                state.bedExitsLastHour += 1;
            }
            state.lastSeen[side] = { ...current };
        }
    }
    async apply(state, level, why, reason) {
        logger.info(`smart schedule ${state.side} ${state.date}: level ${level} (${why})`);
        try {
            await this.deps.applyLevel(state.side, level, reason);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger.warn(`smart schedule ${state.side} ${state.date}: could not set level: ${message}`);
        }
    }
    async finish(state) {
        const start = state.start.status === 'decided'
            ? state.start
            : { coolStart: state.bedtime, confirmedAt: null, reason: 'not-observed' };
        const record = this.offs.get(keyOf(state.side, state.date));
        const off = record?.status === 'done' ? record : null;
        const undecided = this.deps.isPaused(state.side, state.setOff) ? 'paused' : 'not-decided';
        try {
            await this.deps.recordHistory({
                v: 1,
                side: state.side,
                date: state.date,
                rhythmId: state.rhythmId,
                baseLevel: state.smart.baseLevel,
                intensity: state.smart.intensity,
                daySleep: state.daySleep,
                plannedBedtime: state.bedtime.toISOString(),
                plannedCoolStart: state.bedtime.toISOString(),
                plannedWake: state.wake.toISOString(),
                powerOff: state.setOff.toISOString(),
                coolStart: start.coolStart.toISOString(),
                confirmedAt: start.confirmedAt?.toISOString() ?? null,
                startReason: start.reason,
                manualChanges: state.manualChanges,
                bedExitsLastHour: state.bedExitsLastHour,
                upEarlyAt: state.upEarlyAt?.toISOString() ?? null,
                outOfBedAt: state.outOfBedAt?.toISOString() ?? null,
                offWhenUp: state.offWhenUp,
                actualOff: off ? off.at.toISOString() : state.offWhenUp ? null : state.setOff.toISOString(),
                offReason: off ? off.reason : state.offWhenUp ? undecided : 'set-time',
            });
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger.warn(`smart schedule ${state.side} ${state.date}: history not recorded: ${message}`);
        }
    }
}
let active = null;
export function startCurveController(deps) {
    if (!active)
        active = new CurveController(deps);
    return active;
}
export function stopCurveController() {
    active = null;
}
export function smartCoolStartFor(side, date) {
    return active?.coolStartFor(side, date);
}
export function smartPowerOffFor(side, date) {
    return active?.powerOffFor(side, date);
}
// The latest off of a side's sleep kept on past its set off, if any.
export function smartOffExtendedUntil(side) {
    return active?.extendedUntil(side);
}
export function smartOffExtends(side, date) {
    return active?.isExtended(side, date) ?? false;
}
// Without a running controller a sleep turns off at its set time, as before.
export function smartOffDecision(side, sleep, now = new Date(), dueAt = now) {
    return active ? active.decideOff(side, sleep, now, dueAt) : 'off';
}
// Every resolver call except overlap checks passes these, so the jobs, the
// queries and the app agree on a sleep's cool-down start and actual off.
export const smartResolveHooks = { coolStartFor: smartCoolStartFor, powerOffFor: smartPowerOffFor };
export function smartTemperatureGate(side, date, at) {
    return active ? active.gate(side, date, at) : 'run';
}
export function smartManualChange(side, now = new Date()) {
    return active ? active.noteManualChange(side, now) : 'not-smart';
}
export function smartCurveStatus(side, now = new Date()) {
    return active?.status(side, now) ?? null;
}
// The live night for the app. Holds stay in memory, so this is the only way
// the app can see one.
export function liveCurveState(side, now = new Date()) {
    const status = active?.status(side, now);
    if (!status)
        return null;
    return {
        side: status.side,
        date: status.date,
        phase: status.phase,
        waiting: status.start.status === 'waiting',
        coolStart: effectiveCoolStart(status.coolStart, status.coolStart).toISOString(),
        hold: status.holdUntil ? { until: status.holdUntil.toISOString() } : null,
        baseSince: status.baseSince?.toISOString() ?? null,
        nextChange: status.nextChange
            ? { at: status.nextChange.at.toISOString(), level: status.nextChange.level, phase: status.nextChange.phase }
            : null,
        ...(status.offBy ? { offWhenUp: { by: status.offBy.toISOString() } } : {}),
    };
}
//# sourceMappingURL=curveController.js.map