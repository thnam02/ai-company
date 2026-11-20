# AI Company — guide for Claude Code

An AI company workspace: AI agents work as employees in a 3D office. A CEO (the user) gives goals to an orchestrator agent, which plans tasks for worker agents; a reviewer agent checks the work. Read `docs/architecture.md` for the full design and `docs/roadmap.md` for what to build next.

**Product direction: local-first desktop app.** Everything runs on the user's computer: the server on `127.0.0.1`, SQLite (Postgres optional), local models via Ollama (Claude API optional), and the 3D office in the browser, later wrapped in Electron. No cloud service may be required for the app to work. Reference machine: 16 GB Apple-silicon Mac running `qwen3:8b`.

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
11. The server binds to `127.0.0.1` by default and is never exposed on the network unless the CEO explicitly configures it.
12. Model access goes only through the `ModelProvider` interface. `packages/core` never imports a model SDK, and agent code never hard-codes one vendor.

## Repo map

```
packages/core/        control plane (done): engine, policy, plan validation, state machine, event log
  src/engine.ts       WorkflowEngine — commands + reducer + limits
  src/policy.ts       risk tiers and allowlists
  src/plan.ts         gate-1 plan validation
  src/state-machine.ts legal transitions
  src/event-log.ts    EventStore interface + in-memory store
  test/               node:test suites (helpers.ts builds a small test company)
apps/server/          server (done): SQLite/Postgres event store, CEO HTTP API, WebSocket stream, stuck timer
  src/app.ts          HTTP routes + the command queue `run()` (durable before visible, ADR 0002)
  src/buffered-store.ts in-memory log, pending buffer and failure handling shared by both stores
  src/sqlite-event-store.ts append-only SQLite log (default), single writer per file
  src/pg-event-store.ts append-only Postgres log, single writer
  src/boot.ts         env config, store selection, boot sequence, starts agents unless AGENTS=off
  src/sqlite-checkpoint-store.ts agent checkpoints in DATA_DIR/agents.db
  src/run-report.ts   run report (plans, reviews, tokens, time) built from the event log
  config/company.json tools, tiers, limits, agent roster, model options (CEO config)
  config/test-team.json the M3 test team (Ava, Kai, Zara, Rex on ollama:qwen3:8b)
packages/agents/      agent runtime (M3): models, role loops — talks to the company only via AgentPort
  src/model.ts        ModelProvider interface, "<provider>:<model>" refs
  src/providers/      OllamaProvider, ClaudeProvider (official SDK, only with a key), ScriptedProvider (tests)
  src/port.ts         AgentPort: the allowlisted commands agents may call (tools only via callTool)
  src/context.ts      prompts and context packs
  src/roles.ts        planner, worker and reviewer loops
  src/runtime.ts      AgentRuntime: one agent at a time, kill switch between turns
apps/office/          3D office prototype (Three.js, single HTML file, simulated agents)
docs/                 architecture.md, roadmap.md, decisions/ (ADRs), runs/ (live run reports)
.claude/              commands and subagents for working on this repo
```

packages/gateway/     tool gateway (M4): the only code that runs tools
  src/gateway.ts      ToolGateway: requestToolCall → run on allow → record result; final actions; recovery; timeouts, retries, rate limits
  src/registry.ts     ToolExecutor, ToolRegistry, ToolInputError, TransientToolError
  src/credentials.ts  Secret, CredentialStore (DATA_DIR/credentials.json, chmod 600), redaction
  src/workspace.ts    workspace sandbox (files.read/write, fake email.send)
  src/checks.ts       gate-3 automated checks (content, email) run before any reviewer (M5)

Planned (see roadmap): `apps/desktop` (Electron, M9).

## Commands

- `npm test` — run all tests (Node ≥ 22.18 runs `.ts` directly; no build step). SQLite and crash/restart tests always run. Set `DATABASE_URL` to a disposable Postgres database to also run the Postgres store tests and the crash/restart tests against Postgres.
- `npm run typecheck` — `tsc` strict type check
- `CEO_TOKEN=<16+ chars> npm run server` — start the server on `127.0.0.1:4100`. No database server needed: the event log is SQLite at `DATA_DIR/company.db` (default `<repo>/data`, git-ignored). Set `DATABASE_URL` (and optionally `DB_SCHEMA`) to use Postgres instead. Agents start too (set `AGENTS=off` to skip them); they need Ollama at `OLLAMA_URL`, default `http://127.0.0.1:11434`; their files go to `WORKSPACE_DIR` (default `<repo>/workspace`). Set `ANTHROPIC_API_KEY` to allow `claude:` models.
- `OLLAMA_URL=http://127.0.0.1:11434 node --test apps/server/test/live.test.ts` — the M3b acceptance test against a real model (`LIVE_MODEL`, default `qwen3:8b`; `RUN_REPORT=<file>` appends run reports; `LIVE_VERBOSE=1` prints agent logs). Skipped in `npm test` unless `OLLAMA_URL` is set; it takes tens of minutes.
- `npm run office` — serve the 3D office prototype

## Conventions

- TypeScript, ESM, strict. Only erasable syntax (no `enum`, no `namespace`, no constructor parameter properties) so Node can strip types. Import local files with the `.ts` extension; use `import type` for types.
- Keep `packages/core` dependency-free and free of I/O and LLM calls.
- In `apps/server`, everything that leaves the process (responses, stream messages, gateway actions) goes through the command queue `run()`, which waits for the event store's commit first. Build the response inside the function passed to `run()`; never read engine state after the await.
- Agent code calls engine commands only through `AgentPort` (built on `run()`) and acts on a result only after it resolves. Never give agent code the engine, the store, the server or a tool executor: tools run only in `packages/gateway`, through `callTool` or a released final action.
- New tools are `ToolExecutor`s in the gateway. Throw `ToolInputError` for bad model input, and `TransientToolError` only for a failure before any effect. Set `dedupesByKey` only if a repeat of the same key cannot act twice. Read credentials with `ctx.credential(name)` after declaring them, and never put them in output.
- New behaviour starts with a failing test in the matching `test/*.test.ts`. Use `makeCompany()` and `startedTask()` from `test/helpers.ts`.
- A new event type needs: an emit in a command, a `case` in `apply()`, a test that replays it through `WorkflowEngine.fromEvents`.
- New tools need a `ToolSpec` with an honest risk tier. When unsure of the tier, pick the higher one.
- Keep docs in sync: if you change a limit, transition, tier rule or milestone status, update `docs/architecture.md` / `docs/roadmap.md` in the same change.

## How to work here

1. Read `docs/roadmap.md`, pick the first unchecked milestone (or the one asked for), and work only on it.
2. Plan in small steps; write tests first; keep `npm test` and `npm run typecheck` green.
3. Before finishing, run `/safety-review` (or the `architecture-guard` subagent) on your diff.
4. Tick the finished items in `docs/roadmap.md`.
