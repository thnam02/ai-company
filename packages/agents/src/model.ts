/**
 * The only way agent code talks to a model. Agent code never imports a
 * vendor SDK; each vendor is one ModelProvider (invariant 12).
 */

export type JsonSchema = Record<string, unknown>;

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; content: string; toolCallId: string; name: string };

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: JsonSchema;
}

/** Per-agent model options from the company config. */
export interface ModelOptions {
  temperature?: number;
  numCtx?: number;
  think?: boolean;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  /** JSON schema the answer must follow (structured output). */
  format?: JsonSchema;
  options?: ModelOptions;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface ChatResult {
  text: string;
  toolCalls: ToolCall[];
  usage: Usage;
}

export interface ModelProvider {
  /** Provider id as used in model refs, e.g. "ollama". */
  readonly id: string;
  chat(request: ChatRequest, signal?: AbortSignal): Promise<ChatResult>;
}

/** A model reference from the company config: "<provider>:<model>", e.g. "ollama:qwen3:8b". */
export interface ModelRef {
  provider: string;
  model: string;
}

export function parseModelRef(ref: string): ModelRef | null {
  const m = /^([a-z][a-z0-9-]*):(.+)$/.exec(ref);
  return m ? { provider: m[1], model: m[2] } : null;
}

export const totalTokens = (u: Usage): number => u.inputTokens + u.outputTokens;
