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

/**
 * A provider's own record of an answer (e.g. Claude's content blocks with
 * thinking), replayed unchanged by that provider on the next turn. Opaque to
 * agent code; it never holds credentials.
 */
export interface ProviderRaw {
  provider: string;
  content: unknown;
}

export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[]; raw?: ProviderRaw }
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
  /**
   * Most tokens one answer may generate, thinking included. A capped call
   * always comes back (and is recorded); an uncapped local model can think
   * until the request times out, and a timed-out call records nothing.
   */
  maxTokens?: number;
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
  /** True when the provider gave no counts and these are estimates (about 4 characters per token). */
  estimated?: boolean;
}

export interface ChatResult {
  text: string;
  toolCalls: ToolCall[];
  usage: Usage;
  /** Keep on the assistant message so the provider can replay it unchanged. */
  raw?: ProviderRaw;
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
