# ADR 0003 · Agent runtime: in-process, allowlisted, checkpointed

Status: accepted · 2026-11-18

## Context

Milestone 3 adds real agents: an orchestrator that plans, workers that use tools, a reviewer that checks the work. They run on local models (Ollama) by default and must obey every control-plane invariant. Three choices had to be made before writing them: where agents run, where their working memory lives across a crash, and how an approved final action (the email) is executed exactly once.

## Decision

**Agents run inside the server process, behind a port.** `packages/agents` defines an `AgentPort`: the engine commands an agent may use (`submitPlan`, `start`, `recordStep`, `recordGoalStep`, `requestToolCall`, `submitForReview`, `recordReview`, `escalate`) plus a read-only view of the company. The server implements it on top of its command queue `run()`, so every agent command is durable before the agent sees the result (ADR 0002), and a tool runs only after its `allow` is durable. The port has no CEO commands (`updateAgent`, `decideApproval`, `resolveEscalation`, unbench, kill switch) and the agents package never sees the engine. One agent works at a time, which suits one local model on a 16 GB Mac.

**Every model turn is recorded.** Workers record each turn with `recordStep` on their task. The orchestrator and reviewers work for a goal, not inside a task, so a new `recordGoalStep` charges their tokens to the goal budget. A turn is recorded after the model answers and before anything it proposed is acted on.

**Planning state lives in the engine.** A goal is `open` until a plan is accepted, then `planned`. Each rejected plan is counted; after `maxReplans` re-plans the engine itself escalates the goal. The runtime feeds the rejection reasons back to the model but does not decide when to give up.

**Checkpoints live outside the event log.** An agent's conversation for a task (messages, tool results) is saved after every completed turn in a separate SQLite file (`DATA_DIR/agents.db`). It is working memory, not company state: it never changes what the engine decides, and losing it only means the agent starts the task over from its context pack. A checkpoint is written only after the turn's events are durable, so it never runs ahead of the log; after a crash the agent redoes at most its last turn (tool calls get new idempotency keys, so nothing is allowed twice).

**Final actions get a durable execution record.** When `recordReview` or `decideApproval` releases a final action, the server executes it after that release is durable, then records `action.executed` or `action.failed` through the engine. On boot, every released action without a recorded result is either re-run, if its tool dedupes by idempotency key (the fake `email.send` writes `outbox/<key>.eml` with an exclusive create, so a second run finds the file and does nothing), or recorded as failed ("interrupted; not retried"), so the CEO decides. A key is therefore never executed twice, even across a crash between the effect and its record. Milestone 4 generalises this into the gateway.

**Workspace tools are sandboxed.** `files.read` and `files.write` resolve every path inside `./workspace` and refuse anything outside it (including through symlinks). `files.write` also refuses `outbox/`, so a worker cannot fake a sent email without the approval gate.

## Consequences

- Agents share the server's event loop. Model calls are async HTTP, so the server stays responsive; a stuck model call is bounded by a request timeout and by the stuck timer.
- A checkpoint can be lost without harm, so the checkpoint file is not part of backups that matter; the event log is.
- Orchestrator and reviewer tokens now count against goal budgets, so budgets reflect the real cost of a goal.
- Running agents as separate processes later only needs a second `AgentPort` implementation (over HTTP); the agent code does not change.
