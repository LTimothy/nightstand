// Request completion logging, extracted from the middleware so the
// finish/close bookkeeping is unit-testable without an Express app.
// Skip logging boring 2xx responses that finish quickly. The Sleep page fires
// 8 parallel /api/metrics/sleep queries per render and each used to produce a
// log line, drowning out anything actually worth seeing. Errors and slow
// responses still log at info level so debugging is unaffected.
export const SLOW_REQUEST_MS = 250;
export function attachRequestCompletionLogging(req, res, log, now = Date.now) {
    const startTime = now();
    let finished = false;
    res.on('finish', () => {
        finished = true;
        const duration = now() - startTime;
        const isError = res.statusCode >= 400;
        const isSlow = duration >= SLOW_REQUEST_MS;
        // The stream posts this heartbeat every ~21s and it runs over the slow threshold.
        const isHeartbeat = req.method === 'POST' && req.originalUrl.split('?')[0] === '/api/services';
        if (isError || (isSlow && !isHeartbeat)) {
            log.info(`${req.method} ${req.originalUrl} - ${res.statusCode} - ${duration}ms`);
        }
        else {
            log.debug(`${req.method} ${req.originalUrl} - ${res.statusCode} - ${duration}ms`);
        }
    });
    // 'close' without 'finish' means the client went away before a response
    // was ever sent. These requests used to vanish from the logs entirely,
    // a /deviceStatus handler wedged on the hardware socket produced no log
    // line at all, which read as "the request never arrived" during a whole
    // deploy-failure investigation. Log them at warn so hangs are visible.
    res.on('close', () => {
        if (finished)
            return;
        const duration = now() - startTime;
        log.warn(`${req.method} ${req.originalUrl} - client disconnected after ${duration}ms with no response sent`);
    });
}
//# sourceMappingURL=requestLogging.js.map