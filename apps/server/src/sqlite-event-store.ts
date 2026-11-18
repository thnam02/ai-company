import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type { EngineEvent } from '@ai-company/core';
import { BufferedEventStore } from './buffered-store.ts';

export interface SqliteStoreOptions {
  /** Path of the database file. Its directory is created if missing. */
  path: string;
  /** How long to wait for the single-writer lock (e.g. while an old server shuts down). Default 10 s. */
  lockTimeoutMs?: number;
}

interface Row {
  seq: number;
  at: number;
  type: string;
  goal_id: string | null;
  task_id: string | null;
  agent_id: string | null;
  data: string | null;
}

/**
 * Append-only event log in a local SQLite file: the default store for the
 * desktop app, with the same guarantees as the Postgres store (ADR 0002).
 *
 * - `seq` is the primary key, contiguous from 1. Triggers reject UPDATE,
 *   DELETE and INSERT OR REPLACE (SQLite has no TRUNCATE; DELETE without
 *   WHERE fires the trigger).
 * - One writer per file: the store holds an exclusive lock on a sidecar
 *   `<file>.lock` that nothing else opens, and its connection to the log runs
 *   in EXCLUSIVE locking mode, so other processes cannot even read the log.
 *   Both are held until the store closes or the process dies. Never open the
 *   log file any other way from the server process: on POSIX, closing any
 *   descriptor on it drops the process's lock on it (the sidecar still keeps
 *   a second server out). Back up with the server stopped.
 * - Writes are synchronous. `append` buffers in memory; `flush` commits every
 *   pending event in one transaction (synchronous=FULL, F_FULLFSYNC on macOS)
 *   before it returns. A command's events therefore commit together or not at
 *   all, and a command that throws writes nothing (the server aborts the store).
 * - Event data is stored as JSON text, so key order and every string survive.
 */
export class SqliteEventStore extends BufferedEventStore {
  /** True when this open created the log (a new, empty company). */
  readonly created: boolean;
  private readonly db: Database.Database;
  private readonly lock: Database.Database;
  private readonly writeBatch: (batch: EngineEvent[]) => void;

  private constructor(db: Database.Database, lock: Database.Database, events: EngineEvent[], created: boolean) {
    super(events);
    this.db = db;
    this.lock = lock;
    this.created = created;
    const insert = db.prepare('INSERT INTO events (seq, at, type, goal_id, task_id, agent_id, data) VALUES (?, ?, ?, ?, ?, ?, ?)');
    this.writeBatch = db.transaction((batch: EngineEvent[]) => {
      for (const e of batch) {
        insert.run(e.seq, e.at, e.type, e.goalId ?? null, e.taskId ?? null, e.agentId ?? null, e.data === undefined ? null : JSON.stringify(e.data));
      }
    });
  }

  static open(options: SqliteStoreOptions): SqliteEventStore {
    const { path } = options;
    const timeout = options.lockTimeoutMs ?? 10_000;
    // Private: the log holds the company's whole history.
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const created = !existsSync(path);
    const opened: Database.Database[] = [];
    try {
      // POSIX locks belong to the whole process, and closing *any* descriptor
      // on a file drops them. Anything else in this process that opens and
      // closes company.db (a backup, a diagnostic) would silently release
      // SQLite's lock on it. So the single-writer guarantee rests first on a
      // sidecar lock file that nothing else ever opens.
      const lock = new Database(`${path}.lock`, { timeout });
      opened.push(lock);
      holdExclusive(lock, path, 'CREATE TABLE IF NOT EXISTS writer (note TEXT)');

      const db = new Database(path, { timeout });
      opened.push(db);
      // Durability settings first, so even the very first commit is fully synced.
      db.pragma('synchronous = FULL');
      db.pragma('fullfsync = ON');
      db.pragma('checkpoint_fullfsync = ON');
      // Exclusive locking must be set before the first WAL access, so no
      // shared-memory index is used and the lock is kept while the store is open.
      holdExclusive(db, path, SCHEMA);
      const mode = db.pragma('journal_mode = WAL', { simple: true });
      if (mode !== 'wal') throw new Error(`could not switch the event log to WAL mode (got "${String(mode)}")`);
      // better-sqlite3 builds with WAL synchronous=NORMAL as the default; keep FULL.
      db.pragma('synchronous = FULL');
      const rows = db.prepare('SELECT seq, at, type, goal_id, task_id, agent_id, data FROM events ORDER BY seq').all() as Row[];
      return new SqliteEventStore(db, lock, rows.map(fromRow), created);
    } catch (err) {
      for (const db of opened.reverse()) db.close();
      throw err;
    }
  }

