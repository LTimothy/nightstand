import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import cbor from 'cbor';

const dataFolder = mkdtempSync(path.join(tmpdir(), 'free-sleep-status-'));
mkdirSync(path.join(dataFolder, 'lowdb'));
process.env.DATA_FOLDER = `${dataFolder}/`;
process.env.ENV = 'local';

let mod: typeof import('./loadDeviceStatus.js');
before(async () => { mod = await import('./loadDeviceStatus.js'); });

const reply = (overrides: Record<string, string> = {}) => Object.entries({
  tgHeatLevelR: '-40', tgHeatLevelL: '20', heatTimeL: '3600', heatLevelL: '10', heatTimeR: '0',
  heatLevelR: '-100', sensorLabel: '20500-0001-J01-0000', waterLevel: 'true', priming: 'false',
  settings: cbor.encode({ gl: 20, gr: 15, lb: 50 }).toString('hex'),
  doubleTap: '{"l":1,"r":0}', ...overrides,
}).map(([key, value]) => `${key} = ${value}`).join('\n') + '\n\n';

describe('loadDeviceStatus', () => {
  it('maps levels to temperatures on the firmware scale', () => {
    assert.equal(mod.calculateTempInF('-100'), 55);
    assert.equal(mod.calculateTempInF('100'), 110);
    assert.equal(mod.calculateTempInF('0'), 83);
    assert.equal(mod.calculateTempInF('20'), 88);
    assert.equal(mod.calculateTempInF('-40'), 72);
  });

  it('reads both sides, on and off, and the settings', async () => {
    const status = await mod.loadDeviceStatus(reply(), true);
    assert.equal(status.left.isOn, true);
    assert.equal(status.left.secondsRemaining, 3600);
    assert.equal(status.left.currentTemperatureLevel, 10);
    assert.equal(status.left.targetTemperatureF, 88);
    assert.equal(status.right.isOn, false);
    assert.equal(status.right.secondsRemaining, 0);
    assert.equal(status.right.currentTemperatureLevel, -100);
    assert.equal(status.right.currentTemperatureF, 55);
    assert.equal(status.right.targetTemperatureF, 72);
    assert.deepEqual(status.settings, { gainLeft: 20, gainRight: 15, ledBrightness: 50 });
    assert.equal(status.isPriming, false);
    assert.equal(status.waterLevel, 'true');
    assert.equal(status.left.taps?.doubleTap, 1);
    assert.equal(status.right.taps?.doubleTap, 0);
  });

  it('reads a priming reply and a low water level', async () => {
    const status = await mod.loadDeviceStatus(reply({ priming: 'true', waterLevel: 'false' }), false);
    assert.equal(status.isPriming, true);
    assert.equal(status.waterLevel, 'false');
  });

  it('guesses the cover generation from the third sensor label segment', async () => {
    const version = async (sensorLabel: string) => (await mod.loadDeviceStatus(reply({ sensorLabel }), false)).coverVersion;
    assert.equal(await version('20500-0001-J01-0000'), 'Pod 5');
    assert.equal(await version('20500-0001-I05-0000'), 'Pod 4');
    assert.equal(await version('20500-0001-H12-0000'), 'Pod 3');
    assert.equal(await version('test'), 'Version not found');
  });

  it('leaves gestures out unless asked, and tolerates a reply without them', async () => {
    const without = await mod.loadDeviceStatus(reply(), false);
    assert.equal(without.left.taps, undefined);
    const none = await mod.loadDeviceStatus(reply({ doubleTap: '' }), true);
    assert.deepEqual(none.left.taps, {});
    assert.deepEqual(none.right.taps, {});
  });

  it('survives a malformed gesture value', async () => {
    const status = await mod.loadDeviceStatus(reply({ doubleTap: 'not json' }), true);
    assert.equal(status.left.isOn, true);
    assert.equal(status.left.taps?.doubleTap, undefined);
  });

  it('rejects a reply with a malformed level', async () => {
    await assert.rejects(mod.loadDeviceStatus(reply({ heatLevelL: 'warm' }), false));
  });

  it('rejects a negative time remaining and a malformed flag', async () => {
    await assert.rejects(mod.loadDeviceStatus(reply({ heatTimeL: '-5' }), false));
    await assert.rejects(mod.loadDeviceStatus(reply({ priming: 'maybe' }), false));
  });

  it('rejects a reply missing a field', () => {
    assert.throws(() => mod.parseRawDeviceData('tgHeatLevelR = 0\n'));
  });

  it('syncs a firmware dismissal into the returned ringing state even without gestures', async () => {
    const { activeAlarms, forgetActiveAlarm } = await import('../jobs/activeAlarms.js');
    const { default: memoryDB } = await import('../db/memoryDB.js');
    activeAlarms.set('left', { vibrationIntensity: 40, duration: 120, vibrationPattern: 'double' });
    memoryDB.data.left.isAlarmVibrating = true;
    await memoryDB.write();
    try {
      const baseline = await mod.loadDeviceStatus(reply({ dismissAlarm: '{"l":100,"r":0}' }), false);
      assert.equal(baseline.left.isAlarmVibrating, true);
      const dismissed = await mod.loadDeviceStatus(reply({ dismissAlarm: '{"l":101,"r":0}' }), false);
      assert.equal(dismissed.left.isAlarmVibrating, false);
      assert.equal(activeAlarms.has('left'), false);
    } finally {
      forgetActiveAlarm('left');
      memoryDB.data.left.isAlarmVibrating = false;
      await memoryDB.write();
    }
  });
});

describe('hubVersionFromRevision', () => {
  it('reads G43 and later as Pod 5, earlier G revisions as Pod 4', () => {
    for (const [revision, expected] of [['G53', 'Pod 5'], ['G45', 'Pod 5'], ['G43', 'Pod 5'], ['G42', 'Pod 4'], ['G00', 'Pod 4']]) {
      assert.equal(mod.hubVersionFromRevision(revision), expected, revision);
    }
    assert.equal(mod.hubVersionFromRevision('F99'), undefined);
  });
});
