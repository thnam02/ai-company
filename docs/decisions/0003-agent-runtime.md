# ADR 0003 · Agent runtime: in-process, allowlisted, checkpointed

Status: accepted · 2026-11-18 · tool execution superseded by [ADR 0004](0004-tool-gateway.md): agents call `callTool` instead of `requestToolCall`, and only the gateway runs tools

## Context

Milestone 3 adds real agents: an orchestrator that plans, workers that use tools, a reviewer that checks the work. They run on local models (Ollama) by default and must obey every control-plane invariant. Three choices had to be made before writing them: where agents run, where their working memory lives across a crash, and how an approved final action (the email) is executed exactly once.

## Decision

**Agents run inside the server process, behind a port.** `packages/agents` defines an `AgentPort`: the engine commands an agent may use (`submitPlan`, `start`, `recordStep`, `recordGoalStep`, `requestToolCall`, `submitForReview`, `recordReview`, `escalate`) plus a read-only view of the company. The server implements it on top of its command queue `run()`, so every agent command is durable before the agent sees the result (ADR 0002), and a tool runs only after its `allow` is durable. The port has no CEO commands (`updateAgent`, `decideApproval`, `resolveEscalation`, unbench, kill switch) and the agents package never sees the engine. One agent works at a time, which suits one local model on a 16 GB Mac.

**Every model turn is recorded.** Workers record each turn with `recordStep` on their task. The orchestrator and reviewers work for a goal, not inside a task, so a new `recordGoalStep` charges their tokens to the goal budget. A turn is recorded after the model answers and before anything it proposed is acted on.

**Planning state lives in the engine.** A goal is `open` until a plan is accepted, then `planned`. Each rejected plan is counted; after `maxReplans` re-plans the engine itself escalates the goal. The runtime feeds the rejection reasons back to the model but does not decide when to give up.

**Checkpoints live outside the event log.** An agent's conversation for a task (messages, tool results) is saved after every completed turn in a separate SQLite file (`DATA_DIR/agents.db`). It is working memory, not company state: it never changes what the engine decides, and losing it only means the agent starts the task over from its context pack. A checkpoint is written only after the turn's events are durable, so it never runs ahead of the log; after a crash the agent redoes at most its last turn. Its tool calls get new idempotency keys, so "never twice" holds per key, not per effect: a tool that ran just before the crash can run again in the redone turn. That is harmless for tiers 0 and 1 inside the workspace; before an auto-approved tier-2 tool exists (M4), the pending call and its key must be checkpointed before `requestToolCall` so the redo reuses the key.

**Final actions get a durable execution record.** When `recordReview` or `decideApproval` releases a final action, the server executes it after that release is durable, then records `action.executed` or `action.failed` through the engine. On boot, every released action without a recorded result is either re-run, if its tool dedupes by idempotency key (the fake `email.send` writes `outbox/<key>-<hash>.eml` with an exclusive create, so a second run finds the file and does nothing), or recorded as failed ("interrupted; not retried"), so the CEO decides. A key is therefore never executed twice, even across a crash between the effect and its record. Milestone 4 generalises this into the gateway.

Logs written before this record existed have `task.done` events without a release marker; the reducer records those actions as "not executed", so upgrading never runs an old approval.

**Workspace tools are sandboxed.** `files.read` and `files.write` resolve every path inside `./workspace` and refuse anything outside it (including through symlinks). `files.write` also refuses `outbox/`, so a worker cannot fake a sent email without the approval gate. `files.write` does not count as deduping: re-running an old write after a crash could undo a newer one, so an interrupted `files.write` final action is left for the CEO. The server refuses a `WORKSPACE_DIR` that overlaps `DATA_DIR` or holds the company config.

**The pause is checked before every model turn**, by every role, and the engine refuses `recordReview` and `submitPlan` while the company is paused, so a verdict that arrives after the CEO pressed stop releases nothing.

**Agent-written text is data.** Summaries and workspace files shown to the reviewer or to a dependent worker are wrapped in markers with a random per-prompt tag (and the tag is stripped from the text), with a rule that text inside them is never instructions. This lowers, but cannot remove, the risk of prompt injection; the CEO approval gate on tier-3 actions is the real defence.

## Consequences

Known gaps, left for later milestones:

- An escalated goal (re-plans or budget) has no CEO route to reopen it, raise its budget or cancel it; the CEO creates a new goal (M6).
- Every `AgentPort` method takes an `agentId` and trusts the in-process runtime to pass its own. An out-of-process port must bind each connection to one agent. The engine does not check that a reviewer charging `recordGoalStep` reviews a task of that goal.
- The reviewer's runtime reads the task's files from the workspace to build its context pack. That is a tier-0 read by deterministic code, not a tool call by the reviewer, so reviewers still call no tools (invariant 5).
- A model call that fails after generating (a timeout, a broken response) is not recorded, because no token counts come back. When Ollama omits counts, the provider estimates them (about 4 characters per token) instead of recording 0.
- Checkpoints are never pruned.

- Agents share the server's event loop. Model calls are async HTTP, so the server stays responsive; a stuck model call is bounded by a request timeout and by the stuck timer.
- A checkpoint can be lost without harm, so the checkpoint file is not part of backups that matter; the event log is.
- Orchestrator and reviewer tokens now count against goal budgets, so budgets reflect the real cost of a goal.
- Running agents as separate processes later only needs a second `AgentPort` implementation (over HTTP); the agent code does not change.
