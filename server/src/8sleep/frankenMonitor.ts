import moment from 'moment-timezone';
import logger from '../logger.js';
import settingsDB from '../db/settings.js';
import memoryDB from '../db/memoryDB.js';
import { connectFranken, FrankenCommandTimeoutError } from './frankenServer.js';
import { wait } from './promises.js';
import { DeviceStatus, MIN_TEMPERATURE_F, MAX_TEMPERATURE_F } from '../routes/deviceStatus/deviceStatusSchema.js';
import { Side } from '../db/schedulesSchema.js';
import { Gesture, GestureSchema } from '../db/settingsSchema.js';
import { updateDeviceStatus } from '../routes/deviceStatus/updateDeviceStatus.js';
import { markManualTempChange } from '../jobs/scheduleOverride.js';
import { drivingSide } from '../jobs/scheduleQueries.js';
import { noteDeviceStatus } from './lastDeviceStatus.js';
import { wasSentSince } from './sentTargets.js';
import { DeepPartial } from 'ts-essentials';
import serverStatus from '../serverStatus.js';
import { trimixBase } from './trimixBaseControl.js';
import { BASE_PRESETS } from './basePresets.js';
import eventBus from '../events/eventBus.js';
import { waterLevelTracker } from './waterLevel.js';
import { handleAlarmTap } from './tapAlarm.js';

export { lastDeviceStatus } from './lastDeviceStatus.js';

// Pod 4+ only: gestures and the 2s cadence are the only path. The Pod 3
// 60s slow-poll branch was removed alongside the WebSocket initiative.
//
// IMPORTANT: this loop is also where physical-tap gestures (quad-tap to
// toggle the base, double/triple-tap for temperature) are detected, by
// diffing the franken status snapshot against the previous one. So this
// cadence is also the worst-case quad-tap latency. We previously throttled
// to 10s when no WebSocket clients were connected, which made quad-tap take
// 5-10s when the app wasn't open. Gestures are a physical interaction
// independent of whether anyone's watching the app, so always poll fast.
const POLL_MS = 2_000;
// How long a target written by a gesture stays the base for the next one
// when the Pod has not reported it yet. Past this the latest read wins, so a
// write the Pod refused cannot keep steering gestures.
const WRITTEN_TARGET_MS = 10_000;
// A write sent this long before the previous read may still have reached the
// Pod after it, so it counts as ours when a later read shows it.
const SENT_SLACK_MS = 10_000;

type WrittenTarget = {
  // The target the last gesture wrote.
  targetF: number;
  // The target the read carried when that gesture ran.
  readF: number;
  // Every target written since the read last agreed with the gestures.
  written: Set<number>;
  at: number;
};


export class FrankenMonitor {
  private isRunning: boolean;
  private deviceStatus?: DeviceStatus;
  // When deviceStatus was read.
  private readAt = 0;
  private currentBasePreset: keyof typeof BASE_PRESETS = 'flat';
  // The last tap counters read as numbers. A read missing a counter keeps the
  // one before it, so a tap made across that read is still seen.
  private lastTaps: Record<Side, Partial<Record<Gesture, number>>> = { left: {}, right: {} };
  // The target a gesture last wrote per side, which the next gesture steps
  // from until the Pod reports it. A read already in flight when a gesture
  // wrote still carries the old target, and two gestures in one read were
  // both applied to that same value: on a Pod 4 hub with a Pod 5 cover, where
  // the firmware reports a held cover button as a tap, -24 then -16 were
  // written back to back from a read of -24 instead of stacking.
  private writtenTargets: Partial<Record<Side, WrittenTarget>> = {};

  constructor() {
    this.isRunning = false;
    this.deviceStatus = undefined;
  }

  public async start() {
    if (this.isRunning) {
      logger.warn('FrankenMonitor is already running');
      return;
    }
    this.isRunning = true;
    this.frankenLoop().catch(error => {
      logger.error(error);
      this.markStatus('failed', String(error));
    });
  }

  public stop() {
    if (!this.isRunning) return;
    logger.debug('Stopping FrankenMonitor loop');
    this.isRunning = false;
  }

  private setDeviceStatus(next: DeviceStatus) {
    this.deviceStatus = next;
    this.readAt = Date.now();
    noteDeviceStatus(next);
  }

