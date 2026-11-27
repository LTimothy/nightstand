import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { SwapFiles as Files } from './swapSides.js';

const dataFolder = `${mkdtempSync(path.join(tmpdir(), 'nightstand-swap-sides-'))}/`;
mkdirSync(`${dataFolder}lowdb`);
process.env.DATA_FOLDER = dataFolder;
process.env.ENV = 'local';

const { swapped, swapSides } = await import('./swapSides.js');
const { replayJournal, journalPath } = await import('./sideSwapReplay.js');
const { default: settingsDB, updateSettings } = await import('./settings.js');
const { sideSwaps } = await import('./sideSwaps.js');
const { activation } = await import('../jobs/rhythms/activation.js');
const { legacyFingerprint } = await import('../jobs/rhythms/fingerprint.js');
const { parseRhythms } = await import('./rhythms.js');
const { dbOf, rhythmOf, schedulesOf, sideOf, WORKDAY } = await import('../jobs/rhythms/rhythmsTestData.js');

const schedules = schedulesOf({ monday: WORKDAY });
const rhythmsText = (fingerprint: string) => JSON.stringify({
  ...dbOf(sideOf([rhythmOf('workday', WORKDAY)], { monday: 'workday' }), sideOf(), fingerprint), futureKey: 1,
}, null, 2);
const files = (over: Partial<Files> = {}): Files => ({
  settings: structuredClone({ ...settingsDB.data, left: { ...settingsDB.data.left, name: 'Left' },
    right: { ...settingsDB.data.right, name: 'Sam', buttons: { ...settingsDB.data.right.buttons, invertButtons: true } } }),
  schedules,
  rhythms: rhythmsText(legacyFingerprint(schedules)),
  notes: '{"v":1,"kind":"set","side":"left","rhythmId":"workday"}\nnot json\n',
  swaps: [],
  ...over,
});
const enabled = { features: { rhythms: true } } as Files['settings'];

describe('swapped', () => {
  it('moves each side to the other, keeping a default name with its side', () => {
    const next = swapped(files(), 100);
    assert.equal(next.settings.left.name, 'Sam');
    assert.equal(next.settings.left.buttons.invertButtons, true);
    assert.equal(next.settings.right.name, 'Right');
    assert.deepEqual(next.schedules.right, schedules.left);
    assert.deepEqual(next.swaps, [100]);
  });

  it('comes back unchanged after two swaps, unknown keys and odd lines included', () => {
    const start = files();
    const back = swapped(swapped(start, 100), 200);
    assert.deepEqual(back.settings, start.settings);
    assert.deepEqual(back.schedules, start.schedules);
    assert.deepEqual(JSON.parse(back.rhythms!), JSON.parse(start.rhythms!));
    assert.equal(back.notes, start.notes);
  });

  it('flips the side of each note line', () => {
    assert.match(swapped(files(), 1).notes!, /"side":"right"/);
  });

  it('keeps Rhythms active when the fingerprint matched', () => {
    const next = swapped(files(), 1);
    assert.equal(activation(enabled, parseRhythms(next.rhythms), next.schedules).active, true);
  });

  it('leaves a fingerprint that did not match as it was', () => {
    const next = swapped(files({ rhythms: rhythmsText('a'.repeat(64)) }), 1);
    assert.equal(JSON.parse(next.rhythms!).legacyFingerprint, 'a'.repeat(64));
  });

  it('skips missing rhythms and refuses invalid ones', () => {
    assert.equal(swapped(files({ rhythms: null }), 1).rhythms, null);
    assert.throws(() => swapped(files({ rhythms: '{' }), 1), /invalid/);
  });
});

describe('swapSides', () => {
  it('saves the swapped settings and the swap time, and leaves no journal', async () => {
    await updateSettings(draft => { draft.left.name = 'Alex'; draft.right.name = 'Sam'; });
    await swapSides(500);
    await settingsDB.read();
    assert.equal(settingsDB.data.left.name, 'Sam');
    assert.equal(settingsDB.data.right.name, 'Alex');
    assert.deepEqual(sideSwaps(), [500]);
    assert.equal(readFileSync(`${dataFolder}side-swaps.json`, 'utf8'), '[500]');
    assert.equal(existsSync(journalPath()), false);
  });
});

describe('replayJournal', () => {
  it('writes every file from a leftover journal once', async () => {
    const folder = `${mkdtempSync(path.join(tmpdir(), 'nightstand-swap-replay-'))}/`;
    mkdirSync(`${folder}lowdb`);
    const next = swapped(files(), 700);
    writeFileSync(journalPath(folder), JSON.stringify(next));
    assert.equal(await replayJournal(folder), true);
    assert.equal(JSON.parse(readFileSync(`${folder}lowdb/settingsDB.json`, 'utf8')).left.name, 'Sam');
    assert.equal(readFileSync(`${folder}lowdb/rhythmsDB.json`, 'utf8'), next.rhythms);
    assert.equal(readFileSync(`${folder}rhythms-changes.jsonl`, 'utf8'), next.notes);
    assert.equal(readFileSync(`${folder}side-swaps.json`, 'utf8'), '[700]');
    assert.equal(existsSync(journalPath(folder)), false);
    assert.equal(await replayJournal(folder), false);
  });
});
