import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { WorkflowEngine, type EngineEvent } from '@ai-company/core';
import { PostgresEventStore } from '../src/pg-event-store.ts';
import { DATABASE_URL, freshSchema, skipWithoutDb, type TestSchema } from './pg-helpers.ts';
import { makePolicy, registerTestAgents } from './helpers.ts';

describe('PostgresEventStore', { skip: skipWithoutDb }, () => {
  let db: TestSchema;
  const open = (opts: { lockTimeoutMs?: number } = {}) =>
    PostgresEventStore.open({ connectionString: DATABASE_URL, schema: db.schema, ...opts });

  beforeEach(async () => {
    db = await freshSchema();
  });
  afterEach(async () => {
    await db.drop();
  });

  test('appended events are durable after flush and reload in order', async () => {
    const store = await open();
    const a = store.append({ type: 'x.one', at: 1, goalId: 'g1', data: { n: 1 } });
    const b = store.append({ type: 'x.two', at: 2, taskId: 't1', agentId: 'kai' });
    assert.deepEqual([a.seq, b.seq], [1, 2]);
    assert.equal(store.durableSeq, 0);
    await store.flush();
    assert.equal(store.durableSeq, 2);
    await store.close();

    const reopened = await open();
    assert.deepEqual(reopened.all(), [
      { seq: 1, at: 1, type: 'x.one', goalId: 'g1', data: { n: 1 } },
      { seq: 2, at: 2, type: 'x.two', taskId: 't1', agentId: 'kai' },
    ]);
    assert.equal(reopened.durableSeq, 2);
    assert.equal(reopened.append({ type: 'x.three', at: 3 }).seq, 3);
    await reopened.close();
  });

  test('events not flushed before close are lost, never half-written', async () => {
    const store = await open();
    store.append({ type: 'kept', at: 1 });
    await store.flush();
    store.append({ type: 'lost', at: 2 });
    await store.close({ flush: false });

    const reopened = await open();
    assert.deepEqual(reopened.all().map((e) => e.type), ['kept']);
    await reopened.close();
  });

  test('subscribers only see events once they are committed', async () => {
    const store = await open();
    const seen: number[] = [];
    store.subscribe((e) => seen.push(e.seq));
    store.append({ type: 'a', at: 1 });
    store.append({ type: 'b', at: 2 });
    assert.deepEqual(seen, []);
    await store.flush();
    assert.deepEqual(seen, [1, 2]);
    await store.close();
  });

  test('the events table is append-only', async () => {
    const store = await open();
    store.append({ type: 'a', at: 1 });
    await store.flush();
    await assert.rejects(db.query(`UPDATE ${db.schema}.events SET type = 'b'`), /append-only/);
    await assert.rejects(db.query(`DELETE FROM ${db.schema}.events`), /append-only/);
    await assert.rejects(db.query(`TRUNCATE ${db.schema}.events`), /append-only/);
    await store.close();
  });

  test('only one writer may hold the log', async () => {
    const first = await open();
    await assert.rejects(open({ lockTimeoutMs: 300 }), /another server holds the event log/);
    await first.close();
    const second = await open({ lockTimeoutMs: 300 });
    await second.close();
  });

  test('a failed write poisons the store so the server must restart', async () => {
    const store = await open();
    store.append({ type: 'a', at: 1 });
    // Simulate a conflicting writer sneaking in seq 1.
    await db.query(`INSERT INTO ${db.schema}.events (seq, at, type) VALUES (1, 1, 'intruder')`);
    await assert.rejects(store.flush());
    assert.throws(() => store.append({ type: 'b', at: 2 }), /event store failed/);
    await assert.rejects(store.flush(), /event store failed/);
    await store.close({ flush: false });
  });

  test('refuses to load a log with a gap in seq', async () => {
    const store = await open();
    await store.close();
    await db.query(`INSERT INTO ${db.schema}.events (seq, at, type) VALUES (1, 1, 'a'), (3, 3, 'c')`);
    await assert.rejects(open(), /gap in event log/);
  });

  test('stores any JSON string exactly: NUL, lone surrogates, key order', async () => {
    const store = await open();
    const data = { z: 'a\u0000b', a: 'lone \ud800 surrogate', nested: { y: 1, b: [2, { k: 'v' }] } };
    store.append({ type: 'weird', at: 1, data });
    await store.flush();
    await store.close();
    const reopened = await open();
    const [event] = reopened.all();
    assert.deepEqual(event.data, data);
    assert.deepEqual(Object.keys(event.data!), ['z', 'a', 'nested']);
    await reopened.close();
  });

  test('restarting with an unchanged config emits no agent events', async () => {
    const store = await open();
    registerTestAgents(new WorkflowEngine({ policy: makePolicy(), store }));
    await store.close();
    const reopened = await open();
    const engine = new WorkflowEngine({ policy: makePolicy(), store: reopened });
    const before = reopened.size;
    registerTestAgents(engine);
    assert.equal(reopened.size, before);
    await reopened.close();
  });

  test('a dropped connection poisons the store instead of crashing the process', async () => {
    const store = await open();
    // The store's own session is the one holding the single-writer advisory lock.
    const { rows } = await db.query(
      `SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND granted AND objid = (hashtext($1)::bigint & 4294967295)::oid`,
      [`ai-company:${db.schema}.events`],
    );
    assert.equal(rows.length, 1);
    const failed = new Promise<Error>((resolve) => store.onFailure(resolve));
    await db.query('SELECT pg_terminate_backend($1)', [rows[0].pid]);
    // Reported right away, not only at the next write.
    assert.match((await failed).message, /terminating connection/);
    assert.throws(() => store.append({ type: 'after-drop', at: 1 }), /event store failed/);
    await assert.rejects(store.flush(), /event store failed/);
    await store.close({ flush: false });
  });

  test('abort drops pending events: a queued flush writes nothing, the in-flight one completes', async () => {
    const store = await open();
    store.append({ type: 'first', at: 1 });
    const inFlight = store.flush();
    await new Promise((r) => setImmediate(r)); // let the first write take its batch
    store.append({ type: 'second', at: 2 });
    const queued = store.flush();
    store.append({ type: 'half.done', at: 3 });
    store.abort(new Error('command threw'));
    await inFlight;
    await assert.rejects(queued, /event store failed: command threw/);
    assert.throws(() => store.append({ type: 'later', at: 4 }), /event store failed/);
    await store.close();
    const reopened = await open();
    assert.deepEqual(reopened.all().map((e) => e.type), ['first']);
    await reopened.close();
  });

  test('migrates an old jsonb data column to json', async () => {
    await db.query(`CREATE TABLE ${db.schema}.events (seq bigint PRIMARY KEY, at bigint NOT NULL, type text NOT NULL, goal_id text, task_id text, agent_id text, data jsonb, recorded_at timestamptz NOT NULL DEFAULT now())`);
    await db.query(`INSERT INTO ${db.schema}.events (seq, at, type, data) VALUES (1, 1, 'old', '{"a":1}')`);
    const store = await open();
    const { rows } = await db.query(`SELECT data_type FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'events' AND column_name = 'data'`, [db.schema]);
    assert.equal(rows[0].data_type, 'json');
    assert.deepEqual(store.all()[0].data, { a: 1 });
    store.append({ type: 'nul', at: 2, data: { s: 'a\u0000b' } });
    await store.flush();
    await store.close();
  });

  test('an engine rebuilt on boot has identical state', async () => {
    const store = await open();
    const engine = new WorkflowEngine({ policy: makePolicy(), store });
    registerTestAgents(engine);
    const goal = engine.createGoal('Ship', 50_000);
    assert.ok(goal.ok);
    await store.flush();
    const before = { tasks: engine.listTasks(), agents: engine.listAgents(), goals: engine.listGoals() };
    await store.close();

    const reopened = await open();
    const rebuilt = new WorkflowEngine({ policy: makePolicy(), store: reopened });
    assert.deepEqual({ tasks: rebuilt.listTasks(), agents: rebuilt.listAgents(), goals: rebuilt.listGoals() }, before);
    const events: readonly EngineEvent[] = reopened.all();
    assert.equal(events.length, reopened.durableSeq);
    await reopened.close();
  });
});
