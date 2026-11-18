# Roadmap

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

## [ ] M2 · Server and persistence (`apps/server`)

- [ ] Postgres `EventStore` implementation (append-only `events` table, `seq` as identity); engine rebuilds on boot
- [ ] HTTP API for CEO actions: create goal, approve/reject, pause/resume agent, kill switch, resolve escalation
- [ ] WebSocket stream of events (with resume from `seq`) for the 3D office
- [ ] Timer that calls `checkStuck()` every 30 s
- [ ] Integration test: kill the server mid-task, restart, state is identical

## [ ] M3 · Orchestrator and one worker (`packages/agents`)

- [ ] Agent loop using the Claude Agent SDK; every model turn calls `recordStep` with real token counts
- [ ] Orchestrator prompt that outputs a JSON plan matching `PlanTask[]`; rejected plans are fed back with the errors (max 3 re-plans, then escalate goal to CEO)
- [ ] Engineering worker on a test GitHub repo with tools `repo.read` (tier 0) and `github.create_branch` / `github.open_pr` (tier 1)
- [ ] Context packs: worker sees only its task, criteria and role memory
- [ ] Checkpoint after each step; resume after crash

## [ ] M4 · Tool gateway (`packages/gateway`)

- [ ] Every tool call goes `engine.requestToolCall` → execute only on `allow`, never on `duplicate`
- [ ] Credentials stored server-side; never in prompts
- [ ] Executes `execute` actions returned by `recordReview` / `decideApproval`, keyed by idempotency key
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

## Open questions

- [ ] Target customer: solo founders, SMBs, or developers? Decides which departments come first.
- [ ] Hosting: our cloud only, or also self-hosted?
- [ ] Agent framework: Claude Agent SDK (current assumption), LangGraph, or our own loop?
- [ ] Pricing: per agent seat, per task, or pass-through of token cost?
- [ ] Who besides the CEO can approve tier-3 actions in a customer's company?
