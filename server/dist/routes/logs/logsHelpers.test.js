import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { isLogFilename, isSafeLogFilename, linesFromAppendedChunk, readTail, tailLines } from './logsHelpers.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
describe('isLogFilename', () => {
    it('accepts files ending in .log', () => {
        assert.equal(isLogFilename('free-sleep-stream.log'), true);
        assert.equal(isLogFilename('syslog.log'), true);
    });
    it('rejects files that merely contain "log" as a substring', () => {
        assert.equal(isLogFilename('catalog'), false);
        assert.equal(isLogFilename('backlog.txt'), false);
        assert.equal(isLogFilename('logrotate.conf'), false);
    });
});
describe('isSafeLogFilename', () => {
    it('accepts a plain .log basename', () => {
        assert.equal(isSafeLogFilename('free-sleep-stream.log'), true);
    });
    it('rejects relative path traversal', () => {
        assert.equal(isSafeLogFilename('../../etc/passwd'), false);
        assert.equal(isSafeLogFilename('../../../persistent/free-sleep-data/settingsDB.json'), false);
    });
    it('rejects an absolute path even if it ends in .log', () => {
        assert.equal(isSafeLogFilename('/etc/cron.d/evil.log'), false);
    });
    it('rejects an embedded directory separator even if it ends in .log', () => {
        assert.equal(isSafeLogFilename('subdir/evil.log'), false);
    });
    it('rejects non-.log files with no traversal', () => {
        assert.equal(isSafeLogFilename('passwd'), false);
    });
});
describe('linesFromAppendedChunk', () => {
    it('splits multiple newline-terminated lines', () => {
        assert.deepEqual(linesFromAppendedChunk('line1\nline2\nline3\n'), ['line1', 'line2', 'line3']);
    });
    it('keeps a trailing partial line that has not been newline-terminated yet', () => {
        assert.deepEqual(linesFromAppendedChunk('line1\nline2\npartial'), ['line1', 'line2', 'partial']);
    });
    it('returns an empty array for an empty chunk', () => {
        assert.deepEqual(linesFromAppendedChunk(''), []);
    });
    it('returns a single line for a chunk with no trailing newline', () => {
        assert.deepEqual(linesFromAppendedChunk('just one line'), ['just one line']);
    });
});
// The Logs page used to read a whole rotated log line by line before sending
// anything, and a 15MB file took long enough that the browser gave up with no
// response. Only the tail is ever shown, so only the tail is read.
describe('tailLines', () => {
    it('keeps the last N lines', () => {
        assert.deepEqual(tailLines('a\nb\nc\nd\n', 2, false), ['c', 'd']);
    });
    it('drops the first line when the read began partway through the file', () => {
        // Reading from a byte offset almost always lands mid-line.
        assert.deepEqual(tailLines('rtial line\nwhole one\nwhole two\n', 10, true), ['whole one', 'whole two']);
    });
    it('keeps the first line when the read began at the start of the file', () => {
        assert.deepEqual(tailLines('first\nsecond\n', 10, false), ['first', 'second']);
    });
    it('returns every line when there are fewer than N', () => {
        assert.deepEqual(tailLines('only\n', 1000, false), ['only']);
    });
    it('returns nothing for an empty read', () => {
        assert.deepEqual(tailLines('', 1000, false), []);
    });
});
describe('readTail', () => {
    let dir;
    before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logs-')); });
    after(() => fs.rmSync(dir, { recursive: true, force: true }));
    it('reads no more than the tail of a large file', () => {
        const file = path.join(dir, 'big.log');
        const line = 'x'.repeat(99) + '\n';
        fs.writeFileSync(file, line.repeat(20_000) + 'last line\n'); // about 2MB
        return readTail(file, 64 * 1024).then(({ text, startedMidFile, size }) => {
            assert.ok(text.length <= 64 * 1024, `read ${text.length} bytes, more than the tail`);
            assert.equal(startedMidFile, true);
            assert.equal(size, fs.statSync(file).size);
            assert.ok(text.endsWith('last line\n'));
        });
    });
    it('reads a small file whole and says it started at the beginning', async () => {
        const file = path.join(dir, 'small.log');
        fs.writeFileSync(file, 'one\ntwo\n');
        const { text, startedMidFile } = await readTail(file, 64 * 1024);
        assert.equal(text, 'one\ntwo\n');
        assert.equal(startedMidFile, false);
    });
});
//# sourceMappingURL=logsHelpers.test.js.map