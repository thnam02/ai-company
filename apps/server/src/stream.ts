import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import type { DurableEventStore } from './durable-store.ts';

export interface StreamOptions {
  store: DurableEventStore;
  authorize: (req: IncomingMessage, url: URL) => boolean;
  isFailed: () => boolean;
  heartbeatMs?: number;
  /** Drop a client whose unsent backlog grows past this. Default 8 MiB. */
  maxBufferedBytes?: number;
}

export interface EventStream {
  readonly clients: number;
  close(): Promise<void>;
}

/** Close code sent when the client's resume point is ahead of the log (e.g. it saw a different database). */
export const CLOSE_AHEAD_OF_LOG = 4409;
/** Close code sent when a client cannot keep up. It should reconnect with its last seq. */
export const CLOSE_TOO_SLOW = 4429;

/**
 * WebSocket event stream at `/stream?since=<seq>`.
 *
 * Each message is one EngineEvent as JSON, in seq order, with no gaps or
 * repeats: first the backlog after `since`, then live events. Only durable
 * events are sent. A client that reconnects with the last seq it saw resumes
 * exactly where it stopped.
 */
export function attachEventStream(http: Server, options: StreamOptions): EventStream {
  const { store } = options;
  const maxBuffered = options.maxBufferedBytes ?? 8 * 1024 * 1024;
  const wss = new WebSocketServer({ noServer: true });
  const alive = new WeakMap<WebSocket, boolean>();

  const reject = (socket: Duplex, status: number, message: string) => {
    socket.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  };

  http.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/stream') return reject(socket, 404, 'Not Found');
    if (!options.authorize(req, url)) return reject(socket, 401, 'Unauthorized');
    if (options.isFailed()) return reject(socket, 503, 'Service Unavailable');
    const raw = url.searchParams.get('since') ?? '0';
    if (!/^\d+$/.test(raw)) return reject(socket, 400, 'Bad Request');
    const since = Number(raw);
    wss.handleUpgrade(req, socket, head, (ws) => connect(ws, since));
  });

  function connect(ws: WebSocket, since: number): void {
    if (since > store.durableSeq) {
      ws.close(CLOSE_AHEAD_OF_LOG, 'resume point is ahead of the log');
      return;
    }
    alive.set(ws, true);
    ws.on('pong', () => alive.set(ws, true));

    let lastSent = since;
    const sendEvent = (event: { seq: number }) => {
      if (event.seq <= lastSent || ws.readyState !== ws.OPEN) return;
      if (ws.bufferedAmount > maxBuffered) {
        ws.close(CLOSE_TOO_SLOW, 'too slow; reconnect with your last seq');
        return;
      }
      ws.send(JSON.stringify(event));
      lastSent = event.seq;
    };

    // Backlog and subscription happen in the same tick, so no event can slip
    // between them: anything committed later reaches the listener.
    const durable = store.durableSeq;
    for (const event of store.since(since)) {
      if (event.seq > durable) break;
      sendEvent(event);
    }
    const unsubscribe = store.subscribe(sendEvent);
    ws.on('close', unsubscribe);
    ws.on('error', unsubscribe);
  }

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.get(ws)) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  }, options.heartbeatMs ?? 30_000);
  heartbeat.unref();

  return {
    get clients() {
      return wss.clients.size;
    },
    async close() {
      clearInterval(heartbeat);
      for (const ws of wss.clients) ws.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}
