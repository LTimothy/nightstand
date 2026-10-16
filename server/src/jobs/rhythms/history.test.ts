import assert from 'node:assert/strict';
import { describe, it, before } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// config.ts reads DATA_FOLDER at import time, so set it before importing.
const dataFolder = mkdtempSync(path.join(tmpdir(), 'nightstand-rhythms-history-'));
mkdirSync(path.join(dataFolder, 'lowdb'));
process.env.DATA_FOLDER = `${dataFolder}/`;
process.env.ENV = 'local';

let history: typeof import('./history.js');
let config: typeof import('../../config.js')['default'];

before(async () => {
  history = await import('./history.js');
  ({ default: config } = await import('../../config.js'));
});

const record = (date: string, powerOff: string): import('./history.js').SleepHistoryRecord => ({
  v: 1,
  side: 'left',
  date,
  rhythmId: 'workday',
  baseLevel: 0,
  intensity: 'standard',
  daySleep: false,
  plannedBedtime: `${date}T05:45:00.000Z`,
  plannedCoolStart: `${date}T05:45:00.000Z`,
  plannedWake: `${date}T13:30:00.000Z`,
  powerOff,
  coolStart: `${date}T06:00:00.000Z`,
  confirmedAt: `${date}T06:00:00.000Z`,
  startReason: 'confirmed',
  manualChanges: { hold: 1 },
  bedExitsLastHour: 0,
  upEarlyAt: null,
  outOfBedAt: null,
  offWhenUp: false,
  actualOff: powerOff,
  offReason: 'set-time',
  onsetEstimate: null,
  onsetNote: 'no-vitals',
});

const lines = (file: string) => readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { date: string });

describe('rhythms history', () => {
  it('lives in the data folder, outside the watched lowdb folder', () => {
    assert.equal(history.historyPath(), `${dataFolder}/rhythms-history.jsonl`);
    assert.equal(path.dirname(history.historyPath()), path.resolve(config.dbFolder));
    assert.ok(!history.historyPath().startsWith(config.lowDbFolder));
  });

  it('appends one line per sleep', async () => {
    const now = new Date('2026-09-30T16:00:00Z');
    await history.appendHistory(record('2026-09-29', '2026-09-29T14:30:00.000Z'), { now });
    await history.appendHistory(record('2026-09-30', '2026-09-30T14:30:00.000Z'), { now });
    assert.deepEqual(lines(history.historyPath()).map(line => line.date), ['2026-09-29', '2026-09-30']);
    assert.equal(existsSync(`${history.historyPath()}.tmp`), false);
  });

  it('drops entries older than 90 days and unreadable lines on append', async () => {
    const file = path.join(dataFolder, 'prune.jsonl');
    writeFileSync(file, [
      JSON.stringify(record('2026-06-01', '2026-06-01T14:30:00.000Z')),
      'not json',
      JSON.stringify(record('2026-07-10', '2026-07-10T14:30:00.000Z')),
    ].join('\n'));
    await history.appendHistory(record('2026-09-30', '2026-09-30T14:30:00.000Z'), { path: file, now: new Date('2026-09-30T16:00:00Z') });
    assert.deepEqual(lines(file).map(line => line.date), ['2026-07-10', '2026-09-30']);
  });

  it('never throws when the file cannot be written', async () => {
    const file = path.join(dataFolder, 'missing-dir', 'history.jsonl');
    await history.appendHistory(record('2026-09-30', '2026-09-30T14:30:00.000Z'), { path: file });
    assert.equal(existsSync(file), false);
  });

  it('never writes inside the lowdb folder', () => {
    assert.equal(existsSync(path.join(dataFolder, 'lowdb', 'rhythms-history.jsonl')), false);
  });

  it('rewrites a file with the kept lines and the new ones', async () => {
    const file = path.join(dataFolder, 'pruned.jsonl');
    writeFileSync(file, 'keep 1\ndrop\n\nkeep 2\n');
    await history.appendPruned(file, line => line.startsWith('keep'), ['new']);
    assert.equal(readFileSync(file, 'utf8'), 'keep 1\nkeep 2\nnew\n');
    assert.equal(existsSync(`${file}.tmp`), false);
  });

  it('creates a missing file and throws when it cannot write', async () => {
    const file = path.join(dataFolder, 'fresh.jsonl');
    await history.appendPruned(file, () => true, ['one']);
    assert.equal(readFileSync(file, 'utf8'), 'one\n');
    await assert.rejects(history.appendPruned(path.join(dataFolder, 'missing-dir', 'x.jsonl'), () => true, ['one']));
  });
});
