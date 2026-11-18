import { randomUUID } from 'node:crypto';
import type { Task } from '@ai-company/core';
import type { CheckpointStore } from './checkpoints.ts';
import type { AgentPort, AgentView, CompanyView } from './port.ts';
import { runPlanner, runReviewer, runWorker, type AgentModel, type Progress, type RoleContext } from './roles.ts';
import type { ToolRegistry } from './tools/registry.ts';
import type { Workspace } from './tools/workspace.ts';

export interface RuntimeOptions {
  port: AgentPort;
  /** The model for an agent, or undefined if its provider is not available. */
  modelFor: (agent: AgentView) => AgentModel | undefined;
  tools: ToolRegistry;
  workspace: Workspace;
  checkpoints: CheckpointStore;
  log?: (message: string) => void;
  /** Wait between looks when there is nothing to do. Default 1 s. */
  idleMs?: number;
  /** Longest wait after a model error (doubling from 1 s). Default 60 s. */
  maxBackoffMs?: number;
  newKey?: () => string;
}

/**
 * Runs the company's agents, one at a time (maxConcurrentAgents: 1), so one
 * local model serves every agent. Each unit of work is one role run: review
 * a submitted task, continue or start a worker's task, or plan an open goal.
 * Finishing work comes before starting new work.
 */
export class AgentRuntime {
  private readonly options: RuntimeOptions;
  private readonly log: (message: string) => void;
  private readonly warned = new Set<string>();
  private running: Promise<void> | null = null;
  private abort: AbortController | null = null;

  constructor(options: RuntimeOptions) {
    this.options = options;
    this.log = options.log ?? ((m) => console.error(`[agents] ${m}`));
  }

  /**
   * Does one unit of work. Returns false when nothing could make progress.
   * Model errors are thrown (nothing was recorded for the failed call).
   */
  async step(signal?: AbortSignal): Promise<boolean> {
    const view = await this.options.port.view();
    if (view.companyPaused) return false;
    for (const unit of this.candidates(view)) {
      if (signal?.aborted) return false;
      const ctx = this.context(unit.agent, signal);
      if (!ctx) continue;
      let progress: Progress;
      if (unit.kind === 'plan') progress = await runPlanner(ctx, view.goals.find((g) => g.id === unit.goalId)!, view);
      else if (unit.kind === 'review') progress = await runReviewer(ctx, unit.task);
      else progress = await runWorker(ctx, unit.task, view);
      if (progress) return true;
    }
    return false;
  }

  /** Runs units until nothing can make progress. For tests and scripts. */
  async runUntilIdle(maxUnits = 1_000): Promise<number> {
    let units = 0;
    while (await this.step()) {
      if (++units >= maxUnits) throw new Error(`still busy after ${maxUnits} units`);
    }
    return units;
  }

  /** Runs in the background until stop(); errors are logged and backed off. */
  start(): void {
    if (this.running) return;
    const abort = (this.abort = new AbortController());
    const idleMs = this.options.idleMs ?? 1_000;
    const maxBackoff = this.options.maxBackoffMs ?? 60_000;
    this.running = (async () => {
      let backoff = 0;
      while (!abort.signal.aborted) {
        let wait = 0;
        try {
          wait = (await this.step(abort.signal)) ? 0 : idleMs;
          backoff = 0;
        } catch (err) {
          if (abort.signal.aborted) break;
          backoff = Math.min(maxBackoff, backoff ? backoff * 2 : 1_000);
          wait = backoff;
          this.log(`agent work failed, retrying in ${Math.round(backoff / 1000)} s: ${err instanceof Error ? err.message : String(err)}`);
        }
        if (wait) await sleep(wait, abort.signal);
      }
    })();
  }

  /** Stops after aborting any model call in flight. */
  async stop(): Promise<void> {
    this.abort?.abort();
    await this.running;
    this.running = null;
  }

  private *candidates(view: CompanyView): Generator<
    { kind: 'plan'; agent: AgentView; goalId: string } | { kind: 'review' | 'work'; agent: AgentView; task: Task }
  > {
    const available = (a: AgentView | undefined): a is AgentView => !!a && !a.paused && !a.benched;
    const agent = (id: string) => view.agents.find((a) => a.id === id);
    const done = (id: string) => view.tasks.find((t) => t.id === id)?.state === 'done';

    for (const task of view.tasks.filter((t) => t.state === 'review')) {
      const reviewer = view.agents.find((a) => a.kind === 'reviewer' && available(a) && a.id !== task.ownerId);
      if (reviewer) yield { kind: 'review', agent: reviewer, task };
    }
    for (const task of view.tasks.filter((t) => t.state === 'working')) {
      const owner = agent(task.ownerId);
      if (available(owner)) yield { kind: 'work', agent: owner, task };
    }
    for (const task of view.tasks.filter((t) => t.state === 'assigned' && t.dependsOn.every(done))) {
      const owner = agent(task.ownerId);
      if (available(owner)) yield { kind: 'work', agent: owner, task };
    }
    const orchestrator = view.agents.find((a) => a.kind === 'orchestrator' && available(a));
    if (orchestrator) {
      for (const goal of view.goals.filter((g) => g.status === 'open')) yield { kind: 'plan', agent: orchestrator, goalId: goal.id };
    }
  }

  private context(agent: AgentView, signal?: AbortSignal): RoleContext | undefined {
    const model = this.options.modelFor(agent);
    if (!model) {
      if (!this.warned.has(agent.id)) this.log(`${agent.name} has no available model for "${agent.model}"; skipping their work`);
      this.warned.add(agent.id);
      return undefined;
    }
    return {
      port: this.options.port,
      agent,
      model,
      tools: this.options.tools,
      workspace: this.options.workspace,
      checkpoints: this.options.checkpoints,
      newKey: this.options.newKey ?? (() => randomUUID()),
      log: this.log,
      ...(signal ? { signal } : {}),
    };
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}
