import { randomUUID } from 'node:crypto';
import { fail, ok, type ActionResult, type ProposedAction, type Result, type ToolCallDecision } from '@ai-company/core';
import { CredentialStore } from './credentials.ts';
import { ToolInputError, TransientToolError, type ToolExecutor, type ToolRegistry } from './registry.ts';

/** Per-tool limits, set by the CEO in the company config (invariant 10). */
export interface ToolSettings {
  /** Longest one attempt may take. */
  timeoutMs: number;
  /** Tries in all, counting the first; only transient failures are retried. */
  maxAttempts: number;
  /** Calls started per rolling minute across all agents; null for no limit. */
  ratePerMinute: number | null;
}

export const DEFAULT_TOOL_SETTINGS: ToolSettings = { timeoutMs: 30_000, maxAttempts: 3, ratePerMinute: null };
export const DEFAULT_BACKOFF = { baseMs: 500, maxMs: 10_000 };

/** The longest one call can take with these settings: every attempt, every backoff and every rate-limit wait. */
export function worstCaseCallMs(settings: ToolSettings, backoff = DEFAULT_BACKOFF): number {
  let total = settings.timeoutMs * settings.maxAttempts;
  for (let k = 1; k < settings.maxAttempts; k++) total += Math.min(backoff.maxMs, backoff.baseMs * 2 ** (k - 1));
  if (settings.ratePerMinute) total += 60_000 * settings.maxAttempts;
  return total;
}

/**
 * The engine commands the gateway needs, each run through the server's
 * command queue, so a decision is acted on only once it is durable.
 */
export interface GatewayEnginePort {
  requestToolCall(taskId: string, agentId: string, call: ProposedAction): Promise<Result<ToolCallDecision>>;
  recordToolResult(taskId: string, idempotencyKey: string, result: ActionResult): Promise<Result<true>>;
  recordActionResult(taskId: string, idempotencyKey: string, result: ActionResult): Promise<Result<true>>;
  /** Durable before the action's first attempt, so recovery knows it may have run. */
  recordActionStarted(taskId: string, idempotencyKey: string): Promise<Result<true>>;
  pendingToolCalls(): Promise<{ taskId: string; tool: string; idempotencyKey: string }[]>;
  /** `started`: the action may have run (it has a start record, or predates them). */
  pendingActions(): Promise<{ taskId: string; action: ProposedAction; started?: boolean }[]>;
  /** The kill switch: nothing runs while it is on. */
  isPaused(): Promise<boolean>;
}

export interface GatewayOptions {
  engine: GatewayEnginePort;
  tools: ToolRegistry;
  credentials?: CredentialStore;
  /** Overrides of DEFAULT_TOOL_SETTINGS by tool name. */
  settings?: Record<string, Partial<ToolSettings>>;
  log?: (message: string) => void;
  newKey?: () => string;
  /** Clock and sleep for rate limits and backoff; tests replace them. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /** First retry waits about this long, doubling up to maxBackoffMs. */
  baseBackoffMs?: number;
  maxBackoffMs?: number;
}

/** Longest tool output handed back to a model. */
export const MAX_TOOL_OUTPUT = 20_000;
/** Longest result text kept in an event. */
export const MAX_DETAIL = 1_000;

type Attempted =
  | { ok: true; output: string; attempts: number }
  /** `message` is for the model; `detail` for the log and the event. `held`: the company was paused before an attempt, so nothing more ran. */
  | { ok: false; message: string; detail: string; attempts: number; held?: boolean };

const PAUSED = 'the company was paused before it ran; nothing was done';

/**
 * The only code that runs tools (M4). Work-time calls: ask the engine
 * (`requestToolCall`) → run only on a durable `allow` → record the result
 * (`tool.executed` / `tool.failed`). Final actions: run only what the engine
 * released (`recordReview` / `decideApproval`), once per idempotency key, and
 * record `action.executed` / `action.failed`. Every attempt has a timeout;
 * transient failures are retried with backoff; each tool can be rate
 * limited. Credentials stay here, and their values are removed from every
 * text that leaves (invariant 6).
 */
