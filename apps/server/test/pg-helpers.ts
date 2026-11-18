import { randomBytes } from 'node:crypto';
import pg from 'pg';

/** Postgres-backed tests run only when DATABASE_URL points at a disposable database. */
export const DATABASE_URL = process.env.DATABASE_URL ?? '';
export const skipWithoutDb: string | false = DATABASE_URL ? false : 'set DATABASE_URL to run Postgres tests';

export interface TestSchema {
  schema: string;
  /** Raw SQL on a separate connection; use schema-qualified names (`${schema}.events`). */
  query: (sql: string, params?: unknown[]) => Promise<pg.QueryResult>;
  drop: () => Promise<void>;
}

/** A fresh schema per test, dropped afterwards, so tests never share an event log. */
export async function freshSchema(): Promise<TestSchema> {
  const schema = `t_${randomBytes(6).toString('hex')}`;
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  await client.query(`CREATE SCHEMA ${schema}`);
  return {
    schema,
    query: (sql, params) => client.query(sql, params),
    drop: async () => {
      await client.query(`DROP SCHEMA ${schema} CASCADE`);
      await client.end();
    },
  };
}
