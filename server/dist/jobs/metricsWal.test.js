import assert from 'node:assert/strict';
import { after, before, beforeEach, mock, test } from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { PrismaClient } from '@prisma/client';
import { applyMigration } from '../testing/migrations.js';
const folder = mkdtempSync(path.join(tmpdir(), 'nightstand-metrics-wal-'));
const database = path.join(folder, 'metrics.db');
const base = new PrismaClient({ datasources: { db: { url: `file:${database}` } } });
let summaryRead;
let summaryWrite;
let detailDelete;
const client = base.$extends({ query: {
        vitals_summaries: {
            async findMany({ args, query }) {
                const result = await query(args);
                const hook = summaryRead;
                summaryRead = undefined;
                await hook?.();
                return result;
            },
            async create({ args, query }) {
                const result = await query(args);
                const hook = summaryWrite;
                summaryWrite = undefined;
                await hook?.();
                return result;
            },
        },
        async $executeRaw({ args, query }) {
            const result = await query(args);
            const hook = detailDelete;
            detailDelete = undefined;
            await hook?.();
            return result;
        },
    } });
mock.module(new URL('../db/prisma.js', import.meta.url).href, { namedExports: { prisma: client } });
mock.module(new URL('../features/biometricsV2.js', import.meta.url).href, {
    namedExports: { biometricsV2Enabled: () => false },
});
const { default: router } = await import('../routes/metrics/vitals.js');
const { pruneMetrics, retentionCutoffs } = await import('./metricsRetention.js');
const { collectNightSummary } = await import('../db/vitalsSummary.js');
const route = router.stack.find(layer => layer.route?.path === '/vitals/summary')?.route;
assert.ok(route);
const handler = route.stack[0].handle;
const now = new Date('2026-10-07T12:00:00Z');
const second = now.getTime() / 1000;
const day = 86400;
before(async () => {
    for (const name of readdirSync('prisma/migrations').filter(name => /^\d/.test(name)).sort()) {
        await applyMigration(client, 'prisma/migrations', name);
    }
    const [journal] = await client.$queryRaw `PRAGMA journal_mode = WAL`;
    assert.equal(journal.journal_mode, 'wal');
});
beforeEach(async () => {
    summaryRead = summaryWrite = detailDelete = undefined;
    await client.vitals.deleteMany();
    await client.vitals_summaries.deleteMany();
    await client.sleep_records.deleteMany();
});
after(async () => {
    await client.$disconnect();
    rmSync(folder, { recursive: true, force: true });
});
function signal() {
    let resolve;
    let reject;
    const promise = new Promise((accept, fail) => { resolve = accept; reject = fail; });
    return { promise, resolve, reject };
}
// A separate process uses the biometrics writer's SQLite settings and signals before its insert.
function concurrentWriter(timestamp) {
    const worker = spawn('python3', ['-u', '-c', `
import json, sqlite3, sys, time
connection = sqlite3.connect(sys.argv[1], isolation_level=None)
assert connection.execute('PRAGMA journal_mode').fetchone()[0] == 'wal'
connection.execute('PRAGMA busy_timeout = 5000')
print('ready', flush=True)
sys.stdin.readline()
print('attempting', flush=True)
started = time.monotonic()
try:
    connection.execute('INSERT INTO vitals (side, timestamp, heart_rate) VALUES (?, ?, ?)',
                       ('right', int(sys.argv[2]), 72))
    print(json.dumps({'ok': True, 'milliseconds': (time.monotonic() - started) * 1000}), flush=True)
except sqlite3.Error as error:
    print(json.dumps({'ok': False, 'error': str(error), 'milliseconds': (time.monotonic() - started) * 1000}), flush=True)
finally:
    connection.close()
`, database, String(timestamp)], { stdio: ['pipe', 'pipe', 'pipe'] });
    const lines = createInterface({ input: worker.stdout });
    const ready = signal();
    const attempting = signal();
    const result = signal();
    for (const signal of [ready, attempting, result])
        signal.promise.catch(() => { });
    let closing = false;
    let stderr = '';
    worker.stderr.on('data', chunk => { stderr += String(chunk); });
    lines.on('line', line => {
        if (line === 'ready')
            ready.resolve();
        else if (line === 'attempting')
            attempting.resolve();
        else
            result.resolve(JSON.parse(line));
    });
    const closed = new Promise(resolve => worker.once('close', code => {
        if (code !== 0 && !closing) {
            const error = new Error(`SQLite writer exited ${code}: ${stderr}`);
            ready.reject(error);
            attempting.reject(error);
            result.reject(error);
        }
        resolve();
    }));
    return { ready: ready.promise, result: result.promise,
        start: async () => { worker.stdin.end('\n'); await attempting.promise; },
        close: async () => { closing = true; worker.kill(); await closed; lines.close(); },
    };
}
async function night(side, start) {
    await client.sleep_records.create({ data: {
            side, entered_bed_at: start, left_bed_at: start + 8 * 3600, sleep_period_seconds: 8 * 3600,
            times_exited_bed: 0, present_intervals: '[]', not_present_intervals: '[]',
        } });
}
async function summaryResponse(start, end = second) {
    let status = 200;
    let body;
    const response = {
        status(code) { status = code; return response; },
        json(value) { body = value; },
    };
    await handler({ query: { side: 'left', startTime: new Date(start * 1000).toISOString(),
            endTime: new Date(end * 1000).toISOString() } }, response, () => assert.fail('Unexpected next'));
    return { status, body };
}
test('a summary request retains a night pruned between the saved-summary and detail reads', async () => {
    const start = second - 40 * day;
    await night('left', start);
    await night('left', second - day);
    await night('left', second - 2 * day);
    await client.vitals.createMany({ data: [
            { side: 'left', timestamp: start, heart_rate: 50, hrv: 40, breathing_rate: 12 },
            { side: 'left', timestamp: start + 60, heart_rate: 50, hrv: 40, breathing_rate: 12 },
            { side: 'left', timestamp: second, heart_rate: 80, hrv: 70, breathing_rate: 18 },
        ] });
    const expected = { status: 200, body: {
            avgHeartRate: 60, minHeartRate: 50, maxHeartRate: 80, avgHRV: 50, avgBreathingRate: 14,
        } };
    const before = await summaryResponse(start);
    assert.deepEqual(before, expected);
    summaryRead = async () => {
        const result = await pruneMetrics(base, retentionCutoffs(now, null, { metricsRetention: true, metricsLowDiskProtection: false }));
        assert.equal(result.vitals, 2);
    };
    const overlapping = await summaryResponse(start);
    const after = await summaryResponse(start);
    assert.deepEqual(after, expected);
    assert.deepEqual(overlapping, before);
    assert.deepEqual(overlapping, after);
});
test('a summary request detects a payload change with the same saved-summary keys', async () => {
    const start = second - 40 * day;
    await client.vitals.create({ data: { side: 'left', timestamp: start, heart_rate: 50 } });
    const payload = await collectNightSummary(base, 'left', start, start + 8 * 3600);
    const saved = await client.vitals_summaries.create({ data: {
            side: 'left', entered_bed_at: start, left_bed_at: start + 8 * 3600, payload,
        } });
    await client.vitals.deleteMany();
    await client.vitals.create({ data: { side: 'left', timestamp: second, heart_rate: 80 } });
    summaryRead = async () => {
        const updated = JSON.parse(payload);
        for (const key of ['heart', 'positiveHeart'])
            updated.stats[key] = { sum: 60, count: 1, min: 60, max: 60 };
        await base.vitals_summaries.update({ where: { id: saved.id }, data: { payload: JSON.stringify(updated) } });
    };
    assert.deepEqual(await summaryResponse(start), { status: 200, body: {
            avgHeartRate: 70, minHeartRate: 60, maxHeartRate: 80, avgHRV: 0, avgBreathingRate: 0,
        } });
});
for (const changes of [2, 3]) {
    test(changes === 2 ? 'a summary request succeeds when the third attempt is stable'
        : 'a summary request returns 503 after three changing attempts', async () => {
        const start = second - 40 * day;
        await client.vitals.createMany({ data: [0, 1, 2].map(index => ({
                side: 'left', timestamp: start + index * day, heart_rate: 60, hrv: 50, breathing_rate: 14,
            })) });
        await client.vitals.create({ data: { side: 'left', timestamp: second, heart_rate: 80, hrv: 50, breathing_rate: 14 } });
        const payload = await collectNightSummary(base, 'left', start, start + 8 * 3600);
        let committed = 0;
        const change = async () => {
            const entered = start + committed * day;
            await base.$transaction(async (transaction) => {
                await transaction.vitals_summaries.create({ data: {
                        side: 'left', entered_bed_at: entered, left_bed_at: entered + 8 * 3600, payload,
                    } });
                await transaction.vitals.deleteMany({ where: { side: 'left', timestamp: entered } });
            });
            committed++;
            // Skip the verification read, then prune again on the next attempt.
            if (committed < changes)
                summaryRead = async () => { summaryRead = change; };
        };
        summaryRead = change;
        const response = await summaryResponse(start);
        const expected = { status: 200, body: {
                avgHeartRate: 65, minHeartRate: 60, maxHeartRate: 80, avgHRV: 50, avgBreathingRate: 14,
            } };
        if (changes === 2)
            assert.deepEqual(response, expected);
        else {
            assert.equal(response.status, 503);
            assert.match(response.body.error, /busy.*retry/i);
        }
        assert.equal(committed, changes);
        assert.deepEqual(await summaryResponse(start), expected);
    });
}
test('a WAL summary request allows a concurrent writer with a five-second busy timeout', { timeout: 15_000 }, async (context) => {
    const start = second - 40 * day;
    await client.vitals.create({ data: { side: 'left', timestamp: start, heart_rate: 60, hrv: 50, breathing_rate: 14 } });
    const writer = concurrentWriter(second);
    try {
        await writer.ready;
        let overlapping = false;
        summaryRead = async () => {
            overlapping = true;
            await writer.start();
            const result = await writer.result;
            assert.equal(result.ok, true, JSON.stringify(result));
            assert.ok(result.milliseconds < 5000, JSON.stringify(result));
            context.diagnostic(`Concurrent summary write: ${result.milliseconds.toFixed(1)} ms`);
        };
        let response;
        await handler({ query: { side: 'left', startTime: new Date(start * 1000).toISOString(),
                endTime: new Date(second * 1000).toISOString() } }, { json: (value) => { response = value; } }, () => assert.fail('Unexpected next'));
        assert.equal(overlapping, true);
        assert.deepEqual(response, { avgHeartRate: 60, minHeartRate: 60, maxHeartRate: 60, avgHRV: 50, avgBreathingRate: 14 });
        assert.equal(await client.vitals.count({ where: { side: 'right', timestamp: second } }), 1);
    }
    finally {
        await writer.close();
    }
});
test('a WAL retention batch with 864000 rows and 600 nights finishes below a second and permits a concurrent writer', { timeout: 30_000 }, async (context) => {
    const start = second - 300 * day;
    for (const side of ['left', 'right']) {
        await client.$executeRaw `WITH RECURSIVE samples(offset) AS (
        SELECT 0 UNION ALL SELECT offset + 1 FROM samples WHERE offset < 431999
      ) INSERT INTO vitals (side, timestamp, heart_rate, hrv, breathing_rate)
        SELECT ${side}, ${start} + offset * 60, 60, 50, 14 FROM samples`;
        await client.sleep_records.createMany({ data: Array.from({ length: 300 }, (_, index) => ({
                side, entered_bed_at: start + index * day, left_bed_at: start + index * day + 8 * 3600,
                sleep_period_seconds: 8 * 3600, times_exited_bed: 0, present_intervals: '[]', not_present_intervals: '[]',
            })) });
    }
    const writer = concurrentWriter(second);
    try {
        await writer.ready;
        let overlapping = false;
        summaryWrite = async () => { overlapping = true; await writer.start(); };
        const milliseconds = [];
        const plainClient = client;
        const transaction = plainClient.$transaction.bind(plainClient);
        const timedTransaction = async (callback, options) => {
            const started = performance.now();
            try {
                return await transaction(callback, options);
            }
            finally {
                milliseconds.push(performance.now() - started);
            }
        };
        const measuredClient = new Proxy(client, { get: (target, property) => property === '$transaction' ? timedTransaction : Reflect.get(target, property) });
        let checks = 0;
        const result = await pruneMetrics(measuredClient, retentionCutoffs(now, 1), async () => ++checks === 1 ? 1 : 200 * 1024 * 1024);
        assert.equal(overlapping, true);
        assert.deepEqual(result, { vitals: 1000, batches: 1, stopped: 'complete' });
        assert.equal(milliseconds.length, 1);
        context.diagnostic(`1000-row WAL batch transaction: ${milliseconds[0].toFixed(1)} ms`);
        assert.ok(milliseconds[0] < 1000, `${milliseconds[0]} ms`);
        const write = await writer.result;
        context.diagnostic(`Concurrent retention write: ${write.milliseconds.toFixed(1)} ms`);
        assert.equal(write.ok, true, JSON.stringify(write));
        assert.ok(write.milliseconds < 5000, JSON.stringify(write));
        assert.equal(await client.vitals.count(), 863001);
        assert.equal(await client.sleep_records.count(), 600);
        assert.equal(await client.vitals_summaries.count(), 2);
        assert.equal(await client.vitals.count({ where: { side: 'right', timestamp: second } }), 1);
    }
    finally {
        await writer.close();
    }
});
test('a retention transaction exceeding three seconds rolls back its summary and deletion and stops the run', { timeout: 10_000 }, async () => {
    const start = second - 40 * day;
    await night('left', start);
    await night('left', second - day);
    await night('left', second - 2 * day);
    await client.vitals.create({ data: { side: 'left', timestamp: start, heart_rate: 60 } });
    const before = await client.vitals.findMany();
    detailDelete = async () => { await delay(3200); };
    const started = performance.now();
    const result = await pruneMetrics(client, retentionCutoffs(now, null, { metricsRetention: true, metricsLowDiskProtection: false }));
    assert.deepEqual(result, { vitals: 0, batches: 0, stopped: 'transaction timeout' });
    assert.ok(performance.now() - started < 5000);
    assert.deepEqual(await client.vitals.findMany(), before);
    assert.equal(await client.vitals_summaries.count(), 0);
    assert.equal(await client.sleep_records.count(), 3);
});
//# sourceMappingURL=metricsWal.test.js.map