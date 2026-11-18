import { randomUUID } from 'node:crypto';
import type {
  AgentProfile,
  EngineEvent,
  FinalAction,
  Goal,
  Limits,
  NewEvent,
  ProposedAction,
  Result,
  RiskTier,
  Task,
  TaskState,
} from './types.ts';
import { fail, ok } from './types.ts';
import { canTransition, isTerminal } from './state-machine.ts';
import type { PolicyEngine } from './policy.ts';
import { InMemoryEventStore, type EventStore } from './event-log.ts';
import { validatePlan, type PlanTask } from './plan.ts';

export const DEFAULT_LIMITS: Limits = {
  maxSteps: 30,
  maxTokensPerTask: 200_000,
  maxWallMs: 30 * 60_000,
  maxReviewAttempts: 3,
  repeatedCallLimit: 3,
  stuckAfterMs: 5 * 60_000,
  circuitBreakerEscalations: 3,
  budgetWarnAt: 0.8,
};

export interface EngineOptions {
  policy: PolicyEngine;
  /** Existing events are replayed on construction, so state survives restarts. */
  store?: EventStore;
  limits?: Partial<Limits>;
  now?: () => number;
  newId?: () => string;
}

export interface SelfCheckItem {
  criterion: string;
  met: boolean;
  note?: string;
}

export interface Submission {
  summary: string;
  /** Must cover every acceptance criterion with met: true. */
  selfCheck: SelfCheckItem[];
  /** A real-world action to perform once the work passes review (e.g. send the email). */
  finalAction?: ProposedAction;
}

export interface ReviewVerdict {
  passed: boolean;
  score: number;
  feedback: string;
}

export type ToolCallDecision = { kind: 'allow'; tier: RiskTier } | { kind: 'duplicate' };

/** What the tool gateway should now execute, if anything. */
export interface Outcome {
  state: TaskState;
  execute: ProposedAction | null;
}

export type Resolution =
  | { kind: 'retry' }
  | { kind: 'reassign'; ownerId: string }
  | { kind: 'cancel' };

/**
 * The control plane's heart: an event-sourced task state machine.
 *
 * Agents call commands (submitPlan, requestToolCall, submitForReview, …).
 * Every command checks its guards, then emits events; all state is derived
 * from events by `apply`, so the engine can always be rebuilt from its log.
 * Commands never throw on bad agent input — they return `{ ok: false }`.
 */
export class WorkflowEngine {
  readonly store: EventStore;
  readonly policy: PolicyEngine;
  readonly limits: Limits;

  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly agents = new Map<string, AgentProfile>();
  private readonly goals = new Map<string, Goal>();
  private readonly tasks = new Map<string, Task>();
  private readonly usedKeys = new Set<string>();
  private readonly recentCalls = new Map<string, string[]>();
  private readonly escalationStreak = new Map<string, number>();
  private companyPaused = false;

  constructor(options: EngineOptions) {
    this.policy = options.policy;
    this.store = options.store ?? new InMemoryEventStore();
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? (() => randomUUID());
    for (const event of this.store.all()) this.apply(event);
  }

  /** Rebuild an engine from a saved event log. */
  static fromEvents(events: readonly EngineEvent[], options: Omit<EngineOptions, 'store'>): WorkflowEngine {
    return new WorkflowEngine({ ...options, store: new InMemoryEventStore(events) });
  }

  // ───────────────────────── queries ─────────────────────────

  getTask(id: string): Task | undefined {
    const t = this.tasks.get(id);
    return t && structuredClone(t);
  }

  listTasks(goalId?: string): Task[] {
    return [...this.tasks.values()].filter((t) => !goalId || t.goalId === goalId).map((t) => structuredClone(t));
  }

  getGoal(id: string): Goal | undefined {
    const g = this.goals.get(id);
    return g && { ...g };
  }

  getAgent(id: string): AgentProfile | undefined {
    const a = this.agents.get(id);
    return a && structuredClone(a);
  }

  listAgents(): AgentProfile[] {
    return [...this.agents.values()].map((a) => structuredClone(a));
  }

  isCompanyPaused(): boolean {
    return this.companyPaused;
  }

  // ───────────────────────── agents & company ─────────────────────────

