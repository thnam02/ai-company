import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { ClaudeProvider } from '../src/providers/claude.ts';
import type { ChatMessage } from '../src/model.ts';

const KEY = 'sk-ant-test-0123456789-do-not-leak';

/** A fake Messages API: records each request and answers with the next scripted reply. */
function fakeClaude() {
  const requests: { path: string; headers: Record<string, string | string[] | undefined>; body: any }[] = [];
  const replies: { status?: number; body: unknown }[] = [];
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      requests.push({ path: req.url ?? '', headers: req.headers, body: JSON.parse(raw || 'null') });
      const reply = replies.shift() ?? { status: 500, body: { type: 'error', error: { type: 'api_error', message: 'no reply scripted' } } };
      res.writeHead(reply.status ?? 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply.body));
    });
  });
  return { server, requests, replies };
}

const message = (content: unknown[], extra: Record<string, unknown> = {}) => ({
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-5-5',
  content,
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 900, output_tokens: 40, cache_creation_input_tokens: 100, cache_read_input_tokens: 2_000 },
  ...extra,
});

describe('ClaudeProvider', () => {
  let fake: ReturnType<typeof fakeClaude>;
  let provider: ClaudeProvider;

  beforeEach(async () => {
    fake = fakeClaude();
    fake.server.listen(0, '127.0.0.1');
    await once(fake.server, 'listening');
    provider = new ClaudeProvider({ apiKey: KEY, baseURL: `http://127.0.0.1:${(fake.server.address() as AddressInfo).port}`, maxRetries: 0 });
  });
  afterEach(() => {
    fake.server.closeAllConnections();
    fake.server.close();
  });

  test('sends system, tools and structured output; returns text, tool calls and every input token', async () => {
    fake.replies.push({
      body: message([
        { type: 'thinking', thinking: '', signature: 'sig-1' },
        { type: 'text', text: 'Reading the notes.' },
        { type: 'tool_use', id: 'toolu_1', name: 'files_read', input: { path: 'notes' } },
      ], { stop_reason: 'tool_use' }),
    });
    const result = await provider.chat({
      model: 'claude-opus-5-5',
      messages: [
        { role: 'system', content: 'You are Kai.' },
        { role: 'user', content: 'Write the brief.' },
      ],
      tools: [{ name: 'files_read', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }],
      format: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false },
      options: { think: false, temperature: 0.2, numCtx: 16384 },
    });
    assert.equal(result.text, 'Reading the notes.');
    assert.deepEqual(result.toolCalls, [{ id: 'toolu_1', name: 'files_read', arguments: { path: 'notes' } }]);
    assert.deepEqual(result.usage, { inputTokens: 3_000, outputTokens: 40 }, 'cached input counts toward the budget too');

    const [req] = fake.requests;
    assert.match(req.path, /^\/v1\/messages/);
    assert.ok(req.headers['x-api-key'] === KEY || req.headers.authorization === `Bearer ${KEY}`, 'the key goes in a header');
    assert.equal(req.headers['anthropic-beta'], undefined, "no beta: the CEO's model answers, never a fallback the API picks");
    assert.equal(req.body.model, 'claude-opus-5-5');
    assert.equal(req.body.system, 'You are Kai.');
    assert.deepEqual(req.body.messages, [{ role: 'user', content: 'Write the brief.' }]);
    assert.deepEqual(req.body.tools, [{ name: 'files_read', description: 'Read a file', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }]);
    assert.deepEqual(req.body.output_config, { effort: 'low', format: { type: 'json_schema', schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false } } });
    assert.equal('fallbacks' in req.body, false);
    for (const sampling of ['temperature', 'top_p', 'top_k', 'thinking']) assert.equal(sampling in req.body, false, `${sampling} is not sent`);
    assert.doesNotMatch(JSON.stringify(req.body), new RegExp(KEY), 'the key is only a header, never in the request body');
  });

  test("replays its own answers unchanged (thinking blocks included) and sends tool results back", async () => {
    const first = message([
      { type: 'thinking', thinking: '', signature: 'sig-1' },
      { type: 'tool_use', id: 'toolu_1', name: 'files_read', input: { path: 'notes' } },
    ], { stop_reason: 'tool_use' });
    fake.replies.push({ body: first }, { body: message([{ type: 'text', text: 'Done.' }]) });
    const messages: ChatMessage[] = [{ role: 'user', content: 'Go.' }];
    const r1 = await provider.chat({ model: 'claude-opus-5-5', messages });
    messages.push({ role: 'assistant', content: r1.text, toolCalls: r1.toolCalls, raw: r1.raw });
    messages.push({ role: 'tool', content: 'idea.md', toolCallId: 'toolu_1', name: 'files_read' });
    messages.push({ role: 'user', content: 'Continue.' });
    // An answer from another provider is converted, not replayed.
    messages.push({ role: 'assistant', content: 'from ollama', raw: { provider: 'ollama', content: 'x' } });
    messages.push({ role: 'user', content: 'Again.' });
    await provider.chat({ model: 'claude-opus-5-5', messages });

    assert.deepEqual(fake.requests[1].body.messages, [
      { role: 'user', content: 'Go.' },
      { role: 'assistant', content: first.content },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'idea.md' }] },
      { role: 'user', content: 'Continue.' },
      { role: 'assistant', content: [{ type: 'text', text: 'from ollama' }] },
      { role: 'user', content: 'Again.' },
    ]);
  });

  test('a refusal is an empty answer that is still charged, so the turn is recorded', async () => {
    fake.replies.push({
      body: message([{ type: 'tool_use', id: 'toolu_9', name: 'files_write', input: { path: 'x' } }], {
        stop_reason: 'refusal',
        stop_details: { type: 'refusal', category: 'cyber', explanation: '' },
        usage: { input_tokens: 900, output_tokens: 12, cache_creation_input_tokens: 0, cache_read_input_tokens: 100 },
      }),
    });
    const r = await provider.chat({ model: 'claude-opus-5-5', messages: [{ role: 'user', content: 'x' }] });
    assert.equal(r.text, '');
    assert.deepEqual(r.toolCalls, [], 'nothing from a declined answer is acted on');
    assert.deepEqual(r.usage, { inputTokens: 1000, outputTokens: 12 });
    assert.equal(r.raw, undefined, 'a declined answer is not replayed');
  });

  test('an API error becomes an error without the key', async () => {
    fake.replies.push({ status: 401, body: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } } });
    const err = await provider.chat({ model: 'claude-opus-5-5', messages: [{ role: 'user', content: 'x' }] }).catch((e: Error) => e);
    assert.match(String(err), /claude returned 401/);
    assert.doesNotMatch(String(err), new RegExp(KEY));
  });

  test('needs a key, and never exposes it', () => {
    assert.throws(() => new ClaudeProvider({ apiKey: '' }), /needs an API key/);
    assert.doesNotMatch(JSON.stringify(provider), new RegExp(KEY));
    assert.deepEqual(Object.keys(provider), ['id']);
  });
});
