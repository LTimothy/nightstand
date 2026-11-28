import { Server as HttpServer, IncomingMessage } from 'http';
import { WebSocket, WebSocketServer } from 'ws';
import logger from '../logger.js';
import eventBus, { EventEnvelope } from '../events/eventBus.js';
import metrics from '../metrics/metrics.js';
import { isAllowedOrigin } from '../setup/middleware.js';
import serverInfo from '../serverInfo.json' with { type: 'json' };

const HEARTBEAT_INTERVAL_MS = 15_000;
const WS_PATH = '/ws/events';

interface AliveSocket extends WebSocket {
  isAlive?: boolean;
  unsubscribe?: () => void;
}

export class WsServer {
  private wss = new WebSocketServer({ noServer: true });
  private heartbeat: NodeJS.Timeout | undefined;
  private attached = false;

  public attach(httpServer: HttpServer): void {
    if (this.attached) return;
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

    this.wss.on('connection', (raw: WebSocket, req: IncomingMessage) => {
      const ws = raw as AliveSocket;
      ws.isAlive = true;
      eventBus.registerClient();
      logger.debug(`WS client connected from ${req.socket.remoteAddress}, total=${eventBus.clientCount}`);

      ws.on('pong', () => {
        ws.isAlive = true;
      });

      ws.unsubscribe = eventBus.subscribeAll((env: EventEnvelope) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        try {
          ws.send(JSON.stringify(env));
        } catch (err) {
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
        const payload = { ts: new Date().toISOString(), server: 'nightstand', version: serverInfo.version };
        ws.send(JSON.stringify({ channel: 'hello', payload }));
      } catch {
        // ignored
      }
    });

    this.heartbeat = setInterval(() => {
      this.wss.clients.forEach((raw) => {
        const ws = raw as AliveSocket;
        if (ws.isAlive === false) {
          ws.terminate();
          return;
        }
        ws.isAlive = false;
        try {
          ws.ping();
        } catch {
          // ignored, terminate on next sweep
        }
      });
    }, HEARTBEAT_INTERVAL_MS);

    metrics.registerWsClientCount(() => eventBus.clientCount);

    logger.info(`WebSocket server listening on ${WS_PATH}`);
  }

  public async close(): Promise<void> {
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
      } catch {
        // ignored
      }
    });
    await new Promise<void>((resolve) => {
      this.wss.close(() => resolve());
    });
  }
}

export const wsServer = new WsServer();