export class ToolGateway {
  private readonly engine: GatewayEnginePort;
  private readonly tools: ToolRegistry;
  private readonly credentials: CredentialStore;
  private readonly settings: Record<string, Partial<ToolSettings>>;
  private readonly log: (message: string) => void;
  private readonly newKey: () => string;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly windows = new Map<string, number[]>();
  /** Final actions running now, by idempotency key. */
  private readonly actions = new Map<string, Promise<void>>();
  /** Everything running now; close() waits for it. */
  private readonly inFlight = new Set<Promise<unknown>>();
  private closing = false;

  constructor(options: GatewayOptions) {
    this.engine = options.engine;
    this.tools = options.tools;
    this.credentials = options.credentials ?? new CredentialStore();
    this.settings = options.settings ?? {};
    this.log = options.log ?? ((m) => console.error(`[gateway] ${m}`));
    this.newKey = options.newKey ?? (() => randomUUID());
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.random = options.random ?? Math.random;
    this.baseBackoffMs = options.baseBackoffMs ?? DEFAULT_BACKOFF.baseMs;
    this.maxBackoffMs = options.maxBackoffMs ?? DEFAULT_BACKOFF.maxMs;
    for (const tool of this.tools.list()) {
      for (const name of tool.credentials ?? []) {
        if (!this.credentials.has(name)) this.log(`tool ${tool.name} needs credential "${name}", which is not set up; its calls will fail`);
      }
    }
  }

  settingsFor(tool: string): ToolSettings {
    return { ...DEFAULT_TOOL_SETTINGS, ...this.settings[tool] };
  }

  /** Name, description and input schema of every tool this gateway can run. */
  describe() {
    return this.tools.describe();
  }

  has(tool: string): boolean {
    return this.tools.has(tool);
  }

  /**
   * A worker's tool call. The key is made here, never by the agent or model.
   * Returns the tool's output (or why it failed) as text for the model.
   */
  call(taskId: string, agentId: string, tool: string, input: unknown): Promise<Result<string>> {
    return this.track(this.callOnce(taskId, agentId, tool, input));
  }

  private async callOnce(taskId: string, agentId: string, tool: string, input: unknown): Promise<Result<string>> {
    if (this.closing) return fail('the server is stopping; try again later');
    const idempotencyKey = this.newKey();
    const decision = await this.engine.requestToolCall(taskId, agentId, { tool, input, idempotencyKey });
    if (!decision.ok) return decision;
    // Never on duplicate: the key was already used once.
    if (decision.value.kind !== 'allow') return fail('this call was already made; it was not run again');

    const result = await this.attempt(tool, input, idempotencyKey);
    const detail = result.ok ? this.clip(result.output, MAX_DETAIL) : result.detail;
    // A held call is recorded as failed: the worker's turn is over, and it asks again after the resume.
    const recorded = await this.engine.recordToolResult(taskId, idempotencyKey, { ok: result.ok, detail, attempts: result.attempts });
    if (!recorded.ok) this.log(`could not record the result of ${tool} for task ${taskId}: ${recorded.error}`);
    if (!result.ok) {
      this.log(`tool ${tool} for task ${taskId} failed: ${result.detail}`);
      return fail(result.message);
    }
    return ok(this.clip(result.output, MAX_TOOL_OUTPUT));
  }

  /**
   * Runs a released final action once per key, without making the caller
   * wait. Call only after the release is durable. A key already running in
   * this process is not started again; across a crash, recover() decides.
   * While the company is paused the action is held, and runs on resume().
   */
  release(taskId: string, action: ProposedAction): Promise<void> {
    const key = action.idempotencyKey;
    const running = this.actions.get(key);
    if (running) return running;
    if (this.closing) {
      // Its result could not be recorded now: leave it pending for recover() on the next boot.
      this.log(`final action ${action.tool} for task ${taskId} left for the next start: the server is stopping`);
      return Promise.resolve();
    }
    const done = this.track(this.executeAction(taskId, action)).finally(() => this.actions.delete(key));
    this.actions.set(key, done);
    return done;
  }

