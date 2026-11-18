import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.DATA_FOLDER = `${mkdtempSync(path.join(tmpdir(), 'nightstand-journal-sync-'))}/`;
process.env.ENV = 'local';
const { syncJournalStorage } = await import('./journalStorage.js');

describe('syncJournalStorage', () => {
  const dropin = path.join(mkdtempSync(path.join(tmpdir(), 'nightstand-dropin-')), '10-nightstand-memory.conf');

  it('runs the command only when the switch and the drop-in disagree', async () => {
    const calls: boolean[] = [];
    const run = async (inMemory: boolean) => { calls.push(inMemory); };
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
