import type { ChatMessage, ChatRequest, ChatResult, ModelProvider, ToolCall, Usage } from '../model.ts';

export interface OllamaOptions {
  /** Default http://127.0.0.1:11434. */
  baseUrl?: string;
  /** Per request. Local models can be slow on long contexts; default 10 minutes. */
  timeoutMs?: number;
  /** How long Ollama keeps the model loaded after a request; default "5m", so an idle company frees the RAM. */
  keepAlive?: string;
}

/** Local models through Ollama's /api/chat (no SDK, plain HTTP). */
export class OllamaProvider implements ModelProvider {
  readonly id = 'ollama';
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly keepAlive: string;

  constructor(options: OllamaOptions = {}) {
    this.baseUrl = (options.baseUrl ?? 'http://127.0.0.1:11434').replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 10 * 60_000;
    this.keepAlive = options.keepAlive ?? '5m';
  }

  async chat(request: ChatRequest, signal?: AbortSignal): Promise<ChatResult> {
    const body: Record<string, unknown> = {
      model: request.model,
      messages: request.messages.map(toOllama),
      stream: false,
      keep_alive: this.keepAlive,
    };
    if (request.tools?.length) {
      body.tools = request.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
    }
    if (request.format) body.format = request.format;
    const o = request.options ?? {};
    if (o.think !== undefined) body.think = o.think;
    const options: Record<string, number> = {};
    if (o.temperature !== undefined) options.temperature = o.temperature;
    if (o.numCtx !== undefined) options.num_ctx = o.numCtx;
    if (Object.keys(options).length) body.options = options;

    const timeout = AbortSignal.timeout(this.timeoutMs);
    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    const raw = await res.text();
    if (!res.ok) {
      let detail = raw;
      try {
        detail = JSON.parse(raw).error ?? raw;
      } catch {
        // Not JSON; keep the raw text.
      }
      throw new Error(`ollama returned ${res.status}: ${String(detail).slice(0, 300)}`);
    }
    const json = JSON.parse(raw);
    const message = json.message ?? {};
    const toolCalls: ToolCall[] = (message.tool_calls ?? []).map((c: any, i: number) => ({
      id: typeof c.id === 'string' && c.id ? c.id : `call_${i}`,
      name: String(c.function?.name ?? ''),
      arguments: parseArguments(c.function?.arguments),
    }));
    return {
      text: typeof message.content === 'string' ? message.content : '',
      toolCalls,
      usage: usage(json, body.messages as unknown[], message),
    };
  }
}

function toOllama(m: ChatMessage): Record<string, unknown> {
  switch (m.role) {
    case 'assistant':
      return m.toolCalls?.length
        ? { role: 'assistant', content: m.content, tool_calls: m.toolCalls.map((c) => ({ function: { name: c.name, arguments: c.arguments } })) }
        : { role: 'assistant', content: m.content };
    case 'tool':
      return { role: 'tool', content: m.content, tool_name: m.name };
    default:
      return { role: m.role, content: m.content };
  }
}

function parseArguments(args: unknown): Record<string, unknown> {
  if (args && typeof args === 'object' && !Array.isArray(args)) return args as Record<string, unknown>;
  if (typeof args === 'string') {
    try {
      const parsed = JSON.parse(args);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      // Fall through: the agent loop reports this back to the model.
    }
    return { _invalidArguments: args.slice(0, 1000) };
  }
  return {};
}

const count = (n: unknown): number | undefined => (typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.round(n) : undefined);

/**
 * Real counts from Ollama. If a count is missing, estimate it (about 4
 * characters per token) rather than record 0, which would let a goal spend
 * past its budget unseen.
 */
function usage(json: any, sent: unknown[], message: unknown): Usage {
  const input = count(json.prompt_eval_count);
  const output = count(json.eval_count);
  if (input !== undefined && output !== undefined) return { inputTokens: input, outputTokens: output };
  const estimate = (v: unknown) => Math.ceil(JSON.stringify(v ?? '').length / 4);
  return { inputTokens: input ?? estimate(sent), outputTokens: output ?? estimate(message), estimated: true };
}