  private markStatus(status: 'healthy' | 'failed', message = '') {
    const prev = serverStatus.status.frankenMonitor.status;
    serverStatus.status.frankenMonitor.status = status;
    serverStatus.status.frankenMonitor.message = message;
    serverStatus.status.frankenMonitor.timestamp = moment.tz().format();
    if (prev !== status) {
      eventBus.emit('service-health', { frankenMonitor: serverStatus.status.frankenMonitor });
    }
  }

  // `readTarget` is the target of the read that carried the gesture.
  private async processGesture(side: Side, gesture: Gesture, readTarget: number) {
    const behavior = settingsDB.data[side]?.taps?.[gesture];
    if (!behavior) {
      logger.info(`[processGesture] No ${gesture} action set for the ${side} side`);
      return;
    }
    logger.debug(`[processGesture] side: ${side}, gesture: ${gesture}, type: ${behavior.type}`);

    if (behavior.type === 'temperature') {
      const currentTemperatureTarget = this.gestureBaseTarget(side, readTarget);
      let newTemperatureTargetF;
      const change = behavior.amount;
      if (behavior.change === 'increment') {
        newTemperatureTargetF = currentTemperatureTarget + change;
      } else {
        newTemperatureTargetF = currentTemperatureTarget + (-1 * change);
      }
      newTemperatureTargetF = Math.max(MIN_TEMPERATURE_F, Math.min(MAX_TEMPERATURE_F, newTemperatureTargetF));
      logger.debug(`Processing gesture temperature change for ${side}. ${currentTemperatureTarget} -> ${newTemperatureTargetF}`);
      // Away mode writes both sides together, so the side the bed follows has the same target.
      const driver = drivingSide(settingsDB.data, side) ?? side;
      const fromF = this.deviceStatus?.[driver].targetTemperatureF ?? null;
      const on = this.deviceStatus?.[driver].isOn ?? null;
      await updateDeviceStatus({ [side]: { targetTemperatureF: newTemperatureTargetF } } as DeepPartial<DeviceStatus>, { background: true });
      this.noteWrittenTarget(side, newTemperatureTargetF, readTarget);
      // Tap counts as a manual change for schedule-override purposes.
      await markManualTempChange(side, { targetF: newTemperatureTargetF, fromF, on, setsOn: false, source: 'tap' });
      return;
    } else if (behavior.type === 'set_temperature') {
      const targetF = behavior.temperatureF;
      logger.debug(`Processing gesture set temperature for ${side}: ${targetF} F and on`);
      const before = this.deviceStatus?.[drivingSide(settingsDB.data, side) ?? side];
      await updateDeviceStatus({ [side]: { isOn: true, targetTemperatureF: targetF } } as DeepPartial<DeviceStatus>, { background: true });
      this.noteWrittenTarget(side, targetF, readTarget);
      await markManualTempChange(side, {
        targetF, fromF: before?.targetTemperatureF ?? null, on: true, setsOn: before?.isOn === false, source: 'tap',
      });
      return;
    } else if (behavior.type === 'base_control') {
      this.currentBasePreset =
        this.currentBasePreset === 'relax' ? 'flat' : 'relax';

      const targetPreset = BASE_PRESETS[this.currentBasePreset];

      // If the base is already at the target position, skip the BLE command
      // entirely. Calling setPosition with the same position is a no-op at
      // the hardware level, but it leaves isMoving=true in memoryDB with
      // no incoming position-change packets to ever clear it (the timeout
      // in trimixBaseControl.parseNotification only gets armed inside the
      // positionChanged branch). The result is a permanently stuck "Stop
      // movement" button on the elevation page.
      const current = memoryDB.data?.baseStatus;
      if (current && current.head === targetPreset.head && current.feet === targetPreset.feet) {
        logger.info(
          `[quadTap] Already at ${this.currentBasePreset} preset (head=${current.head}, feet=${current.feet}); skipping setPosition.`,
        );
        return;
      }

      logger.info(
        `[quadTap] Cycling base to ${this.currentBasePreset} preset:`,
        targetPreset,
      );

      try {
        if (memoryDB.data) {
          memoryDB.data.baseStatus = {
            head: targetPreset.head,
            feet: targetPreset.feet,
            isMoving: true,
            lastUpdate: new Date().toISOString(),
            isConfigured: true,
          };
          await memoryDB.write();
        }

        if (this.currentBasePreset === 'flat') {
          await trimixBase.goToFlat();
        } else {
          await trimixBase.setPosition({
            head: targetPreset.head,
            feet: targetPreset.feet,
            feedRate: targetPreset.feedRate,
          });
        }
      } catch (error) {
        logger.error(
          `[quadTap] Failed to set base preset: ${error instanceof Error ? error.message : String(error)}`,
        );
        this.currentBasePreset =
        this.currentBasePreset === 'relax' ? 'flat' : 'relax';
      }

    } else if (behavior.type === 'alarm') {
      await handleAlarmTap(side, behavior);
    }
  }

