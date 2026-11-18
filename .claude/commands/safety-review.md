---
description: Check the current changes against the control-plane invariants
---

Review the uncommitted changes (`git diff` plus untracked files) against the invariants in `CLAUDE.md`.

For each invariant, answer: does this change touch it, and does it still hold? Look especially for:

- code that mutates tasks, goals or agents outside `WorkflowEngine.apply()`
- tool execution that does not first get `{ kind: 'allow' }` from `requestToolCall`, or that executes a `duplicate`
- tier-2/3 actions executed anywhere except from an `execute` field returned by `recordReview` / `decideApproval`
- missing idempotency keys
- credentials or secrets reaching prompts, events or logs
- model turns not recorded with `recordStep`
- clock, randomness or I/O inside the reducer
- an agent reviewing its own work, or non-workers calling tools

Report findings as a list: file and line, which invariant, why it breaks, and the fix. If nothing breaks, say so in one line. Then run `npm test` and `npm run typecheck` and report the results.
