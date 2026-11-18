import { WorkflowEngine } from '@ai-company/core';
import { buildPolicy, bootstrapAgents, parseCompanyConfig, type CompanyConfig } from '../src/company.ts';

/** A small company: one orchestrator, two workers, one reviewer. */
export const TEST_CONFIG: CompanyConfig = parseCompanyConfig({
  tools: [
    { name: 'repo.read', tier: 0 },
    { name: 'github.create_branch', tier: 1 },
    { name: 'staging.deploy', tier: 2 },
    { name: 'email.send', tier: 3 },
  ],
  autoApproveTier2: ['staging.deploy'],
  agents: [
    { id: 'ava', name: 'Ava', kind: 'orchestrator', role: 'chief-of-staff', model: 'ollama:qwen3:8b', tools: [] },
    { id: 'kai', name: 'Kai', kind: 'worker', role: 'backend-engineer', model: 'ollama:qwen3:8b', tools: ['repo.read', 'github.create_branch', 'staging.deploy'] },
    { id: 'omar', name: 'Omar', kind: 'worker', role: 'account-executive', model: 'ollama:qwen3:8b', tools: ['repo.read', 'email.send'] },
    { id: 'rex', name: 'Rex', kind: 'reviewer', role: 'reviewer', model: 'ollama:qwen3:8b', tools: [] },
  ],
});

export const makePolicy = () => buildPolicy(TEST_CONFIG);

export function registerTestAgents(engine: WorkflowEngine): void {
  const r = bootstrapAgents(engine, TEST_CONFIG);
  if (!r.ok) throw new Error(r.error);
}

export function must<T>(r: { ok: true; value: T } | { ok: false; error: string }): T {
  if (!r.ok) throw new Error(`expected ok, got: ${r.error}`);
  return r.value;
}

export const allMet = (criteria: string[]) => criteria.map((criterion) => ({ criterion, met: true }));