  private async executeAction(taskId: string, action: ProposedAction): Promise<void> {
    const key = action.idempotencyKey;
    try {
      // Never trust the caller: run only an action the engine released and has no result for.
      const released = (await this.engine.pendingActions()).find((p) => p.taskId === taskId && p.action.idempotencyKey === key);
      if (!released) {
        this.log(`final action ${action.tool} (${key}) for task ${taskId} is not released or already has a result; not run`);
        return;
      }
      const started = () => this.mustRecord(this.engine.recordActionStarted(taskId, key));
      const result = await this.attempt(released.action.tool, released.action.input, key, started);
      if (!result.ok && result.held) {
        this.log(`final action ${action.tool} for task ${taskId} is held until the company resumes`);
        return;
      }
      const recorded: ActionResult = result.ok
        ? { ok: true, detail: this.clip(result.output, MAX_DETAIL), attempts: result.attempts }
        : { ok: false, detail: result.detail, attempts: result.attempts };
      const r = await this.engine.recordActionResult(taskId, key, recorded);
      if (!r.ok) this.log(`could not record the result of ${action.tool} for task ${taskId}: ${r.error}`);
      else this.log(`final action ${action.tool} for task ${taskId} ${recorded.ok ? 'done' : 'failed'}: ${recorded.detail}`);
    } catch (err) {
      // Recording failed, so the server has gone fatal; the action stays pending for the next boot.
      this.log(`final action ${action.tool} for task ${taskId} was not recorded: ${this.text(err)}`);
    }
  }

  /**
   * After a crash: interrupted work-time calls are recorded as failed (the
   * worker redoes its turn with new keys). A released final action with no
   * result is run again only if its tool dedupes by key; otherwise it is
   * recorded as failed for the CEO to check by hand. Call once on boot,
   * before agents start.
   */
  async recover(): Promise<void> {
    for (const call of await this.engine.pendingToolCalls()) {
      const detail = 'interrupted by a restart before its result was recorded; it may or may not have run';
      const r = await this.engine.recordToolResult(call.taskId, call.idempotencyKey, { ok: false, detail });
      if (!r.ok) this.log(`could not record interrupted ${call.tool} for task ${call.taskId}: ${r.error}`);
    }
    for (const { taskId, action, started } of await this.engine.pendingActions()) {
      const executor = this.tools.get(action.tool);
      // Never started (e.g. held by the kill switch): it cannot have acted, so it runs normally.
      if (started && executor && !executor.dedupesByKey) {
        const detail = `interrupted before its result was recorded; not retried because "${action.tool}" cannot detect a repeat. Check it by hand.`;
        const r = await this.engine.recordActionResult(taskId, action.idempotencyKey, { ok: false, detail });
        this.log(r.ok ? `final action ${action.tool} for task ${taskId}: ${detail}` : `could not record ${action.tool} for task ${taskId}: ${r.error}`);
      } else {
        await this.release(taskId, action);
      }
    }
  }

  /** After the kill switch is released: runs the final actions held while it was on. */
  async resume(): Promise<void> {
    // Let actions that are finishing (or just found themselves held) settle first.
    await Promise.allSettled([...this.actions.values()]);
    for (const { taskId, action } of await this.engine.pendingActions()) void this.release(taskId, action);
  }

  /** Refuses new calls and waits for running ones to record their results. */
  async close(): Promise<void> {
    this.closing = true;
    while (this.inFlight.size) await Promise.allSettled([...this.inFlight]);
  }

  // ───────────────────────── running a tool ─────────────────────────

  /** Runs a tool with its timeout, retries and rate limit. Never throws. */
  private async attempt(tool: string, input: unknown, idempotencyKey: string, beforeFirstRun?: () => Promise<void>): Promise<Attempted> {
    const executor = this.tools.get(tool);
    if (!executor) return { ok: false, message: `"${tool}" is not available on this server`, detail: `no executor for "${tool}"; nothing was done`, attempts: 0 };
    const settings = this.settingsFor(tool);
    // A transient failure happened before any effect; a timed-out attempt may still have acted.
    let mayHaveActed = false;
    for (let attempts = 1; ; attempts++) {
      await this.takeSlot(tool, settings.ratePerMinute);
      // The kill switch may have been pressed since the allow, a rate-limit wait or the last try.
      if (await this.engine.isPaused()) {
        const detail = mayHaveActed ? 'the company was paused before a retry; an earlier attempt may have taken effect' : PAUSED;
        return { ok: false, message: 'the company is paused; the call was stopped', detail, attempts: attempts - 1, held: true };
      }
      if (attempts === 1) await beforeFirstRun?.();
      const once = await this.runOnce(executor, input, idempotencyKey, settings.timeoutMs);
      if (once.ok) return { ok: true, output: this.credentials.redact(once.output), attempts };
      const failure = { ...this.describeFailure(executor, once.error, once.timedOut, settings.timeoutMs), attempts };
      // Retry only what cannot act twice: a failure the tool says happened
      // before any effect, or a timeout of a tool that dedupes by key.
      const safe = once.error instanceof TransientToolError || (once.timedOut && executor.dedupesByKey);
      if (once.timedOut) mayHaveActed = true;
      if (!safe || attempts >= settings.maxAttempts || this.closing) return failure;
      const wait = this.backoff(attempts);
      this.log(`tool ${tool} attempt ${attempts} failed (${failure.detail}); retrying in ${wait} ms`);
      await this.sleep(wait);
    }
  }

