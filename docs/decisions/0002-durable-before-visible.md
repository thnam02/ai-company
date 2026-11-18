# ADR 0002 · Synchronous engine, durable before visible

Status: accepted · 2026-11-18

## Context

The `WorkflowEngine` is synchronous: a command checks its guards, appends events and applies them in one call. That keeps the reducer simple and deterministic. Postgres writes are asynchronous. Making every engine command async would spread `await` through the core and open gaps between "guard checked" and "event written" where another command could interleave.

The risk with a sync engine over an async database is a crash after the engine has decided but before the event is stored. If anything outside the process saw that decision (a `tool.allowed`, an approval, a released final action), a restart would rebuild a company that never made it. A tool call could then be allowed twice with the same idempotency key.

## Decision

- `packages/core` stays synchronous and I/O-free. `PostgresEventStore` implements the same `EventStore` interface: it loads the whole log into memory at boot, appends synchronously to memory, and writes pending events in one transaction on `flush()`.
- The server runs every request through one command queue (`run` in `apps/server/src/app.ts`): run the engine command, then `await store.flush()`, then respond. The response is built from the command's own return value, computed inside `run`. Engine state read *after* the await can already include later commands that are not durable yet, so handlers never do that. Reads (`/state`) are computed inside `run` too, so a response never contains state that a crash could still lose.
- Agent code (milestone 3) follows the same rule: call engine commands only through `run`, and act on an `allow` only after `run` resolves. The raw engine is not exposed outside the server.
- WebSocket subscribers are told about an event only after it commits. Final actions go to the gateway hook only after the approval is durable. In M2 that delivery is at most once and no gateway is wired: nothing re-releases an action after a crash or a failing hook. Milestone 4 adds an outbox derived from the log and a durable execution record.
- A failed write, a dropped database connection or a command that throws is fatal, at once. Memory may now be ahead of (or disagree with) the database, so the server aborts the store (pending events are dropped and queued flushes cancelled; a write already in flight may still commit), answers 503 and exits; the next process rebuilds from the log. The client never received an acknowledgement for the lost events, so nothing outside the process acted on them.
- One writer per log: the store holds a Postgres session advisory lock for its lifetime, `seq` is the primary key, and the table rejects UPDATE, DELETE and TRUNCATE. Session locks need a direct connection (or session pooling), not a transaction-pooling proxy such as pgbouncer in transaction mode.
- The SQLite store (M2b, the local default) keeps the same shape: `append` buffers in memory and `flush` commits every pending event in one synchronous transaction before it returns (`synchronous=FULL`, `fullfsync`). Committing on every `append` instead would let a crash or a throwing command leave half a command in the log, so commits stay per flush. `run` calls `flush` in the same tick as the command, so nothing can interleave. One writer per file: the store holds an exclusive lock on a sidecar `company.db.lock` and opens the log itself in EXCLUSIVE locking mode (set before WAL is enabled, so no shared-memory index is used and other processes cannot even read the log). POSIX locks belong to the process, and closing any descriptor on a file drops them, so code in the server process must never open `company.db` except through the store; the sidecar, which nothing else opens, still keeps a second server out if that happens. If the commit's fsync itself fails, the batch may already be in the WAL and reappear after restart; that is the "write in flight may still commit" case, and no client was acknowledged. Data is stored as JSON text.
- Event data is stored as `json`, not `jsonb`: it keeps key order and accepts every string JSON can carry, including `\u0000`, which `jsonb` rejects. One odd character in an agent's output must not be able to stop the control plane.

## Consequences

- The engine stays synchronous and needed no changes for durability; the in-memory store still works for tests and demos.
- Every response waits for a commit. With Postgres, concurrent requests share a transaction when they arrive during a flush, so throughput is bounded by commit latency, not by request count. With SQLite, each `run` is its own transaction and disk sync (about 4 ms with `fullfsync` on an Apple-silicon Mac), and the event loop is blocked during it; plenty for one CEO and a few local agents.
- The guarantee holds only for engine calls made through `run`. An append made anywhere else stays in memory until some later flush.
- The whole log lives in memory. That is fine for one company for a long time; snapshots can be added later without changing this rule.
- Only one server process per company log. Horizontal scaling would need a different design (per-company sharding).
