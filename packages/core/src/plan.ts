import type { AgentProfile, Goal } from './types.ts';
import type { PolicyEngine } from './policy.ts';

/** One task as proposed by the orchestrator. `key` is local to the plan. */
export interface PlanTask {
  key: string;
  title: string;
  acceptanceCriteria: string[];
  ownerId: string;
  requiredTools: string[];
  dependsOn?: string[];
  costEstimateTokens: number;
}

export interface PlanContext {
  goal: Goal;
  agents: ReadonlyMap<string, AgentProfile>;
  policy: PolicyEngine;
}

/**
 * Gate 1: plan validation. Returns a list of problems (empty = valid).
 * The orchestrator's plan is rejected — and it must re-plan — if any check fails.
 */
export function validatePlan(plan: readonly PlanTask[], ctx: PlanContext): string[] {
  const errors: string[] = [];
  if (!Array.isArray(plan) || plan.length === 0) return ['plan has no tasks'];

  const keys = new Set<string>();
  for (const t of plan) {
    const label = `task "${t.key}"`;
    if (!t.key) errors.push('a task has no key');
    else if (keys.has(t.key)) errors.push(`duplicate task key "${t.key}"`);
    keys.add(t.key);

    if (!t.title?.trim()) errors.push(`${label} has no title`);
    if (!Array.isArray(t.acceptanceCriteria) || t.acceptanceCriteria.filter((c: string) => c?.trim()).length === 0) {
      errors.push(`${label} has no acceptance criteria`);
    }
    if (!Number.isFinite(t.costEstimateTokens) || t.costEstimateTokens <= 0) {
      errors.push(`${label} needs a positive cost estimate`);
    }

    const owner = ctx.agents.get(t.ownerId);
    if (!owner) {
      errors.push(`${label} owner "${t.ownerId}" does not exist`);
    } else {
      if (owner.kind !== 'worker') errors.push(`${label} owner ${owner.name} is a ${owner.kind}, not a worker`);
      if (owner.benched) errors.push(`${label} owner ${owner.name} is benched`);
      for (const tool of t.requiredTools ?? []) {
        if (!ctx.policy.hasTool(tool)) errors.push(`${label} requires unknown tool "${tool}"`);
        else if (!owner.tools.includes(tool)) errors.push(`${label} owner ${owner.name} lacks tool "${tool}"`);
      }
    }
  }

  for (const t of plan) {
    for (const dep of t.dependsOn ?? []) {
      if (dep === t.key) errors.push(`task "${t.key}" depends on itself`);
      else if (!keys.has(dep)) errors.push(`task "${t.key}" depends on unknown task "${dep}"`);
    }
  }

  const cycle = findCycle(plan);
  if (cycle) errors.push(`dependency cycle: ${cycle.join(' -> ')}`);

  const total = plan.reduce((sum, t) => sum + (Number.isFinite(t.costEstimateTokens) ? t.costEstimateTokens : 0), 0);
  const remaining = ctx.goal.budgetTokens - ctx.goal.spentTokens;
  if (total > remaining) errors.push(`plan estimate ${total} tokens exceeds remaining goal budget ${remaining}`);

  return errors;
}

function findCycle(plan: readonly PlanTask[]): string[] | null {
  const deps = new Map(plan.map((t) => [t.key, (t.dependsOn ?? []).filter((d) => d !== t.key)]));
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];

  const visit = (key: string): string[] | null => {
    if (state.get(key) === 'done') return null;
    if (state.get(key) === 'visiting') return [...stack.slice(stack.indexOf(key)), key];
    state.set(key, 'visiting');
    stack.push(key);
    for (const d of deps.get(key) ?? []) {
      if (!deps.has(d)) continue;
      const found = visit(d);
      if (found) return found;
    }
    stack.pop();
    state.set(key, 'done');
    return null;
  };

  for (const key of deps.keys()) {
    const found = visit(key);
    if (found) return found;
  }
  return null;
}