  registerAgent(input: Omit<AgentProfile, 'paused' | 'benched'>): Result<AgentProfile> {
    if (!input.id || !input.name) return fail('agent needs an id and a name');
    if (this.agents.has(input.id)) return fail(`agent "${input.id}" already exists`);
    const unknown = input.tools.filter((t) => !this.policy.hasTool(t));
    if (unknown.length) return fail(`unknown tools: ${unknown.join(', ')}`);
    const agent: AgentProfile = { ...input, tools: [...input.tools], paused: false, benched: false };
    this.emit('agent.registered', { agentId: agent.id, data: { agent } });
    return ok(structuredClone(agent));
  }

  pauseAgent(agentId: string): Result<true> {
    const a = this.agents.get(agentId);
    if (!a) return fail(`unknown agent "${agentId}"`);
    if (!a.paused) this.emit('agent.paused', { agentId });
    return ok(true);
  }

  resumeAgent(agentId: string): Result<true> {
    const a = this.agents.get(agentId);
    if (!a) return fail(`unknown agent "${agentId}"`);
    if (a.paused) this.emit('agent.resumed', { agentId });
    return ok(true);
  }

  /** Only the CEO should call this, after reviewing why the agent was benched. */
  unbenchAgent(agentId: string): Result<true> {
    const a = this.agents.get(agentId);
    if (!a) return fail(`unknown agent "${agentId}"`);
    if (a.benched) this.emit('agent.unbenched', { agentId });
    return ok(true);
  }

  /** Kill switch: no task may start and no tool call is allowed until resumed. */
  pauseCompany(reason = 'paused by CEO'): Result<true> {
    if (!this.companyPaused) this.emit('company.paused', { data: { reason } });
    return ok(true);
  }

  resumeCompany(): Result<true> {
    if (this.companyPaused) this.emit('company.resumed', {});
    return ok(true);
  }

  // ───────────────────────── goals & plans ─────────────────────────

  createGoal(text: string, budgetTokens: number): Result<Goal> {
    if (!text?.trim()) return fail('goal text is empty');
    if (!Number.isFinite(budgetTokens) || budgetTokens <= 0) return fail('goal budget must be positive');
    const goal: Goal = { id: this.newId(), text: text.trim(), budgetTokens, spentTokens: 0, warned: false };
    this.emit('goal.created', { goalId: goal.id, data: { goal } });
    return ok({ ...goal });
  }

  /** Gate 1. The orchestrator proposes a plan; the engine validates it or rejects it with reasons. */
  submitPlan(goalId: string, orchestratorId: string, plan: PlanTask[]): Result<Task[]> {
    const goal = this.goals.get(goalId);
    if (!goal) return fail(`unknown goal "${goalId}"`);
    const orchestrator = this.agents.get(orchestratorId);
    if (!orchestrator || orchestrator.kind !== 'orchestrator') return fail('plans must come from the orchestrator');

    const errors = validatePlan(plan, { goal, agents: this.agents, policy: this.policy });
    if (errors.length) {
      this.emit('plan.rejected', { goalId, agentId: orchestratorId, data: { errors } });
      return fail(`plan rejected: ${errors.join('; ')}`);
    }

    const idFor = new Map(plan.map((p) => [p.key, this.newId()]));
    const tasks: Task[] = plan.map((p) => ({
      id: idFor.get(p.key)!,
      goalId,
      title: p.title.trim(),
      acceptanceCriteria: p.acceptanceCriteria.filter((c) => c.trim()),
      requiredTools: [...(p.requiredTools ?? [])],
      dependsOn: (p.dependsOn ?? []).map((d) => idFor.get(d)!),
      costEstimateTokens: p.costEstimateTokens,
      ownerId: p.ownerId,
      state: 'planned',
      steps: 0,
      tokens: 0,
      startedAt: null,
      lastActivityAt: null,
      reviewAttempts: 0,
      summary: null,
      finalAction: null,
      lastFeedback: null,
      escalationReason: null,
    }));

    this.emit('plan.accepted', { goalId, agentId: orchestratorId, data: { tasks } });
    for (const t of tasks) this.emit('task.assigned', { goalId, taskId: t.id, agentId: t.ownerId, data: { ownerId: t.ownerId } });
    return ok(tasks.map((t) => this.getTask(t.id)!));
  }

  // ───────────────────────── working ─────────────────────────

