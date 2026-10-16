import { WebSocket, WebSocketServer } from 'ws';
import logger from '../logger.js';
import eventBus from '../events/eventBus.js';
import metrics from '../metrics/metrics.js';
import { isAllowedOrigin } from '../setup/middleware.js';
const HEARTBEAT_INTERVAL_MS = 15_000;
const WS_PATH = '/ws/events';
export class WsServer {
    wss = new WebSocketServer({ noServer: true });
    heartbeat;
    attached = false;
    attach(httpServer) {
        if (this.attached)
            return;
        this.attached = true;
        httpServer.on('upgrade', (req, socket, head) => {
            const url = new URL(req.url ?? '/', 'http://localhost');
            if (url.pathname !== WS_PATH) {
                socket.destroy();
                return;
            }
            if (!isAllowedOrigin(req.headers.origin, req.headers.host)) {
                socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
                return;
            }
            this.wss.handleUpgrade(req, socket, head, (ws) => {
                this.wss.emit('connection', ws, req);
            });
        });
        this.wss.on('connection', (raw, req) => {
            const ws = raw;
            ws.isAlive = true;
            eventBus.registerClient();
            logger.debug(`WS client connected from ${req.socket.remoteAddress}, total=${eventBus.clientCount}`);
            ws.on('pong', () => {
                ws.isAlive = true;
            });
            ws.unsubscribe = eventBus.subscribeAll((env) => {
                if (ws.readyState !== WebSocket.OPEN)
                    return;
                try {
                    ws.send(JSON.stringify(env));
                }
                catch (err) {
                    logger.warn(`WS send failed: ${err instanceof Error ? err.message : String(err)}`);
                }
            });
            ws.on('close', () => {
                ws.unsubscribe?.();
                eventBus.unregisterClient();
                logger.debug(`WS client disconnected, total=${eventBus.clientCount}`);
            });
            ws.on('error', (err) => {
                logger.warn(`WS client error: ${err.message}`);
            });
            // Greet the new client with a snapshot so they don't have to wait for the
            // next event tick to render something.
            try {
                ws.send(JSON.stringify({ channel: 'hello', payload: { ts: new Date().toISOString() } }));
            }
            catch {
                // ignored
            }
        });
        this.heartbeat = setInterval(() => {
            this.wss.clients.forEach((raw) => {
                const ws = raw;
                if (ws.isAlive === false) {
                    ws.terminate();
                    return;
                }
                ws.isAlive = false;
                try {
                    ws.ping();
                }
                catch {
                    // ignored, terminate on next sweep
                }
            });
        }, HEARTBEAT_INTERVAL_MS);
        metrics.registerWsClientCount(() => eventBus.clientCount);
        logger.info(`WebSocket server listening on ${WS_PATH}`);
    }
    async close() {
        if (this.heartbeat) {
            clearInterval(this.heartbeat);
            this.heartbeat = undefined;
        }
        // wss.close() only stops accepting new connections; open sockets stay
        // alive and would prevent the event loop from idling. Terminate them
        // explicitly first.
        this.wss.clients.forEach((client) => {
            try {
                client.terminate();
            }
            catch {
                // ignored
            }
        });
        await new Promise((resolve) => {
            this.wss.close(() => resolve());
        });
    }
}
export const wsServer = new WsServer();
//# sourceMappingURL=wsServer.js.map