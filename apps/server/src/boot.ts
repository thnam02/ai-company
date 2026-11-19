import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkflowEngine } from '@ai-company/core';
import { inspect } from 'node:util';
import {
  AgentRuntime,
  ClaudeProvider,
  OllamaProvider,
  ToolRegistry,
  Workspace,
  parseModelRef,
  workspaceTools,
  type AgentModel,
  type AgentView,
  type ModelProvider,
} from '@ai-company/agents';
import { createCompanyServer, type CompanyServer } from './app.ts';
import { bootstrapAgents, buildPolicy, loadCompanyConfig } from './company.ts';
import type { DurableEventStore } from './durable-store.ts';
import { PostgresEventStore } from './pg-event-store.ts';
import { SqliteCheckpointStore } from './sqlite-checkpoint-store.ts';
import { SqliteEventStore } from './sqlite-event-store.ts';
import { startStuckTimer } from './stuck-timer.ts';

/** Where the event log lives: a local SQLite file by default, Postgres when DATABASE_URL is set. */
export type StoreConfig = { kind: 'sqlite'; path: string } | { kind: 'postgres'; databaseUrl: string; schema: string };

/**
 * A credential that cannot be printed by accident: logging, JSON or inspect
 * show "[secret]". Only the provider that needs it calls `reveal()` (invariant 6).
 */
export class Secret {
  readonly #value: string;
  constructor(value: string) {
    this.#value = value;
  }
  reveal(): string {
    return this.#value;
  }
  toString(): string {
    return '[secret]';
  }
  toJSON(): string {
    return '[secret]';
  }
  [inspect.custom](): string {
    return '[secret]';
  }
}

export interface AgentsConfig {
  /** On by default; AGENTS=off starts the server without agents. With no goals they stay idle, and if Ollama is down they retry with backoff. */
  enabled: boolean;
  /** The only folder agents' file tools can reach. */
  workspaceDir: string;
  ollamaUrl: string;
  /** ANTHROPIC_API_KEY: enables `claude:` models. Optional; the app works without it. */
  anthropicApiKey?: Secret;
}

export interface BootConfig {
  store: StoreConfig;
  /** Local data: the SQLite event log (unless Postgres) and agent checkpoints. */
  dataDir: string;
  agents: AgentsConfig;
  ceoToken: string;
  host: string;
  port: number;
  companyConfigPath: string;
}

export const DEFAULT_COMPANY_CONFIG = fileURLToPath(new URL('../config/company.json', import.meta.url));
/**
 * `<repo>/data` and `<repo>/workspace`, whatever directory the server is
 * started from, so every way of starting it finds the same company. Relative
 * DATA_DIR and WORKSPACE_DIR values resolve against the working directory.
 */
export const DEFAULT_DATA_DIR = fileURLToPath(new URL('../../../data', import.meta.url));
export const DEFAULT_WORKSPACE_DIR = fileURLToPath(new URL('../../../workspace', import.meta.url));

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): BootConfig {
  const ceoToken = env.CEO_TOKEN;
  if (!ceoToken) throw new Error('CEO_TOKEN is required');
  if (ceoToken.length < 16) throw new Error('CEO_TOKEN must be at least 16 characters');
  const port = Number(env.PORT ?? 4100);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be a port number');
  if (env.AGENTS !== undefined && env.AGENTS !== 'on' && env.AGENTS !== 'off') throw new Error('AGENTS must be "on" or "off"');
  const dataDir = resolve(env.DATA_DIR || DEFAULT_DATA_DIR);
  const store: StoreConfig = env.DATABASE_URL
    ? { kind: 'postgres', databaseUrl: env.DATABASE_URL, schema: env.DB_SCHEMA || 'public' }
    : { kind: 'sqlite', path: join(dataDir, 'company.db') };
  const workspaceDir = resolve(env.WORKSPACE_DIR || DEFAULT_WORKSPACE_DIR);
  const companyConfigPath = resolve(env.COMPANY_CONFIG || DEFAULT_COMPANY_CONFIG);
  // Agents' file tools reach everything under the workspace: it must not hold
  // the event log, the checkpoints or the CEO's config (invariant 10).
  if (contains(workspaceDir, dataDir) || contains(dataDir, workspaceDir)) {
    throw new Error(`WORKSPACE_DIR (${workspaceDir}) and DATA_DIR (${dataDir}) must not contain each other`);
  }
  if (contains(workspaceDir, companyConfigPath)) {
    throw new Error(`WORKSPACE_DIR (${workspaceDir}) must not contain the company config (${companyConfigPath})`);
  }
  const anthropicApiKey = env.ANTHROPIC_API_KEY ? new Secret(env.ANTHROPIC_API_KEY) : undefined;
  // Once held in a Secret, the key leaves the environment, so child
  // processes and environment dumps never see it (invariant 6).
  if (env === process.env) delete process.env.ANTHROPIC_API_KEY;
  return {
    store,
    dataDir,
    agents: {
      enabled: env.AGENTS !== 'off',
      workspaceDir,
      ollamaUrl: env.OLLAMA_URL || 'http://127.0.0.1:11434',
      ...(anthropicApiKey ? { anthropicApiKey } : {}),
    },
    ceoToken,
    host: env.HOST || '127.0.0.1',
    port,
    companyConfigPath,
  };
}

