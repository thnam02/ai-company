import type {
  AgentProfile,
  Goal,
  PlanTask,
  ProposedAction,
  Result,
  ReviewVerdict,
  RiskTier,
  Submission,
  Task,
  TaskState,
  ToolCallDecision,
} from '@ai-company/core';

/** call: allowed during work · final: may only be proposed as the task's final action. */
export type ToolAccess = 'call' | 'final';

export interface AgentView extends AgentProfile {
  /** What policy lets this agent do with each tool on its allowlist. */
  toolAccess: Record<string, ToolAccess>;
}

export interface ToolInfo {
  name: string;
  tier: RiskTier;
  description?: string;
}

/** A read-only, durable snapshot of the company. */
export interface CompanyView {
  seq: number;
  companyPaused: boolean;
  agents: AgentView[];
  goals: Goal[];
  tasks: Task[];
  tools: ToolInfo[];
}

/**
 * Everything an agent may do to the company, and nothing more (ADR 0003).
 * Each method is one engine command run through the server's command queue,
 * so it resolves only once its events are durable. There are no CEO
 * commands here (approvals, escalation resolution, unbench, config, the kill
 * switch), and final actions are executed by the server, never by agents.
 */
export interface AgentPort {
  view(): Promise<CompanyView>;
  submitPlan(goalId: string, orchestratorId: string, plan: PlanTask[]): Promise<Result<Task[]>>;
  start(taskId: string, agentId: string): Promise<Result<TaskState>>;
  recordStep(taskId: string, agentId: string, tokens: number): Promise<Result<TaskState>>;
  recordGoalStep(goalId: string, agentId: string, tokens: number): Promise<Result<true>>;
  requestToolCall(taskId: string, agentId: string, call: ProposedAction): Promise<Result<ToolCallDecision>>;
  submitForReview(taskId: string, agentId: string, submission: Submission): Promise<Result<TaskState>>;
  recordReview(taskId: string, reviewerId: string, verdict: ReviewVerdict): Promise<Result<TaskState>>;
  /** A worker gives up on its own task; the CEO sees the reason. */
  escalate(taskId: string, agentId: string, reason: string): Promise<Result<TaskState>>;
}

/** The method names of AgentPort: the allowlist, checked by the server's tests. */
export const AGENT_PORT_METHODS = [
  'view',
  'submitPlan',
  'start',
  'recordStep',
  'recordGoalStep',
  'requestToolCall',
  'submitForReview',
  'recordReview',
  'escalate',
] as const satisfies readonly (keyof AgentPort)[];
