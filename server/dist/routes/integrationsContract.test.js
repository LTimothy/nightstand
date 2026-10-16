import assert from 'node:assert/strict';
import { after, describe, it, mock } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { z } from 'zod';
const folder = mkdtempSync(path.join(tmpdir(), 'nightstand-integrations-'));
mkdirSync(path.join(folder, 'lowdb'));
process.env.DATA_FOLDER = `${folder}/`;
process.env.ENV = 'local';
process.env.DATABASE_URL = `file:${folder}/contract.db`;
const serverRoot = path.resolve(import.meta.dirname, '../..');
execFileSync(process.execPath, [
    path.join(serverRoot, 'node_modules/prisma/build/index.js'), 'migrate', 'deploy',
    '--schema', path.join(serverRoot, 'prisma/schema.prisma'),
], { env: process.env, stdio: 'pipe', timeout: 60_000 });
const device = {
    left: { currentTemperatureF: 75, currentTemperatureLevel: -27, targetTemperatureF: 76,
        isOn: false, secondsRemaining: 0, isAlarmVibrating: false },
    right: { currentTemperatureF: 80, currentTemperatureLevel: -9, targetTemperatureF: 82,
        isOn: false, secondsRemaining: 0, isAlarmVibrating: false },
    isPriming: false, waterLevel: 'false', wifiStrength: 80, coverVersion: 'Pod 5', hubVersion: 'Pod 5',
    freeSleep: { version: '3.6.1', branch: 'dev' }, settings: { v: 1, gainLeft: 400, gainRight: 400, ledBrightness: 50 }, sensorTemps: null,
};
const commands = [];
const deviceWrites = [];
const jobs = [];
mock.module(new URL('../8sleep/frankenServer.js', import.meta.url).href, { namedExports: {
        FrankenCommandTimeoutError: class extends Error {
        }, isFrankenConnected: () => true,
        getDeviceStatusCoalesced: async () => device,
        connectFrankenWithin: async () => ({ callFunction: async (command, arg) => { commands.push([command, arg]); } }),
    } });
mock.module(new URL('./deviceStatus/updateDeviceStatus.js', import.meta.url).href, {
    namedExports: { updateDeviceStatus: async (body) => { deviceWrites.push(body); } },
});
mock.module(new URL('../jobs/scheduleOverride.js', import.meta.url).href, { namedExports: { markManualTempChange: async () => { } } });
mock.module(new URL('../jobs/resumeSchedule.js', import.meta.url).href, { namedExports: { resumeSchedule: async () => { } } });
mock.module(new URL('../jobs/biometrics.js', import.meta.url).href, { namedExports: {
        shouldDisableBiometrics: () => false, shouldEnableBiometrics: () => false,
        triggerBiometricsDisable: async () => { }, triggerBiometricsEnable: async () => { }, reconcileBiometrics: async () => { },
    } });
mock.module(new URL('../jobs/alarmScheduler.js', import.meta.url).href, { namedExports: {
        executeAlarm: async (alarm) => device[alarm.side].isOn || alarm.force ? 10_000 : 0,
    } });
mock.module(new URL('../jobs/analyzeSleep.js', import.meta.url).href, { namedExports: {
        analyzeSleepKey: (side) => `analyze-${side}`, executeAnalyzeSleep: async (side) => { jobs.push(`analyze-${side}`); },
    } });
mock.module(new URL('../jobs/calibrateSensors.js', import.meta.url).href, { namedExports: {
        calibrateSensorsKey: (side) => `calibrate-${side}`,
        executeCalibrateSensors: async (side) => { jobs.push(`calibrate-${side}`); },
    } });
