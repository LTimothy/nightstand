import express from 'express';
import { performance } from 'node:perf_hooks';
import serverStatus from '../../serverStatus.js';
const router = express.Router();
const CACHE_MS = 15_000;
let cached;
let expiresAt = 0;
let pending;
// Pollers share the database check and an immutable response snapshot.
async function getStatus() {
    if (cached && performance.now() < expiresAt)
        return cached;
    pending ??= serverStatus.toJSON().then(status => {
        cached = structuredClone(status);
        expiresAt = performance.now() + CACHE_MS;
        return cached;
    }).finally(() => { pending = undefined; });
    return pending;
}
// Answers only that the server and its event loop are alive.
router.get('/alive', (_req, res) => {
    res.status(204).end();
});
router.get('/', async (req, res) => {
    const response = await getStatus();
    res.json(response);
});
export default router;
//# sourceMappingURL=serverStatus.js.map