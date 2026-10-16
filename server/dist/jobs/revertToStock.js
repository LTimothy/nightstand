import fs from 'node:fs';
import { runPrivilegedCommand } from './privilegedCommand.js';
const REQUEST_FILE = '/persistent/free-sleep-data/operation-request.json';
export function triggerRevertToStockService(hooks = {}, request) {
    return runPrivilegedCommand(['/bin/systemctl', 'start', 'free-sleep-revert.service', '--no-block'], 'free-sleep-revert.service', {
        beforeStart: async () => {
            await hooks.beforeStart?.();
            if (request?.target) {
                await fs.promises.writeFile(REQUEST_FILE, JSON.stringify({
                    source: 'app', confirmInUse: request.confirmInUse === true, target: request.target,
                }));
            }
        },
        onStartFailure: async () => {
            await hooks.onStartFailure?.();
            if (request?.target)
                await fs.promises.unlink(REQUEST_FILE).catch(() => undefined);
        },
    });
}
//# sourceMappingURL=revertToStock.js.map