  start(taskId: string, agentId: string): Result<TaskState> {
    const t = this.tasks.get(taskId);
    if (!t) return fail(`unknown task "${taskId}"`);
    if (this.companyPaused) return fail('company is paused');
    if (t.state !== 'assigned') return fail(`task is ${t.state}, not assigned`);
    if (t.ownerId !== agentId) return fail('only the task owner can start it');
    const agent = this.agents.get(agentId)!;
    if (agent.paused || agent.benched) return fail(`${agent.name} is ${agent.benched ? 'benched' : 'paused'}`);
    const waiting = t.dependsOn.filter((d) => this.tasks.get(d)?.state !== 'done');
    if (waiting.length) return fail(`waiting on ${waiting.length} unfinished dependencies`);
    const goal = this.goals.get(t.goalId)!;
    if (goal.spentTokens >= goal.budgetTokens) return fail('goal budget exhausted');
    this.emit('task.started', { goalId: t.goalId, taskId, agentId });
    return ok(t.state);
  }

  /** Record one agent step (one model turn). Enforces step, token, time and budget limits. */
  recordStep(taskId: string, agentId: string, tokens: number): Result<TaskState> {
    const t = this.tasks.get(taskId);
    if (!t) return fail(`unknown task "${taskId}"`);
    if (t.state !== 'working') return fail(`task is ${t.state}, not working`);
    if (t.ownerId !== agentId) return fail('only the task owner can record steps');
    if (!Number.isFinite(tokens) || tokens < 0) return fail('tokens must be a non-negative number');

    this.emit('task.step', { goalId: t.goalId, taskId, agentId, data: { tokens } });

    if (t.steps > this.limits.maxSteps) this.escalateInternal(t, `step limit (${this.limits.maxSteps}) exceeded`);
    else if (t.tokens > this.limits.maxTokensPerTask) this.escalateInternal(t, `token limit (${this.limits.maxTokensPerTask}) exceeded`);
    else if (t.startedAt !== null && this.now() - t.startedAt > this.limits.maxWallMs) this.escalateInternal(t, 'time limit exceeded');

    this.enforceGoalBudget(t.goalId);
    return ok(t.state);
  }

  /**
   * Every real-world tool call goes through here first. Tier 0–1 (and
   * auto-approved tier 2) are allowed; higher tiers must be proposed as the
   * task's finalAction so they pass review and the approval gate.
   */
  requestToolCall(taskId: string, agentId: string, call: ProposedAction): Result<ToolCallDecision> {
    const t = this.tasks.get(taskId);
    if (!t) return fail(`unknown task "${taskId}"`);
    if (this.companyPaused) return fail('company is paused');
    if (t.state !== 'working') return fail(`task is ${t.state}, not working`);
    if (t.ownerId !== agentId) return fail('only the task owner can call tools for it');
    if (!call?.idempotencyKey) return fail('tool calls need an idempotency key');
    const agent = this.agents.get(agentId)!;
    const base = { goalId: t.goalId, taskId, agentId };

    if (this.usedKeys.has(call.idempotencyKey)) {
      this.emit('tool.duplicate', { ...base, data: { tool: call.tool, idempotencyKey: call.idempotencyKey } });
      return ok({ kind: 'duplicate' });
    }

    const decision = this.policy.check(agent, call.tool);
    if (decision.kind === 'deny') {
      this.emit('tool.denied', { ...base, data: { tool: call.tool, reason: decision.reason } });
      return fail(decision.reason);
    }
    if (decision.kind === 'needs_approval') {
      const reason = `${decision.reason}; propose it as the task's finalAction instead`;
      this.emit('tool.denied', { ...base, data: { tool: call.tool, reason } });
      return fail(reason);
    }

    const signature = `${call.tool}:${JSON.stringify(call.input ?? null)}`;
    const recent = this.recentCalls.get(taskId) ?? [];
    const need = this.limits.repeatedCallLimit - 1;
    if (need > 0 && recent.length >= need && recent.slice(-need).every((s) => s === signature)) {
      this.emit('tool.denied', { ...base, data: { tool: call.tool, reason: 'repeated identical tool call' } });
      this.escalateInternal(t, `looping: "${call.tool}" called ${this.limits.repeatedCallLimit} times with the same input`);
      return fail('repeated identical tool call; task escalated');
    }

    this.emit('tool.allowed', {
      ...base,
      data: { tool: call.tool, tier: decision.tier, idempotencyKey: call.idempotencyKey, signature },
    });
    return ok({ kind: 'allow', tier: decision.tier });
  }

