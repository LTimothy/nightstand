import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
process.env.DATA_FOLDER = `${mkdtempSync(path.join(tmpdir(), 'nightstand-commit-sync-'))}/`;
process.env.ENV = 'local';
const { commitSeconds, syncFlashCommit } = await import('./flashCommit.js');
const STOCK = '/dev/root / ext4 rw,relatime 0 0\n/dev/mmcblk0p8 /persistent ext4 rw,noatime,discard 0 0\n';
const LONG = '/dev/mmcblk0p8 /persistent ext4 rw,noatime,discard,commit=60 0 0\n';
describe('commitSeconds', () => {
    it('reads the commit option and defaults to 5 s', () => {
        assert.equal(commitSeconds(STOCK), 5);
        assert.equal(commitSeconds(LONG), 60);
    });
    it('is null when /persistent is not an ext4 mount', () => {
        assert.equal(commitSeconds('/dev/root / ext4 rw 0 0\n'), null);
        assert.equal(commitSeconds('tmpfs /persistent tmpfs rw 0 0\n'), null);
    });
});
describe('syncFlashCommit', () => {
    it('runs the script only when the switch and the mount disagree', async () => {
        const calls = [];
        const run = async (long) => { calls.push(long); };
        await syncFlashCommit(false, () => STOCK, run);
        await syncFlashCommit(true, () => STOCK, run);
        await syncFlashCommit(true, () => LONG, run);
        await syncFlashCommit(false, () => LONG, run);
        await syncFlashCommit(true, () => 'tmpfs /persistent tmpfs rw 0 0\n', run);
        assert.deepEqual(calls, [true, false]);
    });
    it('runs nothing when the switch is off and the mount is stock', async () => {
        const calls = [];
        await syncFlashCommit(false, () => STOCK, async (long) => { calls.push(long); });
        assert.deepEqual(calls, []);
    });
    it('never throws when reading the mounts or the script fails', async () => {
        await assert.doesNotReject(syncFlashCommit(true, () => { throw new Error('no proc'); }, async () => { }));
        await assert.doesNotReject(syncFlashCommit(true, () => STOCK, async () => { throw new Error('no sudo'); }));
    });
});
//# sourceMappingURL=flashCommit.test.js.map