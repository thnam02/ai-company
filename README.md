# AI Company

A workspace where AI agents work as employees in a 3D office. You are the CEO: you give a goal to **Ava**, the orchestrator, who splits it into tasks for worker agents in Engineering, Marketing, Sales and Support. A reviewer agent checks the work, and anything risky waits for your approval.

The core rule: **LLMs propose, deterministic code decides.** Agents can't change state, call a tool or spend money on their own; every action goes through a control plane that enforces permissions, budgets, quality gates and approvals.

## Status

| Part | Where | Status |
| --- | --- | --- |
| Control plane: workflow engine, policy, limits, event log | `packages/core` | ✅ Done, 71 tests |
| 3D office UI | `apps/office` | 🟡 Prototype with simulated agents |
| Server, SQLite or Postgres, WebSocket | `apps/server` | ✅ Done, 100 tests (85 without Postgres) |
| Agent runtime: orchestrator, workers, reviewer on Ollama or Claude models | `packages/agents` | ✅ Done, 18 tests plus end-to-end server tests with scripted models (M3a); the test team passes live on `qwen3:8b` (M3b) |
| Tool gateway: runs every tool after the engine allows it, records results, holds credentials, timeouts, retries, rate limits | `packages/gateway` | ✅ Done, 42 tests (M4, M5) |
| Reviewer rubric and automated checks (content, email) before review | `packages/gateway`, `packages/agents` | ✅ Done (M5); code checks come with M7 |

Full plan: [`docs/roadmap.md`](docs/roadmap.md) · Design: [`docs/architecture.md`](docs/architecture.md)

## Quick start

Requires Node 22.18 or newer (runs TypeScript directly, no build step).

```bash
npm install
npm test             # all tests; Postgres store tests are skipped unless DATABASE_URL is set
npm run typecheck
npm run office       # serve the 3D office prototype, then open the printed URL
```

To run the server (no database server needed; the event log is a SQLite file at `./data/company.db`):

```bash
export CEO_TOKEN=$(openssl rand -hex 24)
npm run server       # http://127.0.0.1:4100; call it with "Authorization: Bearer $CEO_TOKEN"
```

The agents start with the server. They need [Ollama](https://ollama.com) running with `ollama pull qwen3:8b`; until it is, they wait and retry. Set `AGENTS=off` to run the server without them, and `ANTHROPIC_API_KEY` to let agents use `claude:` models.

Agents work only inside `./workspace` (set `WORKSPACE_DIR` to change it). The fake `email.send` writes emails to `workspace/outbox/` instead of sending them, and only after you approve them.

Agents never run tools themselves: the tool gateway runs every call after the control plane allows it and records the result. Timeouts, retries and rate limits are set per tool in the company config. Tool logins go in `data/credentials.json` (`{ "name": "value" }`, readable only by you: `chmod 600`). They never reach an agent, an event or a log.

To use Postgres instead, set `DATABASE_URL` (e.g. `postgres://localhost/ai_company`). To run the Postgres store tests, and the crash/restart tests against Postgres as well as SQLite, point `DATABASE_URL` at a disposable database (each test uses its own schema and drops it).

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

engine.registerAgent({ id: 'ava', name: 'Ava', kind: 'orchestrator', role: 'chief-of-staff', model: 'ollama:qwen3:8b', tools: [] });
engine.registerAgent({ id: 'omar', name: 'Omar', kind: 'worker', role: 'account-executive', model: 'ollama:qwen3:8b', tools: ['repo.read', 'email.send'] });
engine.registerAgent({ id: 'rex', name: 'Rex', kind: 'reviewer', role: 'reviewer', model: 'ollama:qwen3:8b', tools: [] });

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

Start a session in the repo root and run `/milestone` to build the next milestone.

## Repo layout

```
packages/core/   control plane (engine, policy, plan validation, state machine, event log) + tests
packages/agents/ agent runtime: model providers (Ollama, scripted), workspace tools, orchestrator/worker/reviewer loops + tests
apps/server/     SQLite (default) and Postgres event stores, CEO HTTP API, WebSocket event stream, stuck timer, agent port + tests
apps/office/     3D office prototype (Three.js, single file)
docs/            architecture, roadmap, decision records
.claude/         Claude Code commands, subagent and permissions
```
