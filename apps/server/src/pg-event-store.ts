import pg from 'pg';
import type { EngineEvent } from '@ai-company/core';
import { BufferedEventStore } from './buffered-store.ts';

export interface PostgresStoreOptions {
  connectionString: string;
  /** Postgres schema holding the `events` table. Default `public`. */
  schema?: string;
  /** How long to wait for the single-writer lock (e.g. while an old server shuts down). Default 10 s. */
  lockTimeoutMs?: number;
}

const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/;
const INSERT_CHUNK = 1000;

/**
 * Append-only event log in Postgres.
 *
 * - `seq` is the event's identity: the primary key, assigned by this store,
 *   contiguous from 1. The table rejects UPDATE, DELETE and TRUNCATE.
 * - One writer at a time: the store holds a session advisory lock for its
 *   whole life, so a second server cannot interleave events.
 * - All events are loaded into memory on open, so the engine can rebuild
 *   synchronously; `append` is synchronous and `flush` writes the pending
 *   events in one transaction.
 * - A failed write poisons the store: memory is now ahead of the database,
 *   so the only safe move is to restart and rebuild from the log.
 */
export class PostgresEventStore extends BufferedEventStore {
  private readonly client: pg.Client;
  private readonly table: string;
  private chain: Promise<void> = Promise.resolve();

  private constructor(client: pg.Client, table: string, events: EngineEvent[]) {
    super(events);
    this.client = client;
    this.table = table;
    // A dropped connection also drops the single-writer lock, so this store
    // must never write again. Poison it; the next flush reports the failure
    // and the server goes fatal (instead of an unhandled 'error' crash).
    client.on('error', (err) => this.fail(err));
  }

  static async open(options: PostgresStoreOptions): Promise<PostgresEventStore> {
    const schema = options.schema ?? 'public';
    if (!SCHEMA_NAME.test(schema)) throw new Error(`invalid schema name "${schema}"`);
    const client = new pg.Client({ connectionString: options.connectionString });
    // Until the store exists, a connection error surfaces through the awaited query.
    const early = (_err: Error) => {};
    client.on('error', early);
    await client.connect();
    try {
      await acquireLock(client, schema, options.lockTimeoutMs ?? 10_000);
      await migrate(client, schema);
      const table = `${schema}.events`;
      const { rows } = await client.query(`SELECT seq, at, type, goal_id, task_id, agent_id, data FROM ${table} ORDER BY seq`);
      const store = new PostgresEventStore(client, table, rows.map(fromRow));
      client.off('error', early);
      return store;
    } catch (err) {
      await client.end().catch(() => {});
      throw err;
    }
  }

  flush(): Promise<void> {
    // Writes run one at a time, in order. After a failure every later flush
    // rejects with "event store failed" (writePending checks `failure`).
    this.chain = this.chain.catch(() => {}).then(() => this.writePending());
    return this.chain;
  }

  async close(options: { flush?: boolean } = {}): Promise<void> {
    if (this.closed) return;
    try {
      if (options.flush !== false && !this.failure) await this.flush();
    } finally {
      this.closed = true;
      await this.client.end().catch(() => {});
    }
  }

  private async writePending(): Promise<void> {
    this.assertWritable();
    const batch = this.takePending();
    if (batch.length === 0) return;
    try {
      await this.client.query('BEGIN');
      for (let i = 0; i < batch.length; i += INSERT_CHUNK) {
        await this.insert(batch.slice(i, i + INSERT_CHUNK));
      }
      await this.client.query('COMMIT');
    } catch (err) {
      const failure = this.fail(err);
      await this.client.query('ROLLBACK').catch(() => {});
      throw failure;
    }
    this.committed(batch);
  }

  private async insert(rows: EngineEvent[]): Promise<void> {
    const params: unknown[] = [];
    const values = rows.map((e) => {
      const base = params.length;
      params.push(e.seq, e.at, e.type, e.goalId ?? null, e.taskId ?? null, e.agentId ?? null, e.data === undefined ? null : JSON.stringify(e.data));
      return `(${[1, 2, 3, 4, 5, 6, 7].map((n) => `$${base + n}`).join(', ')})`;
    });
    await this.client.query(
      `INSERT INTO ${this.table} (seq, at, type, goal_id, task_id, agent_id, data) VALUES ${values.join(', ')}`,
      params,
    );
  }
}

async function acquireLock(client: pg.Client, schema: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { rows } = await client.query(`SELECT pg_try_advisory_lock(hashtext($1)) AS ok`, [`ai-company:${schema}.events`]);
    if (rows[0].ok) return;
    if (Date.now() >= deadline) throw new Error(`another server holds the event log for schema "${schema}"`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

async function migrate(client: pg.Client, schema: string): Promise<void> {
  await client.query(`
    CREATE SCHEMA IF NOT EXISTS ${schema};
    CREATE TABLE IF NOT EXISTS ${schema}.events (
      seq         bigint PRIMARY KEY CHECK (seq > 0),
      at          bigint NOT NULL,
      type        text   NOT NULL,
      goal_id     text,
      task_id     text,
      agent_id    text,
      data        json,
      recorded_at timestamptz NOT NULL DEFAULT now()
    );
    -- Older versions used jsonb, which rejects NUL characters and reorders keys.
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = '${schema}' AND table_name = 'events' AND column_name = 'data' AND data_type = 'jsonb') THEN
        ALTER TABLE ${schema}.events ALTER COLUMN data TYPE json USING data::json;
      END IF;
    END $$;
    CREATE INDEX IF NOT EXISTS events_goal_idx ON ${schema}.events (goal_id) WHERE goal_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS events_task_idx ON ${schema}.events (task_id) WHERE task_id IS NOT NULL;
    CREATE OR REPLACE FUNCTION ${schema}.events_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'events table is append-only'; END
    $$;
    CREATE OR REPLACE TRIGGER events_no_update_delete BEFORE UPDATE OR DELETE ON ${schema}.events
      FOR EACH ROW EXECUTE FUNCTION ${schema}.events_append_only();
    CREATE OR REPLACE TRIGGER events_no_truncate BEFORE TRUNCATE ON ${schema}.events
      FOR EACH STATEMENT EXECUTE FUNCTION ${schema}.events_append_only();
  `);
}

function fromRow(r: { seq: string; at: string; type: string; goal_id: string | null; task_id: string | null; agent_id: string | null; data: Record<string, unknown> | null }): EngineEvent {
  const e: EngineEvent = { seq: Number(r.seq), at: Number(r.at), type: r.type };
  if (r.goal_id !== null) e.goalId = r.goal_id;
  if (r.task_id !== null) e.taskId = r.task_id;
  if (r.agent_id !== null) e.agentId = r.agent_id;
  if (r.data !== null) e.data = r.data;
  return Object.freeze(e);
}