  // The target a gesture steps from: the one the last gesture wrote while the
  // Pod has not reported it yet, else the one the read carried.
  private gestureBaseTarget(side: Side, readTarget: number): number {
    const written = this.writtenTargets[side];
    if (written && Date.now() - written.at <= WRITTEN_TARGET_MS) return written.targetF;
    return readTarget;
  }

  private noteWrittenTarget(side: Side, targetF: number, readF: number) {
    const written = this.writtenTargets[side]?.written ?? new Set<number>();
    written.add(targetF);
    this.writtenTargets[side] = { targetF, readF, written, at: Date.now() };
  }

  // Forgets a side's written target once a read reports it, or reports a
  // target that no gesture wrote and the read did not carry: the app or a
  // schedule changed it, and the read is the truth again.
  private settleWrittenTargets(nextDeviceStatus: DeviceStatus) {
    for (const side of ['left', 'right'] as const) {
      const written = this.writtenTargets[side];
      if (!written) continue;
      const read = nextDeviceStatus[side].targetTemperatureF;
      const confirmed = read === written.targetF;
      const changedElsewhere = read !== written.readF && !written.written.has(read);
      if (confirmed || changedElsewhere || Date.now() - written.at > WRITTEN_TARGET_MS) {
        delete this.writtenTargets[side];
      }
    }
  }

