# ADR 0001 · LLMs propose, deterministic code decides

Status: accepted · 2026-11-18

## Context

The product runs many AI agents that can reach real systems: email, GitHub, CRMs, payments. LLM output is non-deterministic and can be manipulated (prompt injection in a web page or email). If agents could act directly, one bad generation could send emails, deploy broken code or spend money.

## Decision

All authority sits in a deterministic control plane (`packages/core`):

- Agents only produce proposals: plans, tool-call requests, outputs with self-checks, review verdicts.
- The `WorkflowEngine` validates each proposal against a state machine, a policy engine (risk tiers and allowlists) and hard limits, then records the result as an event.
- Real-world effects run only through a tool gateway that executes what the engine allowed, once per idempotency key.
- Irreversible or costly actions (tier 3) run only after an independent review and a human approval.

## Consequences

- Safety does not depend on prompts; a jailbroken agent still cannot exceed its allowlist or skip approval.
- Every action is auditable and replayable from the event log, which also powers the 3D office.
- Agents are slightly slower (round-trips through the engine), and every new tool needs a risk tier and allowlist entry.
