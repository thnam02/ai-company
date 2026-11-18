# AI Company — guide for Claude Code

An AI company workspace: AI agents work as employees in a 3D office. A CEO (the user) gives goals to an orchestrator agent, which plans tasks for worker agents; a reviewer agent checks the work. Read `docs/architecture.md` for the full design and `docs/roadmap.md` for what to build next.

## The one rule

**LLMs propose, deterministic code decides.** Agents never change state, call a tool or spend money directly. Every action goes through `WorkflowEngine` in `packages/core`. If a change would let an agent bypass the engine, it is wrong — stop and ask.

## Invariants (never break these)

1. All task state changes happen by emitting events through `WorkflowEngine`; state is only ever built by the reducer `apply()`. No other code mutates tasks, goals or agents.
2. Every real-world tool call is checked with `engine.requestToolCall` first. Execute only on `{ kind: 'allow' }`; never on `duplicate`; never when `ok: false`.
3. Tier-3 actions (and tier-2 not on `autoApproveTier2`) never run during work. They are proposed as a task's `finalAction` and executed only from the `execute` field returned by `recordReview` or `decideApproval`.
4. Every tool call and final action has an idempotency key, and the gateway never executes the same key twice.
5. Only workers own tasks and call tools. Orchestrators plan; reviewers review; neither calls real-world tools. An agent never reviews its own work.
6. Credentials never enter prompts, agent context, event data or logs.
7. Every agent model turn is recorded with `recordStep` (real token counts), so limits and budgets hold.
8. Engine commands return `Result` (`{ ok: false, error }`) for bad agent input instead of throwing. Throwing is only for programmer errors (illegal transitions in `apply`).
9. The reducer stays deterministic: no clock reads, randomness or I/O inside `apply()`; times and ids come from the event.
10. Policies, limits and role templates are config changed by the CEO, never by an agent at runtime.

## Repo map

```
packages/core/        control plane (done): engine, policy, plan validation, state machine, event log
  src/engine.ts       WorkflowEngine — commands + reducer + limits
  src/policy.ts       risk tiers and allowlists
  src/plan.ts         gate-1 plan validation
  src/state-machine.ts legal transitions
  src/event-log.ts    EventStore interface + in-memory store
  test/               node:test suites (helpers.ts builds a small test company)
apps/server/          server (done): Postgres event store, CEO HTTP API, WebSocket stream, stuck timer
  src/app.ts          HTTP routes + the command queue `run()` (durable before visible, ADR 0002)
  src/pg-event-store.ts append-only Postgres log, single writer
  config/company.json tools, tiers, limits, agent roster (CEO config)
apps/office/          3D office prototype (Three.js, single HTML file, simulated agents)
docs/                 architecture.md, roadmap.md, decisions/ (ADRs)
.claude/              commands and subagents for working on this repo
```

Planned (see roadmap): `packages/agents` (agent loops on the Claude Agent SDK), `packages/gateway` (tool execution).

## Commands

- `npm test` — run all tests (Node ≥ 22.18 runs `.ts` directly; no build step). Set `DATABASE_URL` to a disposable Postgres database to include the Postgres and crash/restart tests.
- `npm run typecheck` — `tsc` strict type check
- `npm run server` — start the server (needs `DATABASE_URL` and `CEO_TOKEN`)
- `npm run office` — serve the 3D office prototype

## Conventions

- TypeScript, ESM, strict. Only erasable syntax (no `enum`, no `namespace`, no constructor parameter properties) so Node can strip types. Import local files with the `.ts` extension; use `import type` for types.
- Keep `packages/core` dependency-free and free of I/O and LLM calls.
- In `apps/server`, everything that leaves the process (responses, stream messages, gateway actions) goes through the command queue `run()`, which waits for the Postgres commit first. Build the response inside the function passed to `run()`; never read engine state after the await.
- Agent code calls engine commands only through `run()` and acts on a result (e.g. a tool `allow`) only after `run()` resolves.
- New behaviour starts with a failing test in the matching `test/*.test.ts`. Use `makeCompany()` and `startedTask()` from `test/helpers.ts`.
- A new event type needs: an emit in a command, a `case` in `apply()`, a test that replays it through `WorkflowEngine.fromEvents`.
- New tools need a `ToolSpec` with an honest risk tier. When unsure of the tier, pick the higher one.
- Keep docs in sync: if you change a limit, transition, tier rule or milestone status, update `docs/architecture.md` / `docs/roadmap.md` in the same change.

## How to work here

1. Read `docs/roadmap.md`, pick the first unchecked milestone (or the one asked for), and work only on it.
2. Plan in small steps; write tests first; keep `npm test` and `npm run typecheck` green.
3. Before finishing, run `/safety-review` (or the `architecture-guard` subagent) on your diff.
4. Tick the finished items in `docs/roadmap.md`.
