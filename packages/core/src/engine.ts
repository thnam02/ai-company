import { randomUUID } from 'node:crypto';
import type {
  ActionResult,
  AgentProfile,
  CheckResult,
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
  maxReplans: 3,
};

const MAX_ARTIFACTS = 20;
const MAX_CHECKS = 50;
const MAX_RUBRIC_NOTE = 2_000;
const SHA256 = /^[0-9a-f]{64}$/;

export interface EngineOptions {
  policy: PolicyEngine;
  /** Existing events are replayed on construction, so state survives restarts. */
  store?: EventStore;
  limits?: Partial<Limits>;
  now?: () => number;
  newId?: () => string;
  /**
   * Gates 3 and 4 in full (M5): a review is accepted only after the
   * submission's automated checks passed, and only with a rubric that judges
   * every acceptance criterion. The server always sets it.
   */
  strictReview?: boolean;
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
  /** Workspace paths the work produced, for the reviewer. */
  artifacts?: string[];
  /** A real-world action to perform once the work passes review (e.g. send the email). */
  finalAction?: ProposedAction;
}

/** The reviewer's judgement of one acceptance criterion. */
export interface RubricItem {
  criterion: string;
  met: boolean;
  /** Evidence; required when the criterion is not met. */
  note?: string;
}

export interface ReviewVerdict {
  passed: boolean;
  score: number;
  feedback: string;
  /** One item per acceptance criterion. `passed` must equal "every item met". Required with strictReview. */
  rubric?: RubricItem[];
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

  private readonly strictReview: boolean;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly agents = new Map<string, AgentProfile>();
  private readonly goals = new Map<string, Goal>();
  private readonly tasks = new Map<string, Task>();
  private readonly usedKeys = new Set<string>();
  /** Tasks whose release records when its action starts (M4 on); older releases count as started. */
  private readonly startTracked = new Set<string>();
  /** Tasks whose released action has started running. */
  private readonly actionStarted = new Set<string>();
  /** Allowed tool calls (from M4 on) with no recorded result yet, by idempotency key. */
  private readonly openToolCalls = new Map<string, { taskId: string; agentId: string; tool: string }>();
  private readonly recentCalls = new Map<string, string[]>();
  private readonly escalationStreak = new Map<string, number>();
  private companyPaused = false;

