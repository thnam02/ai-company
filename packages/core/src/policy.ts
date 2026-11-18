import type { AgentProfile, RiskTier, ToolSpec } from './types.ts';

export type PolicyDecision =
  | { kind: 'allow'; tier: RiskTier }
  | { kind: 'needs_approval'; tier: RiskTier; reason: string }
  | { kind: 'deny'; reason: string };

export interface PolicyConfig {
  tools: ToolSpec[];
  /** Tier-2 tools that may run without approval (e.g. "staging.deploy"). */
  autoApproveTier2?: string[];
}

/**
 * Decides whether an agent may call a tool. Pure and deterministic:
 * the same agent + tool always gets the same answer. Policies are
 * versioned config changed by the CEO, never by an agent.
 */
export class PolicyEngine {
  private readonly tools = new Map<string, ToolSpec>();
  private readonly autoTier2: Set<string>;

  constructor(config: PolicyConfig) {
    for (const t of config.tools) {
      if (this.tools.has(t.name)) throw new Error(`Duplicate tool: ${t.name}`);
      this.tools.set(t.name, t);
    }
    this.autoTier2 = new Set(config.autoApproveTier2 ?? []);
    for (const name of this.autoTier2) {
      const t = this.tools.get(name);
      if (!t || t.tier !== 2) throw new Error(`autoApproveTier2 entry must be a known tier-2 tool: ${name}`);
    }
  }

  getTool(name: string): ToolSpec | undefined {
    return this.tools.get(name);
  }

  hasTool(name: string): boolean {
    return this.tools.has(name);
  }

  check(agent: AgentProfile, toolName: string): PolicyDecision {
    const tool = this.tools.get(toolName);
    if (!tool) return { kind: 'deny', reason: `unknown tool "${toolName}"` };
    if (agent.kind !== 'worker') return { kind: 'deny', reason: `${agent.kind} agents cannot call real-world tools` };
    if (agent.benched) return { kind: 'deny', reason: `${agent.name} is benched` };
    if (agent.paused) return { kind: 'deny', reason: `${agent.name} is paused` };
    if (!agent.tools.includes(toolName)) {
      return { kind: 'deny', reason: `"${toolName}" is not in ${agent.name}'s allowlist` };
    }
    if (tool.tier <= 1) return { kind: 'allow', tier: tool.tier };
    if (tool.tier === 2 && this.autoTier2.has(toolName)) return { kind: 'allow', tier: tool.tier };
    return { kind: 'needs_approval', tier: tool.tier, reason: `tier-${tool.tier} action "${toolName}" requires CEO approval` };
  }
}
