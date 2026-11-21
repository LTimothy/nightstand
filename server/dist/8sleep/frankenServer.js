import { SequentialQueue } from './sequentialQueue.js';
import { MessageStream } from './messageStream.js';
import { frankenCommands } from './deviceApi.js';
import { UnixSocketServer } from './unixSocketServer.js';
import logger from '../logger.js';
import { loadDeviceStatus } from './loadDeviceStatus.js';
import { FirmwareAlarmDismiss } from './firmwareAlarmDismiss.js';
import config from '../config.js';
import { wait } from './promises.js';
import { promiseWithTimeout } from './timeoutPromise.js';
import metrics from '../metrics/metrics.js';
import { FrankenConnectionClosedError, FrankenSupersededError, markCommandWritten } from './frankenErrors.js';
// 0 disables the connection timeout; only a missing or non-numeric value falls back.
const connectionTimeoutFromEnv = (raw) => {
    const parsed = raw === undefined || raw.trim() === '' ? Number.NaN : Number(raw);
    return Number.isNaN(parsed) ? 25_000 : parsed;
};
const FRANKEN_CONNECTION_TIMEOUT_MS = connectionTimeoutFromEnv(process.env.FRANKEN_CONNECTION_TIMEOUT_MS);
// How long a hardware command waits for a missing connection before failing.
// A request gets a prompt answer; a scheduled job also covers a cold-start
// handshake. A command that gave up is never sent later.
const FRANKEN_CONNECT_WAIT_MS = Number(process.env.FRANKEN_CONNECT_WAIT_MS) || 10_000;
const FRANKEN_BACKGROUND_CONNECT_WAIT_MS = Number(process.env.FRANKEN_BACKGROUND_CONNECT_WAIT_MS) || 120_000;
const FRANKEN_COMMAND_TIMEOUT_MS = Number(process.env.FRANKEN_COMMAND_TIMEOUT_MS) || 5_000;
// Hard ceiling on a command's whole trip: queue wait + socket write + read.
// The per-command timeout above only covers the read, so it never fires for
// a command stuck waiting in the queue or blocked mid-write.
const FRANKEN_COMMAND_TOTAL_TIMEOUT_MS = Number(process.env.FRANKEN_COMMAND_TOTAL_TIMEOUT_MS) || 15_000;
class FrankenConnectionTimeoutError extends Error {
    constructor() {
        super('Timed out waiting for Franken hardware connection');
        this.name = 'FrankenConnectionTimeoutError';
    }
}
export class FrankenUnavailableError extends Error {
    constructor(message = 'Pod hardware is not connected') {
        super(message);
        this.name = 'FrankenUnavailableError';
    }
}
export class FrankenCommandTimeoutError extends Error {
    constructor(commandNumber, timeoutMs, detail) {
        super(`Franken command ${commandNumber} did not respond within ${timeoutMs}ms${detail ? ` (${detail})` : ''}`);
        this.name = 'FrankenCommandTimeoutError';
    }
}
function assertBefore(notAfter) {
    if (notAfter !== undefined && Date.now() > notAfter) {
        throw new FrankenUnavailableError('Pod hardware became available too late for this command');
    }
}
// The singleton types refer to the classes defined below.
// eslint-disable-next-line no-use-before-define
let frankenServer;
// eslint-disable-next-line no-use-before-define
let franken;
// eslint-disable-next-line no-use-before-define
let connectPromise;
// Bumped by disconnectFranken so an older connect loop stops instead of
// racing the next one for the socket.
let connectGeneration = 0;
export class Franken {
    socket;
    messageStream;
    sequentialQueue;
    static responseDelayMs = 10;
    lifetime = new AbortController();
    firmwareAlarmDismiss = new FirmwareAlarmDismiss();
    constructor(socket, messageStream, sequentialQueue) {
        this.socket = socket;
        this.messageStream = messageStream;
        this.sequentialQueue = sequentialQueue;
        socket.once('close', () => {
            this.lifetime.abort(new FrankenConnectionClosedError());
            this.firmwareAlarmDismiss.reset();
            // A dropped socket aborts reads before their timeout can trigger recovery.
            // Retire only this active connection; late events must not close a newer one.
            if (franken === this) {
                // eslint-disable-next-line no-use-before-define -- Disconnect is a hoisted function.
                void disconnectFranken().catch(err => logger.error(`disconnect after socket close failed: ${err}`));
            }
        });
    }
    static separator = Buffer.from('\n\n');
    async sendMessage(message, notAfter, beforeSend) {
        logger.debug(`Sending message to sock | message: ${message}`);
        const commandNumber = message.split('\n', 1)[0] ?? '?';
        const startedAt = Date.now();
        let timedOut = false;
        let writeCompleted = false;
        try {
            const execPromise = this.sequentialQueue.exec(async () => {
                this.lifetime.signal.throwIfAborted();
                assertBefore(notAfter);
                beforeSend?.();
                const requestBytes = Buffer.concat([Buffer.from(message), Franken.separator]);
                await this.write(requestBytes);
                writeCompleted = true;
                // Race the read against a per-command timeout. If the timeout fires
                // we abort the readMessage() listener (so it stops holding a slot in
                // the message stream) and surface a typed error.
                const abortController = new AbortController();
                const resp = await promiseWithTimeout(this.messageStream.readMessage({ signal: AbortSignal.any([abortController.signal, this.lifetime.signal]) }), FRANKEN_COMMAND_TIMEOUT_MS, {
                    abortController,
                    onTimeout: () => new FrankenCommandTimeoutError(commandNumber, FRANKEN_COMMAND_TIMEOUT_MS),
                });
                if (Franken.responseDelayMs > 0) {
                    await wait(10);
                }
                return resp;
            });
            // If the total deadline below fires, nothing awaits execPromise anymore.
            // Swallow its eventual settlement so an abandoned task can't surface as
            // an unhandled rejection (which triggers a graceful shutdown).
            execPromise.catch(() => undefined);
            // The read timeout inside the task only starts after the write has
            // completed. A command stuck in the queue or wedged mid-write would
            // otherwise hang its caller forever with no timeout and no log line
            // (observed in production: every /deviceStatus request after a fresh
            // Franken connect hung silently until the deploy health check gave up).
            // The deadline error notes where the command got stuck.
            const responseBytes = await promiseWithTimeout(execPromise, FRANKEN_COMMAND_TOTAL_TIMEOUT_MS, {
                onTimeout: () => new FrankenCommandTimeoutError(commandNumber, FRANKEN_COMMAND_TOTAL_TIMEOUT_MS, `total deadline; queue depth ${this.sequentialQueue.depth()}, write ${writeCompleted ? 'completed' : 'never completed'}`),
            });
            metrics.recordFrankenCommand(Date.now() - startedAt, false);
            const response = responseBytes.toString();
            logger.debug(`Message sent successfully to sock | message: ${message}`);
            return response;
        }
        catch (caught) {
            // The abort reason is shared by every command on this connection.
            const error = caught === this.lifetime.signal.reason ? new FrankenConnectionClosedError() : caught;
            if (writeCompleted && error instanceof Error)
                markCommandWritten(error);
            if (error instanceof FrankenCommandTimeoutError) {
                timedOut = true;
                metrics.recordFrankenCommand(Date.now() - startedAt, true);
                logger.warn(`${error.message}; tearing down dac.sock so the next call reconnects`);
                // Fire-and-forget the reconnect so the rejected caller can handle the
                // error promptly. The next caller will rebuild the connection.
                if (franken === this) {
                    // eslint-disable-next-line no-use-before-define -- Disconnect is a hoisted function.
                    void disconnectFranken().catch(err => logger.error(`disconnect after timeout failed: ${err}`));
                }
                else {
                    this.close();
                }
            }
            if (!timedOut) {
                metrics.recordFrankenCommand(Date.now() - startedAt, false);
            }
            throw error;
        }
    }
    tryStripNewlines(arg) {
        const containsNewline = arg.indexOf('\n') >= 0;
        if (!containsNewline)
            return arg;
        return arg.replace(/\n/gm, '');
    }
    async callFunction(command, arg, notAfter, beforeSend) {
        logger.debug(`Calling function | command: ${command} | arg: ${arg}`);
        const commandNumber = frankenCommands[command];
        const cleanedArg = this.tryStripNewlines(arg);
        logger.debug(`commandNumber: ${commandNumber}`);
        logger.debug(`cleanedArg: ${cleanedArg}`);
        await this.sendMessage(`${commandNumber}\n${cleanedArg}`, notAfter, beforeSend);
    }
    async getDeviceStatus(getGestures = false) {
        const command = 'DEVICE_STATUS';
        const commandNumber = frankenCommands[command];
        const response = await this.sendMessage(commandNumber);
        this.lifetime.signal.throwIfAborted();
        return await loadDeviceStatus(response, getGestures, this.firmwareAlarmDismiss);
    }
    close() {
        this.lifetime.abort(new FrankenConnectionClosedError());
        this.firmwareAlarmDismiss.reset();
        const socket = this.socket;
        if (!socket.destroyed)
            socket.destroy();
    }
    static fromSocket(socket) {
        const messageStream = new MessageStream(socket, Franken.separator);
        return new Franken(socket, messageStream, new SequentialQueue());
    }
    async write(data) {
        this.lifetime.signal.throwIfAborted();
        await new Promise((resolve, reject) => {
            this.socket.write(data, error => {
                if (error)
                    reject(error);
                else
                    resolve();
            });
        });
    }
}
class FrankenServer {
    server;
    constructor(server) {
        this.server = server;
    }
    async close() {
        logger.debug('Closing FrankenServer socket...');
        await this.server.close();
    }
    async waitForFranken() {
        const socket = await this.server.waitForConnection();
        logger.debug('FrankenServer connected');
        return Franken.fromSocket(socket);
    }
    static async start(path) {
        logger.debug(`Creating franken server on socket: ${config.dacSockPath}`);
        const unixSocketServer = await UnixSocketServer.start(path);
        return new FrankenServer(unixSocketServer);
    }
}
function waitForFrankenWithTimeout(server) {
    if (!FRANKEN_CONNECTION_TIMEOUT_MS) {
        return server.waitForFranken();
    }
    const timeoutMessage = `Restarting Franken after ${FRANKEN_CONNECTION_TIMEOUT_MS / 1_000}s timeout`;
    return promiseWithTimeout(server.waitForFranken(), FRANKEN_CONNECTION_TIMEOUT_MS, {
        onTimeout: () => {
            logger.warn(timeoutMessage);
            return new FrankenConnectionTimeoutError();
        },
    });
}
async function shutdownFrankenServer() {
    // Grab and null out the module-level singletons synchronously, before any
    // await. This can run concurrently with itself, e.g. the connect-retry
    // loop calling this after a connection timeout at the same moment
    // gracefulShutdown() calls disconnectFranken() from a SIGTERM, and the
    // old code re-checked franken/frankenServer after an await, so one caller
    // could null a reference out from under the other mid-close, producing
    // "Cannot read properties of undefined (reading 'close')". Capturing
    // locals up front makes a concurrent call see both as already cleared and
    // become a no-op instead of racing.
    const currentFranken = franken;
    const currentFrankenServer = frankenServer;
    franken = undefined;
    frankenServer = undefined;
    if (currentFranken) {
        // Abort pending I/O before waiting for the queue. A wedged write cannot
        // drain until closing the connection rejects its operation.
        currentFranken.close();
        try {
            await currentFranken.sequentialQueue.drain();
        }
        catch {
            // ignored
        }
    }
    if (currentFrankenServer) {
        await currentFrankenServer.close();
    }
}
export async function connectFranken() {
    if (franken)
        return franken;
    if (connectPromise)
        return connectPromise;
    const generation = connectGeneration;
    const cancelled = () => new FrankenUnavailableError('Franken connection attempt was cancelled');
    connectPromise = (async () => {
        // eslint-disable-next-line no-constant-condition
        while (true) {
            if (!frankenServer) {
                const started = await FrankenServer.start(config.dacSockPath);
                if (generation !== connectGeneration) {
                    await started.close();
                    throw cancelled();
                }
                frankenServer = started;
                logger.debug('FrankenServer started');
            }
            try {
                logger.debug('Waiting for Franken hardware connection...');
                const connected = await waitForFrankenWithTimeout(frankenServer);
                if (generation !== connectGeneration) {
                    connected.close();
                    throw cancelled();
                }
                franken = connected;
                logger.info('Franken socket connected');
                return franken;
            }
            catch (error) {
                if (generation !== connectGeneration)
                    throw error;
                if (error instanceof FrankenConnectionTimeoutError) {
                    logger.warn('Unable to connect to Franken within timeout, restarting socket server...');
                    await shutdownFrankenServer();
                    if (generation !== connectGeneration)
                        throw cancelled();
                    continue;
                }
                await shutdownFrankenServer();
                throw error;
            }
        }
    })();
    const attempt = connectPromise;
    try {
        return await attempt;
    }
    finally {
        if (connectPromise === attempt)
            connectPromise = undefined;
    }
}
export async function disconnectFranken() {
    connectGeneration += 1;
    connectPromise = undefined;
    await shutdownFrankenServer();
}
// Newest waiting command per setting; older ones drop out when superseded.
const latestWaiting = new Map();
async function connectFrankenLatest(key, notAfter) {
    const ticket = Symbol(key);
    latestWaiting.set(key, ticket);
    try {
        const connection = franken ?? await connectFranken();
        if (latestWaiting.get(key) !== ticket)
            throw new FrankenSupersededError();
        assertBefore(notAfter);
        return connection;
    }
    finally {
        if (latestWaiting.get(key) === ticket)
            latestWaiting.delete(key);
    }
}
// Connection for a command that changes hardware state. Fails after a bounded
// wait rather than waiting for the firmware indefinitely; a caller that gave
// up never gets a connection later, so its command is dropped, not replayed.
// A latest command is the exception: it waits without a limit, and only the
// newest command for its key is sent.
export async function connectFrankenWithin({ background = false, latest = false, notAfter } = {}, key = '') {
    if (background && latest && key)
        return connectFrankenLatest(key, notAfter);
    if (franken) {
        assertBefore(notAfter);
        return franken;
    }
    let waitMs = background ? FRANKEN_BACKGROUND_CONNECT_WAIT_MS : FRANKEN_CONNECT_WAIT_MS;
    if (notAfter !== undefined)
        waitMs = Math.max(0, Math.min(waitMs, notAfter - Date.now()));
    const connection = await promiseWithTimeout(connectFranken(), waitMs, {
        onTimeout: () => new FrankenUnavailableError(`Pod hardware is not connected; gave up after ${waitMs / 1_000}s`),
    });
    assertBefore(notAfter);
    return connection;
}
export function getFrankenQueueDepth() {
    return franken?.sequentialQueue.depth() ?? 0;
}
export function isFrankenConnected() {
    return franken !== undefined;
}
// Concurrent callers asking for device status share a single roundtrip while
// one is in flight. Cache lifetime is the duration of the in-flight call only,
// no stale reads, this is purely a "did N requests just arrive simultaneously"
// optimisation. Failures (including timeouts) are not cached.
const inFlightDeviceStatus = new Map();
export async function getDeviceStatusCoalesced(getGestures = false) {
    const current = inFlightDeviceStatus.get(getGestures);
    if (current)
        return current;
    // Publish the promise before awaiting connection setup, so callers entering
    // in the same microtask turn share the entire operation.
    const pending = connectFranken().then(connection => connection.getDeviceStatus(getGestures)).finally(() => {
        inFlightDeviceStatus.delete(getGestures);
    });
    inFlightDeviceStatus.set(getGestures, pending);
    return pending;
}
//# sourceMappingURL=frankenServer.js.map