  /** Gate 2: the worker submits output plus a self-check against every acceptance criterion. */
  submitForReview(taskId: string, agentId: string, submission: Submission): Result<TaskState> {
    const t = this.tasks.get(taskId);
    if (!t) return fail(`unknown task "${taskId}"`);
    if (this.companyPaused) return fail('company is paused');
    if (t.state !== 'working') return fail(`task is ${t.state}, not working`);
    if (t.ownerId !== agentId) return fail('only the task owner can submit it');
    if (!submission?.summary?.trim()) return fail('submission needs a summary');
    const base = { goalId: t.goalId, taskId, agentId };

    const checks = submission.selfCheck ?? [];
    const missing = t.acceptanceCriteria.filter((c) => !checks.some((s) => s.criterion === c && s.met));
    if (missing.length) {
      this.emit('task.self_check_failed', { ...base, data: { missing } });
      return fail(`self-check incomplete: ${missing.join('; ')}`);
    }

    let finalAction: FinalAction | null = null;
    if (submission.finalAction) {
      const fa = submission.finalAction;
      if (!fa.idempotencyKey) return fail('finalAction needs an idempotency key');
      if (this.usedKeys.has(fa.idempotencyKey)) return fail('finalAction idempotency key was already used');
      const decision = this.policy.check(this.agents.get(agentId)!, fa.tool);
      if (decision.kind === 'deny') return fail(decision.reason);
      finalAction = { tool: fa.tool, input: fa.input, idempotencyKey: fa.idempotencyKey, needsApproval: decision.kind === 'needs_approval' };
    }

    this.emit('task.submitted', { ...base, data: { summary: submission.summary.trim(), finalAction } });
    return ok(t.state);
  }

  /** Gate 4: an independent reviewer scores the output. Never the author. */
  recordReview(taskId: string, reviewerId: string, verdict: ReviewVerdict): Result<Outcome> {
    const t = this.tasks.get(taskId);
    if (!t) return fail(`unknown task "${taskId}"`);
    if (t.state !== 'review') return fail(`task is ${t.state}, not in review`);
    const reviewer = this.agents.get(reviewerId);
    if (!reviewer || reviewer.kind !== 'reviewer') return fail('reviews must come from a reviewer agent');
    if (reviewerId === t.ownerId) return fail('an agent cannot review its own work');
    if (reviewer.paused || reviewer.benched) return fail(`${reviewer.name} is unavailable`);
    const base = { goalId: t.goalId, taskId, agentId: reviewerId };

    if (!verdict.passed) {
      if (!verdict.feedback?.trim()) return fail('a failed review needs feedback');
      this.emit('review.failed', { ...base, data: { score: verdict.score, feedback: verdict.feedback.trim() } });
      if (t.reviewAttempts >= this.limits.maxReviewAttempts) {
        this.escalateInternal(t, `failed review ${t.reviewAttempts} times`);
      }
      return ok({ state: t.state, execute: null });
    }

    this.emit('review.passed', { ...base, data: { score: verdict.score, feedback: verdict.feedback ?? '' } });
    if (t.finalAction?.needsApproval) {
      this.emit('approval.requested', { goalId: t.goalId, taskId, agentId: t.ownerId, data: { action: t.finalAction } });
      return ok({ state: t.state, execute: null });
    }
    this.emit('task.done', { goalId: t.goalId, taskId, agentId: t.ownerId, data: { summary: t.summary } });
    return ok({ state: t.state, execute: toAction(t.finalAction) });
  }

  /** Gate 5: the CEO approves or rejects a tier-3 final action. */
  decideApproval(taskId: string, decision: { approved: boolean; note?: string }): Result<Outcome> {
    const t = this.tasks.get(taskId);
    if (!t) return fail(`unknown task "${taskId}"`);
    if (t.state !== 'awaiting_approval') return fail(`task is ${t.state}, not awaiting approval`);
    const base = { goalId: t.goalId, taskId, agentId: t.ownerId };

    if (decision.approved) {
      this.emit('approval.granted', { ...base, data: { note: decision.note ?? '' } });
      this.emit('task.done', { ...base, data: { summary: t.summary } });
      return ok({ state: t.state, execute: toAction(t.finalAction) });
    }
    if (!decision.note?.trim()) return fail('a rejection needs a note so the agent can revise');
    this.emit('approval.rejected', { ...base, data: { note: decision.note.trim() } });
    if (t.reviewAttempts >= this.limits.maxReviewAttempts) this.escalateInternal(t, `rejected ${t.reviewAttempts} times`);
    return ok({ state: t.state, execute: null });
  }

