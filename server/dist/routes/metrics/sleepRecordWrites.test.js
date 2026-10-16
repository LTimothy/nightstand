import assert from 'node:assert/strict';
import { after, beforeEach, describe, it, mock } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
const folder = mkdtempSync(path.join(tmpdir(), 'nightstand-sleep-record-writes-'));
mkdirSync(path.join(folder, 'lowdb'));
process.env.DATA_FOLDER = `${folder}/`;
process.env.ENV = 'local';
const rows = new Map();
const uniqueConflict = Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
const fakePrisma = {
    sleep_records: {
        findUnique: async ({ where }) => rows.get(where.id) ?? null,
        update: async ({ where, data }) => {
            const current = rows.get(where.id);
            if (!current)
                throw Object.assign(new Error('Record to update not found'), { code: 'P2025' });
            const next = { ...current, ...data };
            for (const row of rows.values()) {
                if (row.id !== next.id && row.side === next.side && row.entered_bed_at === next.entered_bed_at)
                    throw uniqueConflict;
            }
            rows.set(where.id, next);
            return next;
        },
        findFirst: async ({ where }) => [...rows.values()].find(row => row.id !== where.id.not
            && row.side === where.side && row.entered_bed_at < where.entered_bed_at.lt && row.left_bed_at > where.left_bed_at.gt) ?? null,
        deleteMany: async ({ where }) => ({ count: rows.delete(where.id) ? 1 : 0 }),
    },
    vitals_summaries: { findFirst: async () => null, updateMany: async () => ({ count: 0 }), deleteMany: async () => ({ count: 0 }) },
    $transaction: async (work) => work(fakePrisma),
};
mock.module(new URL('../../db/prisma.js', import.meta.url).href, { namedExports: { prisma: fakePrisma } });
const { default: router } = await import('./sleep.js');
const app = express();
app.use(express.json(), router);
const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}/sleep`;
after(async () => {
    await new Promise(resolve => server.close(() => resolve()));
    rmSync(folder, { recursive: true, force: true });
});
const entered = Date.parse('2026-09-27T05:00:00Z') / 1000;
const left = Date.parse('2026-09-27T13:00:00Z') / 1000;
const iso = (seconds) => new Date(seconds * 1000).toISOString();
beforeEach(() => {
    rows.clear();
    for (const id of [1, 2]) {
        rows.set(id, {
            id, side: 'left', entered_bed_at: entered + id * 86_400, left_bed_at: left + id * 86_400,
            sleep_period_seconds: left - entered, times_exited_bed: 1,
            present_intervals: JSON.stringify([[entered + id * 86_400, left + id * 86_400]]),
            not_present_intervals: JSON.stringify([[entered + id * 86_400 + 3_600, entered + id * 86_400 + 3_900]]),
        });
    }
});
const request = async (method, id, body) => {
    const response = await fetch(`${base}/${id}`, {
        method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : undefined };
};
describe('DELETE /sleep/:id', () => {
    for (const id of ['2abc', '1e3', '1.5', '-1', 'abc', '%00', '0', '99999999999999999999']) {
        it(`refuses the id ${id} without deleting anything`, async () => {
            assert.equal((await request('DELETE', id)).status, 400);
            assert.equal(rows.size, 2);
        });
    }
    it('answers 404 for a record that does not exist', async () => {
        assert.equal((await request('DELETE', '999999')).status, 404);
    });
    it('deletes an existing record', async () => {
        assert.equal((await request('DELETE', '2')).status, 204);
        assert.deepEqual([...rows.keys()], [1]);
    });
});
describe('PUT /sleep/:id', () => {
    it('refuses a malformed id instead of updating another record', async () => {
        assert.equal((await request('PUT', '1.5', { times_exited_bed: 3 })).status, 400);
        assert.equal(rows.get(1)?.times_exited_bed, 1);
    });
    it('refuses an interval that ends before it starts', async () => {
        const response = await request('PUT', '1', { entered_bed_at: iso(left + 86_400), left_bed_at: iso(entered + 86_400) });
        assert.equal(response.status, 400);
        assert.equal(rows.get(1)?.sleep_period_seconds, left - entered);
    });
    it('refuses a new start after the stored end', async () => {
        assert.equal((await request('PUT', '1', { entered_bed_at: iso(left + 2 * 86_400) })).status, 400);
    });
    it('refuses a negative sleep period', async () => {
        assert.equal((await request('PUT', '1', { sleep_period_seconds: -500 })).status, 400);
    });
    it('refuses a side that does not exist', async () => {
        assert.equal((await request('PUT', '1', { side: 'middle' })).status, 400);
    });
    it('refuses a time the database cannot store', async () => {
        assert.equal((await request('PUT', '1', { left_bed_at: '9999-12-31T00:00:00Z' })).status, 400);
    });
    it('does not let the body change the record id', async () => {
        assert.equal((await request('PUT', '1', { id: 5000, times_exited_bed: 2 })).status, 200);
        assert.deepEqual([...rows.keys()], [1, 2]);
        assert.equal(rows.get(1)?.times_exited_bed, 2);
    });
    it('answers 404 for a record that does not exist', async () => {
        assert.equal((await request('PUT', '999999', { times_exited_bed: 2 })).status, 404);
    });
    it('recomputes the period when only one end moves', async () => {
        const newEnd = left + 86_400 + 3_600;
        const response = await request('PUT', '1', { left_bed_at: iso(newEnd) });
        assert.equal(response.status, 200);
        assert.equal(rows.get(1)?.sleep_period_seconds, newEnd - (entered + 86_400));
    });
    it('stores edited intervals in the database format', async () => {
        const pair = [iso(entered + 86_400), iso(entered + 86_400 + 60)];
        const response = await request('PUT', '1', { not_present_intervals: [pair] });
        assert.equal(response.status, 200);
        assert.deepEqual(JSON.parse(rows.get(1)?.not_present_intervals ?? ''), [[entered + 86_400, entered + 86_400 + 60]]);
    });
    it('refuses a reversed presence interval', async () => {
        const pair = [iso(entered + 86_400 + 60), iso(entered + 86_400)];
        assert.equal((await request('PUT', '1', { present_intervals: [pair] })).status, 400);
    });
    it('answers 409 when another record already starts at that time', async () => {
        const response = await request('PUT', '1', { entered_bed_at: iso(entered + 2 * 86_400), left_bed_at: iso(left + 2 * 86_400) });
        assert.equal(response.status, 409);
    });
});
//# sourceMappingURL=sleepRecordWrites.test.js.map