  /** The SQLite settings the guarantees rest on, read back from the connection. */
  settings(): { journalMode: string; lockingMode: string; synchronous: number; fullfsync: number; checkpointFullfsync: number } {
    const get = (name: string) => this.db.pragma(name, { simple: true });
    return {
      journalMode: String(get('journal_mode')),
      lockingMode: String(get('locking_mode')),
      synchronous: Number(get('synchronous')),
      fullfsync: Number(get('fullfsync')),
      checkpointFullfsync: Number(get('checkpoint_fullfsync')),
    };
  }

  flush(): Promise<void> {
    try {
      this.writePending();
      return Promise.resolve();
    } catch (err) {
      return Promise.reject(err);
    }
  }

  async close(options: { flush?: boolean } = {}): Promise<void> {
    if (this.closed) return;
    try {
      if (options.flush !== false && !this.failure) this.writePending();
    } finally {
      this.closed = true;
      this.db.close();
      // Last: the log stays guarded until its own connection is gone.
      this.lock.close();
    }
  }

  private writePending(): void {
    this.assertWritable();
    const batch = this.takePending();
    if (batch.length === 0) return;
    try {
      // Commits before it returns; rolls back on any error.
      this.writeBatch(batch);
    } catch (err) {
      throw this.fail(err);
    }
    this.committed(batch);
  }
}

/** Puts `db` in EXCLUSIVE locking mode and takes the write lock, which it then keeps until closed. */
function holdExclusive(db: Database.Database, path: string, sql: string): void {
  db.pragma('locking_mode = EXCLUSIVE');
  try {
    db.exec('BEGIN EXCLUSIVE');
  } catch (err) {
    if ((err as { code?: string }).code === 'SQLITE_BUSY') throw new Error(`another server holds the event log at ${path}`);
    throw err;
  }
  db.exec(sql);
  db.exec('COMMIT');
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS events (
    seq         INTEGER PRIMARY KEY CHECK (seq > 0),
    at          INTEGER NOT NULL,
    type        TEXT    NOT NULL,
    goal_id     TEXT,
    task_id     TEXT,
    agent_id    TEXT,
    data        TEXT,
    recorded_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ) STRICT;
  CREATE INDEX IF NOT EXISTS events_goal_idx ON events (goal_id) WHERE goal_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS events_task_idx ON events (task_id) WHERE task_id IS NOT NULL;
  CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events
    BEGIN SELECT RAISE(ABORT, 'events table is append-only'); END;
  CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events
    BEGIN SELECT RAISE(ABORT, 'events table is append-only'); END;
  -- INSERT OR REPLACE deletes the old row without firing DELETE triggers.
  CREATE TRIGGER IF NOT EXISTS events_no_replace BEFORE INSERT ON events
    WHEN EXISTS (SELECT 1 FROM events WHERE seq = NEW.seq)
    BEGIN SELECT RAISE(ABORT, 'events table is append-only'); END;
`;

function fromRow(r: Row): EngineEvent {
  const e: EngineEvent = { seq: r.seq, at: r.at, type: r.type };
  if (r.goal_id !== null) e.goalId = r.goal_id;
  if (r.task_id !== null) e.taskId = r.task_id;
  if (r.agent_id !== null) e.agentId = r.agent_id;
  if (r.data !== null) e.data = JSON.parse(r.data);
  return Object.freeze(e);
}
