/**
 * Core domain types for the AI Company control plane.
 *
 * Rule of thumb: LLM agents only ever *propose* (plans, tool calls, outputs,
 * reviews). The WorkflowEngine — plain deterministic code — decides.
 */

/** Lifecycle of a task. See docs/architecture.md § Task lifecycle. */
export type TaskState =
  | 'planned'
  | 'assigned'
  | 'working'
  | 'review'
  | 'awaiting_approval'
  | 'done'
  | 'escalated'
  | 'cancelled';

/**
 * Risk tier of a tool.
 * 0 = read · 1 = internal write · 2 = external but reversible · 3 = irreversible or costs money
 */
export type RiskTier = 0 | 1 | 2 | 3;

/** What kind of agent this is. Only workers may call real-world tools or own tasks. */
export type AgentKind = 'orchestrator' | 'worker' | 'reviewer';

export interface AgentProfile {
  id: string;
  name: string;
  kind: AgentKind;
  /** Role template name, e.g. "backend-engineer". */
  role: string;
  /** Model id, e.g. "claude-sonnet-5-5". */
  model: string;
  /** Tool allowlist for this agent. Anything not listed is denied. */
  tools: string[];
  paused: boolean;
  /** Set by the circuit breaker; only the CEO can un-bench. */
  benched: boolean;
}

export interface ToolSpec {
  name: string;
  tier: RiskTier;
  description?: string;
}

export interface Limits {
  /** Max agent steps (model turns) per task before escalation. */
  maxSteps: number;
  /** Max tokens one task may consume before escalation. */
  maxTokensPerTask: number;
  /** Max wall-clock time a task may spend in `working`. */
  maxWallMs: number;
  /** Failed reviews / rejected approvals allowed before escalation. */
  maxReviewAttempts: number;
  /** Identical tool calls in a row that count as a loop. */
  repeatedCallLimit: number;
  /** No activity for this long while `working` = stuck. */
  stuckAfterMs: number;
  /** Consecutive escalations before an agent is benched. */
  circuitBreakerEscalations: number;
  /** Goal budget fraction that triggers a warning. */
  budgetWarnAt: number;
  /** Rejected plans allowed after the first one before the goal is escalated. */
  maxReplans: number;
}

/** open: waiting for a plan · planned: a plan was accepted · escalated: the CEO must step in. */
export type GoalStatus = 'open' | 'planned' | 'escalated';

export interface Goal {
  id: string;
  text: string;
  budgetTokens: number;
  spentTokens: number;
  warned: boolean;
  status: GoalStatus;
  planRejections: number;
  escalationReason: string | null;
}

/** Outcome of executing a released final action, recorded once. */
export interface ActionResult {
  ok: boolean;
  detail: string;
}

/** An action that has a real-world effect, executed by the tool gateway. */
export interface ProposedAction {
  tool: string;
  input: unknown;
  /** Unique per real-world effect; the gateway must never execute a key twice. */
  idempotencyKey: string;
}

export interface FinalAction extends ProposedAction {
  /** Decided by policy at submit time: tier-3 (or non-auto tier-2) actions need the CEO. */
  needsApproval: boolean;
}

export interface Task {
  id: string;
  goalId: string;
  title: string;
  acceptanceCriteria: string[];
  requiredTools: string[];
  dependsOn: string[];
  costEstimateTokens: number;
  ownerId: string;
  state: TaskState;
  steps: number;
  tokens: number;
  startedAt: number | null;
  lastActivityAt: number | null;
  reviewAttempts: number;
  summary: string | null;
  /** Workspace paths the submitted work produced, shown to the reviewer. */
  artifacts: string[];
  finalAction: FinalAction | null;
  /** Set once the released final action has been executed (or given up on). */
  actionResult: ActionResult | null;
  lastFeedback: string | null;
  escalationReason: string | null;
}

/** Every state change is one of these, appended to the event log. */
export interface EngineEvent {
  seq: number;
  at: number;
  type: string;
  goalId?: string;
  taskId?: string;
  agentId?: string;
  // Event payloads are plain JSON; the reducer in engine.ts knows each shape.
  data?: Record<string, any>;
}

export type NewEvent = Omit<EngineEvent, 'seq'>;

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const fail = <T = never>(error: string): Result<T> => ({ ok: false, error });
