import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { WorkflowEngine } from '@ai-company/core';
import { MemoryDurableEventStore } from '../src/durable-store.ts';
import { startStuckTimer, STUCK_CHECK_INTERVAL_MS } from '../src/stuck-timer.ts';
import { makePolicy, must, registerTestAgents } from './helpers.ts';

describe('stuck timer', () => {
  test('calls checkStuck every 30 s through the command queue', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    let clock = 1_000_000;
    const store = new MemoryDurableEventStore();
    const engine = new WorkflowEngine({ policy: makePolicy(), store, now: () => clock });
    registerTestAgents(engine);
    const goal = must(engine.createGoal('G', 100_000));
    const [task] = must(engine.submitPlan(goal.id, 'ava', [{ key: 'a', title: 'A', acceptanceCriteria: ['c'], ownerId: 'kai', requiredTools: ['repo.read'], costEstimateTokens: 1 }]));
    must(engine.start(task.id, 'kai'));

    const runs: string[][] = [];
    const run = async <T>(fn: () => T): Promise<T> => {
      const value = fn();
      await store.flush();
      runs.push(value as string[]);
      return value;
    };
    const stop = startStuckTimer({ run, engine });

    assert.equal(STUCK_CHECK_INTERVAL_MS, 30_000);
    clock += 6 * 60_000; // quiet for longer than stuckAfterMs (5 min)
    t.mock.timers.tick(29_999);
    await Promise.resolve();
    assert.equal(runs.length, 0);
    t.mock.timers.tick(1);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(runs, [[task.id]]);
    assert.equal(engine.getTask(task.id)!.state, 'escalated');

    t.mock.timers.tick(30_000);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(runs, [[task.id], []]);
    stop();
    t.mock.timers.tick(60_000);
    await new Promise((r) => setImmediate(r));
    assert.equal(runs.length, 2);
  });

  test('each tick also retries work that waits on it (automated checks)', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const engine = new WorkflowEngine({ policy: makePolicy(), store: new MemoryDurableEventStore() });
    let retries = 0;
    const stop = startStuckTimer({ run: async (fn) => fn(), engine, alsoEachTick: async () => void retries++ });
    t.mock.timers.tick(30_000);
    await new Promise((r) => setImmediate(r));
    t.mock.timers.tick(30_000);
    await new Promise((r) => setImmediate(r));
    stop();
    assert.equal(retries, 2);
  });

  test('a tick never overlaps a slow previous tick', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const engine = new WorkflowEngine({ policy: makePolicy(), store: new MemoryDurableEventStore() });
    let calls = 0;
    let release!: () => void;
    const run = async <T>(fn: () => T): Promise<T> => {
      calls += 1;
      const value = fn();
      await new Promise<void>((r) => (release = r));
      return value;
    };
    const stop = startStuckTimer({ run, engine });
    t.mock.timers.tick(30_000);
    t.mock.timers.tick(30_000);
    t.mock.timers.tick(30_000);
    assert.equal(calls, 1);
    release();
    await new Promise((r) => setImmediate(r));
    t.mock.timers.tick(30_000);
    assert.equal(calls, 2);
    stop();
  });
});
