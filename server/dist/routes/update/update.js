import express from 'express';
import fs from 'fs';
import { z } from 'zod';
import logger from '../../logger.js';
import { triggerUpdateService } from '../../jobs/update.js';
import { triggerRollbackService } from '../../jobs/rollback.js';
import { triggerRevertToStockService } from '../../jobs/revertToStock.js';
import { UpdateRequestSchema, UpdateResultSchema, OperationRequestSchema, SwitchRequestSchema } from './updateSchema.js';
import { inUseText } from './inUseText.js';
import { PrivilegedCommandError, privilegedErrorStatus } from '../../jobs/privilegedCommand.js';
const router = express.Router();
// The updater keeps the previous install here after every swap (see
// scripts/update.sh): reading its serverInfo.json is how we know whether an
// instant rollback is available and what it would roll back to.
const PREV_SERVER_INFO_PATH = '/home/dac/free-sleep-prev/server/src/serverInfo.json';
// Consumed once by scripts/update.sh (deleted immediately after reading), so
// a stale file can never redirect a future plain update.
const TARGET_FILE = '/persistent/free-sleep-data/update-target.json';
// Read and removed by the update, rollback and switch scripts, which check
// the bed again just before they stop the server unless the owner confirmed.
// Without it, as from an older server or over SSH, they do not check again.
const REQUEST_FILE = '/persistent/free-sleep-data/operation-request.json';
// A request that cannot be saved still starts, as it did before the file existed.
function requestHooks(confirmInUse) {
    return {
        beforeStart: () => fs.promises.writeFile(REQUEST_FILE, JSON.stringify({ source: 'app', confirmInUse: confirmInUse === true }))
            .catch((error) => { logger.warn('Could not save the operation request', error); }),
        onStartFailure: () => fs.promises.unlink(REQUEST_FILE).catch(() => undefined),
    };
}
// Written by the update, rollback and switch scripts when they end, so the
// app can report a failure at once instead of waiting out a timeout.
let resultFile = '/persistent/free-sleep-data/update-result.json';
export const setResultFileForTests = (file) => { resultFile = file; };
// handBack is false when the target continues Rhythms sleeps itself.
const PrepareToStopSchema = z.object({
    reason: z.enum(['downgrade', 'rollback', 'revert']),
    handBack: z.boolean().default(true),
}).strict();
let leaveHook;
// This file also ships in the updater overlay for stock installs, which has
// no Rhythms, so the server registers the handoff here at startup.
export function setLeaveHook(hook) {
    leaveHook = hook;
}
// Without a registered check the bed cannot be read, which counts as in use.
let inUseCheck = async () => ['status-unknown'];
// This file also ships in the updater overlay for stock installs, which
// cannot read the bed or its alarms, so the server registers the check at
// startup too.
export function setInUseCheck(check) {
    inUseCheck = check;
}
async function currentInUseReasons() {
    try {
        return await inUseCheck();
    }
    catch (error) {
        logger.warn('The in-use check failed, treating the bed as possibly in use', error);
        return ['status-unknown'];
    }
}
// Answers 409 and returns true when the bed may be in use and the request
// did not confirm it. Enforced here so a stale page cannot skip the check.
// The message copy is for pages that only read that field.
export async function refusedWhileInUse(res, confirmInUse) {
    if (confirmInUse === true)
        return false;
    const reasons = await currentInUseReasons();
    if (reasons.length === 0)
        return false;
    const text = inUseText(reasons);
    res.status(409).json({ error: text, message: text, reasons });
    return true;
}
export function isLoopbackAddress(address) {
    return address !== undefined && /^(::ffff:)?127\.|^::1$/.test(address);
}
// The update, rollback and switch scripts call this just before they stop
// the server, after every check that could still abort them. The next
// version may not know Rhythms, so this server hands any sleep it started
// back to the weekly schedule unless handBack is false. A failure never
// stops the script; the firmware off time set at power-on is the backstop.
router.post('/prepare-to-stop', async (req, res) => {
    if (!isLoopbackAddress(req.socket.remoteAddress)) {
        res.status(403).json({ error: 'Only the Pod itself can prepare the server to stop' });
        return;
    }
    const parsed = PrepareToStopSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
        res.status(400).json({ error: 'Invalid request data', details: parsed.error.errors });
        return;
    }
    const { reason, handBack } = parsed.data;
    try {
        await leaveHook?.(reason, { handBack });
    }
    catch (error) {
        logger.error(`Rhythms handoff before ${reason} failed, continuing`, error);
    }
    res.status(204).end();
});
router.get('/in-use', async (_req, res) => {
    res.json({ reasons: await currentInUseReasons() });
});
router.post('/', async (req, res) => {
    const parsed = UpdateRequestSchema.safeParse(req.body);
    if (!parsed.success) {
        logger.error('Invalid update request:', parsed.error);
        res.status(400).json({ error: 'Invalid request data', details: parsed.error.errors });
        return;
    }
    const { targetVersion, allowDowngrade, confirmInUse } = parsed.data;
    if (await refusedWhileInUse(res, confirmInUse))
        return;
    const request = requestHooks(confirmInUse);
    let ownsTarget = false;
    try {
        await triggerUpdateService({
            beforeStart: async () => {
                await request.beforeStart();
                if (targetVersion) {
                    ownsTarget = true;
                    await fs.promises.writeFile(TARGET_FILE, JSON.stringify({ version: targetVersion, allowDowngrade: !!allowDowngrade }));
                }
            },
            onStartFailure: async () => {
                await request.onStartFailure();
                if (ownsTarget)
                    await fs.promises.unlink(TARGET_FILE).catch(() => undefined);
            },
        });
        res.status(204).end();
    }
    catch (error) {
        logger.error('Failed to start update', error);
        res.status(privilegedErrorStatus(error)).json({
            message: error instanceof PrivilegedCommandError ? error.message : 'Unable to start update',
        });
    }
});
router.get('/last-result', async (_req, res) => {
    try {
        const parsed = UpdateResultSchema.safeParse(JSON.parse(await fs.promises.readFile(resultFile, 'utf8')));
        if (!parsed.success)
            throw new Error('unreadable');
        res.json(parsed.data);
    }
    catch {
        res.status(404).json({ error: 'No result recorded yet' });
    }
});
router.get('/rollback-info', async (_req, res) => {
    try {
        const raw = await fs.promises.readFile(PREV_SERVER_INFO_PATH, 'utf8');
        const version = JSON.parse(raw).version;
        const info = { available: !!version, version: version ?? null };
        res.json(info);
    }
    catch {
        // No PREV tree (fresh install, or this update's the first one), not an
        // error, just nothing to roll back to.
        const info = { available: false, version: null };
        res.json(info);
    }
});
// Parses the optional body of rollback and switch, and answers 400 or 409
// itself, returning undefined, when the request must not go ahead.
async function admitted(req, res) {
    const parsed = OperationRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
        res.status(400).json({ error: 'Invalid request data', details: parsed.error.errors });
        return undefined;
    }
    if (await refusedWhileInUse(res, parsed.data.confirmInUse))
        return undefined;
    return requestHooks(parsed.data.confirmInUse);
}
router.post('/rollback', async (req, res) => {
    const hooks = await admitted(req, res);
    if (!hooks)
        return;
    try {
        await triggerRollbackService(hooks);
        res.status(204).end();
    }
    catch (error) {
        logger.error('Failed to start rollback', error);
        res.status(privilegedErrorStatus(error)).json({
            message: error instanceof PrivilegedCommandError ? error.message : 'Unable to start rollback',
        });
    }
});
// Switch the app to upstream free-sleep. System configuration and backups can remain.
// Reversible only by re-adopting via scripts/migrate/switch-to-this-fork.sh
// afterward. There's no in-app way back once upstream free-sleep is running.
async function switchToUpstream(req, res) {
    const parsed = SwitchRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
        res.status(400).json({ error: 'Invalid request data', details: parsed.error.errors });
        return;
    }
    if (await refusedWhileInUse(res, parsed.data.confirmInUse))
        return;
    try {
        await triggerRevertToStockService(requestHooks(parsed.data.confirmInUse), parsed.data);
        res.status(204).end();
    }
    catch (error) {
        logger.error('Could not start switching to upstream free-sleep.', error);
        res.status(privilegedErrorStatus(error)).json({
            message: error instanceof PrivilegedCommandError ? error.message : 'Could not start switching to upstream free-sleep.',
        });
    }
}
router.post('/switch-to-upstream', switchToUpstream);
// The old name, for apps from before the rename.
router.post('/revert-to-stock', switchToUpstream);
export default router;
//# sourceMappingURL=update.js.map