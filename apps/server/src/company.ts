import { readFileSync } from 'node:fs';
import {
  DEFAULT_LIMITS,
  PolicyEngine,
  fail,
  ok,
  type AgentKind,
  type AgentProfile,
  type Limits,
  type Result,
  type RiskTier,
  type ToolSpec,
  type WorkflowEngine,
} from '@ai-company/core';
import { parseModelRef, type ModelOptions } from '@ai-company/agents';
import { DEFAULT_TOOL_SETTINGS, worstCaseCallMs, type ToolRegistry, type ToolSettings } from '@ai-company/gateway';

/**
 * Company configuration: tools with risk tiers, the tier-2 auto-approve list,
 * limits and the agent roster. Written by the CEO and read at boot; agents
 * can never change it at runtime.
 */
export interface CompanyConfig {
  tools: ToolSpec[];
  autoApproveTier2: string[];
  limits: Partial<Limits>;
  /** `model` is a "<provider>:<model>" ref, e.g. "ollama:qwen3:8b". */
  agents: Omit<AgentProfile, 'paused' | 'benched'>[];
  /** Per-agent model options. Runtime config only: never registered with the engine or logged as events. */
  modelOptions: Record<string, ModelOptions>;
  /** The CEO's notes per role ("how to do this job"), shown to agents with that role. */
  roleNotes: Record<string, string>;
  /** Per-tool gateway limits (timeout, attempts, rate); defaults for the rest. */
  toolSettings: Record<string, Partial<ToolSettings>>;
}

const TOOL_SETTING_CHECKS: Record<keyof ToolSettings, (v: unknown) => boolean> = {
  timeoutMs: (v) => Number.isInteger(v) && (v as number) >= 100 && (v as number) <= 600_000,
  maxAttempts: (v) => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 10,
  ratePerMinute: (v) => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 10_000,
};

const OPTION_CHECKS: Record<keyof ModelOptions, (v: unknown) => boolean> = {
  temperature: (v) => typeof v === 'number' && v >= 0 && v <= 2,
  numCtx: (v) => Number.isInteger(v) && (v as number) >= 512 && (v as number) <= 1_048_576,
  think: (v) => typeof v === 'boolean',
  maxTokens: (v) => Number.isInteger(v) && (v as number) >= 256 && (v as number) <= 131_072,
};

function parseModelOptions(agentId: string, raw: unknown): ModelOptions {
  if (raw === undefined) return {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`agent "${agentId}" options must be an object`);
  const options: ModelOptions = {};
  for (const [key, value] of Object.entries(raw)) {
    const check = OPTION_CHECKS[key as keyof ModelOptions];
    if (!check) throw new Error(`agent "${agentId}" has unknown option "${key}" (temperature, numCtx, think, maxTokens)`);
    if (!check(value)) throw new Error(`agent "${agentId}" option ${key} is invalid`);
    (options as Record<string, unknown>)[key] = value;
  }
  return options;
}

const KINDS: readonly AgentKind[] = ['orchestrator', 'worker', 'reviewer'];
const LIMIT_KEYS: readonly (keyof Limits)[] = [
  'maxSteps',
  'maxTokensPerTask',
  'maxWallMs',
  'maxReviewAttempts',
  'repeatedCallLimit',
  'stuckAfterMs',
  'circuitBreakerEscalations',
  'budgetWarnAt',
  'maxReplans',
];

export function loadCompanyConfig(path: string): CompanyConfig {
  return parseCompanyConfig(JSON.parse(readFileSync(path, 'utf8')));
}

