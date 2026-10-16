import assert from 'node:assert/strict';
import { after, afterEach, describe, it } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import schedule from 'node-schedule';

const folder = mkdtempSync(path.join(tmpdir(), 'nightstand-alarm-activity-'));
mkdirSync(path.join(folder, 'lowdb'));
process.env.DATA_FOLDER = `${folder}/`;
process.env.ENV = 'local';
const { nightAlarmPending, resetAlarmActivity, rhythmNightAlarms, trackAlarm, waitForNightAlarms } = await import('./alarmActivity.js');
const { setRebuilding } = await import('./rebuildState.js');
after(() => rmSync(folder, { recursive: true, force: true }));

const MINUTE = 60_000;
const NIGHT = rhythmNightAlarms('left', '2026-09-29');
const inMinutes = (minutes: number) => new Date(Date.now() + minutes * MINUTE);

afterEach(() => {
  for (const name of Object.keys(schedule.scheduledJobs)) schedule.cancelJob(name);
  resetAlarmActivity();
  setRebuilding(false);
});

describe('nightAlarmPending', () => {
  it('counts an alarm of the night due by the given time', () => {
    schedule.scheduleJob('rhythm-left-2026-09-29-alarm-0700-0', inMinutes(20), () => {});
    assert.equal(nightAlarmPending('left', inMinutes(30), NIGHT), true);
    assert.equal(nightAlarmPending('left', inMinutes(10), NIGHT), false);
  });

  it("ignores another night's alarms and the other side's", () => {
    schedule.scheduleJob('rhythm-left-2026-09-30-alarm-0700-0', inMinutes(20), () => {});
    schedule.scheduleJob('rhythm-right-2026-09-29-alarm-0700-0', inMinutes(20), () => {});
    assert.equal(nightAlarmPending('left', inMinutes(30), NIGHT), false);
  });

  it('counts the one-time alarm, which can end any night', () => {
    schedule.scheduleJob('left-one-off-alarm', inMinutes(20), () => {});
    assert.equal(nightAlarmPending('left', inMinutes(30), NIGHT), true);
  });

  it('counts an alarm while it rings, and not after', async () => {
    let ring: (ms: number) => void = () => {};
    void trackAlarm('left', 'rhythm-left-2026-09-29-alarm-0700-0', () => new Promise<number>(resolve => { ring = resolve; }));
    assert.equal(nightAlarmPending('left', new Date(), NIGHT), true);
    ring(0);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(nightAlarmPending('left', new Date(), NIGHT), false);
  });

  it('counts as pending while the jobs are re-planned, when the list is empty', () => {
    setRebuilding(true);
    assert.equal(Object.keys(schedule.scheduledJobs).length, 0);
    assert.equal(nightAlarmPending('left', inMinutes(30), NIGHT), true);
  });
});

describe('waitForNightAlarms', () => {
  it('leaves no listener behind on the shutdown signal', async () => {
    // Node does not warn for an AbortSignal here, so count the abort listeners.
    const proto = EventTarget.prototype;
    const { addEventListener, removeEventListener } = proto;
    let open = 0;
    proto.addEventListener = function (type: string, ...rest: [never]) {
      if (type === 'abort') open++;
      return addEventListener.call(this, type, ...rest);
    };
    proto.removeEventListener = function (type: string, ...rest: [never]) {
      if (type === 'abort') open--;
      return removeEventListener.call(this, type, ...rest);
    };
    try {
      for (let i = 0; i < 20; i++) await waitForNightAlarms('left', new Date(), NIGHT);
    } finally {
      proto.addEventListener = addEventListener;
      proto.removeEventListener = removeEventListener;
    }
    assert.equal(open, 0);
  });
});
