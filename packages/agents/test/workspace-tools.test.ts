import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Workspace, workspaceTools, ToolInputError } from '../src/tools/workspace.ts';
import { ToolRegistry } from '../src/tools/registry.ts';

describe('workspace tools', () => {
  let dir: string;
  let ws: Workspace;
  let tools: ToolRegistry;
  const run = (tool: string, input: unknown, key = `k-${Math.random()}`) => tools.get(tool)!.run(input, { idempotencyKey: key });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ai-company-ws-'));
    mkdirSync(join(dir, 'workspace', 'notes'), { recursive: true });
    writeFileSync(join(dir, 'workspace', 'notes', 'idea.md'), '# 3D office\nAgents at desks.');
    writeFileSync(join(dir, 'secret.txt'), 'outside');
    ws = new Workspace(join(dir, 'workspace'));
    tools = new ToolRegistry(workspaceTools(ws));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test('files.read reads a file, or lists a directory', async () => {
    assert.equal(await run('files.read', { path: 'notes/idea.md' }), '# 3D office\nAgents at desks.');
    assert.equal(await run('files.read', { path: 'notes' }), 'notes/idea.md');
    assert.equal(await run('files.read', { path: '.' }), 'notes/idea.md');
  });

  test('paths outside the workspace are refused, including through symlinks', async () => {
    symlinkSync(join(dir, 'secret.txt'), join(dir, 'workspace', 'link.txt'));
    symlinkSync(dir, join(dir, 'workspace', 'up'));
    for (const path of ['../secret.txt', '/etc/passwd', 'notes/../../secret.txt', 'link.txt', 'up/secret.txt', 'a\u0000b', '']) {
      await assert.rejects(run('files.read', { path }), ToolInputError, `read ${JSON.stringify(path)}`);
    }
    for (const path of ['../evil.md', 'up/evil.md', '/tmp/evil.md']) {
      await assert.rejects(run('files.write', { path, content: 'x' }), ToolInputError, `write ${path}`);
    }
    assert.equal(existsSync(join(dir, 'evil.md')), false);
  });

  test('files.write creates folders, and refuses the outbox so no one can fake a sent email', async () => {
    assert.match(await run('files.write', { path: 'drafts/brief.md', content: '# Brief' }), /wrote 7 bytes to drafts\/brief.md/);
    assert.equal(readFileSync(join(dir, 'workspace', 'drafts', 'brief.md'), 'utf8'), '# Brief');
    mkdirSync(join(dir, 'workspace', 'outbox'));
    symlinkSync(join(dir, 'workspace', 'outbox'), join(dir, 'workspace', 'sneaky'));
    symlinkSync(join(dir, 'nowhere'), join(dir, 'workspace', 'dangling'));
    for (const path of ['outbox/fake.eml', './outbox/x.eml', 'Outbox/x.eml', 'sneaky/x.eml']) {
      await assert.rejects(run('files.write', { path, content: 'x' }), /outbox/, path);
    }
    await assert.rejects(run('files.write', { path: 'dangling/x.md', content: 'x' }), ToolInputError);
    assert.deepEqual(readdirSync(join(dir, 'workspace', 'outbox')), []);
    await assert.rejects(run('files.write', { path: 'a.md' }), /content/);
    await assert.rejects(run('files.write', { path: 'big.md', content: 'x'.repeat(300_000) }), /too large/);
  });

  test('email.send writes to the outbox exactly once per idempotency key', async () => {
    const email = { to: 'team@example.com', subject: 'We launched', body: 'Hello team' };
    const first = await run('email.send', email, 'mail-1');
    assert.match(first, /written to outbox\//);
    const files = readdirSync(join(dir, 'workspace', 'outbox'));
    assert.equal(files.length, 1);
    const content = readFileSync(join(dir, 'workspace', 'outbox', files[0]), 'utf8');
    assert.match(content, /^To: team@example.com\nSubject: We launched\nIdempotency-Key: mail-1\n\nHello team\n$/);

    // A repeat of the same key (e.g. after a crash) changes nothing.
    assert.match(await run('email.send', { ...email, body: 'different' }, 'mail-1'), /already in the outbox/);
    assert.deepEqual(readdirSync(join(dir, 'workspace', 'outbox')), files);
    assert.equal(readFileSync(join(dir, 'workspace', 'outbox', files[0]), 'utf8'), content);

    await run('email.send', email, 'mail-2');
    assert.equal(readdirSync(join(dir, 'workspace', 'outbox')).length, 2);
    await assert.rejects(run('email.send', { to: 'x' }, 'mail-3'), /subject/);
    await assert.rejects(run('email.send', { ...email, to: 'a\nBcc: evil@x.com' }, 'mail-4'), /to/);
  });

  test('every workspace tool dedupes by idempotency key, so a crash re-run is safe', () => {
    assert.deepEqual(tools.list().map((t) => [t.name, t.dedupesByKey]), [
      ['files.read', true],
      ['files.write', true],
      ['email.send', true],
    ]);
  });
});
