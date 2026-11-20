import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CHECK_SETTINGS, fingerprint, runChecks, type CheckSettings } from '../src/checks.ts';
import { Workspace } from '../src/workspace.ts';

describe('automated checks (M5)', () => {
  let dir: string;
  let ws: Workspace;
  const write = (path: string, text: string) => {
    mkdirSync(join(ws.root, path, '..'), { recursive: true });
    writeFileSync(join(ws.root, path), text);
  };
  const byName = (results: { name: string; ok: boolean; detail: string }[]) => Object.fromEntries(results.map((r) => [r.name, r]));
  const email = (overrides: Record<string, unknown> = {}) => ({
    tool: 'email.send',
    input: { to: 'team@example.com', subject: 'We launched', body: 'Hi team, the brief is at https://example.com/brief.', ...overrides },
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ai-company-checks-'));
    ws = new Workspace(join(dir, 'workspace'));
    write('notes/idea.md', '# Idea\nAgents at desks.');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test('a good document passes every content check', () => {
    write('brief.md', '# Brief\nThe problem, the product and pricing. See [the notes](notes/idea.md#top) and [our site](https://example.com).');
    const results = runChecks({ artifacts: ['brief.md'], finalAction: null }, ws);
    assert.deepEqual(results.map((r) => [r.name, r.ok]), [
      ['files.exist', true],
      ['content.length', true],
      ['content.placeholders', true],
      ['content.links', true],
    ]);
  });

  test('missing, empty and outside files fail files.exist with each reason', () => {
    write('empty.md', '');
    const r = byName(runChecks({ artifacts: ['nope.md', 'empty.md', '../secret.md', 'notes'], finalAction: null }, ws));
    assert.equal(r['files.exist'].ok, false);
    assert.match(r['files.exist'].detail, /nope\.md: does not exist/);
    assert.match(r['files.exist'].detail, /empty\.md: is empty/);
    assert.match(r['files.exist'].detail, /\.\.\/secret\.md: .*outside the workspace/);
    assert.match(r['files.exist'].detail, /notes: is not a file/);
  });

  test('length, placeholders and links are checked in each content file', () => {
    write('short.md', 'Too short.');
    write('draft.md', '# Brief\nPricing: [insert price here]. TODO: finish. Read [notes](notes/missing.md), [x](javascript:alert(1)) and [y](../../etc/passwd).');
    const settings: CheckSettings = { ...DEFAULT_CHECK_SETTINGS, content: { minWords: 5, maxWords: 100 } };
    const r = byName(runChecks({ artifacts: ['short.md', 'draft.md'], finalAction: null }, ws, settings));
    assert.match(r['content.length'].detail, /short\.md has 2 words \(at least 5\)/);
    assert.equal(r['content.placeholders'].ok, false);
    assert.match(r['content.placeholders'].detail, /draft\.md still has a placeholder: "\[insert price here\]"/);
    const links = r['content.links'].detail;
    assert.match(links, /"notes\/missing\.md" does not exist/);
    assert.match(links, /"javascript:alert\(1" uses a scheme that is not allowed/);
    assert.match(links, /leads outside the workspace/);
  });

  test('code files skip content checks (they get tests, lint and build later)', () => {
    write('app.ts', '// TODO\nexport const x = 1;');
    assert.deepEqual(runChecks({ artifacts: ['app.ts'], finalAction: null }, ws).map((r) => r.name), ['files.exist']);
  });

  test('an email needs its fields, allowed recipients, a short body and links a recipient can open', () => {
    const rules: CheckSettings = { ...DEFAULT_CHECK_SETTINGS, email: { allowedRecipients: ['@example.com', 'ceo@acme.test'], maxBodyWords: 20 } };
    assert.ok(runChecks({ artifacts: [], finalAction: email() }, ws, rules).every((r) => r.ok));

    const schema = byName(runChecks({ artifacts: [], finalAction: email({ subject: 'a\nBcc: x@evil.test', body: '' }) }, ws, rules));
    assert.match(schema['email.schema'].detail, /"subject" must be one non-empty line; "body" must be non-empty text/);
    assert.equal(schema['email.recipients'], undefined, 'nothing more is checked on a broken email');

    const r = byName(runChecks({ artifacts: [], finalAction: email({ to: 'team@example.com, boss@evil.test; nobody', body: 'Hi {{name}}, read [the brief](brief.md).' }) }, ws, rules));
    assert.match(r['email.recipients'].detail, /boss@evil\.test is not on the allowed recipients list/);
    assert.match(r['email.recipients'].detail, /"nobody" is not an email address/);
    assert.doesNotMatch(r['email.recipients'].detail, /team@example\.com/);
    assert.match(r['email.body'].detail, /placeholder: "\{\{name\}\}"/);
    assert.match(r['email.body'].detail, /"brief\.md" is not a web link a recipient can open/);
    assert.match(byName(runChecks({ artifacts: [], finalAction: email({ body: 'word '.repeat(21) }) }, ws, rules))['email.body'].detail, /21 words \(at most 20\)/);
    assert.ok(byName(runChecks({ artifacts: [], finalAction: email({ to: 'CEO@ACME.test' }) }, ws, rules))['email.recipients'].ok, 'addresses match case-insensitively');
  });

  test('agent-written text cannot make the checks slow: patterns stay linear on the largest files', () => {
    const big = 199_000;
    const cases = ['['.repeat(big), '{{'.repeat(big / 2), '[add'.repeat(big / 4), `[m](mailto:x@${'a.'.repeat(big / 2)}<)`, `<insert${'x'.repeat(big)}`];
    cases.forEach((text, i) => write(`slow${i}.md`, text));
    const paths = cases.map((_, i) => `slow${i}.md`);
    const started = performance.now();
    // Listed twice: the same file is read and checked once.
    const results = runChecks({ artifacts: [...paths, ...paths], finalAction: email({ to: `x@${'a.'.repeat(50_000)}com`, body: '{{'.repeat(50_000) }) }, ws);
    const ms = performance.now() - started;
    assert.ok(ms < 1_500, `checks took ${Math.round(ms)} ms`);
    assert.match(byName(results)['files.exist'].detail, /^5 file\(s\) found$/);
    assert.match(byName(results)['email.recipients'].detail, /is not an email address/);
  });

  test('a symlink out of the workspace, an unreadable file and too much text are problems, without host paths', () => {
    writeFileSync(join(dir, 'secret.md'), 'outside');
    symlinkSync(join(dir, 'secret.md'), join(ws.root, 'link.md'));
    write('locked.md', 'text');
    chmodSync(join(ws.root, 'locked.md'), 0o000);
    for (let i = 0; i < 6; i++) write(`part${i}.md`, 'word '.repeat(39_000));
    const detail = byName(runChecks({ artifacts: ['link.md', 'locked.md', ...[0, 1, 2, 3, 4, 5].map((i) => `part${i}.md`)], finalAction: null }, ws))['files.exist'].detail;
    chmodSync(join(ws.root, 'locked.md'), 0o600);
    assert.match(detail, /link\.md: .*outside the workspace/);
    assert.match(detail, /locked\.md: cannot be read \(EACCES\)/);
    assert.match(detail, /part5\.md: is past the 1000000 bytes checked per submission/);
    assert.doesNotMatch(detail, new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'no absolute paths');
  });

  test('fingerprints are the sha256 of the files as read, and change when a file changes', () => {
    const before = fingerprint(['notes/idea.md', 'notes/idea.md', 'missing.md'], ws);
    assert.deepEqual(Object.keys(before), ['notes/idea.md']);
    assert.match(before['notes/idea.md'], /^[0-9a-f]{64}$/);
    write('notes/idea.md', '# Idea\nAgents at desks. TODO');
    assert.notEqual(fingerprint(['notes/idea.md'], ws)['notes/idea.md'], before['notes/idea.md']);
    assert.deepEqual(fingerprint(['notes/idea.md'], null), {});
  });

  test('with no allowlist any valid address may receive email; nothing to check means no results', () => {
    assert.ok(byName(runChecks({ artifacts: [], finalAction: email({ to: 'anyone@else.test' }) }, ws))['email.recipients'].ok);
    assert.deepEqual(runChecks({ artifacts: [], finalAction: null }, ws), []);
    assert.deepEqual(runChecks({ artifacts: [], finalAction: { tool: 'other.tool', input: {} } }, ws), []);
  });
});
