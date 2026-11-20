import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkflowEngine } from '@ai-company/core';
import type { DurableEventStore } from '../src/durable-store.ts';
import { PostgresEventStore } from '../src/pg-event-store.ts';
import { SqliteEventStore } from '../src/sqlite-event-store.ts';
import { snapshot } from '../src/app.ts';
import { buildPolicy } from '../src/company.ts';
import { DATABASE_URL, freshSchema, skipWithoutDb } from './pg-helpers.ts';
import { TEST_CONFIG, allMet, must, registerTestAgents } from './helpers.ts';

const MAIN = fileURLToPath(new URL('../src/main.ts', import.meta.url));
const TOKEN = 'crash-test-token-0123456789';

interface Child {
  proc: ChildProcess;
  call: (method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }>;
  kill: () => Promise<void>;
}

/** One event log per test, plus the env that points a server at it. */
interface Log {
  env: Record<string, string>;
  /** Opens the log directly; no server may be running. */
  open: () => Promise<DurableEventStore>;
  drop: () => Promise<void>;
}

const backends: { name: string; skip: string | false; create: (dir: string) => Promise<Log> }[] = [
  {
    name: 'SQLite',
    skip: false,
    create: async (dir) => ({
      env: { DATA_DIR: join(dir, 'data') },
      open: async () => SqliteEventStore.open({ path: join(dir, 'data', 'company.db'), lockTimeoutMs: 5_000 }),
      drop: async () => {},
    }),
  },
  {
    name: 'Postgres',
    skip: skipWithoutDb,
    create: async () => {
      const db = await freshSchema();
      return {
        env: { DATABASE_URL, DB_SCHEMA: db.schema },
        open: () => PostgresEventStore.open({ connectionString: DATABASE_URL, schema: db.schema, lockTimeoutMs: 5_000 }),
        drop: () => db.drop(),
      };
    },
  },
];