/** Validates config at boot. Bad config is an operator error, so this throws. */
export function parseCompanyConfig(raw: unknown): CompanyConfig {
  const c = raw as Record<string, unknown>;
  if (!c || typeof c !== 'object') throw new Error('company config must be an object');
  if (!Array.isArray(c.tools)) throw new Error('company config needs a "tools" array');
  if (!Array.isArray(c.agents)) throw new Error('company config needs an "agents" array');

  const toolSettings: Record<string, Partial<ToolSettings>> = {};
  const tools: ToolSpec[] = c.tools.map((t: any, i: number) => {
    if (typeof t?.name !== 'string' || !t.name) throw new Error(`tools[${i}] needs a name`);
    if (![0, 1, 2, 3].includes(t.tier)) throw new Error(`tool "${t.name}" needs a tier of 0, 1, 2 or 3`);
    for (const key of Object.keys(t)) {
      if (!['name', 'tier', 'description', ...Object.keys(TOOL_SETTING_CHECKS)].includes(key)) {
        throw new Error(`tool "${t.name}" has unknown field "${key}" (description, timeoutMs, maxAttempts, ratePerMinute)`);
      }
    }
    for (const [key, check] of Object.entries(TOOL_SETTING_CHECKS) as [keyof ToolSettings, (v: unknown) => boolean][]) {
      if (t[key] === undefined) continue;
      if (!check(t[key])) throw new Error(`tool "${t.name}" ${key} is out of range`);
      (toolSettings[t.name] ??= {})[key] = t[key];
    }
    return { name: t.name, tier: t.tier as RiskTier, ...(typeof t.description === 'string' ? { description: t.description } : {}) };
  });

  const autoApproveTier2 = c.autoApproveTier2 ?? [];
  if (!Array.isArray(autoApproveTier2) || !autoApproveTier2.every((s) => typeof s === 'string')) {
    throw new Error('"autoApproveTier2" must be an array of tool names');
  }

  const limits: Partial<Limits> = {};
  if (c.limits !== undefined) {
    if (typeof c.limits !== 'object' || c.limits === null) throw new Error('"limits" must be an object');
    for (const [key, value] of Object.entries(c.limits)) {
      if (!LIMIT_KEYS.includes(key as keyof Limits)) throw new Error(`unknown limit "${key}"`);
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new Error(`limit "${key}" must be a positive number`);
      limits[key as keyof Limits] = value;
    }
  }

  const ids = new Set<string>();
  const modelOptions: Record<string, ModelOptions> = {};
  const agents = c.agents.map((a: any, i: number) => {
    for (const field of ['id', 'name', 'role', 'model'] as const) {
      if (typeof a?.[field] !== 'string' || !a[field]) throw new Error(`agents[${i}] needs a "${field}"`);
    }
    if (!parseModelRef(a.model)) throw new Error(`agent "${a.id}" model must be "<provider>:<model>", e.g. "ollama:qwen3:8b"`);
    modelOptions[a.id] = parseModelOptions(a.id, a.options);
    if (!KINDS.includes(a.kind)) throw new Error(`agent "${a.id}" has unknown kind "${a.kind}"`);
    if (!Array.isArray(a.tools) || !a.tools.every((t: unknown) => typeof t === 'string')) throw new Error(`agent "${a.id}" needs a "tools" array`);
    if (a.kind !== 'worker' && a.tools.length) throw new Error(`agent "${a.id}" is a ${a.kind}; only workers get tools`);
    if (ids.has(a.id)) throw new Error(`duplicate agent id "${a.id}"`);
    ids.add(a.id);
    return { id: a.id, name: a.name, kind: a.kind as AgentKind, role: a.role, model: a.model, tools: [...a.tools] };
  });

  const toolNames = new Set(tools.map((t) => t.name));
  for (const a of agents) {
    const unknown = a.tools.filter((t: string) => !toolNames.has(t));
    if (unknown.length) throw new Error(`agent "${a.id}" lists unknown tools: ${unknown.join(', ')}`);
  }

  const roleNotes: Record<string, string> = {};
  if (c.roles !== undefined) {
    if (typeof c.roles !== 'object' || c.roles === null || Array.isArray(c.roles)) throw new Error('"roles" must be an object of role → notes');
    for (const [role, notes] of Object.entries(c.roles)) {
      if (typeof notes !== 'string' || notes.length > 4_000) throw new Error(`notes for role "${role}" must be text of at most 4000 characters`);
      roleNotes[role] = notes;
    }
  }

  // A call (every attempt, backoff and rate-limit wait) must end before the
  // stuck timer could escalate its task for silence. Other limits (wall time,
  // budget) can still end a task mid-call; its result is then recorded late.
  const stuckAfterMs = limits.stuckAfterMs ?? DEFAULT_LIMITS.stuckAfterMs;
  for (const t of tools) {
    const worst = worstCaseCallMs({ ...DEFAULT_TOOL_SETTINGS, ...toolSettings[t.name] });
    if (worst >= stuckAfterMs) {
      throw new Error(`tool "${t.name}": one call can take up to ${worst} ms with its timeout, attempts and rate limit; it must be under the stuckAfterMs limit (${stuckAfterMs})`);
    }
  }

  const config: CompanyConfig = { tools, autoApproveTier2: [...autoApproveTier2], limits, agents, modelOptions, roleNotes, toolSettings };
  buildPolicy(config); // throws on duplicate tools or a bad auto-approve entry
  return config;
}

