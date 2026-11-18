import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type { Checkpoint, CheckpointStore } from '@ai-company/agents';

export interface SqliteCheckpointOptions {
  path: string;
  lockTimeoutMs?: number;
}

/**
 * Agents' working memory (ADR 0003): one conversation per task and agent,
 * outside the event log. Losing it is harmless, so writes use
 * synchronous=NORMAL; the file is still locked to one server.
 */
export class SqliteCheckpointStore implements CheckpointStore {
  private readonly db: Database.Database;
  private readonly put: Database.Statement;
  private readonly get: Database.Statement;

  private constructor(db: Database.Database) {
    this.db = db;
    this.put = db.prepare(
      `INSERT INTO checkpoints (task_id, agent_id, run, attempt, messages) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (task_id, agent_id) DO UPDATE SET run = excluded.run, attempt = excluded.attempt, messages = excluded.messages, saved_at = excluded.saved_at`,
    );
    this.get = db.prepare('SELECT run, attempt, messages FROM checkpoints WHERE task_id = ? AND agent_id = ?');
  }

  static open(options: SqliteCheckpointOptions): SqliteCheckpointStore {
    mkdirSync(dirname(options.path), { recursive: true, mode: 0o700 });
    const db = new Database(options.path, { timeout: options.lockTimeoutMs ?? 10_000 });
    try {
      db.pragma('locking_mode = EXCLUSIVE');
      try {
        db.exec('BEGIN EXCLUSIVE');
      } catch (err) {
        if ((err as { code?: string }).code === 'SQLITE_BUSY') throw new Error(`another server holds the checkpoints at ${options.path}`);
        throw err;
      }
      db.exec(`
        CREATE TABLE IF NOT EXISTS checkpoints (
          task_id  TEXT    NOT NULL,
          agent_id TEXT    NOT NULL,
          run      INTEGER NOT NULL,
          attempt  INTEGER NOT NULL,
          messages TEXT    NOT NULL,
          saved_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          PRIMARY KEY (task_id, agent_id)
        ) STRICT;
      `);
      db.exec('COMMIT');
      db.pragma('journal_mode = WAL');
      db.pragma('synchronous = NORMAL');
      return new SqliteCheckpointStore(db);
    } catch (err) {
      db.close();
      throw err;
    }
  }

  load(taskId: string, agentId: string): Checkpoint | undefined {
    const row = this.get.get(taskId, agentId) as { run: number; attempt: number; messages: string } | undefined;
    if (!row) return undefined;
    try {
      return { taskId, agentId, run: row.run, attempt: row.attempt, messages: JSON.parse(row.messages) };
    } catch {
      // A damaged checkpoint only means starting the task's conversation over.
      return undefined;
    }
  }

  save(c: Checkpoint): void {
    this.put.run(c.taskId, c.agentId, c.run, c.attempt, JSON.stringify(c.messages));
  }

  close(): void {
    this.db.close();
  }
}
