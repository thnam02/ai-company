import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { WorkflowEngine, type ProposedAction } from '@ai-company/core';
import WebSocket from 'ws';
import { createCompanyServer, type CompanyServer, type ServerOptions } from '../src/app.ts';
import { MemoryDurableEventStore, type DurableEventStore } from '../src/durable-store.ts';
import { allMet, makePolicy, must, registerTestAgents } from './helpers.ts';

const TOKEN = 'test-ceo-token';

interface Harness {
  engine: WorkflowEngine;
  server: CompanyServer;
  executed: ProposedAction[];
  fatal: Error[];
  logs: string[];
  port: number;
  call: (method: string, path: string, body?: unknown, token?: string | null) => Promise<{ status: number; body: any }>;
}

let open: Harness[] = [];

async function start(store: DurableEventStore = new MemoryDurableEventStore(), overrides: Partial<ServerOptions> = {}): Promise<Harness> {
  const engine = new WorkflowEngine({ policy: makePolicy(), store });
  registerTestAgents(engine);
  await store.flush();
  const executed: ProposedAction[] = [];
  const fatal: Error[] = [];
  const logs: string[] = [];
  const server = createCompanyServer({
    engine,
    store,
    ceoToken: TOKEN,
    onExecute: (action) => {
      executed.push(action);
    },
    onFatal: (err) => fatal.push(err),
    log: (m) => logs.push(m),
    ...overrides,
  });
  await new Promise<void>((resolve) => server.http.listen(0, '127.0.0.1', resolve));
  const { port } = server.http.address() as AddressInfo;
  const call: Harness['call'] = async (method, path, body, token = TOKEN) => {
    const headers: Record<string, string> = {};
    if (token !== null) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const h = { engine, server, executed, fatal, logs, port, call };
  open.push(h);
  return h;
}

afterEach(async () => {
  for (const h of open) await h.server.close();
  open = [];
});

/** Drive a task to awaiting_approval the way agents would (through the engine). */
function taskAwaitingApproval(engine: WorkflowEngine) {
  const goal = must(engine.createGoal('Close the deal', 100_000));
  const [t] = must(
    engine.submitPlan(goal.id, 'ava', [
      { key: 'mail', title: 'Email the client', acceptanceCriteria: ['Polite'], ownerId: 'omar', requiredTools: ['email.send'], costEstimateTokens: 1_000 },
    ]),
  );
  must(engine.start(t.id, 'omar'));
  must(engine.submitForReview(t.id, 'omar', { summary: 'Draft ready', selfCheck: allMet(t.acceptanceCriteria), finalAction: { tool: 'email.send', input: { to: 'client' }, idempotencyKey: 'mail-1' } }));
  must(engine.recordReview(t.id, 'rex', { passed: true, score: 0.9, feedback: 'good' }));
  return t.id;
}

describe('auth', () => {
  test('every route except /health needs the CEO token', async () => {
    const { call } = await start();
    assert.equal((await call('GET', '/health', undefined, null)).status, 200);
    assert.equal((await call('GET', '/state', undefined, null)).status, 401);
    assert.equal((await call('GET', '/state', undefined, 'wrong')).status, 401);
    assert.equal((await call('POST', '/goals', { text: 'x', budgetTokens: 1 }, null)).status, 401);
    assert.equal((await call('GET', '/state')).status, 200);
  });

  test('HTTP routes refuse a token in the query string (it would end up in access logs)', async () => {
    const { call } = await start();
    assert.equal((await call('GET', `/state?token=${TOKEN}`, undefined, null)).status, 401);
    assert.equal((await call('POST', `/company/pause?token=${TOKEN}`, undefined, null)).status, 401);
  });

  test('a malformed path is a 400, not a 500', async () => {
    const { call } = await start();
    assert.equal((await call('POST', '/agents/%E0%A4%A/pause')).status, 400);
  });
});

describe('CEO actions', () => {
  test('create goal and read it back in /state', async () => {
    const { call } = await start();
    const created = await call('POST', '/goals', { text: 'Launch the site', budgetTokens: 50_000 });
    assert.equal(created.status, 201);
    assert.equal(created.body.text, 'Launch the site');
    const state = await call('GET', '/state');
    assert.deepEqual(state.body.goals.map((g: any) => g.id), [created.body.id]);
    assert.equal(state.body.companyPaused, false);
    assert.ok(state.body.seq > 0);
    assert.ok(state.body.agents.some((a: any) => a.id === 'kai'));
  });

  test('bad input gets 400, engine refusals get 409/404 with the reason', async () => {
    const { call } = await start();
    assert.equal((await call('POST', '/goals', '{not json')).status, 400);
    assert.equal((await call('POST', '/goals', { text: 'x' })).status, 400);
    const refused = await call('POST', '/goals', { text: 'x', budgetTokens: -5 });
    assert.equal(refused.status, 409);
    assert.match(refused.body.error, /budget must be positive/);
    const unknown = await call('POST', '/agents/nobody/pause');
    assert.equal(unknown.status, 404);
    assert.equal((await call('GET', '/nope')).status, 404);
    assert.equal((await call('POST', '/goals', 'x'.repeat(70_000))).status, 413);
  });

  test('pause, resume and unbench agents', async () => {
    const { call, engine } = await start();
    assert.equal((await call('POST', '/agents/kai/pause')).status, 200);
    assert.equal(engine.getAgent('kai')!.paused, true);
    assert.equal((await call('POST', '/agents/kai/resume')).status, 200);
    assert.equal(engine.getAgent('kai')!.paused, false);
    assert.equal((await call('POST', '/agents/kai/unbench')).status, 200);
  });

  test('kill switch stops starts and tool calls until resumed', async () => {
    const { call, engine } = await start();
    const goal = must(engine.createGoal('G', 100_000));
    const [t] = must(engine.submitPlan(goal.id, 'ava', [{ key: 'a', title: 'A', acceptanceCriteria: ['c'], ownerId: 'kai', requiredTools: ['repo.read'], costEstimateTokens: 1 }]));
    assert.equal((await call('POST', '/company/pause', { reason: 'audit' })).status, 200);
    assert.equal((await call('GET', '/state')).body.companyPaused, true);
    assert.equal(engine.start(t.id, 'kai').ok, false);
    assert.equal((await call('POST', '/company/resume')).status, 200);
    assert.equal(engine.start(t.id, 'kai').ok, true);
  });

  test('approving releases the final action to the gateway hook once, never to the HTTP caller', async () => {
    const { call, engine, executed } = await start();
    const taskId = taskAwaitingApproval(engine);
    const res = await call('POST', `/tasks/${taskId}/approval`, { approved: true });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { state: 'done' });
    assert.deepEqual(executed, [{ tool: 'email.send', input: { to: 'client' }, idempotencyKey: 'mail-1' }]);
    const again = await call('POST', `/tasks/${taskId}/approval`, { approved: true });
    assert.equal(again.status, 409);
    assert.equal(executed.length, 1);
  });

  test('rejecting needs a note and sends the task back to work', async () => {
    const { call, engine, executed } = await start();
    const taskId = taskAwaitingApproval(engine);
    assert.equal((await call('POST', `/tasks/${taskId}/approval`, { approved: 'yes' })).status, 400);
    assert.equal((await call('POST', `/tasks/${taskId}/approval`, { approved: false })).status, 409);
    const res = await call('POST', `/tasks/${taskId}/approval`, { approved: false, note: 'Too pushy' });
    assert.deepEqual(res.body, { state: 'working' });
    assert.equal(engine.getTask(taskId)!.lastFeedback, 'Too pushy');
    assert.equal(executed.length, 0);
  });

  test('resolve escalations: retry, reassign, cancel', async () => {
    const { call, engine } = await start();
    const goal = must(engine.createGoal('G', 100_000));
    // Two escalations each, so the circuit breaker (3 in a row) stays quiet.
    const plan = [['a', 'kai'], ['b', 'kai'], ['c', 'omar']].map(([key, ownerId]) => ({ key, title: key, acceptanceCriteria: ['c'], ownerId, requiredTools: ['repo.read'], costEstimateTokens: 1 }));
    const [a, b, c] = must(engine.submitPlan(goal.id, 'ava', plan));
    for (const t of [a, b, c]) {
      must(engine.start(t.id, t.ownerId));
      must(engine.escalate(t.id, 'stuck'));
    }
    assert.deepEqual((await call('POST', `/tasks/${a.id}/resolve`, { kind: 'retry' })).body, { state: 'assigned' });
    assert.deepEqual((await call('POST', `/tasks/${b.id}/resolve`, { kind: 'reassign', ownerId: 'omar' })).body, { state: 'assigned' });
    assert.equal(engine.getTask(b.id)!.ownerId, 'omar');
    assert.deepEqual((await call('POST', `/tasks/${c.id}/resolve`, { kind: 'cancel' })).body, { state: 'cancelled' });
    assert.equal((await call('POST', `/tasks/${c.id}/resolve`, { kind: 'explode' })).status, 400);
    assert.equal((await call('POST', `/tasks/${a.id}/resolve`, { kind: 'reassign', ownerId: 'rex' })).status, 409);
  });

  test('/events returns durable events after a seq', async () => {
    const { call, engine } = await start();
    const size = engine.store.size;
    await call('POST', '/goals', { text: 'G', budgetTokens: 10 });
    const res = await call('GET', `/events?since=${size}`);
    assert.deepEqual(res.body.map((e: any) => [e.seq, e.type]), [[size + 1, 'goal.created']]);
    assert.equal((await call('GET', '/events?since=abc')).status, 400);
  });
});

