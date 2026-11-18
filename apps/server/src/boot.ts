import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkflowEngine, type ProposedAction } from '@ai-company/core';
import { createCompanyServer, type CompanyServer } from './app.ts';
import { bootstrapAgents, buildPolicy, loadCompanyConfig } from './company.ts';
import type { DurableEventStore } from './durable-store.ts';
import { PostgresEventStore } from './pg-event-store.ts';
import { SqliteEventStore } from './sqlite-event-store.ts';
import { startStuckTimer } from './stuck-timer.ts';

/** Where the event log lives: a local SQLite file by default, Postgres when DATABASE_URL is set. */
export type StoreConfig = { kind: 'sqlite'; path: string } | { kind: 'postgres'; databaseUrl: string; schema: string };

export interface BootConfig {
  store: StoreConfig;
  ceoToken: string;
  host: string;
  port: number;
  companyConfigPath: string;
}

export const DEFAULT_COMPANY_CONFIG = fileURLToPath(new URL('../config/company.json', import.meta.url));

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): BootConfig {
  const ceoToken = env.CEO_TOKEN;
  if (!ceoToken) throw new Error('CEO_TOKEN is required');
  if (ceoToken.length < 16) throw new Error('CEO_TOKEN must be at least 16 characters');
  const port = Number(env.PORT ?? 4100);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be a port number');
  const store: StoreConfig = env.DATABASE_URL
    ? { kind: 'postgres', databaseUrl: env.DATABASE_URL, schema: env.DB_SCHEMA || 'public' }
    : { kind: 'sqlite', path: resolve(env.DATA_DIR || 'data', 'company.db') };
  return {
    store,
    ceoToken,
    host: env.HOST || '127.0.0.1',
    port,
    companyConfigPath: env.COMPANY_CONFIG || DEFAULT_COMPANY_CONFIG,
  };
}

export interface RunningServer {
  /**
   * Engine commands go through `server.run`, and callers act only after it
   * resolves. The raw engine is deliberately not exposed: acting on a
   * `tool.allowed` before it is durable could run a tool twice after a crash.
   */
  server: CompanyServer;
  url: string;
  stop(): Promise<void>;
}

export async function openStore(config: StoreConfig): Promise<DurableEventStore> {
  return config.kind === 'sqlite'
    ? SqliteEventStore.open({ path: config.path })
    : PostgresEventStore.open({ connectionString: config.databaseUrl, schema: config.schema });
}

/**
 * Boot sequence: load config → take the event-log lock → replay every event
 * into a fresh engine → register any new agents → start the stuck timer →
 * listen. State comes only from the log, so a restart after a crash ends up
 * exactly where the last durable event left it.
 */
export async function boot(config: BootConfig, hooks: { onExecute?: (action: ProposedAction, ctx: { taskId: string }) => void; onFatal?: (err: Error) => void } = {}): Promise<RunningServer> {
  const log = (m: string) => console.error(`[server] ${m}`);
  const company = loadCompanyConfig(config.companyConfigPath);
  const store = await openStore(config.store);
  const engine = new WorkflowEngine({ policy: buildPolicy(company), store, limits: company.limits });
  // Never log the database URL: it can carry a password.
  log(`event store: ${config.store.kind === 'sqlite' ? `SQLite at ${config.store.path}` : `Postgres, schema "${config.store.schema}"`}`);
  log(`replayed ${store.size} events`);

  const server = createCompanyServer({
    engine,
    store,
    ceoToken: config.ceoToken,
    log,
    onExecute: hooks.onExecute,
    onFatal: hooks.onFatal ?? (() => process.exit(1)),
  });

  // Throwing inside `run` makes the failure fatal before anything is flushed,
  // so a bootstrap that fails halfway leaves the log untouched.
  const report = await server.run(() => {
    const r = bootstrapAgents(engine, company);
    if (!r.ok) throw new Error(r.error);
    return r.value;
  });
  if (report.registered.length) log(`registered agents: ${report.registered.join(', ')}`);
  if (report.updated.length) log(`updated agents from config: ${report.updated.join(', ')}`);
  if (report.retired.length) log(`retired agents (not in config; tools revoked, paused): ${report.retired.join(', ')}`);

  const stopTimer = startStuckTimer({ run: server.run, engine, log });
  await new Promise<void>((resolve, reject) => {
    server.http.once('error', reject);
    server.http.listen(config.port, config.host, () => resolve());
  });
  const address = server.http.address();
  const port = typeof address === 'object' && address ? address.port : config.port;

  return {
    server,
    url: `http://${config.host}:${port}`,
    async stop() {
      stopTimer();
      await server.close();
      await store.close({ flush: !server.failed });
    },
  };
}