  private async runOnce(
    executor: ToolExecutor,
    input: unknown,
    idempotencyKey: string,
    timeoutMs: number,
  ): Promise<{ ok: true; output: string } | { ok: false; error: unknown; timedOut: boolean }> {
    const controller = new AbortController();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new Error(`timed out after ${timeoutMs} ms`));
      }, timeoutMs);
    });
    const declared = new Set(executor.credentials ?? []);
    const credential = (name: string): string => {
      if (!declared.has(name)) throw new Error(`"${executor.name}" did not declare credential "${name}"`);
      const value = this.credentials.reveal(name);
      if (value === undefined) throw new Error(`credential "${name}" is not set up`);
      return value;
    };
    try {
      // A tool that ignores the signal is not waited for: after the timeout it
      // may still finish, which is why only deduping tools are retried then.
      const run = Promise.resolve().then(() => executor.run(input, { idempotencyKey, signal: controller.signal, credential }));
      const output = await Promise.race([run, timeout]);
      if (typeof output !== 'string') return { ok: false, error: new Error('the tool returned no text'), timedOut: false };
      return { ok: true, output };
    } catch (error) {
      return { ok: false, error, timedOut };
    } finally {
      clearTimeout(timer);
    }
  }

  private describeFailure(executor: ToolExecutor, error: unknown, timedOut: boolean, timeoutMs: number): { ok: false; message: string; detail: string } {
    const detail = this.clip(this.text(error), MAX_DETAIL);
    if (timedOut) {
      const maybe = executor.dedupesByKey ? '' : '; it may still have taken effect';
      return { ok: false, message: `${executor.name} timed out after ${timeoutMs} ms${maybe}`, detail: `timed out after ${timeoutMs} ms${maybe}` };
    }
    if (error instanceof ToolInputError) return { ok: false, message: detail, detail };
    if (error instanceof TransientToolError) return { ok: false, message: `${executor.name} is temporarily unavailable; try later or report_blocked`, detail };
    return { ok: false, message: `${executor.name} failed; try again or report_blocked`, detail };
  }

  /** Waits until the tool's rolling-minute window has room. */
  private async takeSlot(tool: string, perMinute: number | null): Promise<void> {
    if (!perMinute) return;
    for (;;) {
      const now = this.now();
      const window = (this.windows.get(tool) ?? []).filter((t) => t > now - 60_000);
      if (window.length < perMinute) {
        window.push(now);
        this.windows.set(tool, window);
        return;
      }
      this.windows.set(tool, window);
      await this.sleep(window[0] + 60_000 - now);
    }
  }

  /** Doubling delay with jitter, capped. */
  private backoff(attempt: number): number {
    const ceiling = Math.min(this.maxBackoffMs, this.baseBackoffMs * 2 ** (attempt - 1));
    return Math.round(ceiling / 2 + (this.random() * ceiling) / 2);
  }

  private async mustRecord(r: Promise<Result<true>>): Promise<void> {
    const recorded = await r;
    if (!recorded.ok) throw new Error(recorded.error);
  }

  private track<T>(p: Promise<T>): Promise<T> {
    this.inFlight.add(p);
    void p.finally(() => this.inFlight.delete(p)).catch(() => {});
    return p;
  }

  private text(err: unknown): string {
    return this.credentials.redact(err instanceof Error ? err.message : String(err));
  }

  private clip(text: string, max: number): string {
    const clean = this.credentials.redact(text);
    return clean.length > max ? `${clean.slice(0, max)}\n… (truncated)` : clean;
  }
}