/**
 * Checks the config against the tools this server can run. An auto-approved
 * tier-2 tool runs during work, and a worker's turn redone after a crash gets
 * new keys, so until pending calls are checkpointed with their keys (ADR
 * 0004) only a tool that dedupes by key may be auto-approved.
 */
export function checkExecutors(config: CompanyConfig, tools: ToolRegistry): void {
  for (const name of config.autoApproveTier2) {
    const executor = tools.get(name);
    if (executor && !executor.dedupesByKey) {
      throw new Error(`"${name}" is auto-approved but cannot detect a repeated call; remove it from autoApproveTier2 (ADR 0004)`);
    }
  }
}

export function buildPolicy(config: CompanyConfig): PolicyEngine {
  return new PolicyEngine({ tools: config.tools, autoApproveTier2: config.autoApproveTier2 });
}

export interface BootstrapReport {
  registered: string[];
  /** Agents in the log whose name, role, model or tools were changed to match the config. */
  updated: string[];
  /** Agents in the log but no longer in the config: tools revoked and paused. Re-adding one leaves it paused for the CEO to resume. */
  retired: string[];
}

/**
 * Brings the agent roster in line with the CEO's config, through engine
 * commands: new agents are registered, changed ones updated (so a revoked
 * tool is revoked), and agents no longer in the config lose all tools and
 * are paused. Fails closed: a kind change stops the boot rather than running
 * with a roster the CEO did not write. Call it inside the server's `run` and
 * throw on failure, so a failed bootstrap writes nothing.
 */
export function bootstrapAgents(engine: WorkflowEngine, config: CompanyConfig): Result<BootstrapReport> {
  const report: BootstrapReport = { registered: [], updated: [], retired: [] };
  // Check everything before emitting anything, so a bad config changes nothing.
  for (const agent of config.agents) {
    const existing = engine.getAgent(agent.id);
    if (existing && existing.kind !== agent.kind) {
      return fail(`agent "${agent.id}" is a ${existing.kind} in the log; config says ${agent.kind}. Kinds cannot change; use a new id.`);
    }
  }
  for (const agent of config.agents) {
    const existing = engine.getAgent(agent.id);
    if (existing) {
      const before = engine.store.size;
      const r = engine.updateAgent(agent.id, { name: agent.name, role: agent.role, model: agent.model, tools: agent.tools });
      if (!r.ok) return fail(`cannot update agent "${agent.id}": ${r.error}`);
      if (engine.store.size > before) report.updated.push(agent.id);
      continue;
    }
    const r = engine.registerAgent(agent);
    if (!r.ok) return fail(`cannot register agent "${agent.id}": ${r.error}`);
    report.registered.push(agent.id);
  }
  // Deleting an agent from the config must take its access away, not leave it running.
  const configured = new Set(config.agents.map((a) => a.id));
  for (const agent of engine.listAgents()) {
    if (configured.has(agent.id)) continue;
    const before = engine.store.size;
    const revoked = engine.updateAgent(agent.id, { tools: [] });
    if (!revoked.ok) return fail(`cannot retire agent "${agent.id}": ${revoked.error}`);
    const paused = engine.pauseAgent(agent.id);
    if (!paused.ok) return fail(`cannot retire agent "${agent.id}": ${paused.error}`);
    if (engine.store.size > before) report.retired.push(agent.id);
  }
  return ok(report);
}
