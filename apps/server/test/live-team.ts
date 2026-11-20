import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkflowEngine, type Limits } from '@ai-company/core';
import { AgentRuntime, MemoryCheckpointStore, OllamaProvider } from '@ai-company/agents';
import { ToolRegistry, Workspace, workspaceTools } from '@ai-company/gateway';
import { createCompanyServer, type CompanyServer } from '../src/app.ts';
import { bootstrapAgents, buildPolicy, parseCompanyConfig } from '../src/company.ts';
import { MemoryDurableEventStore } from '../src/durable-store.ts';
import { buildRunReport, formatRunReport } from '../src/run-report.ts';

const TEST_TEAM = fileURLToPath(new URL('../config/test-team.json', import.meta.url));
const NOTES = fileURLToPath(new URL('./fixtures/notes', import.meta.url));

export interface LiveTeam {
  dir: string;
  workspace: string;
  engine: WorkflowEngine;
  store: MemoryDurableEventStore;
  server: CompanyServer;
  runtime: AgentRuntime;
  logs: string[];
  call: (method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }>;
  /** Polls engine state until `check` is true; throws after `ms`. */
  until: (check: () => boolean, ms: number, what: string) => Promise<void>;
  /** Builds the run report from the log, prints it and appends it to RUN_REPORT if set. */
  report: (title: string) => string;
  stop: () => Promise<void>;
}

/**
 * The M3b test team (config/test-team.json) on a real Ollama model, with the
 * fixture notes in its workspace. Everything else is the production path:
 * the engine, the command queue, the agent port, the runtime, the tools.
 */
export async function liveTeam(options: { ollamaUrl: string; model: string; limits?: Partial<Limits> }): Promise<LiveTeam> {
  const raw = JSON.parse(readFileSync(TEST_TEAM, 'utf8'));
  for (const a of raw.agents) a.model = `ollama:${options.model}`;
  raw.limits = { ...raw.limits, ...options.limits };
  const config = parseCompanyConfig(raw);

  const dir = mkdtempSync(join(tmpdir(), 'ai-company-live-'));
  const workspaceDir = join(dir, 'workspace');
  mkdirSync(workspaceDir, { recursive: true });
  cpSync(NOTES, join(workspaceDir, 'notes'), { recursive: true });

  const store = new MemoryDurableEventStore();
  const engine = new WorkflowEngine({ policy: buildPolicy(config), store, limits: config.limits, strictReview: true });
  const boot = bootstrapAgents(engine, config);
  if (!boot.ok) throw new Error(boot.error);
  const workspace = new Workspace(workspaceDir);
  const tools = new ToolRegistry(workspaceTools(workspace));
  const logs: string[] = [];
  const log = (m: string) => {
    logs.push(m);
    if (process.env.LIVE_VERBOSE) console.error(`[live] ${m}`);
  };
  const server = createCompanyServer({ engine, store, ceoToken: 'live-team-token-0123456789', tools, workspace, checks: config.checks, log, onFatal: (e) => log(`FATAL ${e.message}`) });
  await new Promise<void>((resolve) => server.http.listen(0, '127.0.0.1', resolve));
  const { port } = server.http.address() as AddressInfo;

  const provider = new OllamaProvider({ baseUrl: options.ollamaUrl });
  const runtime = new AgentRuntime({
    port: server.agentPort,
    modelFor: (a) => ({ provider, model: options.model, options: config.modelOptions[a.id] }),
    workspace: { read: (path) => workspace.read(path) },
    checkpoints: new MemoryCheckpointStore(),
    roleNotes: config.roleNotes,
    log,
    idleMs: 250,
  });

  // Peak memory: this process, and the model as Ollama reports it.
  let peakRss = 0;
  let peakModel = 0;
  const sample = async () => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
    try {
      const ps = (await (await fetch(`${options.ollamaUrl}/api/ps`)).json()) as { models?: { size?: number }[] };
      peakModel = Math.max(peakModel, (ps.models ?? []).reduce((n, m) => n + (m.size ?? 0), 0));
    } catch {
      // Memory figures are best effort.
    }
  };
  const sampler = setInterval(() => void sample(), 2_000);
  const started = Date.now();

  return {
    dir,
    workspace: workspaceDir,
    engine,
    store,
    server,
    runtime,
    logs,
    async call(method, path, body) {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: { authorization: 'Bearer live-team-token-0123456789', ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, body: await res.json() };
    },
    async until(check, ms, what) {
      const deadline = Date.now() + ms;
      while (!check()) {
        if (Date.now() > deadline) throw new Error(`timed out after ${Math.round(ms / 1000)} s waiting for ${what}\nlast logs:\n${logs.slice(-15).join('\n')}`);
        await new Promise((r) => setTimeout(r, 500));
      }
    },
    report(title) {
      const md = formatRunReport(buildRunReport(store.all()), {
        model: `${options.model} · ${title}`,
        wallSeconds: (Date.now() - started) / 1000,
        peakServerRssMb: peakRss / 2 ** 20,
        ...(peakModel ? { peakModelMb: peakModel / 2 ** 20 } : {}),
      });
      console.log(md);
      if (process.env.RUN_REPORT) appendFileSync(process.env.RUN_REPORT, `${md}\n`);
      return md;
    },
    async stop() {
      clearInterval(sampler);
      await runtime.stop();
      await server.close();
      if (!process.env.LIVE_KEEP) rmSync(dir, { recursive: true, force: true });
      else console.error(`[live] kept ${dir}`);
    },
  };
}
