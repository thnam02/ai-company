import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { OllamaProvider } from '../src/providers/ollama.ts';
import { parseModelRef } from '../src/model.ts';

/** A fake Ollama: records each /api/chat body and answers with the next scripted reply. */
function fakeOllama() {
  const bodies: any[] = [];
  const replies: { status?: number; body: unknown; delayMs?: number }[] = [];
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      bodies.push({ path: req.url, method: req.method, body: JSON.parse(raw || 'null') });
      const reply = replies.shift() ?? { status: 500, body: { error: 'no reply scripted' } };
      setTimeout(() => {
        res.writeHead(reply.status ?? 200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(reply.body));
      }, reply.delayMs ?? 0);
    });
  });
  return { server, bodies, replies };
}

describe('OllamaProvider', () => {
  let fake: ReturnType<typeof fakeOllama>;
  let url: string;

  beforeEach(async () => {
    fake = fakeOllama();
    fake.server.listen(0, '127.0.0.1');
    await once(fake.server, 'listening');
    url = `http://127.0.0.1:${(fake.server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    fake.server.closeAllConnections();
    fake.server.close();
  });

  test('sends messages, tools, format and options; returns text, tool calls and real token counts', async () => {
    fake.replies.push({
      body: {
        model: 'qwen3:8b',
        message: { role: 'assistant', content: '', thinking: 'hmm', tool_calls: [{ function: { name: 'files.read', arguments: { path: 'notes/a.md' } } }] },
        done: true,
        prompt_eval_count: 812,
        eval_count: 37,
      },
    });
    const provider = new OllamaProvider({ baseUrl: url, keepAlive: '10m' });
    const result = await provider.chat({
      model: 'qwen3:8b',
      messages: [
        { role: 'system', content: 'You are Kai.' },
        { role: 'user', content: 'Read the notes.' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'files.read', arguments: { path: 'notes' } }] },
        { role: 'tool', content: 'a.md', toolCallId: 'c1', name: 'files.read' },
      ],
      tools: [{ name: 'files.read', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } }],
      format: { type: 'object' },
      options: { temperature: 0.2, numCtx: 16384, think: false, maxTokens: 3000 },
    });

    assert.deepEqual(result, {
      text: '',
      toolCalls: [{ id: 'call_0', name: 'files.read', arguments: { path: 'notes/a.md' } }],
      usage: { inputTokens: 812, outputTokens: 37 },
    });
    const sent = fake.bodies[0];
    assert.equal(sent.path, '/api/chat');
    assert.deepEqual(sent.body, {
      model: 'qwen3:8b',
      messages: [
        { role: 'system', content: 'You are Kai.' },
        { role: 'user', content: 'Read the notes.' },
        { role: 'assistant', content: '', tool_calls: [{ function: { name: 'files.read', arguments: { path: 'notes' } } }] },
        { role: 'tool', content: 'a.md', tool_name: 'files.read' },
      ],
      tools: [{ type: 'function', function: { name: 'files.read', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }],
      format: { type: 'object' },
      stream: false,
      think: false,
      keep_alive: '10m',
      options: { num_predict: 3000, temperature: 0.2, num_ctx: 16384 },
    });
  });

  test('omits what is not set, and parses tool arguments sent as a JSON string', async () => {
    fake.replies.push({
      body: { message: { role: 'assistant', content: 'ok', tool_calls: [{ id: 'x9', function: { name: 'files.write', arguments: '{"path":"a.md","content":"hi"}' } }] }, done: true },
    });
    const result = await new OllamaProvider({ baseUrl: url }).chat({ model: 'qwen3:8b', messages: [{ role: 'user', content: 'hi' }] });
    assert.deepEqual(result.toolCalls, [{ id: 'x9', name: 'files.write', arguments: { path: 'a.md', content: 'hi' } }]);
    assert.equal(result.usage.estimated, true, 'no counts sent, so they are estimated');
    assert.deepEqual(Object.keys(fake.bodies[0].body).sort(), ['keep_alive', 'messages', 'model', 'options', 'stream']);
    assert.deepEqual(fake.bodies[0].body.options, { num_predict: 8_192 }, 'every answer is capped, even with no options');
  });

  test('turns HTTP errors and timeouts into errors', async () => {
    fake.replies.push({ status: 404, body: { error: 'model "qwen3:8b" not found, try pulling it first' } });
    await assert.rejects(new OllamaProvider({ baseUrl: url }).chat({ model: 'qwen3:8b', messages: [] }), /ollama returned 404: .*try pulling it first/);
    fake.replies.push({ body: { message: { content: 'late' } }, delayMs: 500 });
    await assert.rejects(new OllamaProvider({ baseUrl: url, timeoutMs: 50 }).chat({ model: 'qwen3:8b', messages: [] }), /timed out|aborted/i);
  });

  test('unparseable tool arguments reach the agent as an error it can fix', async () => {
    fake.replies.push({ body: { message: { content: '', tool_calls: [{ function: { name: 'files.write', arguments: '{oops' } }] } } });
    const result = await new OllamaProvider({ baseUrl: url }).chat({ model: 'm', messages: [] });
    assert.deepEqual(result.toolCalls[0].arguments, { _invalidArguments: '{oops' });
  });

  test('missing token counts are estimated, never recorded as zero', async () => {
    fake.replies.push({ body: { message: { role: 'assistant', content: 'x'.repeat(400) }, done: true } });
    const provider = new OllamaProvider({ baseUrl: url });
    const result = await provider.chat({ model: 'qwen3:8b', messages: [{ role: 'user', content: 'y'.repeat(800) }] });
    assert.ok(result.usage.inputTokens >= 200, `input estimate ${result.usage.inputTokens}`);
    assert.ok(result.usage.outputTokens >= 100, `output estimate ${result.usage.outputTokens}`);
    assert.equal(result.usage.estimated, true);
  });

  test('model refs name the provider and the model', () => {
    assert.deepEqual(parseModelRef('ollama:qwen3:8b'), { provider: 'ollama', model: 'qwen3:8b' });
    assert.deepEqual(parseModelRef('claude:claude-sonnet-5-5'), { provider: 'claude', model: 'claude-sonnet-5-5' });
    assert.equal(parseModelRef('qwen3'), null);
    assert.equal(parseModelRef(':x'), null);
  });
});
