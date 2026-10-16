import assert from 'node:assert/strict';
import { after, before, describe, it, mock } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import cbor from 'cbor';
const dataFolder = mkdtempSync(path.join(tmpdir(), 'nightstand-alarm-pattern-'));
mkdirSync(path.join(dataFolder, 'lowdb'));
process.env.DATA_FOLDER = `${dataFolder}/`;
process.env.ENV = 'local';
const commands = [];
let hubVersion = 'Pod 5';
let coverVersion = 'Pod 5';
mock.module(new URL('../8sleep/deviceApi.js', import.meta.url).href, {
    namedExports: { executeFunction: async (...args) => { commands.push(args); } },
});
mock.module(new URL('../8sleep/frankenServer.js', import.meta.url).href, {
    namedExports: { connectFrankenWithin: async () => ({
            getDeviceStatus: async () => ({ left: { isOn: true }, right: { isOn: true }, hubVersion, coverVersion }),
        }) },
});
let executeAlarm;
before(async () => {
    ({ executeAlarm } = await import('./alarmScheduler.js'));
});
after(() => {
    rmSync(dataFolder, { recursive: true, force: true });
});
const sentPattern = async (vibrationPattern) => {
    commands.length = 0;
    await executeAlarm({ side: 'right', vibrationIntensity: 40, duration: 10, vibrationPattern, force: true });
    const alarmCommand = commands.find(([command]) => command === 'ALARM_RIGHT');
    assert.ok(alarmCommand, 'no ALARM_RIGHT command was sent');
    const payload = cbor.decodeFirstSync(Buffer.from(alarmCommand[1], 'hex'));
    assert.equal(payload.pl, 40);
    return payload.pi;
};
describe('alarm vibration pattern', () => {
    for (const version of ['Pod 3', 'Pod 4', 'Version not found']) {
        it(`sends double for every alarm on ${version}`, async () => {
            hubVersion = version;
            assert.equal(await sentPattern('rise'), 'double');
            assert.equal(await sentPattern('double'), 'double');
        });
    }
    it('sends the chosen pattern on a Pod 5', async () => {
        hubVersion = 'Pod 5';
        assert.equal(await sentPattern('rise'), 'rise');
        assert.equal(await sentPattern('double'), 'double');
    });
});
for (const cover of ['Pod 3', 'Pod 4', 'Version not found', undefined]) {
    it(`sends double on a Pod 5 hub with cover ${cover}`, async () => {
        hubVersion = 'Pod 5';
        coverVersion = cover;
        assert.equal(await sentPattern('rise'), 'double');
    });
}
//# sourceMappingURL=alarmPattern.test.js.map