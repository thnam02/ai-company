import type { ChatRequest, ChatResult, ModelProvider, ToolCall } from '../model.ts';

/** One scripted answer: plain text, tool calls, or a function of the request. */
export type ScriptedTurn =
  | { text?: string; toolCalls?: (Omit<ToolCall, 'id'> & { id?: string })[]; usage?: { inputTokens: number; outputTokens: number } }
  | ((request: ChatRequest) => ScriptedTurn);

/**
 * A model that plays back a script, for tests: no real model in CI. Every
 * request is kept so tests can check what the agent was shown.
 */
export class ScriptedProvider implements ModelProvider {
  readonly id = 'scripted';
  readonly requests: ChatRequest[] = [];
  private readonly turns: ScriptedTurn[];

  constructor(turns: ScriptedTurn[] = []) {
    this.turns = [...turns];
  }

  push(...turns: ScriptedTurn[]): void {
    this.turns.push(...turns);
  }

  get remaining(): number {
    return this.turns.length;
  }

  async chat(request: ChatRequest): Promise<ChatResult> {
    this.requests.push(structuredClone(request));
    let turn = this.turns.shift();
    if (turn === undefined) throw new Error('scripted model has no more turns');
    while (typeof turn === 'function') turn = turn(request);
    return {
      text: turn.text ?? '',
      toolCalls: (turn.toolCalls ?? []).map((c, i) => ({ id: c.id ?? `call_${this.requests.length}_${i}`, name: c.name, arguments: c.arguments })),
      usage: turn.usage ?? { inputTokens: 100, outputTokens: 20 },
    };
  }
}
