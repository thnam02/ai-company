import Anthropic from '@anthropic-ai/sdk';
import type { ChatMessage, ChatRequest, ChatResult, JsonSchema, ModelProvider, ToolCall } from '../model.ts';

export interface ClaudeOptions {
  /** Held only inside the SDK client: never in prompts, events, checkpoints or logs (invariant 6). */
  apiKey: string;
  /** For tests against a fake server. */
  baseURL?: string;
  /** Per request; default 10 minutes. */
  timeoutMs?: number;
  /** SDK retries for 429, 5xx and connection errors; default 2. */
  maxRetries?: number;
}

const PROVIDER = 'claude';
const DEFAULT_MAX_TOKENS = 16_000;

/**
 * Claude through the official Anthropic SDK (Messages API). Used only when
 * the CEO configures an API key. Thinking is adaptive (always on for current
 * models); `think: false` lowers the effort instead. Sampling options such
 * as temperature are not sent: current models reject them. No server-side
 * fallback: the model the CEO configured is the one that answers.
 */
export class ClaudeProvider implements ModelProvider {
  readonly id = PROVIDER;
  readonly #client: Anthropic;

  constructor(options: ClaudeOptions) {
    if (!options.apiKey) throw new Error('ClaudeProvider needs an API key');
    this.#client = new Anthropic({
      apiKey: options.apiKey,
      ...(options.baseURL ? { baseURL: options.baseURL } : {}),
      timeout: options.timeoutMs ?? 10 * 60_000,
      maxRetries: options.maxRetries ?? 2,
    });
  }

  async chat(request: ChatRequest, signal?: AbortSignal): Promise<ChatResult> {
    const system = request.messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n');
    const think = request.options?.think;
    const outputConfig: Anthropic.Beta.BetaOutputConfig = {
      ...(think === false ? { effort: 'low' as const } : think === true ? { effort: 'high' as const } : {}),
      ...(request.format ? { format: { type: 'json_schema' as const, schema: request.format } } : {}),
    };
    let response: Anthropic.Beta.BetaMessage;
    try {
      response = await this.#client.beta.messages.create(
        {
          model: request.model,
          max_tokens: request.options?.maxTokens ?? DEFAULT_MAX_TOKENS,
          cache_control: { type: 'ephemeral' },
          ...(system ? { system } : {}),
          messages: toClaudeMessages(request.messages),
          ...(request.tools?.length
            ? { tools: request.tools.map((t) => ({ name: t.name, description: t.description, input_schema: inputSchema(t.parameters) })) }
            : {}),
          ...(Object.keys(outputConfig).length ? { output_config: outputConfig } : {}),
        },
        { signal },
      );
    } catch (err) {
      if (err instanceof Anthropic.APIError) throw new Error(`claude returned ${err.status ?? 'an error'}: ${err.message}`.slice(0, 500));
      throw err;
    }
    const u = response.usage;
    const usage = {
      inputTokens: u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
      outputTokens: u.output_tokens,
    };
    // A declined turn was billed: return it as an empty answer so the role
    // records it (invariant 7) and the step and budget limits stop retries.
    // Nothing in it is acted on or replayed.
    if (response.stop_reason === 'refusal') return { text: '', toolCalls: [], usage };
    const text = response.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
    const toolCalls: ToolCall[] = response.content
      .filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use')
      .map((b) => ({ id: b.id, name: b.name, arguments: isObject(b.input) ? b.input : {} }));
    return {
      text,
      toolCalls,
      usage,
      // Thinking blocks must go back unchanged on the next turn.
      raw: { provider: PROVIDER, content: response.content },
    };
  }
}

/** Our messages → Claude's. History is only ever appended to, so replays stay byte-identical. */
function toClaudeMessages(messages: ChatMessage[]): Anthropic.Beta.BetaMessageParam[] {
  const out: Anthropic.Beta.BetaMessageParam[] = [];
  for (const m of messages) {
    switch (m.role) {
      case 'system':
        break;
      case 'user':
        out.push({ role: 'user', content: m.content });
        break;
      case 'assistant':
        if (m.raw?.provider === PROVIDER && Array.isArray(m.raw.content)) {
          out.push({ role: 'assistant', content: m.raw.content as Anthropic.Beta.BetaContentBlockParam[] });
        } else {
          const blocks: Anthropic.Beta.BetaContentBlockParam[] = [];
          if (m.content) blocks.push({ type: 'text', text: m.content });
          for (const c of m.toolCalls ?? []) blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.arguments });
          out.push({ role: 'assistant', content: blocks.length ? blocks : '(no answer)' });
        }
        break;
      case 'tool':
        out.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: m.toolCallId, content: m.content }] });
        break;
    }
  }
  return out;
}

function inputSchema(parameters: JsonSchema): Anthropic.Beta.BetaTool.InputSchema {
  return { type: 'object', ...parameters } as Anthropic.Beta.BetaTool.InputSchema;
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
