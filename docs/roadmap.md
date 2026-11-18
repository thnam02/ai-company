# Roadmap

**Direction (decided 2026-11-18): a local-first desktop app.** Everything runs on the user's own computer: the server on `127.0.0.1`, a SQLite event store (Postgres stays available for a hosted version later), local models through Ollama with an optional Claude API key, and the 3D office in the browser, later wrapped in Electron. No cloud service may be required for the app to work. Reference machine: a 16 GB Apple-silicon Mac running `qwen3:8b`.

Build the parts that make real tools safe first. Each milestone is usable before the next starts. Work on one milestone at a time; a milestone is done only when every acceptance criterion holds and `npm test` and `npm run typecheck` pass.

Status: `[x]` done · `[ ]` not started

## [x] M1 · Core control plane (`packages/core`)

- [x] Task state machine with the legal-transition table
- [x] Policy engine: risk tiers, per-agent allowlists, tier-2 auto-approve list
- [x] Plan validation (gate 1)
- [x] Workflow engine: event-sourced commands for plans, start, steps, tool calls, submit, review, approval, escalation
- [x] Limits: steps, tokens, time, review attempts, loop detection, stuck detection, goal budget, circuit breaker, kill switch
- [x] In-memory event store with subscribe
- [x] 35 tests

## [x] M2 · Server and persistence (`apps/server`)

- [x] Postgres `EventStore` implementation (append-only `events` table, `seq` as identity); engine rebuilds on boot
- [x] HTTP API for CEO actions: create goal, approve/reject, pause/resume agent, kill switch, resolve escalation
- [x] WebSocket stream of events (with resume from `seq`) for the 3D office
- [x] Timer that calls `checkStuck()` every 30 s
- [x] Integration test: kill the server mid-task, restart, state is identical
- [x] `updateAgent` command (`agent.updated` event) so CEO config changes apply on boot: revoked tools are revoked, agents removed from the config lose all tools and are paused
- [x] 47 new tests (82 in total); Postgres tests run when `DATABASE_URL` is set (always in CI). See ADR 0002 for the durability design.

## [x] M2b · SQLite event store (local-first)

- [x] `SqliteEventStore` implementing `DurableEventStore` with `better-sqlite3`; writes are synchronous: `flush()` commits a command's events in one transaction before it returns, in the same tick as the command (per-append commits would let a crash leave half a command in the log; see ADR 0002)
- [x] Same guarantees as the Postgres store: append-only (triggers reject UPDATE, DELETE and INSERT OR REPLACE), `seq` primary key, one writer per file (sidecar lock plus EXCLUSIVE locking mode, checked across processes), event JSON stored as text so key order and every string survive
- [x] The server picks the store from config: `DATABASE_URL` set → Postgres; otherwise SQLite at `DATA_DIR` (default `./data/company.db`)
- [x] The existing crash/restart test runs against both stores
- [x] `npm run server` works on a fresh Mac with no database server installed (better-sqlite3 ships prebuilt binaries)
- [x] 17 new tests (99 in total with Postgres, 84 without); the shared in-memory log and failure handling live in one base class for both stores
- [x] Hardened after review: a sidecar lock file keeps a second server out even if the process drops its lock on the log, full fsync from the first commit, private data directory, `DATA_DIR` anchored to the repo, a failed boot releases the log

## [ ] M3a · Agent runtime with pluggable models (`packages/agents`), tested with a scripted model

Decisions: [ADR 0003](decisions/0003-agent-runtime.md) (agents in the server process behind an allowlisted port, checkpoints outside the event log, a durable execution record for final actions).

- [ ] `ModelProvider` interface: `chat(model, messages, tools, opts) → { text, toolCalls, usage: { inputTokens, outputTokens } }`. Agent code never imports a vendor SDK directly
- [ ] `OllamaProvider` for `http://localhost:11434`: tool calls, JSON-schema `format` for structured output, `think` on/off, `num_ctx`, `temperature`, `keep_alive`, token usage from `prompt_eval_count` / `eval_count` (tested against a fake Ollama server)
- [ ] Model per agent in the company config as `"<provider>:<model>"` (e.g. `"ollama:qwen3:8b"`), with per-agent options `temperature`, `numCtx`, `think`
- [ ] Every model turn is recorded: workers with `recordStep`, the orchestrator and reviewers with a new `recordGoalStep` charged to the goal budget
- [ ] Provider-agnostic worker loop: model turn → `recordStep` with real token counts → each tool call through `requestToolCall` → execute only on `allow` → feed the result back
- [ ] Agent loops get an allowlisted port over the server's `run()` (`submitPlan`, `start`, `recordStep`, `recordGoalStep`, `requestToolCall`, `submitForReview`, `recordReview`, `escalate`, a read-only view), never the raw engine or CEO commands such as `updateAgent`
- [ ] Goals have a planning status in the engine; the orchestrator outputs a `PlanTask[]` JSON plan via structured output; rejected plans are fed back with the errors; after `maxReplans` (3) re-plans the engine escalates the goal to the CEO
- [ ] Reviewer outputs a `ReviewVerdict` JSON from the task's acceptance criteria, the worker's summary and the files it produced (basic version; rubrics and automated checks come in M5)
- [ ] Workspace tools sandboxed to `./workspace`: `files.read` (tier 0), `files.write` (tier 1, refuses any path outside the workspace and the outbox) and a fake `email.send` (tier 3) that writes the email to `workspace/outbox/<idempotency key>.eml` instead of sending it
- [ ] Durable execution record: a released final action is executed after its release is durable and its result recorded as an event; on boot, released actions with no result are re-run only if their tool dedupes by idempotency key, otherwise marked failed for the CEO
- [ ] Context packs: a worker sees only its task, its criteria, review feedback, the summaries and files of the tasks it depends on, and its role
- [ ] Checkpoint after each step (outside the event log, `DATA_DIR/agents.db`); resume after a crash
- [ ] One agent runs at a time (`maxConcurrentAgents: 1`) so one local model serves every agent on a 16 GB Mac; the kill switch and agent pause stop work between turns
- [ ] Tests use a scripted fake provider (no real model in CI), including the test team's goal end to end
- [ ] Agents start with the server only when `AGENTS=on` (default off until M3b proves the live run)

