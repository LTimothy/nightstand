import assert from 'node:assert/strict';
import { after, it } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const folder = mkdtempSync(path.join(tmpdir(), 'nightstand-schedules-'));
mkdirSync(path.join(folder, 'lowdb'));
process.env.DATA_FOLDER = `${folder}/`;
process.env.ENV = 'local';
const { default: schedulesDB } = await import('./schedules.js');
after(() => rmSync(folder, { recursive: true, force: true }));

it('gives an unused day a double pulse at full strength for 30 s', () => {
  const { vibrationIntensity, vibrationPattern, duration } = schedulesDB.data.left.monday.alarm;
  assert.deepEqual({ vibrationIntensity, vibrationPattern, duration }, { vibrationIntensity: 100, vibrationPattern: 'double', duration: 30 });
});