for (const backend of backends) {
  describe(`crash and restart (${backend.name})`, { skip: backend.skip }, () => {
    let log: Log;
    let dir: string;
    let configPath: string;
    const children: Child[] = [];

    beforeEach(async () => {
      dir = mkdtempSync(join(tmpdir(), 'ai-company-'));
      log = await backend.create(dir);
      configPath = join(dir, 'company.json');
      writeFileSync(configPath, JSON.stringify(TEST_CONFIG));
    });

    afterEach(async () => {
      for (const c of children.splice(0)) await c.kill();
      await log.drop();
      rmSync(dir, { recursive: true, force: true });
    });

    async function startServer(): Promise<Child> {
      // Only this test's log: a SQLite run must never inherit DATABASE_URL.
      const { DATABASE_URL: _url, DB_SCHEMA: _schema, DATA_DIR: _data, WORKSPACE_DIR: _ws, AGENTS: _agents, ...inherited } = process.env;
      const proc = spawn(process.execPath, [MAIN], {
        env: { ...inherited, ...log.env, CEO_TOKEN: TOKEN, PORT: '0', COMPANY_CONFIG: configPath, WORKSPACE_DIR: join(dir, 'workspace'), AGENTS: 'off' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      proc.stderr!.on('data', (d) => (stderr += d));
      const url = await new Promise<string>((resolve, reject) => {
        let out = '';
        proc.stdout!.on('data', (d) => {
          out += d;
          const m = /listening on (http:\/\/\S+)/.exec(out);
          if (m) resolve(m[1]);
        });
        proc.once('exit', (code) => reject(new Error(`server exited (${code}) before listening:\n${stderr}`)));
      });
      assert.match(stderr, new RegExp(`event store: ${backend.name}`), 'the server must use the store under test');
      const exited = new Promise<void>((resolve) => proc.once('exit', () => resolve()));
      const child: Child = {
        proc,
        async call(method, path, body) {
          const res = await fetch(url + path, {
            method,
            headers: { authorization: `Bearer ${TOKEN}`, ...(body ? { 'content-type': 'application/json' } : {}) },
            body: body ? JSON.stringify(body) : undefined,
          });
          return { status: res.status, body: await res.json() };
        },
        async kill() {
          if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
          await exited;
          const i = children.indexOf(child);
          if (i >= 0) children.splice(i, 1);
        },
      };
      children.push(child);
      return child;
    }

    /** Opens the log directly (no server running) and rebuilds an engine from it. */
    async function replay() {
      const store = await log.open();
      const engine = new WorkflowEngine({ policy: buildPolicy(TEST_CONFIG), store, limits: TEST_CONFIG.limits });
      return { store, engine };
    }

    const json = <T>(v: T): T => JSON.parse(JSON.stringify(v));

    test('kill the server mid-task, restart, state is identical', async () => {
      // Agents (simulated here, through the engine) get two tasks under way.
      const seed = await replay();
      registerTestAgents(seed.engine);
      const goal = must(seed.engine.createGoal('Ship the release', 100_000));
      const [build, mail] = must(
        seed.engine.submitPlan(goal.id, 'ava', [
          { key: 'build', title: 'Build it', acceptanceCriteria: ['Builds'], ownerId: 'kai', requiredTools: ['repo.read'], costEstimateTokens: 5_000 },
          { key: 'mail', title: 'Announce it', acceptanceCriteria: ['Clear'], ownerId: 'omar', requiredTools: ['email.send'], costEstimateTokens: 5_000 },
        ]),
      );
      must(seed.engine.start(build.id, 'kai'));
      must(seed.engine.recordStep(build.id, 'kai', 1_200));
      assert.equal(must(seed.engine.requestToolCall(build.id, 'kai', { tool: 'repo.read', input: { path: 'README.md' }, idempotencyKey: 'read-1' })).kind, 'allow');
      must(seed.engine.start(mail.id, 'omar'));
      must(seed.engine.submitForReview(mail.id, 'omar', { summary: 'Draft', selfCheck: allMet(mail.acceptanceCriteria), finalAction: { tool: 'email.send', input: { to: 'all' }, idempotencyKey: 'mail-1' } }));
      must(seed.engine.recordReview(mail.id, 'rex', { passed: true, score: 0.9, feedback: '' }));
      await seed.store.close();

      // The CEO works through the API, then the server dies without warning.
      const first = await startServer();
      assert.equal((await first.call('POST', '/agents/omar/pause')).status, 200);
      assert.equal((await first.call('POST', '/goals', { text: 'Second goal', budgetTokens: 10_000 })).status, 201);
      const before = (await first.call('GET', '/state')).body;
      assert.equal(before.tasks.find((t: any) => t.id === build.id).state, 'working');
      assert.equal(before.tasks.find((t: any) => t.id === build.id).steps, 1);
      // The repo.read allowed before the crash never recorded a result: boot records it as interrupted.
      const lost = (await first.call('GET', '/events')).body.filter((e: any) => e.type === 'tool.failed');
      assert.deepEqual(lost.map((e: any) => e.data.idempotencyKey), ['read-1']);
      assert.match(lost[0].data.detail, /interrupted by a restart/);
      await first.kill();

      // A new process rebuilds from the log and sees exactly the same company.
      const second = await startServer();
      const after = (await second.call('GET', '/state')).body;
      assert.deepEqual(after, before);

      // It carries on: the approval made before the crash can now be decided.
      assert.deepEqual((await second.call('POST', `/tasks/${mail.id}/approval`, { approved: true })).body, { state: 'done' });
      const final = (await second.call('GET', '/state')).body;
      await second.kill();

      // The log alone reproduces that state, and idempotency keys survive restarts.
      const check = await replay();
      assert.deepEqual(json(snapshot(check.engine)), final);
      assert.equal(must(check.engine.requestToolCall(build.id, 'kai', { tool: 'repo.read', input: { path: 'other' }, idempotencyKey: 'read-1' })).kind, 'duplicate');
      assert.equal(check.engine.decideApproval(mail.id, { approved: true }).ok, false);
      await check.store.close({ flush: false });
    });

    test('every acknowledged command survives a kill in the middle of a burst', async () => {
      const first = await startServer();
      const acked: string[] = [];
      let reached!: () => void;
      const enough = new Promise<void>((r) => (reached = r));
      let cut = 0;
      // Eight clients send goals back to back until the server dies, so the
      // kill always lands while requests are in flight.
      const clients = Array.from({ length: 8 }, async (_, c) => {
        for (let i = 0; ; i++) {
          try {
            const r = await first.call('POST', '/goals', { text: `client ${c} goal ${i}`, budgetTokens: 1_000 });
            if (r.status !== 201) throw new Error(`status ${r.status}`);
            acked.push(r.body.id);
            if (acked.length === 50) reached();
          } catch {
            cut += 1;
            return;
          }
        }
      });
      await enough;
      await first.kill();
      await Promise.all(clients);
      assert.equal(cut, 8, 'every client should have been cut off by the kill');

      const second = await startServer();
      const state = (await second.call('GET', '/state')).body;
      await second.kill();
      // A 201 is only sent once the goal is durable, so none may be missing.
      const goalIds = new Set(state.goals.map((g: any) => g.id));
      for (const id of acked) assert.ok(goalIds.has(id), `acknowledged goal ${id} was lost`);

      const check = await replay();
      assert.deepEqual(json(snapshot(check.engine)), state);
      assert.deepEqual(check.store.all().map((e) => e.seq), Array.from({ length: check.store.size }, (_, i) => i + 1));
      await check.store.close({ flush: false });
    });
  });
}
