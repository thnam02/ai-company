import { PolicyEngine } from '../src/policy.ts';
import { WorkflowEngine, type EngineOptions } from '../src/engine.ts';
import type { PlanTask } from '../src/plan.ts';
import type { Limits } from '../src/types.ts';

export const TOOLS = [
  { name: 'repo.read', tier: 0 as const },
  { name: 'github.create_branch', tier: 1 as const },
  { name: 'staging.deploy', tier: 2 as const },
  { name: 'social.schedule_post', tier: 2 as const },
  { name: 'email.send', tier: 3 as const },
  { name: 'prod.deploy', tier: 3 as const },
];

export function makePolicy() {
  return new PolicyEngine({ tools: TOOLS, autoApproveTier2: ['staging.deploy'] });
}

/** A small company with a fake clock and predictable ids. */
export function makeCompany(limits: Partial<Limits> = {}, extra: Partial<EngineOptions> = {}) {
  let clock = 1_000_000;
  let seq = 0;
  const options = {
    policy: makePolicy(),
    limits,
    now: () => clock,
    newId: () => `id${++seq}`,
    ...extra,
  };
  const engine = new WorkflowEngine(options);
  must(engine.registerAgent({ id: 'ava', name: 'Ava', kind: 'orchestrator', role: 'chief-of-staff', model: 'opus', tools: [] }));
  must(engine.registerAgent({ id: 'kai', name: 'Kai', kind: 'worker', role: 'backend-engineer', model: 'sonnet', tools: ['repo.read', 'github.create_branch', 'staging.deploy', 'prod.deploy'] }));
  must(engine.registerAgent({ id: 'omar', name: 'Omar', kind: 'worker', role: 'account-executive', model: 'sonnet', tools: ['repo.read', 'email.send'] }));
  must(engine.registerAgent({ id: 'rex', name: 'Rex', kind: 'reviewer', role: 'reviewer', model: 'opus', tools: [] }));
  return {
    engine,
    options,
    advance(ms: number) {
      clock += ms;
    },
  };
}

export function task(overrides: Partial<PlanTask> = {}): PlanTask {
  return {
    key: 'build',
    title: 'Build the landing page',
    acceptanceCriteria: ['Page renders', 'Tests pass'],
    ownerId: 'kai',
    requiredTools: ['repo.read'],
    costEstimateTokens: 10_000,
    ...overrides,
  };
}

export function must<T>(r: { ok: true; value: T } | { ok: false; error: string }): T {
  if (!r.ok) throw new Error(`expected ok, got: ${r.error}`);
  return r.value;
}

export const allMet = (criteria: string[]) => criteria.map((criterion) => ({ criterion, met: true }));

/** Goal + one-task plan, already started. */
export function startedTask(engine: WorkflowEngine, overrides: Partial<PlanTask> = {}, budget = 100_000) {
  const goal = must(engine.createGoal('Launch a landing page', budget));
  const [t] = must(engine.submitPlan(goal.id, 'ava', [task(overrides)]));
  must(engine.start(t.id, t.ownerId));
  return { goal, task: engine.getTask(t.id)! };
}