## [ ] M3b · Live test team on `qwen3:8b`, Claude provider

- [ ] `ClaudeProvider` (Anthropic API), used only when an API key is configured; the key never enters prompts, events or logs
- [ ] The acceptance test below passes against a real `qwen3:8b`; one opt-in live test runs when `OLLAMA_URL` is set
- [ ] Prompts tuned on the live run; `AGENTS=on` becomes the default
- [ ] Role memory in context packs

### M3b acceptance test: the test team

Config `apps/server/config/test-team.json`:

| Agent | Kind | Model and options | Tools |
| --- | --- | --- | --- |
| Ava | orchestrator | `ollama:qwen3:8b`, think on, temperature 0.2 | none |
| Kai | worker (researcher) | `ollama:qwen3:8b`, think off, temperature 0.2, numCtx 16384 | `files.read`, `files.write` |
| Zara | worker (writer) | `ollama:qwen3:8b`, think off, temperature 0.3, numCtx 16384 | `files.read`, `files.write`, `email.send` |
| Rex | reviewer | `ollama:qwen3:8b`, think on, temperature 0.1 | none |

Goal: "Write a one-page product brief for our 3D AI office from the notes in `workspace/notes/`, then draft a launch email to our team."

End to end against a real `qwen3:8b`:

- [ ] Ava's plan has two tasks, Zara's depending on Kai's; Zara starts only after Kai's task is done
- [ ] Kai writes `workspace/brief.md`; Zara writes the email and proposes `email.send` as her final action
- [ ] Rex reviews both; a failed review sends the work back with feedback
- [ ] The email waits for CEO approval; after approval it appears in `workspace/outbox/` exactly once
- [ ] Safety: impossible criteria escalate after 3 tries; a low step limit escalates; the kill switch stops work mid-task
- [ ] A run report lists: plans accepted first try, re-plans, first-try review pass rate, tokens and time per task, peak memory

Round 2 (manual comparison, not required for M3): the same goal with Ava and Rex on `claude:` models.

## [ ] M4 · Tool gateway (`packages/gateway`)

- [ ] Every tool call goes `engine.requestToolCall` → execute only on `allow`, never on `duplicate`
- [ ] Credentials stored server-side; never in prompts
- [ ] Executes `execute` actions returned by `recordReview` / `decideApproval`, keyed by idempotency key
- [ ] Outbox: approved actions are derived from the log and re-released after a crash; a durable execution record (e.g. an `action.executed` event) keeps the gateway from running any key twice. Replaces M2's at-most-once `onExecute` hook
- [ ] Timeouts, retry with backoff for transient errors, per-tool rate limits
- [ ] Records tool results and failures as events

## [ ] M5 · Reviewer and automated checks

- [ ] Reviewer agent with a rubric built from acceptance criteria; outputs `ReviewVerdict` JSON
- [ ] Automated checks per output type run before the reviewer (tests/lint/build for code; links/length for content)
- [ ] Rework loop and escalation verified end to end

## [ ] M6 · 3D office on real data (`apps/office`)

- [ ] Replace the simulation with the WebSocket event stream from M2
- [ ] Approvals inbox and kill switch call the M2 API
- [ ] Agent inspector shows real logs, tokens and cost

## [ ] M7 · More departments

- [ ] Marketing, Sales and Support role templates and tools (with tier tags)
- [ ] Tier-3 email and publishing flows through the approval gate

## [ ] M8 · Improvement loop

- [ ] Agent scorecards from the event log
- [ ] Golden tasks per role; run on every prompt/model/tool change
- [ ] Versioned prompts and policies recorded on each event; canary rollout and rollback

## [ ] M9 · Desktop app (`apps/desktop`)

- [ ] Electron shell that starts the server in-process (or a utility process) and opens the office in its window
- [ ] Tray/menu-bar mode: closing the window keeps agents running; quitting stops them cleanly
- [ ] First-run setup: detect Ollama, guide the install, recommend a model from available RAM (16 GB → `qwen3:8b`), pull it
- [ ] API keys and tool logins in the OS keychain (`safeStorage`)
- [ ] Pause the 3D render loop when the window is hidden; low-quality mode for weak machines
- [ ] Packaging with electron-builder for macOS and Windows, auto-update, then code signing and notarization

## Open questions

- [ ] Target customer: solo founders, SMBs, or developers? Decides which departments come first.
- [x] Hosting: local-first desktop app now; a hosted version can reuse the Postgres store later (decided 2026-11-18)
- [x] Agent framework: our own provider-agnostic loop, Ollama first, Claude optional (decided 2026-11-18)
- [ ] Pricing: per agent seat, per task, or pass-through of token cost?
- [ ] Who besides the CEO can approve tier-3 actions in a customer's company?
- [ ] CEO auth: M2 uses one shared bearer token (`CEO_TOKEN`). Real users and sessions are needed before anyone else gets access.
