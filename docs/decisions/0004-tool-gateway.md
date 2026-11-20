# ADR 0004 · Tool gateway: the only code that runs tools

Status: accepted · 2026-11-20

## Context

Up to M3, agent code asked the engine for an `allow` (`requestToolCall`) and then ran the tool itself from a `ToolRegistry` it was handed. The engine decided, but the code that acted sat inside the agent runtime. That meant three things. Nothing structural stopped agent code from running an executor without asking. A tool's result was never recorded, only that it was allowed. And there was nowhere to put timeouts, retries, rate limits or credentials. Released final actions were run by the server, which had its own copy of the execution and recovery code, plus an at-most-once `onExecute` test hook from M2.

## Decision

**One package runs tools: `packages/gateway`.** It depends only on `packages/core`. It holds the executors (`ToolRegistry`, the sandboxed workspace tools) and `ToolGateway`. `ToolGateway` reaches the engine through a `GatewayEnginePort` that the server builds on its command queue, so every decision it acts on is durable first (ADR 0002).

**Agents no longer run tools.** `AgentPort.requestToolCall` is replaced by `callTool(taskId, agentId, tool, input)`, which hands the call to the gateway, and the runtime no longer gets a `ToolRegistry`. An agent learns how to call a tool from its view: a `runnable` field with the description and input schema, for tools the gateway on this server can run. It never gets the executor or its credentials.

**A work-time call:**

1. The gateway makes the idempotency key; the agent never does.
2. It calls `requestToolCall`.
3. It runs the tool only on `allow`: never on `duplicate`, never on `ok: false`.
4. It records `tool.executed` or `tool.failed` with a new engine command, `recordToolResult`. The event holds the tool, the key, a detail capped at 1,000 characters with credentials removed, and the number of attempts.
5. The model gets the output (capped at 20,000 characters) or a reason it can act on. Bad input is described in full. Any other error is reported to the model in plain words, while the real error is logged and recorded.

`recordToolResult` accepts only a key the engine allowed for that task, and only once. It works in any task or company state, because a call that was running when the kill switch fired still happened. The result is credited to the agent that made the call, even if the task was reassigned since. `tool.allowed` events now carry `tracked: true`, and only those calls expect a result, so calls in logs written before M4 are never reported as interrupted.

**A released final action** goes to `gateway.release(taskId, action)`. It runs once per key in this process and its result is recorded as `action.executed` or `action.failed`, as before. The server's own execution code and the `onExecute` hook are gone. A server with no executor for a tool records the action as failed instead of leaving it pending.

Right before an action's first attempt, the gateway records `action.started` through the engine (`recordActionStarted`). A release from before M4 has no start record and is treated as possibly started.

The gateway does not trust the caller of `release`. Before it runs anything, it asks the engine for the released action with that task and key, has no result yet. It then runs the engine's copy of the action, not the caller's. An action released while the server is stopping is left pending for the next boot.

**The kill switch.** Before every attempt (the first, each retry, and after any rate-limit wait) the gateway asks the engine whether the company is paused.

- A work-time call stopped this way is recorded as failed: "the company was paused before it ran; nothing was done".
- A final action (for example one the CEO approved while paused) is held instead, still pending. It runs when the CEO resumes the company: the resume route calls `gateway.resume()`.

**Recovery on boot** (`gateway.recover()`, before agents start):

- An allowed call with no result, whatever its task's state, is recorded as `tool.failed`: "interrupted by a restart; it may or may not have run". It is never re-run. The worker redoes its turn from its checkpoint with new keys.
- A released action with no result that never started (for example one held by the kill switch) cannot have acted, so it is released normally: it runs, or stays held while the company is paused.
- A started action with no result is re-run only if its tool dedupes by key. Otherwise it is recorded as failed for the CEO.

**Timeouts, retries and rate limits** come from the company config, per tool: `timeoutMs`, `maxAttempts` and `ratePerMinute`, with defaults of 30 s, 3 and unlimited. They are CEO config (invariant 10) and are kept out of the policy and the events. Boot refuses a tool whose worst-case call reaches the `stuckAfterMs` limit. The worst case is every attempt plus every backoff, plus a minute per attempt if the tool is rate limited. This way the stuck timer cannot escalate a task for silence while its tool is still running. Other limits (wall time, budget) can still end a task mid-call; the result is then recorded late and credited to the agent that made the call.

- Every attempt has a timeout. The executor gets an `AbortSignal`, and an executor that ignores the signal is not waited for.
- Only failures that cannot act twice are retried, with doubling backoff and jitter (0.5 s, then 1 s, and so on, capped at 10 s):
  - a `TransientToolError`, which the executor throws only when the failure happened before any effect (a 429, a 503, a refused connection);
  - a timeout, but only for a tool that dedupes by key.
- A timed-out tool that does not dedupe is reported as "may still have taken effect" and is not retried.
- All attempts of one call share its key, so a deduping service sees one effect.
- The rate limit is a rolling 60-second window per tool across all agents; a call waits for room.

**Credentials live only in the gateway** (invariant 6):

- `DATA_DIR/credentials.json` holds `{ "name": "value" }`. Boot refuses the file if other users can read it, and a parse error never quotes it.
- Each value is held in a `Secret`. `Secret` moved from the server to the gateway.
- A tool lists the credentials it needs (`credentials: ['smtp']`) and reads them while it runs with `ctx.credential(name)`; any other name throws.
- Every text that leaves the gateway has credential values replaced by `[secret]`: model output, event details, log lines and error messages. Each value is removed as written, URL-encoded, JSON-escaped and base64-encoded, longest first, so a value that contains another is removed whole. Values shorter than 6 characters are refused, since removing them would mangle ordinary text.
- Not covered: a credential base64-encoded together with other text (as in `user:password` Basic auth), and a tool that cuts its own output in the middle of a credential before returning it. Connectors must keep credentials out of what they return.

## Consequences

- Invariant 2 holds by construction: the only call site of an executor's `run` is in `packages/gateway`, after a durable `allow` or release.
- Every allowed call ends in exactly one recorded result, so the log shows what each tool did, which M6's agent inspector needs. The run report counts failed calls.
- Tool output now enters the event log, capped at 1,000 characters. That is a deliberate trace. Like the rest of the log, it stays on the CEO's machine.
- **Still open (from ADR 0003):** a worker's redone turn after a crash gets new keys, so a call that ran just before the crash can run again. That is harmless for today's tools (tier 0 and 1 inside the workspace). Until the pending call and its key are checkpointed before `callTool`, so the redo reuses the key, boot refuses to auto-approve a tier-2 tool whose executor does not dedupe by key.
- The agent runtime gets a read-only view of the workspace (for the reviewer). Workspace writes happen only through the gateway.
- Real connectors (SMTP, GitHub, CMS) plug in as `ToolExecutor`s with declared credentials. The gateway, the engine and the agents do not change.
