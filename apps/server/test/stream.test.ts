import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { WorkflowEngine, type EngineEvent } from '@ai-company/core';
import { createCompanyServer, type CompanyServer } from '../src/app.ts';
import { MemoryDurableEventStore } from '../src/durable-store.ts';
import { CLOSE_AHEAD_OF_LOG } from '../src/stream.ts';
import { makePolicy, must, registerTestAgents } from './helpers.ts';

const TOKEN = 'stream-token';
let servers: CompanyServer[] = [];
let sockets: WebSocket[] = [];

afterEach(async () => {
  for (const ws of sockets) ws.terminate();
  for (const s of servers) await s.close();
  servers = [];
  sockets = [];
});

async function start() {
  const store = new MemoryDurableEventStore();
  const engine = new WorkflowEngine({ policy: makePolicy(), store });
  registerTestAgents(engine);
  const server = createCompanyServer({ engine, store, ceoToken: TOKEN, log: () => {} });
  await new Promise<void>((resolve) => server.http.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const { port } = server.http.address() as AddressInfo;
  return { engine, server, base: `ws://127.0.0.1:${port}/stream` };
}

/** Opens a stream and collects events until `count` have arrived. */
function collect(url: string, count: number, headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` }) {
  const ws = new WebSocket(url, { headers });
  sockets.push(ws);
  const events: EngineEvent[] = [];
  const done = new Promise<EngineEvent[]>((resolve, reject) => {
    ws.on('message', (data) => {
      events.push(JSON.parse(String(data)));
      if (events.length === count) resolve(events);
    });
    ws.on('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    ws.on('close', (code) => events.length < count && reject(Object.assign(new Error(`closed ${code}`), { code })));
    ws.on('error', () => {});
  });
  const opened = new Promise<void>((resolve) => ws.on('open', () => resolve()));
  return { ws, events, done, opened };
}

describe('event stream', () => {
  test('sends the backlog, then live events, in seq order without gaps or repeats', async () => {
    const { engine, base } = await start();
    const backlog = engine.store.size;
    const c = collect(`${base}?since=0`, backlog + 2);
    await c.opened;
    must(engine.createGoal('A', 10));
    must(engine.createGoal('B', 10));
    const events = await c.done;
    assert.deepEqual(events.map((e) => e.seq), Array.from({ length: backlog + 2 }, (_, i) => i + 1));
    assert.deepEqual(events.slice(-2).map((e) => e.data!.goal.text), ['A', 'B']);
  });

  test('a client that reconnects with its last seq resumes exactly where it stopped', async () => {
    const { engine, base } = await start();
    const first = collect(`${base}?since=0`, engine.store.size);
    const seen = await first.done;
    first.ws.close();
    must(engine.createGoal('missed while offline', 10));
    const last = seen.at(-1)!.seq;
    const resumed = collect(`${base}?since=${last}`, 1);
    const [event] = await resumed.done;
    assert.equal(event.seq, last + 1);
    assert.equal(event.type, 'goal.created');
  });

  test('rejects unauthorized clients and bad resume points', async () => {
    const { engine, base } = await start();
    await assert.rejects(collect(`${base}?since=0`, 1, {}).done, /HTTP 401/);
    await assert.rejects(collect(`${base}?since=-1`, 1).done, /HTTP 400/);
    await assert.rejects(collect(`${base}?since=${engine.store.size + 5}`, 1).done, (err: any) => err.code === CLOSE_AHEAD_OF_LOG);
    // Browsers cannot set headers on a WebSocket, so the token may also come as a query parameter.
    const viaQuery = collect(`${base}?since=0&token=${TOKEN}`, 1, {});
    assert.equal((await viaQuery.done)[0].seq, 1);
  });
});
