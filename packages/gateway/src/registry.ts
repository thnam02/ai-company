/** A JSON schema object, shown to models as a tool's input format. */
export type JsonSchema = Record<string, unknown>;

/** Bad input from the model: reported back to it so it can fix the call. Never retried. */
export class ToolInputError extends Error {}

/**
 * A temporary failure that happened before the tool had any effect (a 429, a
 * 503, a refused connection), so trying again is safe. The gateway retries
 * these with backoff; every other error is final.
 */
export class TransientToolError extends Error {}

export interface ToolRunContext {
  /** Unique per real-world effect: pass it to services that dedupe by key. */
  idempotencyKey: string;
  /** Aborted when this attempt times out. (Stopping the server waits for running calls instead.) */
  signal: AbortSignal;
  /**
   * The value of a credential this tool declared in `credentials`. Throws for
   * any other name. Use it only to call the service: never put it in output.
   */
  credential(name: string): string;
}

/**
 * Code that performs one tool's real-world effect. Only the gateway runs it,
 * after the engine allowed the call (or released the final action) and that
 * decision is durable. It never decides whether it may run.
 */
export interface ToolExecutor {
  name: string;
  description: string;
  /** JSON schema of the input, shown to the model. */
  parameters: JsonSchema;
  /**
   * True if running the same idempotency key twice has the effect of running
   * it once. Only such tools are retried after a timeout or re-run after a
   * crash (ADR 0003, ADR 0004).
   */
  dedupesByKey: boolean;
  /** Names of the server-side credentials this tool needs. */
  credentials?: string[];
  /** Returns text for the model. Throws ToolInputError for bad input, TransientToolError for a safe-to-retry failure. */
  run(input: unknown, ctx: ToolRunContext): Promise<string>;
}

/** What agents may know about a tool: never its code or credentials. */
export interface ToolDescription {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolExecutor>();

  constructor(executors: ToolExecutor[] = []) {
    for (const e of executors) {
      if (this.tools.has(e.name)) throw new Error(`duplicate tool executor "${e.name}"`);
      this.tools.set(e.name, e);
    }
  }

  get(name: string): ToolExecutor | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): ToolExecutor[] {
    return [...this.tools.values()];
  }

  describe(): ToolDescription[] {
    return this.list().map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
  }
}
