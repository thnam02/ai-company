---
description: Implement a milestone from docs/roadmap.md (the next unchecked one if none is given)
argument-hint: "[milestone, e.g. M2]"
---

Implement milestone $ARGUMENTS from `docs/roadmap.md`. If no milestone was given, take the first one that is not checked.

1. Read `CLAUDE.md`, `docs/architecture.md` and `docs/roadmap.md`. Restate the milestone's acceptance items and the invariants it touches.
2. Propose a short plan (files to add or change, new events or types, tests). Wait for confirmation if anything is ambiguous or would change an invariant.
3. Work test-first, one acceptance item at a time. Keep `npm test` and `npm run typecheck` passing after each item.
4. Never route around `WorkflowEngine`: every state change, tool call and final action goes through it.
5. When all items pass, run the `architecture-guard` subagent on the diff and fix anything it finds.
6. Tick the finished items in `docs/roadmap.md`, update `docs/architecture.md` if behaviour changed, and summarise what was built, what was tested and any open questions.