mock.module(new URL('../jobs/executePython.js', import.meta.url).href, { namedExports: { isPythonJobPending: () => false } });
mock.module(new URL('../jobs/reboot.js', import.meta.url).href, { defaultExport: async () => { jobs.push('reboot'); } });
const update = async () => { jobs.push('update'); };
mock.module(new URL('../jobs/update.js', import.meta.url).href, { defaultExport: update, namedExports: { triggerUpdateService: update } });
const { prisma } = await import('../db/prisma.js');
const { setInUseCheck } = await import('./update/update.js');
setInUseCheck(async () => []);
const app = express();
(await import('../setup/middleware.js')).default(app);
for (const name of ['deviceStatus', 'settings', 'schedules', 'services', 'alarm', 'execute', 'jobs']) {
    const { default: router } = await import(`./${name}/${name}.js`);
    app.use('/api', router);
}
for (const name of ['presence', 'vitals', 'sleep', 'movement']) {
    const { default: router } = await import(`./metrics/${name}.js`);
    app.use('/api/metrics', router);
}
app.use('/api/serverStatus', (await import('./serverStatus/serverStatus.js')).default);
const listener = app.listen(0, '127.0.0.1');
await new Promise(resolve => listener.once('listening', resolve));
const base = `http://127.0.0.1:${listener.address().port}`;
after(async () => {
    await new Promise(resolve => { listener.closeAllConnections(); listener.close(() => resolve()); });
    await prisma.$disconnect();
    rmSync(folder, { recursive: true, force: true });
});
const now = Math.floor(Date.now() / 1000);
const iso = (seconds) => new Date(seconds * 1000).toISOString();
await prisma.vitals.create({ data: { side: 'left', timestamp: now - 60, heart_rate: 60, breathing_rate: 14, hrv: 50 } });
await prisma.sleep_records.create({ data: {
        side: 'left', entered_bed_at: now - 3600, left_bed_at: now - 60, sleep_period_seconds: 3540,
        times_exited_bed: 0, present_intervals: JSON.stringify([[now - 3600, now - 60]]), not_present_intervals: '[]',
    } });
