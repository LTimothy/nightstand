import assert from 'node:assert/strict';
import { describe, it, before, beforeEach, afterEach, mock } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const dataFolder = mkdtempSync(path.join(tmpdir(), 'nightstand-boost-'));
mkdirSync(path.join(dataFolder, 'lowdb'));
process.env.DATA_FOLDER = `${dataFolder}/`;
process.env.ENV = 'local';
const boostFile = path.join(dataFolder, 'boost.json');
let pod;
let reads = 0;
let updates = [];
mock.module(new URL('../routes/deviceStatus/updateDeviceStatus.js', import.meta.url).href, {
    namedExports: {
        updateDeviceStatus: async (status, options = {}) => {
            updates.push([status, options]);
            for (const side of ['left', 'right']) {
                const target = status[side]?.targetTemperatureF;
                if (target !== undefined)
                    pod[side].targetTemperatureF = target;
            }
        },
    },
});
// Runs before a read returns; a test can make it throw or wait.
let beforeRead;
const readStatus = async () => {
    reads += 1;
    await beforeRead?.();
    return structuredClone(pod);
};
mock.module(new URL('./frankenServer.js', import.meta.url).href, {
    namedExports: {
        connectFrankenWithin: async () => ({ getDeviceStatus: readStatus }),
        connectFranken: async () => ({ getDeviceStatus: readStatus }),
        FrankenCommandTimeoutError: class extends Error {
        },
    },
});
let manualChanges = 0;
mock.module(new URL('../jobs/scheduleOverride.js', import.meta.url).href, {
    namedExports: { markManualTempChange: async () => { manualChanges += 1; } },
});
let boost;
let noteSentTarget;
before(async () => {
    boost = await import('./boost.js');
    ({ noteSentTarget } = await import('./sentTargets.js'));
});
const NOW = 1_800_000_000_000;
const MINUTE = 60_000;
// Timer callbacks finish on real file IO, so wait for their effect.
async function settle(done = () => false) {
    for (let i = 0; i < 2000 && !done(); i++)
        await new Promise(resolve => setImmediate(resolve));
}
const restores = () => updates.filter(([, options]) => options.background);
const stored = () => JSON.parse(readFileSync(boostFile, 'utf8'));
describe('boost', () => {
    beforeEach(async () => {
        pod = { left: { isOn: false, targetTemperatureF: 80 }, right: { isOn: false, targetTemperatureF: 80 } };
        await boost.endBoost('left');
        await boost.endBoost('right');
        rmSync(boostFile, { force: true });
        pod.left.isOn = true;
        pod.right.isOn = true;
        updates = [];
        reads = 0;
        manualChanges = 0;
    });
    afterEach(() => {
        beforeRead = undefined;
        mock.timers.reset();
    });
    it('sets the boost target, then restores the target from before the press', async () => {
        mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOW });
        assert.equal(await boost.startBoost('left', 55, 5, NOW - 20_000), true);
        assert.deepEqual(updates, [[{ left: { targetTemperatureF: 55 } }, { notAfter: NOW + 10_000 }]]);
        assert.deepEqual(stored(), { left: { boostF: 55, previousF: 80, endsAt: NOW + 5 * MINUTE, sentAt: NOW } });
        mock.timers.tick(5 * MINUTE - 1);
        await settle();
        assert.deepEqual(restores(), []);
        mock.timers.tick(1);
        await settle(() => restores().length > 0);
        assert.deepEqual(restores(), [[{ left: { targetTemperatureF: 80 } }, { background: true }]]);
        await settle(() => !('left' in stored()));
        assert.deepEqual(stored(), {});
        assert.equal(manualChanges, 0);
    });
    for (const [what, movedF] of [['a schedule step', 72], ['a plus press', 56], ['the app', 90]]) {
        it(`leaves a target moved by ${what} during the boost`, async () => {
            mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOW });
            await boost.startBoost('left', 55, 5, NOW);
            pod.left.targetTemperatureF = movedF;
            mock.timers.tick(5 * MINUTE);
            await settle(() => reads === 2);
            await settle();
            assert.equal(reads, 2);
            assert.deepEqual(restores(), []);
            assert.equal(pod.left.targetTemperatureF, movedF);
        });
    }
    it('restores a side turned off during the boost without turning it on', async () => {
        mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOW });
        await boost.startBoost('left', 55, 5, NOW);
        pod.left.isOn = false;
        mock.timers.tick(5 * MINUTE);
        await settle(() => restores().length > 0);
        assert.deepEqual(restores(), [[{ left: { targetTemperatureF: 80 } }, { background: true }]]);
        assert.equal(pod.left.isOn, false);
    });
    it('restarts the timer on a second press and keeps the first return temperature', async () => {
        mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOW });
        await boost.startBoost('left', 55, 5, NOW);
        mock.timers.tick(30_000);
        assert.equal(await boost.startBoost('left', 55, 5, NOW + 30_000), true);
        assert.equal(stored().left.previousF, 80);
        mock.timers.tick(5 * MINUTE - 1);
        await settle();
        assert.deepEqual(restores(), []);
        mock.timers.tick(1);
        await settle(() => restores().length > 0);
        assert.deepEqual(restores(), [[{ left: { targetTemperatureF: 80 } }, { background: true }]]);
    });
    it('keeps the boost and tries again 30 s after a failed status read', async () => {
        mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOW });
        await boost.startBoost('left', 55, 5, NOW);
        beforeRead = async () => {
            beforeRead = undefined;
            throw new Error('no answer');
        };
        mock.timers.tick(5 * MINUTE);
        await settle(() => reads === 2);
        await settle();
        assert.deepEqual(restores(), []);
        assert.equal(stored().left.previousF, 80);
        mock.timers.tick(30_000);
        await settle(() => restores().length > 0);
        assert.deepEqual(restores(), [[{ left: { targetTemperatureF: 80 } }, { background: true }]]);
        await settle(() => !('left' in stored()));
        assert.deepEqual(stored(), {});
    });
    it('keeps the first return temperature for a press during the end read', async () => {
        mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOW });
        await boost.startBoost('left', 55, 5, NOW);
        let release = () => { };
        beforeRead = () => {
            beforeRead = undefined;
            return new Promise(resolve => { release = resolve; });
        };
        mock.timers.tick(5 * MINUTE);
        await settle(() => reads === 2);
        assert.equal(await boost.startBoost('left', 55, 5, Date.now()), true);
        release();
        await settle();
        assert.deepEqual(restores(), []);
        assert.equal(stored().left.previousF, 80);
        mock.timers.tick(5 * MINUTE);
        await settle(() => restores().length > 0);
        assert.deepEqual(restores(), [[{ left: { targetTemperatureF: 80 } }, { background: true }]]);
    });
    it('returns to a target moved before a second press', async () => {
        mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOW });
        await boost.startBoost('left', 55, 5, NOW);
        pod.left.targetTemperatureF = 72;
        mock.timers.tick(30_000);
        assert.equal(await boost.startBoost('left', 55, 5, NOW + 30_000), true);
        assert.equal(stored().left.previousF, 72);
    });
    it('returns false and writes nothing for a side that is off', async () => {
        pod.right.isOn = false;
        assert.equal(await boost.startBoost('right', 55, 5, Date.now()), false);
        assert.deepEqual(updates, []);
        assert.equal(existsSync(boostFile), false);
    });
    it('leaves the target when something sent the boost level again after it', async () => {
        mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOW });
        // A level no other test sends, as sent targets outlive a test.
        await boost.startBoost('right', 57, 5, NOW);
        mock.timers.tick(MINUTE);
        noteSentTarget('right', 57, Date.now());
        mock.timers.tick(4 * MINUTE);
        await settle(() => reads === 2);
        await settle();
        assert.equal(reads, 2);
        assert.deepEqual(restores(), []);
    });
    it('never marks a manual change', async () => {
        mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOW });
        await boost.startBoost('right', 60, 1, NOW);
        mock.timers.tick(MINUTE);
        await settle(() => restores().length > 0);
        assert.equal(restores().length, 1);
        assert.equal(manualChanges, 0);
    });
    describe('restoreBoosts', () => {
        it('restores at once a boost that ended while the server was down', async () => {
            pod.left.targetTemperatureF = 55;
            const ended = { boostF: 55, previousF: 78, endsAt: Date.now() - MINUTE, sentAt: Date.now() - 6 * MINUTE };
            writeFileSync(boostFile, JSON.stringify({ left: ended }));
            await boost.restoreBoosts();
            await settle(() => restores().length > 0);
            assert.deepEqual(restores(), [[{ left: { targetTemperatureF: 78 } }, { background: true }]]);
            await settle(() => !('left' in stored()));
            assert.deepEqual(stored(), {});
        });
        it('restores a running boost when it ends', async () => {
            mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOW });
            pod.right.targetTemperatureF = 55;
            writeFileSync(boostFile, JSON.stringify({ right: { boostF: 55, previousF: 70, endsAt: NOW + MINUTE, sentAt: NOW - 4 * MINUTE } }));
            await boost.restoreBoosts();
            await settle();
            assert.deepEqual(updates, []);
            mock.timers.tick(MINUTE);
            await settle(() => restores().length > 0);
            assert.deepEqual(restores(), [[{ right: { targetTemperatureF: 70 } }, { background: true }]]);
        });
        it('drops a boost that ended 13 h ago', async () => {
            pod.left.targetTemperatureF = 55;
            writeFileSync(boostFile, JSON.stringify({ left: { boostF: 55, previousF: 78, endsAt: Date.now() - 13 * 60 * MINUTE, sentAt: 0 } }));
            await boost.restoreBoosts();
            await settle();
            assert.deepEqual(updates, []);
            assert.equal(reads, 0);
        });
        const changed = [['off and moved', { isOn: false, targetTemperatureF: 66 }], ['moved', { isOn: true, targetTemperatureF: 66 }]];
        for (const [what, value] of changed) {
            it(`leaves a side that is ${what}`, async () => {
                pod.left = { ...value };
                writeFileSync(boostFile, JSON.stringify({ left: { boostF: 55, previousF: 78, endsAt: Date.now() - MINUTE, sentAt: 0 } }));
                await boost.restoreBoosts();
                await settle(() => reads === 1);
                await settle();
                assert.equal(reads, 1);
                assert.deepEqual(updates, []);
            });
        }
        for (const [what, content] of [['missing', null], ['unparsable', '{not json'], ['not boosts', '{"left":{"boostF":"cold"}}']]) {
            it(`does nothing for a file that is ${what}`, async () => {
                if (content !== null)
                    writeFileSync(boostFile, content);
                await boost.restoreBoosts();
                await settle();
                assert.deepEqual(updates, []);
                assert.equal(reads, 0);
            });
        }
    });
});
//# sourceMappingURL=boost.test.js.map