/** True when `path` is `dir` or inside it. */
function contains(dir: string, path: string): boolean {
  const rel = relative(dir, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
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

export interface BootHooks {
  onFatal?: (err: Error) => void;
  /** Overrides how agents find their model (tests use scripted models). */
  modelFor?: (agent: AgentView) => AgentModel | undefined;
}

/** Model providers by ref prefix: Ollama always (local), Claude only with an API key. */
export function modelProviders(agents: AgentsConfig): Record<string, ModelProvider> {
  const providers: Record<string, ModelProvider> = { ollama: new OllamaProvider({ baseUrl: agents.ollamaUrl }) };
  if (agents.anthropicApiKey) providers.claude = new ClaudeProvider({ apiKey: agents.anthropicApiKey.reveal() });
  return providers;
}

export async function openStore(config: StoreConfig): Promise<DurableEventStore> {
  return config.kind === 'sqlite'
    ? SqliteEventStore.open({ path: config.path })
    : PostgresEventStore.open({ connectionString: config.databaseUrl, schema: config.schema });
}

/**
 * Boot sequence: load config → take the event-log lock → replay every event
 * into a fresh engine → bring the roster in line with the config → finish or
 * give up on final actions interrupted by a crash → start the stuck timer →
 * listen → start the agents (if enabled). State comes only from the log, so a
 * restart after a crash ends up exactly where the last durable event left it.
 */
export async function boot(config: BootConfig, hooks: BootHooks = {}): Promise<RunningServer> {
  const log = (m: string) => console.error(`[server] ${m}`);
  const company = loadCompanyConfig(config.companyConfigPath);
  const store = await openStore(config.store);
  // Never log the database URL: it can carry a password.
  log(`event store: ${config.store.kind === 'sqlite' ? `SQLite at ${config.store.path}` : `Postgres, schema "${config.store.schema}"`}`);
  if (store instanceof SqliteEventStore && store.created) log('created a new, empty event log (a new company)');

  let server: CompanyServer | undefined;
  let stopTimer: (() => void) | undefined;
  let checkpoints: SqliteCheckpointStore | undefined;
  let runtime: AgentRuntime | undefined;
  try {
    const engine = new WorkflowEngine({ policy: buildPolicy(company), store, limits: company.limits });
    log(`replayed ${store.size} events`);

    // Executors for released final actions, needed even with agents off (a CEO approval releases one).
    const workspace = new Workspace(config.agents.workspaceDir);
    const tools = new ToolRegistry(workspaceTools(workspace));

    server = createCompanyServer({
      engine,
      store,
      ceoToken: config.ceoToken,
      tools,
      log,
      onFatal: hooks.onFatal ?? (() => process.exit(1)),
    });
    const { run, http } = server;

    // Throwing inside `run` makes the failure fatal before anything is flushed,
    // so a bootstrap that fails halfway leaves the log untouched.
    const report = await run(() => {
      const r = bootstrapAgents(engine, company);
      if (!r.ok) throw new Error(r.error);
      return r.value;
    });
    if (report.registered.length) log(`registered agents: ${report.registered.join(', ')}`);
    if (report.updated.length) log(`updated agents from config: ${report.updated.join(', ')}`);
    if (report.retired.length) log(`retired agents (not in config; tools revoked, paused): ${report.retired.join(', ')}`);

    await server.recoverActions();

    stopTimer = startStuckTimer({ run, engine, log });
    await new Promise<void>((resolve, reject) => {
      http.once('error', reject);
      http.listen(config.port, config.host, () => resolve());
    });
    const address = http.address();
    const port = typeof address === 'object' && address ? address.port : config.port;

    if (config.agents.enabled) {
      checkpoints = SqliteCheckpointStore.open({ path: join(config.dataDir, 'agents.db') });
      const providers = modelProviders(config.agents);
      const modelFor =
        hooks.modelFor ??
        ((agent: AgentView): AgentModel | undefined => {
          const ref = parseModelRef(agent.model);
          const provider = ref && providers[ref.provider];
          return provider ? { provider, model: ref.model, options: company.modelOptions[agent.id] } : undefined;
        });
      runtime = new AgentRuntime({
        port: server.agentPort,
        modelFor,
        tools,
        workspace,
        checkpoints,
        roleNotes: company.roleNotes,
        log: (m) => console.error(`[agents] ${m}`),
      });
      runtime.start();
      log(`agents on; workspace ${workspace.root}; model providers: ${Object.keys(providers).join(', ')}`);
    } else {
      log('agents off (AGENTS=off)');
    }

    const running = server;
    const stopTicks = stopTimer;
    const agents = runtime;
    const memory = checkpoints;
    return {
      server: running,
      url: `http://${config.host}:${port}`,
      async stop() {
        await agents?.stop();
        stopTicks();
        await running.close();
        memory?.close();
        await store.close({ flush: !running.failed });
      },
    };
  } catch (err) {
    // Release the log (and its lock) so a retry in this process can open it.
    await runtime?.stop().catch(() => {});
    stopTimer?.();
    await server?.close().catch(() => {});
    checkpoints?.close();
    await store.close({ flush: false }).catch(() => {});
    throw err;
  }
}
