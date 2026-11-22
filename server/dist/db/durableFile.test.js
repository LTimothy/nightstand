import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import logger from '../logger.js';
import { DurableJSONFile, syncToFlash } from './durableFile.js';
const folder = () => mkdtemp(path.join(tmpdir(), 'durable-'));
describe('DurableJSONFile', () => {
    it('writes the new content, then syncs the file and its folder', async () => {
        const dir = await folder();
        const file = path.join(dir, 'db.json');
        const synced = [];
        const db = new DurableJSONFile(file, async (target) => {
            synced.push({ target, text: await readFile(file, 'utf8').catch(() => 'missing') });
        });
        await db.write({ a: 1 });
        assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { a: 1 });
        assert.deepEqual(synced.map(entry => entry.target), [file, dir]);
        assert.deepEqual(JSON.parse(synced[0].text), { a: 1 }, 'synced after the rename');
    });
    it('ends with the last of two overlapping writes and syncs after it', async () => {
        const dir = await folder();
        const file = path.join(dir, 'db.json');
        const seen = [];
        const db = new DurableJSONFile(file, async (target) => {
            if (target === file)
                seen.push(await readFile(file, 'utf8'));
        });
        await Promise.all([db.write({ a: 1 }), db.write({ a: 2 })]);
        assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { a: 2 });
        assert.ok(seen.some(text => JSON.parse(text).a === 2));
    });
    it('does not fail a save when the sync fails, and logs it once', async (t) => {
        const warn = t.mock.method(logger, 'warn', () => logger);
        const dir = await folder();
        const file = path.join(dir, 'db.json');
        const db = new DurableJSONFile(file, async () => { throw new Error('io'); });
        await db.write({ a: 1 });
        assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { a: 1 });
        assert.equal(warn.mock.callCount(), 1);
    });
    it('reads through the JSON file and leaves no temp file behind', async () => {
        const dir = await folder();
        const file = path.join(dir, 'db.json');
        const db = new DurableJSONFile(file, async () => { });
        assert.equal(await db.read(), null);
        await db.write({ a: 3 });
        assert.deepEqual(await db.read(), { a: 3 });
        assert.deepEqual(await readdir(dir), ['db.json']);
    });
});
describe('syncToFlash', () => {
    it('syncs a real file and its folder without throwing or warning', async (t) => {
        const warn = t.mock.method(logger, 'warn', () => logger);
        const dir = await folder();
        const file = path.join(dir, 'x.json');
        await new DurableJSONFile(file, async () => { }).write({ x: 1 });
        await syncToFlash(file);
        assert.equal(warn.mock.callCount(), 0);
    });
});
//# sourceMappingURL=durableFile.test.js.map