import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { closeSync, existsSync, mkdtempSync, openSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { WorkflowEngine } from '@ai-company/core';
import { SqliteEventStore } from '../src/sqlite-event-store.ts';
import { createCompanyServer } from '../src/app.ts';
import { boot } from '../src/boot.ts';
import { TEST_CONFIG, makePolicy, registerTestAgents } from './helpers.ts';

const SERVER_DIR = fileURLToPath(new URL('..', import.meta.url));
const STORE_URL = new URL('../src/sqlite-event-store.ts', import.meta.url).href;

describe('SqliteEventStore', () => {
  let dir: string;
  let path: string;
  const open = (opts: { lockTimeoutMs?: number } = {}) => SqliteEventStore.open({ path, ...opts });
  /** A raw connection to the file, for setting up or inspecting it while no store is open. */
  const raw = <T>(fn: (db: Database.Database) => T): T => {
    const db = new Database(path);
    try {
      return fn(db);
    } finally {
      db.close();
    }
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ai-company-sqlite-'));
    path = join(dir, 'nested', 'data', 'company.db');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('creates the data directory, and events are durable after flush and reload in order', async () => {
    const store = open();
    assert.ok(existsSync(path));
    const a = store.append({ type: 'x.one', at: 1, goalId: 'g1', data: { n: 1 } });
    const b = store.append({ type: 'x.two', at: 2, taskId: 't1', agentId: 'kai' });
    assert.deepEqual([a.seq, b.seq], [1, 2]);
    assert.equal(store.durableSeq, 0);
    await store.flush();
    assert.equal(store.durableSeq, 2);
    await store.close();

    const reopened = open();
    assert.deepEqual(reopened.all(), [
      { seq: 1, at: 1, type: 'x.one', goalId: 'g1', data: { n: 1 } },
      { seq: 2, at: 2, type: 'x.two', taskId: 't1', agentId: 'kai' },
    ]);
    assert.equal(reopened.durableSeq, 2);
    assert.equal(reopened.append({ type: 'x.three', at: 3 }).seq, 3);
    await reopened.close();
  });

  test('events not flushed before close are lost, never half-written', async () => {
    const store = open();
    store.append({ type: 'kept', at: 1 });
    await store.flush();
    store.append({ type: 'lost', at: 2 });
    store.append({ type: 'also.lost', at: 3 });
    await store.close({ flush: false });

    const reopened = open();
    assert.deepEqual(reopened.all().map((e) => e.type), ['kept']);
    await reopened.close();
  });

  test('subscribers only see events once they are committed', async () => {
    const store = open();
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
    const store = open();
    store.append({ type: 'a', at: 1 });
    await store.close();
    raw((db) => {
      assert.throws(() => db.exec(`UPDATE events SET type = 'b'`), /append-only/);
      assert.throws(() => db.exec(`DELETE FROM events WHERE seq = 1`), /append-only/);
      assert.throws(() => db.exec(`DELETE FROM events`), /append-only/);
      assert.throws(() => db.exec(`INSERT OR REPLACE INTO events (seq, at, type) VALUES (1, 9, 'replaced')`), /append-only|constraint/i);
      assert.equal((db.prepare('SELECT type FROM events').get() as { type: string }).type, 'a');
    });
  });

  test('only one writer may hold the file, in this process', async () => {
    const first = open();
    assert.throws(() => open({ lockTimeoutMs: 200 }), /another server holds the event log/);
    await first.close();
    const second = open({ lockTimeoutMs: 200 });
    await second.close();
  });

  test('only one writer may hold the file, across processes', async () => {
    const store = open();
    store.append({ type: 'a', at: 1 });
    await store.flush();
    // Another process cannot even read the file while the server holds it.
    const script = `
      const Database = require('better-sqlite3');
      const db = new Database(process.argv[1], { timeout: 200 });
      try { db.prepare('SELECT count(*) AS n FROM events').get(); console.log('READ'); }
      catch (e) { console.log(e.code); }
    `;
    const tryRead = () => spawnSync(process.execPath, ['-e', script, path], { cwd: SERVER_DIR, encoding: 'utf8' });
    const busy = tryRead();
    assert.equal(busy.stdout.trim(), 'SQLITE_BUSY', busy.stderr);
    await store.close();
    const free = tryRead();
    assert.equal(free.stdout.trim(), 'READ', free.stderr);
    // Reopening a file that is already in WAL mode takes the lock again.
    const reopened = open();
    assert.equal(tryRead().stdout.trim(), 'SQLITE_BUSY');
    await reopened.close();
  });

  test('a second server is refused even after something in this process opens and closes the file', async () => {
    // POSIX locks belong to the process: closing any descriptor on company.db
    // drops SQLite's lock on it. The sidecar lock file must still refuse a
    // second server.
    const store = open();
    store.append({ type: 'a', at: 1 });
    await store.flush();
    closeSync(openSync(path, 'r'));
    const script = `
      import { SqliteEventStore } from ${JSON.stringify(STORE_URL)};
      try { SqliteEventStore.open({ path: process.argv[1], lockTimeoutMs: 200 }); console.log('OPENED'); }
      catch (e) { console.log(e.message); }
    `;
    const second = spawnSync(process.execPath, ['--input-type=module', '-e', script, path], { cwd: SERVER_DIR, encoding: 'utf8' });
    assert.match(second.stdout, /another server holds the event log/, second.stderr);
    store.append({ type: 'b', at: 2 });
    await store.flush();
    await store.close();
    const reopened = open();
    assert.deepEqual(reopened.all().map((e) => e.type), ['a', 'b']);
    await reopened.close();
  });

  test('runs with WAL, exclusive locking and full fsync, in a private directory', async () => {
    const store = open();
    assert.deepEqual(store.settings(), { journalMode: 'wal', lockingMode: 'exclusive', synchronous: 2, fullfsync: 1, checkpointFullfsync: 1 });
    assert.equal(statSync(dirname(path)).mode & 0o777, 0o700);
    await store.close();
  });

  test('a command that throws inside run() writes nothing', async () => {
    const store = open();
    const engine = new WorkflowEngine({ policy: makePolicy(), store });
    const fatal: Error[] = [];
    const server = createCompanyServer({ engine, store, ceoToken: 'x'.repeat(16), onFatal: (e) => fatal.push(e), log: () => {} });
    await server.run(() => registerTestAgents(engine));
    const size = store.size;
    await assert.rejects(
      server.run(() => {
        engine.createGoal('half done', 1_000);
        throw new Error('bug after append');
      }),
      /bug after append/,
    );
    assert.equal(fatal.length, 1);
    await server.close();
    await store.close();
    const reopened = open();
    assert.equal(reopened.size, size);
    await reopened.close();
  });

  test('a failed boot releases the event log', async () => {
    const configPath = join(dir, 'company.json');
    writeFileSync(configPath, JSON.stringify(TEST_CONFIG));
    const blocker = createServer().listen(0, '127.0.0.1');
    await once(blocker, 'listening');
    const port = (blocker.address() as AddressInfo).port;
    const config = { store: { kind: 'sqlite' as const, path }, ceoToken: 'x'.repeat(16), host: '127.0.0.1', port, companyConfigPath: configPath };
    await assert.rejects(boot(config, { onFatal: () => {} }), /EADDRINUSE/);
    blocker.close();
    const running = await boot({ ...config, port: 0 }, { onFatal: () => {} });
    await running.stop();
  });

  test('a failed write rolls back the whole batch and poisons the store', async () => {
    // Make the database refuse one event, as a full disk or I/O error would.
    await open().close();
    raw((db) => db.exec(`CREATE TRIGGER refuse BEFORE INSERT ON events WHEN NEW.type = 'boom' BEGIN SELECT RAISE(ABORT, 'disk on fire'); END`));
    const store = open();
    store.append({ type: 'kept', at: 1 });
    await store.flush();
    const failed = new Promise<Error>((resolve) => store.onFailure(resolve));
    store.append({ type: 'fine', at: 2 });
    store.append({ type: 'boom', at: 3 });
    await assert.rejects(store.flush(), /disk on fire/);
    assert.match((await failed).message, /disk on fire/);
    assert.equal(store.durableSeq, 1);
    assert.throws(() => store.append({ type: 'later', at: 4 }), /event store failed/);
    await assert.rejects(store.flush(), /event store failed/);
    await store.close({ flush: false });

    const reopened = open();
    assert.deepEqual(reopened.all().map((e) => e.type), ['kept'], 'the batch with the refused event must not be half-written');
    await reopened.close();
  });

  test('abort drops pending events and stops all later writes', async () => {
    const store = open();
    store.append({ type: 'first', at: 1 });
    await store.flush();
    store.append({ type: 'half.done', at: 2 });
    store.abort(new Error('command threw'));
    await assert.rejects(store.flush(), /event store failed: command threw/);
    assert.throws(() => store.append({ type: 'later', at: 3 }), /event store failed/);
    await store.close();
    const reopened = open();
    assert.deepEqual(reopened.all().map((e) => e.type), ['first']);
    await reopened.close();
  });

  test('refuses to load a log with a gap in seq', async () => {
    await open().close();
    raw((db) => db.exec(`INSERT INTO events (seq, at, type) VALUES (1, 1, 'a'), (3, 3, 'c')`));
    assert.throws(() => open(), /gap in event log/);
    // A refused open must release the file.
    raw((db) => assert.equal((db.prepare('SELECT count(*) AS n FROM events').get() as { n: number }).n, 2));
  });

  test('stores any JSON string exactly: NUL, lone surrogates, key order', async () => {
    const store = open();
    const data = { z: 'a\u0000b', a: 'lone \ud800 surrogate', nested: { y: 1, b: [2, { k: 'v' }] } };
    store.append({ type: 'weird', at: 1, data });
    await store.flush();
    await store.close();
    const reopened = open();
    const [event] = reopened.all();
    assert.deepEqual(event.data, data);
    assert.deepEqual(Object.keys(event.data!), ['z', 'a', 'nested']);
    await reopened.close();
  });

  test('an engine rebuilt on boot has identical state', async () => {
    const store = open();
    const engine = new WorkflowEngine({ policy: makePolicy(), store });
    registerTestAgents(engine);
    assert.ok(engine.createGoal('Ship', 50_000).ok);
    await store.flush();
    const before = { tasks: engine.listTasks(), agents: engine.listAgents(), goals: engine.listGoals() };
    await store.close();

    const reopened = open();
    const rebuilt = new WorkflowEngine({ policy: makePolicy(), store: reopened });
    assert.deepEqual({ tasks: rebuilt.listTasks(), agents: rebuilt.listAgents(), goals: rebuilt.listGoals() }, before);
    const size = reopened.size;
    registerTestAgents(rebuilt);
    assert.equal(reopened.size, size, 'an unchanged config emits no agent events');
    await reopened.close();
  });
});
