import assert from 'node:assert/strict';
import { it } from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
// A journal left by a swap a power cut interrupted: what settings and schedules load must already be swapped.
const folder = `${mkdtempSync(path.join(tmpdir(), 'nightstand-swap-startup-'))}/`;
mkdirSync(`${folder}lowdb`);
const power = (on) => ({ on, off: '07:00', enabled: true, onTemperature: 80 });
writeFileSync(`${folder}lowdb/settingsDB.json`, JSON.stringify({ left: { name: 'Alex' }, right: { name: 'Sam' } }));
writeFileSync(`${folder}lowdb/schedulesDB.json`, JSON.stringify({
    left: { monday: { power: power('20:00') } }, right: { monday: { power: power('23:00') } },
}));
writeFileSync(`${folder}side-swap.json`, JSON.stringify({
    settings: { left: { name: 'Sam' }, right: { name: 'Alex' } },
    schedules: { left: { monday: { power: power('23:00') } }, right: { monday: { power: power('20:00') } } },
    rhythms: null, notes: null, swaps: [100],
}));
process.env.DATA_FOLDER = folder;
process.env.ENV = 'local';
const { default: settingsDB } = await import('./settings.js');
const { default: schedulesDB } = await import('./schedules.js');
it('finishes the swap before the databases load', () => {
    assert.equal(settingsDB.data.left.name, 'Sam');
    assert.equal(schedulesDB.data.left.monday.power.on, '23:00');
    assert.equal(JSON.parse(readFileSync(`${folder}lowdb/settingsDB.json`, 'utf8')).left.name, 'Sam');
    assert.equal(JSON.parse(readFileSync(`${folder}lowdb/schedulesDB.json`, 'utf8')).left.monday.power.on, '23:00');
});
//# sourceMappingURL=sideSwapReplayStartup.test.js.map