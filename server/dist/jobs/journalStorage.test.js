import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
process.env.DATA_FOLDER = `${mkdtempSync(path.join(tmpdir(), 'nightstand-journal-sync-'))}/`;
process.env.ENV = 'local';
const { hasOldJournalFiles, syncJournalStorage, tidyJournal } = await import('./journalStorage.js');
describe('syncJournalStorage', () => {
    const dropin = path.join(mkdtempSync(path.join(tmpdir(), 'nightstand-dropin-')), '10-nightstand-memory.conf');
    it('runs the command only when the switch and the drop-in disagree', async () => {
        const calls = [];
        const run = async (inMemory) => { calls.push(inMemory); };
        await syncJournalStorage(false, dropin, run);
        await syncJournalStorage(true, dropin, run);
        writeFileSync(dropin, '[Journal]\n');
        await syncJournalStorage(true, dropin, run);
        await syncJournalStorage(false, dropin, run);
        assert.deepEqual(calls, [true, false]);
    });
    it('never throws when the command fails', async () => {
        await assert.doesNotReject(syncJournalStorage(false, dropin, async () => { throw new Error('no sudo'); }));
    });
});
describe('tidyJournal', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'nightstand-tidy-'));
    const dropin = path.join(dir, '10-nightstand-memory.conf');
    it('runs only with the switch on, the drop-in present and old files left', async () => {
        let calls = 0;
        const tidy = async () => { calls += 1; };
        const left = () => true;
        await tidyJournal(true, dropin, tidy, left);
        writeFileSync(dropin, '[Journal]\n');
        await tidyJournal(false, dropin, tidy, left);
        await tidyJournal(true, dropin, tidy, () => false);
        await tidyJournal(true, dropin, tidy, left);
        assert.equal(calls, 1);
    });
    it('never throws when the command fails', async () => {
        writeFileSync(dropin, '[Journal]\n');
        await assert.doesNotReject(tidyJournal(true, dropin, async () => { throw new Error('no sudo'); }, () => true));
    });
    it('is not called when settings are saved', async () => {
        const { readFileSync } = await import('node:fs');
        const route = readFileSync(new URL('../routes/settings/settings.ts', import.meta.url), 'utf8');
        assert.doesNotMatch(route, /tidyJournal/);
    });
});
describe('hasOldJournalFiles', () => {
    it('finds journal files under the machine folder, through a link, and nothing else', () => {
        const root = mkdtempSync(path.join(tmpdir(), 'nightstand-oldjournal-'));
        const real = path.join(root, 'persistent-journal');
        mkdirSync(path.join(real, 'abc'), { recursive: true });
        const linked = path.join(root, 'journal');
        symlinkSync(real, linked);
        assert.equal(hasOldJournalFiles(linked), false, 'empty folders');
        writeFileSync(path.join(real, 'abc', 'notes.txt'), '');
        assert.equal(hasOldJournalFiles(linked), false, 'other files');
        writeFileSync(path.join(real, 'abc', 'user-1000.journal~'), '');
        assert.equal(hasOldJournalFiles(linked), true);
        assert.equal(hasOldJournalFiles(path.join(root, 'missing')), false);
    });
});
//# sourceMappingURL=journalStorage.test.js.map