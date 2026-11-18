import { existsSync } from 'node:fs';
import config from '../config.js';
import logger from '../logger.js';
import { runPrivilegedCommand } from './privilegedCommand.js';
export const JOURNAL_DROPIN = '/etc/systemd/journald.conf.d/10-nightstand-memory.conf';
// The unit name only satisfies runPrivilegedCommand's unit check; journald is not restarted.
// Literal commands, so setupServicesScript.test.ts can match them to the sudo rules.
const runScript = async (inMemory) => {
    if (config.remoteDevMode)
        return;
    await (inMemory
        ? runPrivilegedCommand(['/bin/bash', '/usr/local/lib/nightstand/live/scripts/journal_storage.sh', 'memory'], 'systemd-journald.service')
        : runPrivilegedCommand(['/bin/bash', '/usr/local/lib/nightstand/live/scripts/journal_storage.sh', 'disk'], 'systemd-journald.service'));
};
// Never fails the caller. The change applies at the next restart of the Pod.
export async function syncJournalStorage(inMemory, dropin = JOURNAL_DROPIN, run = runScript) {
    if (existsSync(dropin) === inMemory)
        return;
    try {
        await run(inMemory);
    }
    catch (error) {
        logger.warn(`Could not ${inMemory ? 'move the system log to memory' : 'keep the system log on flash'}: `
            + `${error instanceof Error ? error.message : String(error)}`);
    }
}
//# sourceMappingURL=journalStorage.js.map