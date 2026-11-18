import { mkdirSync } from 'node:fs';
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
 * - `seq` is the primary key, contiguous from 1. Triggers reject UPDATE and
 *   DELETE (SQLite has no TRUNCATE; DELETE without WHERE fires the trigger).
 * - One writer per file: the connection runs in EXCLUSIVE locking mode and
 *   takes the write lock on open, so no other connection or process can even
 *   read the file until this store closes or the process dies.
 * - Writes are synchronous. `append` buffers in memory; `flush` commits every
 *   pending event in one transaction (synchronous=FULL, F_FULLFSYNC on macOS)
 *   before it returns. A command's events therefore commit together or not at
 *   all, and a command that throws writes nothing (the server aborts the store).
 * - Event data is stored as JSON text, so key order and every string survive.
 */
export class SqliteEventStore extends BufferedEventStore {
  private readonly db: Database.Database;
  private readonly writeBatch: (batch: EngineEvent[]) => void;

  private constructor(db: Database.Database, events: EngineEvent[]) {
    super(events);
    this.db = db;
    const insert = db.prepare('INSERT INTO events (seq, at, type, goal_id, task_id, agent_id, data) VALUES (?, ?, ?, ?, ?, ?, ?)');
    this.writeBatch = db.transaction((batch: EngineEvent[]) => {
      for (const e of batch) {
        insert.run(e.seq, e.at, e.type, e.goalId ?? null, e.taskId ?? null, e.agentId ?? null, e.data === undefined ? null : JSON.stringify(e.data));
      }
    });
  }

  static open(options: SqliteStoreOptions): SqliteEventStore {
    mkdirSync(dirname(options.path), { recursive: true });
    const db = new Database(options.path, { timeout: options.lockTimeoutMs ?? 10_000 });
    try {
      // Exclusive locking must be set before the first WAL access, so no
      // shared-memory index is used and the lock is never released.
      db.pragma('locking_mode = EXCLUSIVE');
      try {
        db.exec('BEGIN EXCLUSIVE');
      } catch (err) {
        if ((err as { code?: string }).code === 'SQLITE_BUSY') throw new Error(`another server holds the event log at ${options.path}`);
        throw err;
      }
      db.exec(SCHEMA);
      db.exec('COMMIT');
      db.pragma('journal_mode = WAL');
      db.pragma('synchronous = FULL');
      db.pragma('fullfsync = ON');
      db.pragma('checkpoint_fullfsync = ON');
      const rows = db.prepare('SELECT seq, at, type, goal_id, task_id, agent_id, data FROM events ORDER BY seq').all() as Row[];
      return new SqliteEventStore(db, rows.map(fromRow));
    } catch (err) {
      db.close();
      throw err;
    }
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
