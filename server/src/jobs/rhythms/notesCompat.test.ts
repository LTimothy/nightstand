import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { parseLine } from './learn.js';

// The first 3.7.0 builds' reader, kept as text and transpiled here, so it never builds into dist.
const FIXTURE = new URL('../../../../fixtures/compat/notes-3.7.0-pre/notesReader.ts.txt', import.meta.url);
const folder = mkdtempSync(path.join(tmpdir(), 'nightstand-notes-reader-'));
type OlderReader = { parseLine: (text: string) => object | null; isJsonObject: (text: string) => boolean };
let older: OlderReader;

before(async () => {
  const source = readFileSync(FIXTURE, 'utf8').replaceAll("from 'zod'", `from '${import.meta.resolve('zod')}'`);
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  const file = path.join(folder, 'notesReader.mjs');
  writeFileSync(file, outputText);
  older = await import(pathToFileURL(file).href) as OlderReader;
});
after(() => rmSync(folder, { recursive: true, force: true }));

const set = {
  v: 1, kind: 'set', at: '2026-10-11T03:00:00.000Z', side: 'right', rhythmId: 'off-days', planKey: '3f9a1c2b7e44', date: '2026-10-10',
  targetF: 79, reason: 'step',
};

describe('the notes file under the first 3.7.0 builds', () => {
  it('skips a set line this build reads', () => {
    assert.ok(parseLine(JSON.stringify(set)), 'this build reads set');
    assert.equal(older.parseLine(JSON.stringify(set)), null, 'the older reader skips set');
  });

  it('keeps the line it cannot read when it prunes, so going back and forth loses nothing', () => {
    // Its keepFor keeps a line it cannot parse when the line is a JSON object.
    assert.equal(older.isJsonObject(JSON.stringify(set)), true);
  });
});