describe('durability ordering', () => {
  /** A store whose flushes wait until the test releases them, in order. */
  class GatedStore extends MemoryDurableEventStore {
    gates: { resolve: () => void; reject: (e: Error) => void }[] = [];
    gated = false;
    flushes = 0;
    aborted: Error[] = [];
    failureListeners: ((err: Error) => void)[] = [];
    override abort(err: Error): void {
      this.aborted.push(err);
      super.abort(err);
    }
    override onFailure(listener: (err: Error) => void): void {
      this.failureListeners.push(listener);
    }
    override flush(): Promise<void> {
      this.flushes += 1;
      if (!this.gated) return Promise.resolve();
      return new Promise((resolve, reject) => this.gates.push({ resolve, reject }));
    }
  }
  const waitFor = async (cond: () => boolean) => {
    while (!cond()) await new Promise((r) => setTimeout(r, 5));
  };

  test('no response leaves before its events are durable', async () => {
    const store = new GatedStore();
    const { call } = await start(store);
    store.gated = true;
    let answered = false;
    const pending = call('POST', '/goals', { text: 'G', budgetTokens: 10 }).then((r) => {
      answered = true;
      return r;
    });
    await waitFor(() => store.gates.length === 1);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(answered, false);
    store.gates[0].resolve();
    assert.equal((await pending).status, 201);
  });

  test('concurrent commands each answer with their own durable result', async () => {
    const store = new GatedStore();
    const { call } = await start(store);
    store.gated = true;
    const pause = call('POST', '/company/pause');
    await waitFor(() => store.gates.length === 1);
    const resume = call('POST', '/company/resume');
    const agentPause = call('POST', '/agents/kai/pause');
    await waitFor(() => store.gates.length === 3);
    // The first commit lands while the later commands are already applied in memory.
    store.gates[0].resolve();
    assert.deepEqual((await pause).body, { companyPaused: true });
    store.gates[1].resolve();
    assert.deepEqual((await resume).body, { companyPaused: false });
    store.gates[2].resolve();
    assert.equal((await agentPause).body.agent.paused, true);
  });

  test('a failed flush is fatal: 500 now, 503 afterwards, nothing executed, no stream', async () => {
    const store = new GatedStore();
    const { call, engine, fatal, executed, port } = await start(store);
    const taskId = taskAwaitingApproval(engine);
    store.gated = true;
    const pending = call('POST', `/tasks/${taskId}/approval`, { approved: true });
    await waitFor(() => store.gates.length === 1);
    store.gates[0].reject(new Error('disk on fire'));
    assert.equal((await pending).status, 500);
    assert.equal(fatal.length, 1);
    assert.deepEqual(executed, []);
    store.gated = false;
    assert.equal((await call('GET', '/state')).status, 503);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/stream`, { headers: { authorization: `Bearer ${TOKEN}` } });
    const status = await new Promise<number>((resolve) => ws.on('unexpected-response', (_req, res) => resolve(res.statusCode!)));
    assert.equal(status, 503);
  });

  test('a command that throws is fatal and its partial events are never written', async () => {
    const store = new GatedStore();
    const { server, fatal, call } = await start(store);
    const flushesBefore = store.flushes;
    await assert.rejects(
      server.run(() => {
        store.append({ type: 'half.done', at: 1 });
        throw new Error('illegal transition');
      }),
      /illegal transition/,
    );
    assert.equal(store.flushes, flushesBefore, 'nothing flushed after a throw');
    assert.deepEqual(store.aborted.map((e) => e.message), ['illegal transition'], 'pending events dropped, queued flushes cancelled');
    assert.equal(fatal.length, 1);
    assert.equal(server.failed, true);
    assert.equal((await call('POST', '/goals', { text: 'G', budgetTokens: 10 })).status, 503);
    assert.equal(store.flushes, flushesBefore);
  });
});

describe('store failure', () => {
  test('a store failing on its own (e.g. lost connection) makes the server fatal at once', async () => {
    const store = new MemoryDurableEventStore();
    const listeners: ((err: Error) => void)[] = [];
    store.onFailure = (l) => void listeners.push(l);
    const { call, fatal } = await start(store);
    assert.equal(listeners.length, 1);
    listeners[0](new Error('connection terminated'));
    assert.equal(fatal.length, 1);
    assert.equal((await call('GET', '/health', undefined, null)).status, 503);
  });
});

describe('gateway hook', () => {
  test('a throwing hook does not undo or fail the approval, and is logged', async () => {
    const { call, engine, logs } = await start(undefined, {
      onExecute: () => {
        throw new Error('gateway down');
      },
    });
    const taskId = taskAwaitingApproval(engine);
    assert.deepEqual((await call('POST', `/tasks/${taskId}/approval`, { approved: true })).body, { state: 'done' });
    await new Promise((r) => setImmediate(r));
    assert.ok(logs.some((l) => /gateway hook failed for mail-1: gateway down/.test(l)));
  });

  test('without executors the released action is only logged, never returned', async () => {
    const { call, engine, logs } = await start(undefined, { onExecute: undefined });
    const taskId = taskAwaitingApproval(engine);
    const res = await call('POST', `/tasks/${taskId}/approval`, { approved: true });
    assert.deepEqual(res.body, { state: 'done' });
    assert.ok(logs.some((l) => /email.send \(mail-1\).*no executors are configured/.test(l)));
  });
});
