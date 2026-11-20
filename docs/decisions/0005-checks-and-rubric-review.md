# ADR 0005 · Automated checks before review, and rubric verdicts decided by code

Status: accepted · 2026-11-20

## Context

Up to M4, the reviewer agent returned `{ passed, score, feedback }` and the engine recorded whatever it said. Two problems followed. A small local model judged the whole submission at once, so it could pass work that missed a criterion, or fail work for a reason that was not a criterion. And nothing mechanical was checked: a brief with `TODO` in it, a link to a file that does not exist, or an email to an address outside the company reached the reviewer, and could pass.

## Decision

**Gate 3: deterministic checks run by the gateway, after submit and before any reviewer.** `runChecks` (`packages/gateway/src/checks.ts`) looks at what a submission produced. It never calls a model or the network, and it reads only workspace files through the workspace sandbox.

- `files.exist`: every listed file is in the workspace and is a regular, non-empty file under 200 KB.
- Content files (`.md`, `.txt`, `.html`, `.rst`, no extension):
  - `content.length`: the word count is within the CEO's range.
  - `content.placeholders`: no `TODO`, `TBD`, `FIXME`, `lorem ipsum`, `[insert …]`, `{{…}}` and the like.
  - `content.links`: web links parse and have a real host; only `http`, `https` and `mailto` are allowed; relative links lead to an existing file inside the workspace.
- An `email.send` final action:
  - `email.schema`: `to` and `subject` are one line each, and the body is not empty.
  - `email.recipients`: every address is valid and on the CEO's allowlist (addresses or `@domain`).
  - `email.body`: the body is under the word limit, has no placeholders in the body or subject, and has only links a recipient can open.

The rules are CEO config: `checks` in the company config, checked at boot, never changed by an agent.

Agent-written text runs through these checks on the server's only thread, so their cost is bounded:
- every repeated part of a pattern has a length limit and cannot contain its own opening character, so matching time grows linearly with the text;
- addresses longer than 254 characters are refused;
- at most 200 links are checked per text;
- at most 1 MB is read per submission, and each file listed twice is read once.

A file system error is reported as "cannot be read (CODE)", with the workspace path only.

**Checks are recorded through the engine.** Recording uses a new command, `recordChecks(taskId, submission, results, files)`:

- It accepts results only for a task in `review` whose current submission has none yet. `task.submitted` clears them and counts the submission (`Task.submissions`). `awaitingChecks` hands out that number and `recordChecks` must name it, so results are never taken for a later submission.
- `files` holds the sha256 of each file, taken from the same read the checks used (`checkSubmission`). Under `strictReview`, a pass must have a hash for every artifact. A file the gateway could not hash fails the check `files.hashed`.
- It emits `checks.passed` or `checks.failed`.
- A failure sends the task back to `working`. The worker's feedback lists each failed check and its reasons.
- A failure counts as a review attempt, so `maxReviewAttempts` failures escalate the task exactly as failed reviews do.

The server runs the checks inside `submitForReview`, after the submit is durable. On boot, recovery runs them for any submission left unchecked by a crash, before agents start; the stuck timer retries any whose results could not be recorded. The kill switch holds checks like everything else: none run while the company is paused, and the waiting ones run on resume. The runtime offers a reviewer only tasks whose checks are recorded. A check that throws is recorded as a failed check (`checks`), never skipped. The events carry no agent: the gateway ran them.

**A review is of the checked files.** Workers share one workspace, so another task can rewrite a file while this one waits for review. `checks.passed` records the hashes (`Task.checkedFiles`). When a verdict arrives, the server hashes the files again and records the review in the same synchronous command, so nothing can write in between. If a file changed:
1. The server records `checks.reset` (engine command `resetChecks`). This is not a failed attempt.
2. The verdict is refused.
3. The gateway checks the files again.

The reviewer then starts a fresh review of what is there now. If the files change during review `maxReviewAttempts` times for one submission, the task escalates ("its files kept changing during review"), so a worker that keeps rewriting a shared file cannot hold a task in review.

**Strict review.** With `strictReview` (set by the server; off by default in `packages/core` so older tests and tools keep working), `recordReview` refuses a verdict until checks are recorded for the submission. It also refuses a verdict without a rubric that covers every acceptance criterion exactly once. `passed` must equal "every criterion met", and an unmet criterion needs a note. The rubric is stored in the `review.passed` / `review.failed` event. Outside strict mode a rubric, if given, is checked the same way.

**The reviewer judges criteria; code decides the verdict.** The reviewer model answers `{ criteria: [{ criterion, met, evidence }], feedback }`, a JSON schema enforced as structured output. Then code takes over:

- It matches each item to one criterion, by the criterion's text or its number. It takes the items in order only when no item names any criterion.
- It asks again if any criterion is not judged exactly once, or if any item is malformed (a dropped item might be the one that said "not met"). A guess there could give one criterion another's verdict and turn a "not met" into a pass.
- It sets `passed` to "every item met" and `score` to the share met. The engine computes the stored score from the rubric too, so the CEO never sees a score the rubric does not support.
- It builds the feedback: each unmet criterion with its evidence, then the model's own feedback.

The model is told it does not decide pass or fail.

## Consequences

- The reviewer sees only work that passed its checks, so its turns go to judgement, not to spotting placeholders. A failed check costs no model tokens.
- A pass can no longer contradict the rubric, and the stored rubric shows which criterion failed and why.
- A plan with a blank or repeated acceptance criterion is refused at gate 1, since a rubric must judge each criterion exactly once.
- The `checks.*` events, `Task.checkResults`, `checkedFiles`, `submissions` and `checkResets` are replayed by `apply()`. A log written before M5 has none of them; replay sets them to `null`, `null`, `0` and `0`, then counts the submissions in the log.
- Failed check runs and failed reviews share one count, so the escalation reads "failed its checks or review N times".
- **Code checks are deferred to M7.** Tests, lint and build would run code written by an agent. That needs a sandbox (no network, a resource limit, a throwaway copy of the workspace), which does not exist yet, and no agent writes code yet. The `CONTENT_EXTENSIONS` list means code files get only `files.exist` until then.
- The checks are heuristics. A placeholder rule can flag real text (a document about `TODO` lists), and word counts are rough. The CEO can loosen the length rules in config; the placeholder list is fixed in code for now.