  // ───────────────────────── escalation & safety ─────────────────────────

  /** An agent or the CEO can escalate any live task. */
  escalate(taskId: string, reason: string): Result<TaskState> {
    const t = this.tasks.get(taskId);
    if (!t) return fail(`unknown task "${taskId}"`);
    if (!canTransition(t.state, 'escalated')) return fail(`cannot escalate a ${t.state} task`);
    this.escalateInternal(t, reason || 'escalated');
    return ok(t.state);
  }

  resolveEscalation(taskId: string, resolution: Resolution): Result<TaskState> {
    const t = this.tasks.get(taskId);
    if (!t) return fail(`unknown task "${taskId}"`);
    if (t.state !== 'escalated') return fail(`task is ${t.state}, not escalated`);
    const base = { goalId: t.goalId, taskId };

    if (resolution.kind === 'cancel') {
      this.emit('task.cancelled', { ...base, data: { reason: 'cancelled after escalation' } });
      return ok(t.state);
    }
    const ownerId = resolution.kind === 'reassign' ? resolution.ownerId : t.ownerId;
    const owner = this.agents.get(ownerId);
    if (!owner || owner.kind !== 'worker') return fail('new owner must be a worker');
    if (owner.benched) return fail(`${owner.name} is benched`);
    const lacking = t.requiredTools.filter((tool) => !owner.tools.includes(tool));
    if (lacking.length) return fail(`${owner.name} lacks tools: ${lacking.join(', ')}`);
    this.emit('task.assigned', { ...base, agentId: ownerId, data: { ownerId, reset: true } });
    return ok(t.state);
  }

  cancelTask(taskId: string, reason: string): Result<TaskState> {
    const t = this.tasks.get(taskId);
    if (!t) return fail(`unknown task "${taskId}"`);
    if (isTerminal(t.state)) return fail(`task is already ${t.state}`);
    this.emit('task.cancelled', { goalId: t.goalId, taskId, data: { reason } });
    return ok(t.state);
  }

  /** Call on a timer. Escalates working tasks that went quiet or ran out of time. */
  checkStuck(): string[] {
    const now = this.now();
    const escalated: string[] = [];
    for (const t of this.tasks.values()) {
      if (t.state !== 'working') continue;
      if (t.lastActivityAt !== null && now - t.lastActivityAt > this.limits.stuckAfterMs) {
        this.escalateInternal(t, `no progress for ${Math.round((now - t.lastActivityAt) / 1000)}s`);
        escalated.push(t.id);
      } else if (t.startedAt !== null && now - t.startedAt > this.limits.maxWallMs) {
        this.escalateInternal(t, 'time limit exceeded');
        escalated.push(t.id);
      }
    }
    return escalated;
  }

  // ───────────────────────── internals ─────────────────────────

  private escalateInternal(t: Task, reason: string): void {
    if (!canTransition(t.state, 'escalated')) return;
    this.emit('task.escalated', { goalId: t.goalId, taskId: t.id, agentId: t.ownerId, data: { reason } });
    const streak = this.escalationStreak.get(t.ownerId) ?? 0;
    const owner = this.agents.get(t.ownerId);
    if (owner && !owner.benched && streak >= this.limits.circuitBreakerEscalations) {
      this.emit('agent.benched', { agentId: owner.id, data: { reason: `${streak} escalations in a row` } });
    }
  }

  private enforceGoalBudget(goalId: string): void {
    const goal = this.goals.get(goalId);
    if (!goal) return;
    const used = goal.spentTokens / goal.budgetTokens;
    if (used >= 1) {
      for (const t of this.tasks.values()) {
        if (t.goalId === goalId && (t.state === 'working' || t.state === 'assigned' || t.state === 'planned')) {
          this.escalateInternal(t, 'goal budget exhausted');
        }
      }
    } else if (used >= this.limits.budgetWarnAt && !goal.warned) {
      this.emit('budget.warning', { goalId, data: { used: Math.round(used * 100) / 100 } });
    }
  }