  // Runs one read's gestures for a side one after another, so each steps
  // from the target the one before it wrote.
  private async processGesturesInOrder(side: Side, gestures: Gesture[], readTarget: number) {
    for (const gesture of gestures) {
      try {
        await this.processGesture(side, gesture, readTarget);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`Failed to process ${gesture} on the ${side} side: ${message}`);
        this.markStatus('failed', message);
      }
    }
  }

  // `hubFromF` is the target before a change the hub made by itself in this read, if any.
  private processGesturesForSide(nextDeviceStatus: DeviceStatus, side: Side, hubFromF: number | null = null) {
    try {
      const gestures: Gesture[] = [];
      for (const gesture of GestureSchema.options) {
        const prior = this.deviceStatus?.[side].taps?.[gesture];
        if (this.lastTaps[side][gesture] === undefined && typeof prior === 'number') {
          this.lastTaps[side][gesture] = prior;
        }
        const previous = this.lastTaps[side][gesture];
        const current = nextDeviceStatus[side].taps?.[gesture];
        // A missing counter says nothing about a tap, and treating it as one
        // would act on the bed with nobody touching it.
        if (typeof current !== 'number') continue;
        this.lastTaps[side][gesture] = current;
        if (previous !== undefined && current > previous) gestures.push(gesture);
      }
      if (gestures.length === 0) {
        if (hubFromF !== null) this.noteHubChange(side, hubFromF, nextDeviceStatus[side].targetTemperatureF);
        return;
      }
      // A Pod 5 hub steps a plus click itself and also reports it as a tap, so
      // the tap steps from the target before the hub's step and replaces it.
      // Assumes both land in one read, as seen on a Pod 5; a step and tap split across reads still stack.
      const readTarget = hubFromF ?? nextDeviceStatus[side].targetTemperatureF;
      // Deliberately detached: a base move takes seconds over BLE and this
      // loop doubles as the tap-detection cadence, so awaiting here would
      // delay the next read. Detached means the surrounding try cannot see a
      // rejection, and an unhandled one takes the whole server down (the
      // process-level handler shuts it down), so each gesture is caught in
      // processGesturesInOrder.
      void this.processGesturesInOrder(side, gestures, readTarget);
    } catch (error) {
      logger.error(error);
    }
  }

  // A target that moved while the side stayed on, and that Nightstand did not
  // send, was changed on the bed itself: a Pod 5 hub acts on cover clicks.
  // Returns the target before that change.
  private hubStepFrom(nextDeviceStatus: DeviceStatus, side: Side): number | null {
    const before = this.deviceStatus?.[side];
    const after = nextDeviceStatus[side];
    if (!before?.isOn || !after.isOn || before.targetTemperatureF === after.targetTemperatureF) return null;
    // Anything sent since the previous read is ours, however long the reads were failing.
    if (wasSentSince(side, after.targetTemperatureF, this.readAt - SENT_SLACK_MS)
      || this.writtenTargets[side]?.written.has(after.targetTemperatureF)) return null;
    return before.targetTemperatureF;
  }

  private noteHubChange(side: Side, fromF: number, targetF: number) {
    logger.info(`[frankenMonitor] ${side} target changed on the bed: ${fromF} -> ${targetF} F`);
    markManualTempChange(side, { targetF, fromF, on: true, setsOn: false, source: 'tap' })
      .catch(error => logger.error(`Failed to note the ${side} side's change: ${error instanceof Error ? error.message : String(error)}`));
  }

  // Not async: it awaits nothing, and an async function called without await
  // is the same floating-promise trap the gesture calls above just closed.
  private processGestures(nextDeviceStatus: DeviceStatus) {
    if (!this.deviceStatus) {
      logger.warn('Missing current deviceStatus, exiting...');
      return;
    }

    // Read before settling, which forgets targets the gestures wrote.
    const hubFrom = { left: this.hubStepFrom(nextDeviceStatus, 'left'), right: this.hubStepFrom(nextDeviceStatus, 'right') };
    this.settleWrittenTargets(nextDeviceStatus);
    this.processGesturesForSide(nextDeviceStatus, 'left', hubFrom.left);
    this.processGesturesForSide(nextDeviceStatus, 'right', hubFrom.right);
  }

  // Cheap deep-equality for the status payload. The shape is stable so a
  // JSON round-trip is the simplest correct comparison.
  private hasStatusChanged(next: DeviceStatus): boolean {
    if (!this.deviceStatus) return true;
    return JSON.stringify(this.deviceStatus) !== JSON.stringify(next);
  }

  private async frankenLoop() {
    const franken = await connectFranken();
    try {
      const first = await franken.getDeviceStatus(true);
      this.setDeviceStatus(first);
      eventBus.emit('device-status', first);
    } catch (error) {
      // A failed first read must not kill the monitor before its retry loop
      // even starts: the loop below fetches every tick, and gestures resume
      // once a snapshot lands.
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`FrankenMonitor: initial device status failed (${message}); will retry in loop`);
    }

    while (this.isRunning) {
      try {
        while (this.isRunning) {
          await wait(POLL_MS);
          if (!this.isRunning) break;
          const f = await connectFranken();
          let nextDeviceStatus: DeviceStatus;
          try {
            nextDeviceStatus = await f.getDeviceStatus(true);
          } catch (error) {
            if (error instanceof FrankenCommandTimeoutError) {
              logger.warn(`FrankenMonitor: ${error.message}; will retry next tick`);
              this.markStatus('failed', error.message);
              continue;
            }
            throw error;
          }

          await settingsDB.read();
          this.processGestures(nextDeviceStatus);
          waterLevelTracker.observe(nextDeviceStatus.waterLevel);

          if (this.hasStatusChanged(nextDeviceStatus)) {
            eventBus.emit('device-status', nextDeviceStatus);
          }
          this.setDeviceStatus(nextDeviceStatus);
          this.markStatus('healthy', '');
        }
      } catch (error) {
        this.markStatus('failed', String(error));
        logger.error(error instanceof Error ? error.message : String(error), 'franken disconnected');
        await wait(POLL_MS);
      }
    }
    logger.debug('FrankenMonitor loop exited');
  }
}
