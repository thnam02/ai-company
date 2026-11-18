# AI Company

A workspace where AI agents work as employees in a 3D office. You are the CEO: you give a goal to **Ava**, the orchestrator, who splits it into tasks for worker agents in Engineering, Marketing, Sales and Support. A reviewer agent checks the work, and anything risky waits for your approval.

The core rule: **LLMs propose, deterministic code decides.** Agents can't change state, call a tool or spend money on their own; every action goes through a control plane that enforces permissions, budgets, quality gates and approvals.

## Status

| Part | Where | Status |
| --- | --- | --- |
| Control plane: workflow engine, policy, limits, event log | `packages/core` | ✅ Done, 35 tests |
| 3D office UI | `apps/office` | 🟡 Prototype with simulated agents |
| Server, Postgres, WebSocket | `apps/server` | ⬜ Milestone 2 |
| Real agents (Claude Agent SDK) | `packages/agents` | ⬜ Milestone 3 |
| Tool gateway | `packages/gateway` | ⬜ Milestone 4 |

Full plan: [`docs/roadmap.md`](docs/roadmap.md) · Design: [`docs/architecture.md`](docs/architecture.md)

## Quick start

Requires Node 22.18 or newer (runs TypeScript directly, no build step).

```bash
npm install          # only dev tools (typescript, @types/node)
npm test             # run the control-plane tests
npm run typecheck
npm run office       # serve the 3D office prototype, then open the printed URL
```

You can also open `apps/office/index.html` directly in a browser.

## How the control plane works

```ts
import { PolicyEngine, WorkflowEngine } from '@ai-company/core';

const policy = new PolicyEngine({
  tools: [
    { name: 'repo.read', tier: 0 },
    { name: 'email.send', tier: 3 },
  ],
});
const engine = new WorkflowEngine({ policy });

engine.registerAgent({ id: 'ava', name: 'Ava', kind: 'orchestrator', role: 'chief-of-staff', model: 'claude-opus-5-5', tools: [] });
engine.registerAgent({ id: 'omar', name: 'Omar', kind: 'worker', role: 'account-executive', model: 'claude-sonnet-5-5', tools: ['repo.read', 'email.send'] });
engine.registerAgent({ id: 'rex', name: 'Rex', kind: 'reviewer', role: 'reviewer', model: 'claude-opus-5-5', tools: [] });

const goal = engine.createGoal('Send a proposal to Acme', 50_000);
// The orchestrator's plan is validated (gate 1) before any task exists.
const plan = engine.submitPlan(goal.value.id, 'ava', [{
  key: 'proposal', title: 'Write and send the Acme proposal', ownerId: 'omar',
  acceptanceCriteria: ['Mentions pricing', 'Under 200 words'], requiredTools: ['email.send'], costEstimateTokens: 20_000,
}]);

// Workers ask before every tool call; sending email (tier 3) is refused during work…
// …so it is proposed as the task's final action, reviewed, then released only after CEO approval:
// engine.submitForReview(...) → engine.recordReview(...) → engine.decideApproval(taskId, { approved: true })
```

Every command returns `{ ok, value }` or `{ ok: false, error }`, and every state change is an event in `engine.store`, so the whole company can be rebuilt with `WorkflowEngine.fromEvents(events, { policy })`.

## Working on this repo with Claude Code

This repo is set up for [Claude Code](https://claude.com/claude-code):

- `CLAUDE.md` holds the architecture rules and invariants Claude follows.
- `/milestone` builds the next milestone from the roadmap, test-first.
- `/safety-review` checks your changes against the invariants.
- The `architecture-guard` subagent reviews diffs for anything that lets an agent bypass the control plane.

Start a session in the repo root and run `/milestone` to build Milestone 2.

## Repo layout

```
packages/core/   control plane (engine, policy, plan validation, state machine, event log) + tests
apps/office/     3D office prototype (Three.js, single file)
docs/            architecture, roadmap, decision records
.claude/         Claude Code commands, subagent and permissions
```
