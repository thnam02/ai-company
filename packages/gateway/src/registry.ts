import type { ActionResult, ProposedAction } from '@ai-company/core';
import type { JsonSchema } from '../model.ts';

/**
 * Code that performs one tool's real-world effect. It runs only after the
 * engine allowed the call (or released the final action) and that decision
 * is durable. It never decides whether it may run.
 */
export interface ToolExecutor {
  name: string;
  description: string;
  /** JSON schema of the input, shown to the model. */
  parameters: JsonSchema;
  /**
   * True if running the same idempotency key twice has the effect of running
   * it once. Only such actions are re-run after a crash (ADR 0003).
   */
  dedupesByKey: boolean;
  /** Returns text for the model. Throws ToolInputError for bad input. */
  run(input: unknown, ctx: { idempotencyKey: string }): Promise<string>;
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

  /** Executes a released final action. Never throws: failures become a recorded result. */
  async executeAction(action: ProposedAction): Promise<ActionResult> {
    const tool = this.tools.get(action.tool);
    if (!tool) return { ok: false, detail: `no executor for "${action.tool}" yet; nothing was done` };
    try {
      return { ok: true, detail: await tool.run(action.input, { idempotencyKey: action.idempotencyKey }) };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }
}
