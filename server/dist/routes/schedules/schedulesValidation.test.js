import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import express from 'express';
// Isolated DATA_FOLDER, set before the dynamic imports (config.ts reads it at
// import time). Same pattern as jobs/scheduleOverride.test.ts.
const dataFolder = mkdtempSync(path.join(tmpdir(), 'nightstand-schedules-validation-'));
mkdirSync(path.join(dataFolder, 'lowdb'));
process.env.DATA_FOLDER = `${dataFolder}/`;
process.env.ENV = 'local';
let schedulesRouter;
let schedulesDB;
let SchedulesUpdateSchema;
let MAX_ALARMS_PER_DAY;
let server;
let baseUrl;
before(async () => {
    ({ default: schedulesRouter } = await import('./schedules.js'));
    ({ default: schedulesDB } = await import('../../db/schedules.js'));
    ({ SchedulesUpdateSchema, MAX_ALARMS_PER_DAY } = await import('../../db/schedulesSchema.js'));
    const app = express();
    app.use(express.json());
    app.use(schedulesRouter);
    server = createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
    await new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
    });
});
const validAlarm = {
    enabled: true,
    time: '07:00',
    vibrationIntensity: 100,
    vibrationPattern: 'rise',
    duration: 60,
    alarmTemperature: 82,
};
const postSchedules = async (body) => {
    const res = await fetch(`${baseUrl}/schedules`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
};
describe('POST /schedules partial updates', () => {
    it('updates or disables only the first alarm through a legacy write', async () => {
        const later = { ...validAlarm, time: '08:00' };
        const last = { ...validAlarm, time: '08:30', enabled: false };
        await postSchedules({ left: { monday: { alarms: [validAlarm, later, last] } } });
        for (const enabled of [true, false, true]) {
            const first = { ...validAlarm, time: '07:15', enabled };
            const res = await postSchedules({ left: { monday: { alarm: first } } });
            assert.equal(res.status, 200);
            assert.deepEqual(res.body.left.monday.alarms, [first, later, last]);
            assert.deepEqual(res.body.left.monday.alarm, first);
            await schedulesDB.read();
            assert.deepEqual(schedulesDB.data.left.monday.alarms, [first, later, last]);
        }
    });
    it('creates the first alarm on an empty day and lets the array replace it', async () => {
        await postSchedules({ right: { tuesday: { alarms: [] } } });
        const disabled = { ...validAlarm, enabled: false };
        const res = await postSchedules({ right: { tuesday: { alarm: disabled } } });
        assert.equal(res.status, 200);
        assert.deepEqual(res.body.right.tuesday.alarms, [disabled]);
        const cleared = await postSchedules({ right: { tuesday: { alarm: validAlarm, alarms: [] } } });
        assert.deepEqual(cleared.body.right.tuesday.alarms, []);
        assert.equal(cleared.body.right.tuesday.alarm.enabled, false);
    });
    it('accepts a partial power patch', async () => {
        const res = await postSchedules({ left: { monday: { power: { enabled: true } } } });
        assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
    });
    it('accepts a complete alarm', async () => {
        const res = await postSchedules({ left: { monday: { alarms: [validAlarm] } } });
        assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
        await schedulesDB.read();
        assert.equal(schedulesDB.data.left.monday.alarms[0].time, '07:00');
    });
    it('accepts an empty alarms array, which is how the UI clears alarms', async () => {
        const res = await postSchedules({ left: { monday: { alarms: [] } } });
        assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
    });
});
describe('POST /schedules alarm validation', () => {
    it('rejects an alarm entry with no time field', async () => {
        // A recurring alarm with `enabled: true` but no `time` is nonsense: there
        // is no moment for it to fire at, and the scheduler splits that string.
        const res = await postSchedules({ left: { monday: { alarms: [{ enabled: true }] } } });
        assert.equal(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(res.body)}`);
    });
    it('rejects an alarm entry missing vibration/duration fields', async () => {
        // These flow straight into the CBOR payload sent to the pod hardware.
        const res = await postSchedules({ left: { wednesday: { alarms: [{ enabled: true, time: '07:00' }] } } });
        assert.equal(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(res.body)}`);
    });
    it('rejects an incomplete legacy singular alarm', async () => {
        const res = await postSchedules({ left: { monday: { alarm: { enabled: true } } } });
        assert.equal(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(res.body)}`);
    });
    it('keeps the existing error response shape', async () => {
        const res = await postSchedules({ left: { monday: { alarms: [{ enabled: true }] } } });
        assert.equal(res.body.error, 'Invalid request data');
        assert.ok(Array.isArray(res.body.details));
    });
    it('does not persist a timeless alarm into schedulesDB', async () => {
        await postSchedules({ left: { tuesday: { alarms: [{ enabled: true }] } } });
        await schedulesDB.read();
        const stored = schedulesDB.data.left.tuesday;
        assert.ok(stored.alarms.every((a) => typeof a.time === 'string'), `stored alarms lost their time: ${JSON.stringify(stored.alarms)}`);
        assert.equal(typeof stored.alarm.time, 'string', `primary alarm lost its time: ${JSON.stringify(stored.alarm)}`);
    });
    it('rejects a schema-level empty alarm object', () => {
        const parsed = SchedulesUpdateSchema.safeParse({ left: { monday: { alarms: [{}] } } });
        assert.equal(parsed.success, false, 'the update schema accepted an entirely empty alarm entry');
    });
    it('caps the number of alarms per day', async () => {
        const res = await postSchedules({
            left: { friday: { alarms: Array.from({ length: MAX_ALARMS_PER_DAY + 1 }, () => validAlarm) } },
        });
        assert.equal(res.status, 400, `expected 400 past the cap, got ${res.status}`);
    });
    it('allows exactly the cap', async () => {
        const res = await postSchedules({
            left: { friday: { alarms: Array.from({ length: MAX_ALARMS_PER_DAY }, () => validAlarm) } },
        });
        assert.equal(res.status, 200, `expected 200 at the cap, got ${res.status}: ${JSON.stringify(res.body)}`);
    });
});
it('allows editing and reducing existing oversized days without spreading or growing them', async () => {
    schedulesDB.data.left.saturday.alarms = Array.from({ length: 12 }, () => ({ ...validAlarm, vibrationPattern: 'rise' }));
    await schedulesDB.write();
    const alarms = Array.from({ length: 12 }, () => ({ ...validAlarm, time: '08:00' }));
    assert.equal((await postSchedules({ left: { saturday: { alarms } } })).status, 200);
    assert.equal((await postSchedules({ left: { friday: { alarms } } })).status, 400);
    assert.equal((await postSchedules({ left: { saturday: { alarms: [...alarms, validAlarm] } } })).status, 400);
    assert.equal((await postSchedules({ left: { saturday: { alarms: alarms.slice(1) } } })).status, 200);
    assert.equal((await postSchedules({ left: { saturday: { alarms } } })).status, 400);
    const invalidAlarms = alarms.slice(1).map(alarm => ({ ...alarm, duration: 999 }));
    assert.equal((await postSchedules({ left: { saturday: { alarms: invalidAlarms } } })).status, 400);
});
describe('temperature set point limit', () => {
    const setPoints = (count) => Object.fromEntries(Array.from({ length: count }, (_, index) => [
        `${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}`, 70,
    ]));
    const limit = async () => (await import('../../db/schedulesSchema.js')).MAX_TEMPERATURES_PER_DAY;
    it('refuses more set points in a day than the cap', async () => {
        const max = await limit();
        assert.equal((await postSchedules({ left: { thursday: { temperatures: setPoints(max + 1) } } })).status, 400);
        assert.equal((await postSchedules({ right: { thursday: { temperatures: setPoints(1440) } } })).status, 400);
    });
    it('allows exactly the cap', async () => {
        const max = await limit();
        assert.equal((await postSchedules({ left: { thursday: { temperatures: setPoints(max) } } })).status, 200);
    });
    it('keeps an existing oversized day editable without letting it grow or spread', async () => {
        const max = await limit();
        const stored = setPoints(max + 12);
        schedulesDB.data.right.sunday.temperatures = stored;
        await schedulesDB.write();
        assert.equal((await postSchedules({ right: { sunday: { power: { on: '21:30' } } } })).status, 200);
        assert.equal((await postSchedules({ right: { sunday: { temperatures: stored } } })).status, 200);
        assert.equal((await postSchedules({ right: { sunday: { temperatures: setPoints(max + 13) } } })).status, 400);
        assert.equal((await postSchedules({ right: { monday: { temperatures: stored } } })).status, 400);
    });
});
describe('POST /schedules with a side or day of the wrong type', () => {
    it('refuses them instead of answering 200 with nothing saved', async () => {
        await schedulesDB.read();
        const before = JSON.stringify(schedulesDB.data);
        for (const body of [{ left: 5 }, { left: 'x' }, { left: [] }, { left: { monday: 'garbage' } }, { right: { sunday: 7 } }, [{}]]) {
            assert.equal((await postSchedules(body)).status, 400, JSON.stringify(body));
        }
        await schedulesDB.read();
        assert.equal(JSON.stringify(schedulesDB.data), before);
    });
    it('still saves a whole day the way the app sends it', async () => {
        await schedulesDB.read();
        const day = structuredClone(schedulesDB.data.left.friday);
        const body = SchedulesUpdateSchema.parse({ left: { friday: { ...day, power: { ...day.power, on: '21:15' } } } });
        assert.equal((await postSchedules(body)).status, 200);
        await schedulesDB.read();
        assert.equal(schedulesDB.data.left.friday.power.on, '21:15');
    });
});
//# sourceMappingURL=schedulesValidation.test.js.map