  private emit(type: string, fields: Omit<NewEvent, 'type' | 'at'>): EngineEvent {
    const event = this.store.append({ type, at: this.now(), ...fields });
    this.apply(event);
    return event;
  }

  private move(t: Task, to: TaskState): void {
    if (!canTransition(t.state, to)) throw new Error(`illegal transition ${t.state} -> ${to} (task ${t.id})`);
    t.state = to;
  }

  /** The reducer: the only place state changes. Must stay deterministic. */
  private apply(e: EngineEvent): void {
    const d = e.data ?? {};
    const t = e.taskId ? this.tasks.get(e.taskId) : undefined;
    const touch = () => {
      if (t) t.lastActivityAt = e.at;
    };

    switch (e.type) {
      case 'agent.registered':
        this.agents.set(d.agent.id, structuredClone(d.agent));
        break;
      case 'agent.paused':
        this.agents.get(e.agentId!)!.paused = true;
        break;
      case 'agent.resumed':
        this.agents.get(e.agentId!)!.paused = false;
        break;
      case 'agent.benched':
        this.agents.get(e.agentId!)!.benched = true;
        break;
      case 'agent.unbenched':
        this.agents.get(e.agentId!)!.benched = false;
        this.escalationStreak.set(e.agentId!, 0);
        break;
      case 'company.paused':
        this.companyPaused = true;
        break;
      case 'company.resumed':
        this.companyPaused = false;
        break;
      case 'goal.created':
        this.goals.set(d.goal.id, { ...d.goal });
        break;
      case 'plan.accepted':
        for (const task of d.tasks as Task[]) this.tasks.set(task.id, structuredClone(task));
        break;
      case 'task.assigned':
        this.move(t!, 'assigned');
        t!.ownerId = d.ownerId;
        if (d.reset) {
          Object.assign(t!, { steps: 0, tokens: 0, startedAt: null, lastActivityAt: null, reviewAttempts: 0, summary: null, finalAction: null, escalationReason: null });
          this.recentCalls.delete(t!.id);
        }
        break;
      case 'task.started':
        this.move(t!, 'working');
        t!.startedAt = e.at;
        touch();
        break;
      case 'task.step': {
        t!.steps += 1;
        t!.tokens += d.tokens;
        const goal = this.goals.get(t!.goalId);
        if (goal) goal.spentTokens += d.tokens;
        touch();
        break;
      }
      case 'budget.warning':
        this.goals.get(e.goalId!)!.warned = true;
        break;
      case 'tool.allowed': {
        this.usedKeys.add(d.idempotencyKey);
        const list = this.recentCalls.get(e.taskId!) ?? [];
        list.push(d.signature);
        if (list.length > 10) list.shift();
        this.recentCalls.set(e.taskId!, list);
        touch();
        break;
      }
      case 'tool.denied':
      case 'tool.duplicate':
      case 'task.self_check_failed':
        touch();
        break;
      case 'task.submitted':
        this.move(t!, 'review');
        t!.summary = d.summary;
        t!.finalAction = d.finalAction ?? null;
        touch();
        break;
      case 'review.failed':
        t!.reviewAttempts += 1;
        t!.lastFeedback = d.feedback;
        this.move(t!, 'working');
        touch();
        break;
      case 'review.passed':
        touch();
        break;
      case 'approval.requested':
        this.move(t!, 'awaiting_approval');
        break;
      case 'approval.granted':
        break;
      case 'approval.rejected':
        t!.reviewAttempts += 1;
        t!.lastFeedback = d.note;
        this.move(t!, 'working');
        touch();
        break;
      case 'task.done':
        this.move(t!, 'done');
        if (t!.finalAction) this.usedKeys.add(t!.finalAction.idempotencyKey);
        this.escalationStreak.set(t!.ownerId, 0);
        break;
      case 'task.escalated':
        this.move(t!, 'escalated');
        t!.escalationReason = d.reason;
        this.escalationStreak.set(t!.ownerId, (this.escalationStreak.get(t!.ownerId) ?? 0) + 1);
        break;
      case 'task.cancelled':
        this.move(t!, 'cancelled');
        break;
      default:
        // Unknown event types are ignored so old engines can read newer logs.
        break;
    }
  }
}

function toAction(fa: FinalAction | null): ProposedAction | null {
  return fa ? { tool: fa.tool, input: fa.input, idempotencyKey: fa.idempotencyKey } : null;
}