await prisma.movement.create({ data: { side: 'left', timestamp: now - 60, total_movement: 3 } });
async function request(route, body) {
    const response = await fetch(`${base}/api/${route}`, body === undefined ? {} : {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, body: (text ? JSON.parse(text) : undefined) };
}
const alarm = { time: '07:00', enabled: true, vibrationIntensity: 100, vibrationPattern: 'rise', duration: 10, alarmTemperature: 82 };
const trigger = { side: 'left', vibrationIntensity: 100, vibrationPattern: 'double', duration: 3, force: true };
const expiresAt = '2099-01-01T00:00:00Z';
const commonWrites = [
    ['deviceStatus', { left: { isOn: true } }, 204], ['deviceStatus', { right: { isOn: false } }, 204],
    ['deviceStatus', { settings: { ledBrightness: 50 } }, 204], ['deviceStatus', { isPriming: true }, 204],
    ['settings', { left: { awayMode: true } }, 200], ['settings', { left: { awayMode: false } }, 200],
];
// Request shapes from the clients' API and entity code, with fixed input values.
const clients = [
    {
        repo: 'Mrtenz/hass-free-sleep', commit: 'ddf0c5e',
        writes: [...commonWrites,
            ['deviceStatus', { left: { targetTemperatureF: 75.5 } }, 204],
            ['settings', { primePodDaily: { enabled: true } }, 200], ['settings', { primePodDaily: { time: '14:00' } }, 200],
            ['settings', { rebootDaily: true }, 200], ['services', { biometrics: { enabled: true } }, 200],
            ['schedules', { left: { monday: { power: { enabled: true }, alarm, temperatures: { '22:00': 75 } } } }, 200],
            ['execute', { command: 'TEMP_LEVEL_LEFT', arg: '-20' }, 200], ['jobs', ['reboot'], 204], ['jobs', ['update'], 204],
            ['schedules', { left: { monday: { alarm: { time: '07:00', enabled: true } } } }, 400],
            ['schedules', { left: { monday: { temperatures: [{ time: '22:00', temperature: 75 }] } } }, 400],
        ], reads: ['deviceStatus', 'settings', 'services', 'metrics/presence',
            `metrics/vitals/summary?side=left&startTime=${iso(now - 300).replace('.000Z', 'Z')}`],
    },
    {
        repo: 'DaSonOfPoseidon/free-sleep-ha', commit: 'b390441',
        writes: [...commonWrites,
            ['deviceStatus', { left: { targetTemperatureF: 75, secondsRemaining: 60 * 60 } }, 204],
            ['deviceStatus', { left: { targetTemperatureF: 75, secondsRemaining: 721 * 60 } }, 400],
            ['deviceStatus', { left: { isAlarmVibrating: false } }, 204], ['alarm', trigger, 200],
            ['settings', { left: { scheduleOverrides: {
                            alarm: { disabled: true, expiresAt }, temperatureSchedules: { disabled: true, expiresAt },
                        } } }, 200],
            ['settings', { temperatureFormat: 'celsius' }, 200],
            ['settings', { primePodDaily: { enabled: true, time: '14:00' }, rebootDaily: false }, 200],
            ['settings', { left: { taps: { doubleTap: { type: 'temperature', change: 'increment', amount: 1 } } } }, 200],
            ['services', { biometrics: { enabled: false } }, 200], ['services', { sentryLogging: { enabled: true } }, 400],
            ['schedules', { left: { monday: { alarm, power: { on: '22:00' }, temperatures: { '23:00': 75 } } } }, 200],
            ['execute', { command: 'HELLO' }, 200],
            ...['reboot', 'update', 'analyzeSleepLeft', 'analyzeSleepRight', 'biometricsCalibrationLeft', 'biometricsCalibrationRight']
                .map(job => ['jobs', [job], 204]),
        ], reads: ['deviceStatus', 'settings', 'metrics/presence', 'schedules', 'services', 'serverStatus',
            ...['vitals/summary', 'sleep', 'movement']
                .map(route => `metrics/${route}?${new URLSearchParams({ side: 'left', startTime: iso(now - 7200) })}`)],
    },
    {
        repo: 'NylonDiamond/free-sleep-hacs', commit: 'd6328cc',
        writes: [...commonWrites,
            ['deviceStatus', { left: { targetTemperatureF: 75 } }, 204], ['deviceStatus', { settings: { gainLeft: 400 } }, 204],
            ['deviceStatus', { settings: { gainRight: 400 } }, 204], ['services', { biometrics: { enabled: true } }, 200],
            ['settings', { rebootDaily: false, primePodDaily: { enabled: true, time: '14:00' } }, 200],
            ['settings', { right: { taps: { tripleTap: {
                                type: 'alarm', behavior: 'dismiss', snoozeDuration: 60, inactiveAlarmBehavior: 'power',
                            } } } }, 200],
            ['settings', { right: { scheduleOverrides: { alarm: { disabled: true, expiresAt } } } }, 200],
            ['schedules', { left: { monday: { alarm: { ...alarm, enabled: false } } } }, 200],
            ['alarm', { side: 'left', vibrationIntensity: 100, vibrationPattern: 'rise', duration: 10 }, 503],
            ['jobs', ['update'], 204], ['jobs', ['reboot'], 204],
        ], reads: ['deviceStatus', 'settings', 'metrics/presence', 'schedules', 'services', 'serverStatus',
            ...['vitals/summary', 'sleep'].map(route => `metrics/${route}?side=left&startTime=${iso(now - 43200)}&endTime=${iso(now)}`)],
    },
    {
        repo: 'caseyWebb/homebridge-free-sleep', commit: '8f92a83',
        writes: [...commonWrites,
            ['deviceStatus', { left: { targetTemperatureF: 75 } }, 204], ['deviceStatus', { left: { secondsRemaining: 43200 } }, 204],
            ['deviceStatus', { right: { isAlarmVibrating: false } }, 204],
            ['alarm', { ...trigger, vibrationIntensity: 60, duration: 10 }, 200],
            ['settings', { left: { scheduleOverrides: { alarm: { disabled: true, timeOverride: '', expiresAt } } } }, 200],
        ], reads: ['deviceStatus', 'settings', 'schedules', 'services', 'serverStatus', 'metrics/presence',
            `metrics/vitals?${new URLSearchParams({ side: 'left', startTime: iso(now - 300), endTime: iso(now) })}`],
    },
];
const statusInfo = z.object({
    name: z.string(), status: z.string(), description: z.string(), message: z.string(), timestamp: z.string().optional(),
});
const alarmRead = z.object({
    time: z.string(), enabled: z.boolean(), vibrationIntensity: z.number(), vibrationPattern: z.string(),
    duration: z.number(), alarmTemperature: z.number(),
});
const dailyRead = z.object({
    alarm: alarmRead, power: z.object({ on: z.string(), off: z.string(), enabled: z.boolean(), onTemperature: z.number() }),
    temperatures: z.record(z.number()),
});
const sideRead = z.object({
    currentTemperatureF: z.number(), targetTemperatureF: z.number(), currentTemperatureLevel: z.number(),
    isOn: z.boolean(), secondsRemaining: z.number(), isAlarmVibrating: z.boolean(),
});
const settingSideRead = z.object({
    name: z.string(), awayMode: z.boolean(), taps: z.record(z.object({ type: z.string() })),
    scheduleOverrides: z.object({ alarm: z.object({ disabled: z.boolean(), expiresAt: z.string(), timeOverride: z.string() }) }),
});
const reads = {
    deviceStatus: z.object({
        left: sideRead, right: sideRead, waterLevel: z.string(), isPriming: z.boolean(), wifiStrength: z.number(),
        coverVersion: z.string(), hubVersion: z.string(), freeSleep: z.object({ version: z.string(), branch: z.string() }),
        settings: z.object({ ledBrightness: z.number(), gainLeft: z.number(), gainRight: z.number(), v: z.number() }),
    }),
    settings: z.object({
        left: settingSideRead, right: settingSideRead, primePodDaily: z.object({ enabled: z.boolean(), time: z.string() }),
        rebootDaily: z.boolean(), temperatureFormat: z.string(), timeZone: z.string(),
    }),
    schedules: z.object({ left: z.record(dailyRead), right: z.record(dailyRead) }),
    services: z.object({ biometrics: z.object({ enabled: z.boolean(), jobs: z.record(statusInfo) }) }),
    serverStatus: z.object(Object.fromEntries([
        'alarmSchedule', 'database', 'express', 'franken', 'frankenMonitor', 'jobs', 'logger', 'powerSchedule',
        'primeSchedule', 'rebootSchedule', 'systemDate', 'temperatureSchedule', 'waterTank',
    ].map(key => [key, statusInfo]))),
    'metrics/presence': z.object({ left: z.object({ present: z.boolean() }), right: z.object({ present: z.boolean() }) }),
    'metrics/vitals/summary': z.object({
        avgHeartRate: z.number(), minHeartRate: z.number(), maxHeartRate: z.number(), avgBreathingRate: z.number(), avgHRV: z.number(),
    }),
    'metrics/vitals': z.array(z.object({
        id: z.number(), side: z.string(), timestamp: z.number(), heart_rate: z.number().nullable(),
        breathing_rate: z.number().nullable(), hrv: z.number().nullable(),
    })),
    'metrics/sleep': z.array(z.object({
        id: z.number(), side: z.string(), entered_bed_at: z.string(), left_bed_at: z.string(),
        sleep_period_seconds: z.number(), times_exited_bed: z.number(),
        present_intervals: z.array(z.tuple([z.string(), z.string()])), not_present_intervals: z.array(z.tuple([z.string(), z.string()])),
    })),
    'metrics/movement': z.array(z.object({ timestamp: z.number(), side: z.string(), total_movement: z.number() })),
};
for (const client of clients) {
    describe(`${client.repo} at ${client.commit}`, () => {
        for (const [index, [route, body, status]] of client.writes.entries()) {
            it(`replays write ${index + 1}: POST /api/${route} (${status})`, async () => {
                const response = await request(route, body);
                assert.equal(response.status, status, JSON.stringify(response.body));
                if (status === 400)
                    assert.equal(response.body.error, 'Invalid request data');
                if (status === 503) {
                    const { error } = z.object({ error: z.object({ message: z.string() }) }).parse(response.body);
                    assert.match(error.message, /did not start/);
                }
                if (status === 200 && reads[route])
                    reads[route].parse(response.body);
                if (route === 'execute')
                    assert.equal(response.body.success, true);
            });
        }
        const clientReads = client.reads.flatMap(route => route.includes('side=left')
            ? [route, route.replace('side=left', 'side=right')] : [route]);
        for (const route of clientReads) {
            it(`pins the fields read from GET /api/${route.split('?')[0]}`, async () => {
                const response = await request(route);
                assert.equal(response.status, 200);
                reads[route.split('?')[0]].parse(response.body);
                if (route.startsWith('metrics/vitals/summary')) {
                    assert.equal(response.body.avgHeartRate, route.includes('side=left') ? 60 : 0);
                }
                if (route.startsWith('metrics/sleep'))
                    assert.equal(response.body.length, route.includes('side=left') ? 1 : 0);
            });
        }
    });
}
it('pins the two Homebridge read-side incompatibilities without restoring dead fields', async () => {
    const services = (await request('services')).body;
    assert.equal(Object.hasOwn(services, 'sentryLogging'), false);
    assert.equal(z.object({ sentryLogging: z.object({ enabled: z.boolean() }) }).safeParse(services).success, false);
    const rows = (await request(`metrics/vitals?side=left&startTime=${iso(now - 300)}`)).body;
    assert.equal(rows[0].timestamp, now - 60);
    assert.equal(z.array(z.object({ timestamp: z.string() })).safeParse(rows).success, false);
});
it('pins NylonDiamond raw positive-offset queries and their encoded replacement', async () => {
    for (const route of ['metrics/vitals/summary', 'metrics/sleep']) {
        assert.equal((await request(`${route}?side=left&startTime=2026-10-07T12:00:00+00:00`)).status, 400);
        assert.equal((await request(`${route}?${new URLSearchParams({ side: 'left', startTime: '2026-10-07T12:00:00+00:00' })}`)).status, 200);
    }
});
it('keeps level display separate from writable Fahrenheit targets', async () => {
    assert.equal((await request('settings', { features: { levelTemps: true }, temperatureFormat: 'level' })).status, 200);
    assert.equal((await request('deviceStatus', { left: { targetTemperatureF: 75 } })).status, 204);
    assert.equal((await request('deviceStatus', { left: { targetTemperatureLevel: 0 } })).status, 400);
    assert.equal((await request('deviceStatus', { left: { currentTemperatureLevel: 0 } })).status, 204);
    assert.deepEqual(deviceWrites.at(-1), { left: { currentTemperatureLevel: 0 } });
    assert.equal((await request('settings', { features: { levelTemps: false } })).status, 409);
});
it('pins update refusal and verifies that side effects used only local stubs', async () => {
    setInUseCheck(async () => ['left-on']);
    const response = await request('jobs', ['update']);
    assert.equal(response.status, 409);
    assert.deepEqual(response.body.reasons, ['left-on']);
    assert.deepEqual(commands, [['TEMP_LEVEL_LEFT', '-20'], ['HELLO', 'empty']]);
    assert.ok(deviceWrites.length > 0);
    assert.ok(jobs.includes('reboot') && jobs.includes('update') && jobs.includes('calibrate-left'));
});
//# sourceMappingURL=integrationsContract.test.js.map