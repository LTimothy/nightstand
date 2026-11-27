// Finishes a side swap that a crash or power cut interrupted. The settings,
// schedules and rhythms modules import it first, before they read their files.
import { readFile, rm } from 'node:fs/promises';
import config from '../config.js';
import logger from '../logger.js';
import { writeTextDurably } from './durableFile.js';
export const journalPath = (folder = config.dbFolder) => `${folder}side-swap.json`;
// Every file gets its post-swap content, so replaying twice changes nothing.
export async function writeSwapFiles(journal, folder = config.dbFolder) {
    const lowdb = `${folder}lowdb/`;
    await writeTextDurably(`${lowdb}settingsDB.json`, JSON.stringify(journal.settings, null, 2));
    await writeTextDurably(`${lowdb}schedulesDB.json`, JSON.stringify(journal.schedules, null, 2));
    if (journal.rhythms !== null)
        await writeTextDurably(`${lowdb}rhythmsDB.json`, journal.rhythms);
    await writeTextDurably(`${folder}rhythms-changes.jsonl`, journal.notes);
    await writeTextDurably(`${folder}side-swaps.json`, JSON.stringify(journal.swaps));
}
export async function replayJournal(folder = config.dbFolder) {
    let text;
    try {
        text = await readFile(journalPath(folder), 'utf8');
    }
    catch {
        return false;
    }
    const journal = JSON.parse(text);
    await writeSwapFiles(journal, folder);
    await rm(journalPath(folder), { force: true });
    logger.info('Finished a side swap that was interrupted');
    return true;
}
try {
    await replayJournal();
}
catch (error) {
    logger.error(`Could not finish an interrupted side swap: ${error instanceof Error ? error.message : String(error)}`);
}
//# sourceMappingURL=sideSwapReplay.js.map