  constructor(options: EngineOptions) {
    this.policy = options.policy;
    this.store = options.store ?? new InMemoryEventStore();
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
    this.now = options.now ?? Date.now;
    this.strictReview = options.strictReview ?? false;
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

  listGoals(): Goal[] {
    return [...this.goals.values()].map((g) => ({ ...g }));
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

  /**
   * Final actions that were released (task done) but have no recorded result:
   * the outbox. The server executes these and records the result; after a
   * crash, they are the actions that may or may not have run.
   */
  pendingActions(): { taskId: string; action: ProposedAction; started?: true }[] {
    const pending: { taskId: string; action: ProposedAction; started?: true }[] = [];
    for (const t of this.tasks.values()) {
      if (t.state !== 'done' || !t.finalAction || t.actionResult) continue;
      // `started`: it may have run (a start was recorded, or the release predates start records).
      const started = !this.startTracked.has(t.id) || this.actionStarted.has(t.id);
      pending.push({ taskId: t.id, action: toAction(t.finalAction)!, ...(started ? { started: true as const } : {}) });
    }
    return pending;
  }

  /**
   * Allowed tool calls with no recorded result, whatever their task's state.
   * At boot these were interrupted by a crash; the gateway records them as
   * failed (the worker redoes its turn from its checkpoint with new keys).
   * Calls allowed before M4 never expected a result and are not included.
   */
  pendingToolCalls(): { taskId: string; tool: string; idempotencyKey: string }[] {
    return [...this.openToolCalls].map(([idempotencyKey, call]) => ({ taskId: call.taskId, tool: call.tool, idempotencyKey }));
  }

  /**
   * Submissions waiting for their automated checks (gate 3): tasks in review
   * with none recorded. `submission` goes back with the results, so they are
   * never taken for a later submission. Copies, safe to read after an await.
   */
  awaitingChecks(): { taskId: string; submission: number; artifacts: string[]; finalAction: ProposedAction | null }[] {
    return [...this.tasks.values()]
      .filter((t) => t.state === 'review' && !t.checkResults)
      .map((t) => ({ taskId: t.id, submission: t.submissions, artifacts: [...t.artifacts], finalAction: structuredClone(toAction(t.finalAction)) }));
  }

  /** The files a task's passed checks read, with their sha256, while it waits for review. */
  checkedFiles(taskId: string): { artifacts: string[]; files: Record<string, string> } | null {
    const t = this.tasks.get(taskId);
    if (!t || t.state !== 'review' || !t.checkResults || !t.checkedFiles) return null;
    return { artifacts: [...t.artifacts], files: { ...t.checkedFiles } };
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

  /**
   * CEO config change to a live agent (name, role, model, tool allowlist).
   * The kind cannot change. Revoked tools are denied from the next call on.
   * CEO/boot only, like registerAgent and unbenchAgent: it can grant tools,
   * so agent loops must never be given access to it.
   */
  updateAgent(agentId: string, changes: Partial<Pick<AgentProfile, 'name' | 'role' | 'model' | 'tools'>>): Result<AgentProfile> {
    const a = this.agents.get(agentId);
    if (!a) return fail(`unknown agent "${agentId}"`);
    const next = {
      name: changes.name ?? a.name,
      role: changes.role ?? a.role,
      model: changes.model ?? a.model,
      tools: [...(changes.tools ?? a.tools)],
    };
    if (!next.name) return fail('agent needs a name');
    const unknown = next.tools.filter((t) => !this.policy.hasTool(t));
    if (unknown.length) return fail(`unknown tools: ${unknown.join(', ')}`);
    if (a.kind !== 'worker' && next.tools.length) return fail(`only workers may have tools; ${a.name} is a ${a.kind}`);
    const same =
      next.name === a.name && next.role === a.role && next.model === a.model &&
      next.tools.length === a.tools.length && next.tools.every((t, i) => t === a.tools[i]);
    if (!same) this.emit('agent.updated', { agentId, data: { profile: next } });
    return ok(structuredClone(this.agents.get(agentId)!));
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
    const goal: Goal = {
      id: this.newId(),
      text: text.trim(),
      budgetTokens,
      spentTokens: 0,
      warned: false,
      status: 'open',
      planRejections: 0,
      escalationReason: null,
    };
    this.emit('goal.created', { goalId: goal.id, data: { goal } });
    return ok({ ...goal });
  }

  /**
   * Gate 1. The orchestrator proposes a plan; the engine validates it or
   * rejects it with reasons. After `maxReplans` re-plans the goal escalates.
   */
  submitPlan(goalId: string, orchestratorId: string, plan: PlanTask[]): Result<Task[]> {
    const goal = this.goals.get(goalId);
    if (!goal) return fail(`unknown goal "${goalId}"`);
    const orchestrator = this.agents.get(orchestratorId);
    if (!orchestrator || orchestrator.kind !== 'orchestrator') return fail('plans must come from the orchestrator');
    if (this.companyPaused) return fail('company is paused');
    if (orchestrator.paused || orchestrator.benched) return fail(`${orchestrator.name} is ${orchestrator.benched ? 'benched' : 'paused'}`);
    if (goal.status !== 'open') return fail(`goal is ${goal.status}, not open`);

    const errors = validatePlan(plan, { goal, agents: this.agents, policy: this.policy });
    if (errors.length) {
      this.emit('plan.rejected', { goalId, agentId: orchestratorId, data: { errors } });
      if (goal.planRejections > this.limits.maxReplans) {
        this.emit('goal.escalated', { goalId, data: { reason: `plan rejected ${goal.planRejections} times` } });
      }
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
      artifacts: [],
      finalAction: null,
      actionResult: null,
      lastFeedback: null,
      escalationReason: null,
      checkResults: null,
      checkedFiles: null,
      submissions: 0,
      checkResets: 0,
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

  /**
   * Record one agent step (one model turn). Enforces step, token, time and
   * budget limits. A turn that finishes after its task left `working` (the
   * CEO or a limit stopped it mid-call) is still charged, as `task.usage`,
   * but is not a step and the call fails.
   */
  recordStep(taskId: string, agentId: string, tokens: number): Result<TaskState> {
    const t = this.tasks.get(taskId);
    if (!t) return fail(`unknown task "${taskId}"`);
    if (t.ownerId !== agentId) return fail('only the task owner can record steps');
    if (!Number.isFinite(tokens) || tokens < 0) return fail('tokens must be a non-negative number');
    if (t.state !== 'working') {
      if (tokens > 0) {
        this.emit('task.usage', { goalId: t.goalId, taskId, agentId, data: { tokens } });
        this.enforceGoalBudget(t.goalId);
      }
      return fail(`task is ${t.state}, not working`);
    }

    this.emit('task.step', { goalId: t.goalId, taskId, agentId, data: { tokens } });

    if (t.steps > this.limits.maxSteps) this.escalateInternal(t, `step limit (${this.limits.maxSteps}) exceeded`);
    else if (t.tokens > this.limits.maxTokensPerTask) this.escalateInternal(t, `token limit (${this.limits.maxTokensPerTask}) exceeded`);
    else if (t.startedAt !== null && this.now() - t.startedAt > this.limits.maxWallMs) this.escalateInternal(t, 'time limit exceeded');

    this.enforceGoalBudget(t.goalId);
    return ok(t.state);
  }

  /**
   * Record one model turn by an orchestrator (planning) or a reviewer
   * (reviewing) for a goal. Their work happens outside any task, so it is
   * charged to the goal budget. Real usage is always recorded; the budget
   * is enforced afterwards.
   */
  recordGoalStep(goalId: string, agentId: string, tokens: number): Result<true> {
    const goal = this.goals.get(goalId);
    if (!goal) return fail(`unknown goal "${goalId}"`);
    const agent = this.agents.get(agentId);
    if (!agent) return fail(`unknown agent "${agentId}"`);
    if (agent.kind === 'worker') return fail('workers record steps on their task');
    if (!Number.isFinite(tokens) || tokens < 0) return fail('tokens must be a non-negative number');
    this.emit('goal.step', { goalId, agentId, data: { tokens } });
    this.enforceGoalBudget(goalId);
    return ok(true);
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
      // tracked: a result will be recorded for it (M4); older logs' calls have none.
      data: { tool: call.tool, tier: decision.tier, idempotencyKey: call.idempotencyKey, signature, tracked: true },
    });
    return ok({ kind: 'allow', tier: decision.tier });
  }

  /**
   * The gateway records what happened to an allowed tool call, once. Never
   * called by agents. Allowed in any task or company state: a call that was
   * running when the task moved on or the company stopped still happened.
   */
  recordToolResult(taskId: string, idempotencyKey: string, result: ActionResult): Result<true> {
    const t = this.tasks.get(taskId);
    if (!t) return fail(`unknown task "${taskId}"`);
    const call = this.openToolCalls.get(idempotencyKey);
    if (!call || call.taskId !== taskId) return fail(`no open tool call "${idempotencyKey}" for this task`);
    const data = { tool: call.tool, idempotencyKey, detail: String(result.detail ?? ''), ...attemptsOf(result) };
    // The agent that made the call, even if the task was reassigned since.
    this.emit(result.ok ? 'tool.executed' : 'tool.failed', { goalId: t.goalId, taskId, agentId: call.agentId, data });
    return ok(true);
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

    const artifacts = submission.artifacts ?? [];
    if (
      !Array.isArray(artifacts) ||
      artifacts.length > MAX_ARTIFACTS ||
      !artifacts.every((a) => typeof a === 'string' && a.trim() !== '' && a.length <= 500)
    ) {
      return fail(`artifacts must be up to ${MAX_ARTIFACTS} non-empty workspace paths`);
    }

    let finalAction: FinalAction | null = null;
    if (submission.finalAction) {
      const fa = submission.finalAction;
      if (!fa.idempotencyKey) return fail('finalAction needs an idempotency key');
      if (this.usedKeys.has(fa.idempotencyKey)) return fail('finalAction idempotency key was already used');
      // The plan decides what a task may do: a worker cannot add an action it was not planned for.
      if (!t.requiredTools.includes(fa.tool)) return fail(`${fa.tool} is not in this task's requiredTools (${t.requiredTools.join(', ') || 'none'}); submit without a finalAction`);
      const decision = this.policy.check(this.agents.get(agentId)!, fa.tool);
      if (decision.kind === 'deny') return fail(decision.reason);
      finalAction = { tool: fa.tool, input: fa.input, idempotencyKey: fa.idempotencyKey, needsApproval: decision.kind === 'needs_approval' };
    }

    this.emit('task.submitted', { ...base, data: { summary: submission.summary.trim(), artifacts: artifacts.map((a) => a.trim()), finalAction } });
    return ok(t.state);
  }

  /**
   * Gate 3: the gateway's automated checks of a submission, once per
   * submission, before any review. A failure sends the task back with the
   * failures as feedback and counts as a failed review attempt.
   */
  recordChecks(taskId: string, submission: number, results: CheckResult[], files: Record<string, string> = {}): Result<TaskState> {
    const t = this.tasks.get(taskId);
    if (!t) return fail(`unknown task "${taskId}"`);
    if (t.state !== 'review') return fail(`task is ${t.state}, not in review`);
    if (submission !== t.submissions) return fail(`these checks are for submission ${submission}; the task is on submission ${t.submissions}`);
    if (t.checkResults) return fail('checks already recorded for this submission');
    if (
      !files ||
      typeof files !== 'object' ||
      Array.isArray(files) ||
      !Object.entries(files).every(([path, hash]) => t.artifacts.includes(path) && typeof hash === 'string' && SHA256.test(hash))
    ) {
      return fail('checked files must map artifact paths to sha256 hashes');
    }
    if (
      !Array.isArray(results) ||
      results.length > MAX_CHECKS ||
      !results.every((r) => r && typeof r.name === 'string' && r.name.trim() !== '' && typeof r.ok === 'boolean' && typeof r.detail === 'string')
    ) {
      return fail(`checks must be up to ${MAX_CHECKS} results of { name, ok, detail }`);
    }
    const clean = results.map((r) => ({ name: r.name.trim(), ok: r.ok, detail: r.detail.slice(0, 1_000) }));
    // Run by the gateway, not by an agent: the events carry no agent.
    const base = { goalId: t.goalId, taskId };
    const failed = clean.filter((r) => !r.ok);
    // A pass must say which content passed: the review is held to these hashes.
    const unhashed = this.strictReview ? [...new Set(t.artifacts)].filter((p) => !files[p]) : [];
    if (!failed.length && unhashed.length) return fail(`checks passed without a hash of: ${unhashed.join(', ')}`);
    if (!failed.length) {
      this.emit('checks.passed', { ...base, data: { submission, results: clean, files: { ...files } } });
      return ok(t.state);
    }
    const feedback = ['Automated checks failed:', ...failed.map((r) => `- ${r.name}: ${r.detail}`)].join('\n');
    this.emit('checks.failed', { ...base, data: { submission, results: clean, feedback } });
    if (t.reviewAttempts >= this.limits.maxReviewAttempts) this.escalateInternal(t, `failed its checks or review ${t.reviewAttempts} times`);
    return ok(t.state);
  }

  /**
   * The files changed after their checks passed (another worker shares the
   * workspace): drop the results so the gateway checks them again before
   * any review. Not a failed attempt.
   */
  resetChecks(taskId: string, reason: string): Result<TaskState> {
    const t = this.tasks.get(taskId);
    if (!t) return fail(`unknown task "${taskId}"`);
    if (t.state !== 'review' || !t.checkResults) return fail('no recorded checks to reset');
    this.emit('checks.reset', { goalId: t.goalId, taskId, data: { submission: t.submissions, reason: String(reason).slice(0, 1_000) } });
    // Something keeps rewriting the files: a review could never settle, so the CEO decides.
    if (t.checkResets >= this.limits.maxReviewAttempts) this.escalateInternal(t, `its files kept changing during review (${t.checkResets} times)`);
    return ok(t.state);
  }

  /** Gate 4: an independent reviewer scores the output. Never the author. */
  recordReview(taskId: string, reviewerId: string, verdict: ReviewVerdict): Result<Outcome> {
    const t = this.tasks.get(taskId);
    if (!t) return fail(`unknown task "${taskId}"`);
    if (this.companyPaused) return fail('company is paused');
    if (t.state !== 'review') return fail(`task is ${t.state}, not in review`);
    const reviewer = this.agents.get(reviewerId);
    if (!reviewer || reviewer.kind !== 'reviewer') return fail('reviews must come from a reviewer agent');
    if (reviewerId === t.ownerId) return fail('an agent cannot review its own work');
    if (reviewer.paused || reviewer.benched) return fail(`${reviewer.name} is unavailable`);
    if (this.strictReview && !t.checkResults) return fail('automated checks have not passed for this submission yet');
    const rubricError = this.checkRubric(t, verdict);
    if (rubricError) return fail(rubricError);
    const base = { goalId: t.goalId, taskId, agentId: reviewerId };
    const rubric = verdict.rubric ? { rubric: verdict.rubric.map((r) => ({ criterion: r.criterion, met: r.met, ...(r.note?.trim() ? { note: r.note.trim() } : {}) })) } : {};
    // With a rubric, the score is the share of criteria met, not the reviewer's say.
    const score = verdict.rubric?.length ? Math.round((100 * verdict.rubric.filter((r) => r.met).length) / verdict.rubric.length) / 100 : verdict.score;

    if (!verdict.passed) {
      if (!verdict.feedback?.trim()) return fail('a failed review needs feedback');
      this.emit('review.failed', { ...base, data: { score, feedback: verdict.feedback.trim(), ...rubric } });
      if (t.reviewAttempts >= this.limits.maxReviewAttempts) {
        this.escalateInternal(t, `failed its checks or review ${t.reviewAttempts} times`);
      }
      return ok({ state: t.state, execute: null });
    }

    this.emit('review.passed', { ...base, data: { score, feedback: verdict.feedback ?? '', ...rubric } });
    if (t.finalAction?.needsApproval) {
      this.emit('approval.requested', { goalId: t.goalId, taskId, agentId: t.ownerId, data: { action: t.finalAction } });
      return ok({ state: t.state, execute: null });
    }
    this.emit('task.done', { goalId: t.goalId, taskId, agentId: t.ownerId, data: { summary: t.summary, release: !!t.finalAction, startTracked: true } });
    return ok({ state: t.state, execute: toAction(t.finalAction) });
  }

  /** A rubric must judge each acceptance criterion exactly once and agree with the verdict. */
  private checkRubric(t: Task, verdict: ReviewVerdict): string | null {
    if (verdict.rubric === undefined) return this.strictReview ? 'a review needs a rubric: one item per acceptance criterion' : null;
    const items = verdict.rubric;
    if (
      !Array.isArray(items) ||
      !items.every((r) => r && typeof r.criterion === 'string' && typeof r.met === 'boolean' && (r.note === undefined || (typeof r.note === 'string' && r.note.length <= MAX_RUBRIC_NOTE)))
    ) {
      return `rubric items must be { criterion, met, note? } with a note of at most ${MAX_RUBRIC_NOTE} characters`;
    }
    const extra = items.filter((r) => !t.acceptanceCriteria.includes(r.criterion)).map((r) => r.criterion);
    if (extra.length) return `rubric item is not an acceptance criterion: ${extra.join('; ')}`;
    const missing = t.acceptanceCriteria.filter((c) => items.filter((r) => r.criterion === c).length !== 1);
    if (missing.length) return `rubric does not cover: ${missing.join('; ')} (one item each)`;
    const allMet = items.every((r) => r.met);
    if (verdict.passed && !allMet) return 'the verdict passes but a criterion is not met';
    if (!verdict.passed && allMet) return 'the verdict fails but every criterion is met';
    const bare = items.filter((r) => !r.met && !r.note?.trim()).map((r) => r.criterion);
    if (bare.length) return `an unmet criterion needs a note saying what is missing: ${bare.join('; ')}`;
    return null;
  }

  /** Gate 5: the CEO approves or rejects a tier-3 final action. */
  decideApproval(taskId: string, decision: { approved: boolean; note?: string }): Result<Outcome> {
    const t = this.tasks.get(taskId);
    if (!t) return fail(`unknown task "${taskId}"`);
    if (t.state !== 'awaiting_approval') return fail(`task is ${t.state}, not awaiting approval`);
    const base = { goalId: t.goalId, taskId, agentId: t.ownerId };

    if (decision.approved) {
      this.emit('approval.granted', { ...base, data: { note: decision.note ?? '' } });
      this.emit('task.done', { ...base, data: { summary: t.summary, release: !!t.finalAction, startTracked: true } });
      return ok({ state: t.state, execute: toAction(t.finalAction) });
    }
    if (!decision.note?.trim()) return fail('a rejection needs a note so the agent can revise');
    this.emit('approval.rejected', { ...base, data: { note: decision.note.trim() } });
    if (t.reviewAttempts >= this.limits.maxReviewAttempts) this.escalateInternal(t, `rejected ${t.reviewAttempts} times`);
    return ok({ state: t.state, execute: null });
  }

  /**
   * The gateway records that a released final action is about to run for the
   * first time, so after a crash an action that never started (held by the
   * kill switch, say) is run normally instead of being treated as interrupted.
   */
  recordActionStarted(taskId: string, idempotencyKey: string): Result<true> {
    const t = this.tasks.get(taskId);
    if (!t) return fail(`unknown task "${taskId}"`);
    if (t.state !== 'done' || !t.finalAction) return fail('task is not done with a released final action');
    if (t.finalAction.idempotencyKey !== idempotencyKey) return fail('idempotency key does not match the task\'s final action');
    if (t.actionResult) return fail('action result already recorded');
    if (!this.actionStarted.has(taskId)) this.emit('action.started', { goalId: t.goalId, taskId, agentId: t.ownerId, data: { idempotencyKey, tool: t.finalAction.tool } });
    return ok(true);
  }

  /**
   * The gateway records what happened to a released final action, once.
   * Never called by agents. A failed or interrupted action is recorded with
   * `ok: false` so the CEO can see it; it is not retried automatically.
   */
  recordActionResult(taskId: string, idempotencyKey: string, result: ActionResult): Result<true> {
    const t = this.tasks.get(taskId);
    if (!t) return fail(`unknown task "${taskId}"`);
    if (t.state !== 'done' || !t.finalAction) return fail('task is not done with a released final action');
    if (t.finalAction.idempotencyKey !== idempotencyKey) return fail('idempotency key does not match the task\'s final action');
    if (t.actionResult) return fail('action result already recorded');
    const data = { idempotencyKey, tool: t.finalAction.tool, detail: String(result.detail ?? ''), ...attemptsOf(result) };
    this.emit(result.ok ? 'action.executed' : 'action.failed', { goalId: t.goalId, taskId, agentId: t.ownerId, data });
    return ok(true);
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
      // Work stopped by the CEO is not stuck; resuming restarts its clock.
      if (this.companyPaused || this.agents.get(t.ownerId)?.paused) continue;
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
      if (goal.status === 'open') this.emit('goal.escalated', { goalId, data: { reason: 'goal budget exhausted' } });
      for (const t of this.tasks.values()) {
        if (t.goalId === goalId && (t.state === 'working' || t.state === 'assigned' || t.state === 'planned' || t.state === 'review')) {
          this.escalateInternal(t, 'goal budget exhausted');
        }
      }
    } else if (used >= this.limits.budgetWarnAt && !goal.warned) {
      this.emit('budget.warning', { goalId, data: { used: Math.round(used * 100) / 100 } });
    }
  }

  /** Pausing stops the stuck clock: on resume, working tasks count as active from now. */
  private restartActivityClock(at: number, ownerId?: string): void {
    for (const t of this.tasks.values()) {
      if (t.state === 'working' && (ownerId === undefined || t.ownerId === ownerId)) t.lastActivityAt = at;
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
      case 'agent.updated': {
        const a = this.agents.get(e.agentId!)!;
        a.name = d.profile.name;
        a.role = d.profile.role;
        a.model = d.profile.model;
        a.tools = [...d.profile.tools];
        break;
      }
      case 'agent.paused':
        this.agents.get(e.agentId!)!.paused = true;
        break;
      case 'agent.resumed':
        this.agents.get(e.agentId!)!.paused = false;
        this.restartActivityClock(e.at, e.agentId);
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
        this.restartActivityClock(e.at);
        break;
      case 'goal.created':
        // Older logs have no planning fields.
        this.goals.set(d.goal.id, { status: 'open', planRejections: 0, escalationReason: null, ...d.goal });
        break;
      case 'goal.step': {
        this.goals.get(e.goalId!)!.spentTokens += d.tokens;
        break;
      }
      case 'goal.escalated': {
        const goal = this.goals.get(e.goalId!)!;
        goal.status = 'escalated';
        goal.escalationReason = d.reason;
        break;
      }
      case 'plan.rejected': {
        const goal = this.goals.get(e.goalId!);
        if (goal) goal.planRejections += 1;
        break;
      }
      case 'plan.accepted': {
        for (const task of d.tasks as Task[]) {
          const copy = structuredClone(task);
          // Older logs have no artifacts or action results.
          copy.artifacts ??= [];
          copy.actionResult ??= null;
          copy.checkResults ??= null;
          copy.checkedFiles ??= null;
          copy.submissions ??= 0;
          copy.checkResets ??= 0;
          this.tasks.set(copy.id, copy);
        }
        const goal = this.goals.get(e.goalId!);
        if (goal) goal.status = 'planned';
        break;
      }
      case 'action.executed':
      case 'action.failed':
        t!.actionResult = { ok: e.type === 'action.executed', detail: d.detail, ...attemptsOf(d) };
        break;
      case 'action.started':
        this.actionStarted.add(t!.id);
        break;
      case 'tool.executed':
      case 'tool.failed':
        this.openToolCalls.delete(d.idempotencyKey);
        touch();
        break;
      case 'task.assigned':
        this.move(t!, 'assigned');
        t!.ownerId = d.ownerId;
        if (d.reset) {
          Object.assign(t!, { steps: 0, tokens: 0, startedAt: null, lastActivityAt: null, reviewAttempts: 0, summary: null, artifacts: [], finalAction: null, actionResult: null, escalationReason: null, checkResults: null, checkedFiles: null });
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
      case 'task.usage': {
        t!.tokens += d.tokens;
        const goal = this.goals.get(t!.goalId);
        if (goal) goal.spentTokens += d.tokens;
        break;
      }
      case 'budget.warning':
        this.goals.get(e.goalId!)!.warned = true;
        break;
      case 'tool.allowed': {
        this.usedKeys.add(d.idempotencyKey);
        if (d.tracked) this.openToolCalls.set(d.idempotencyKey, { taskId: e.taskId!, agentId: e.agentId!, tool: d.tool });
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
        t!.artifacts = [...(d.artifacts ?? [])];
        t!.finalAction = d.finalAction ?? null;
        t!.checkResults = null;
        t!.checkedFiles = null;
        t!.submissions += 1;
        t!.checkResets = 0;
        touch();
        break;
      case 'checks.passed':
        t!.checkResults = structuredClone(d.results);
        t!.checkedFiles = { ...(d.files ?? {}) };
        touch();
        break;
      case 'checks.reset':
        t!.checkResults = null;
        t!.checkedFiles = null;
        t!.checkResets += 1;
        break;
      case 'checks.failed':
        t!.checkResults = structuredClone(d.results);
        t!.reviewAttempts += 1;
        t!.lastFeedback = d.feedback;
        this.move(t!, 'working');
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
        if (d.startTracked) this.startTracked.add(t!.id);
        // Before M3a the server released actions without executing them, and
        // `task.done` had no release marker. Never run those on upgrade.
        if (t!.finalAction && !d.release && !t!.actionResult) {
          t!.actionResult = { ok: false, detail: 'released before the server executed final actions; it was not executed' };
        }
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

function attemptsOf(r: { attempts?: unknown }): { attempts?: number } {
  return Number.isInteger(r.attempts) && (r.attempts as number) > 0 ? { attempts: r.attempts as number } : {};
}

function toAction(fa: FinalAction | null): ProposedAction | null {
  return fa ? { tool: fa.tool, input: fa.input, idempotencyKey: fa.idempotencyKey } : null;
}
