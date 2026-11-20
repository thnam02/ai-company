import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import type { WorkflowEngine } from '@ai-company/core';
import { allMet, makeCompany, must, startedTask } from '../../core/test/helpers.ts';
import { CredentialStore, Secret, loadCredentials } from '../src/credentials.ts';
import { ToolGateway, type GatewayOptions, type GatewayEnginePort } from '../src/gateway.ts';
import { ToolInputError, ToolRegistry, TransientToolError, type ToolExecutor, type ToolRunContext } from '../src/registry.ts';

/** The engine behind an async port, as the server's command queue gives it. */
function enginePort(engine: WorkflowEngine): GatewayEnginePort {
  return {
    requestToolCall: async (taskId, agentId, call) => engine.requestToolCall(taskId, agentId, call),
    recordToolResult: async (taskId, key, result) => engine.recordToolResult(taskId, key, result),
    recordActionResult: async (taskId, key, result) => engine.recordActionResult(taskId, key, result),
    recordActionStarted: async (taskId, key) => engine.recordActionStarted(taskId, key),
    pendingToolCalls: async () => engine.pendingToolCalls(),
    pendingActions: async () => engine.pendingActions(),
    isPaused: async () => engine.isCompanyPaused(),
    awaitingChecks: async () => engine.awaitingChecks(),
    recordChecks: async (taskId, submission, results, files) => engine.recordChecks(taskId, submission, results, files),
  };
}

/** A fake tool that records every run and behaves as `impl` says. */
function fakeTool(name: string, impl: (input: any, ctx: ToolRunContext, n: number) => Promise<string> | string, extra: Partial<ToolExecutor> = {}) {
  const runs: { input: unknown; key: string }[] = [];
  const executor: ToolExecutor = {
    name,
    description: `fake ${name}`,
    parameters: { type: 'object' },
    dedupesByKey: false,
    ...extra,
    run: async (input, ctx) => {
      runs.push({ input, key: ctx.idempotencyKey });
      return impl(input, ctx, runs.length);
    },
  };
  return { executor, runs };
}

function setup(executors: ToolExecutor[], options: Partial<GatewayOptions> = {}) {
  const company = makeCompany();
  const { engine } = company;
  const sleeps: number[] = [];
  const logs: string[] = [];
  let keys = 0;
  let clock = 0;
  const gateway = new ToolGateway({
    engine: enginePort(engine),
    tools: new ToolRegistry(executors),
    newKey: () => `gw-${++keys}`,
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    random: () => 1,
    log: (m) => logs.push(m),
    ...options,
  });
  return { engine, gateway, sleeps, logs, tick: (ms: number) => (clock += ms) };
}

const types = (engine: WorkflowEngine) => engine.store.all().map((e) => e.type);
const last = (engine: WorkflowEngine) => engine.store.all().at(-1)!;

describe('tool gateway: work-time calls', () => {
  test('a call runs only after the engine allows it, with a key the gateway made, and its result is recorded', async () => {
    const read = fakeTool('repo.read', (input) => `contents of ${input.path}`);
    const { engine, gateway } = setup([read.executor]);
    const { task } = startedTask(engine);

    assert.deepEqual(await gateway.call(task.id, 'kai', 'repo.read', { path: 'README.md' }), { ok: true, value: 'contents of README.md' });
    assert.deepEqual(read.runs, [{ input: { path: 'README.md' }, key: 'gw-1' }]);
    const allowed = engine.store.all().find((e) => e.type === 'tool.allowed')!;
    assert.ok(allowed.seq < last(engine).seq, 'allowed before it ran');
    assert.equal(last(engine).type, 'tool.executed');
    assert.deepEqual(last(engine).data, { tool: 'repo.read', idempotencyKey: 'gw-1', detail: 'contents of README.md', attempts: 1 });
  });

  test('a denied call never runs: wrong tier, not on the allowlist, wrong owner, company paused', async () => {
    const deploy = fakeTool('prod.deploy', () => 'deployed');
    const mail = fakeTool('email.send', () => 'sent');
    const read = fakeTool('repo.read', () => 'ok');
    const { engine, gateway } = setup([deploy.executor, mail.executor, read.executor]);
    const { task } = startedTask(engine);

    assert.match((await gateway.call(task.id, 'kai', 'prod.deploy', {}) as any).error, /finalAction/);
    assert.match((await gateway.call(task.id, 'kai', 'email.send', {}) as any).error, /allowlist|not allowed/);
    assert.match((await gateway.call(task.id, 'omar', 'repo.read', {}) as any).error, /owner/);
    must(engine.pauseCompany());
    assert.match((await gateway.call(task.id, 'kai', 'repo.read', {}) as any).error, /paused/);
    assert.deepEqual([deploy.runs, mail.runs, read.runs], [[], [], []]);
    assert.ok(!types(engine).includes('tool.executed') && !types(engine).includes('tool.failed'));
  });

  test('bad input goes back to the model; an unexpected error is recorded but the model gets a plain message', async () => {
    const read = fakeTool('repo.read', (input) => {
      if (!input.path) throw new ToolInputError('"path" is required');
      throw new Error('EACCES: permission denied, open /srv/secret-place');
    });
    const { engine, gateway } = setup([read.executor]);
    const { task } = startedTask(engine);

    assert.deepEqual(await gateway.call(task.id, 'kai', 'repo.read', {}), { ok: false, error: '"path" is required' });
    assert.equal(last(engine).type, 'tool.failed');
    assert.equal(last(engine).data!.detail, '"path" is required');

    const r = await gateway.call(task.id, 'kai', 'repo.read', { path: 'x' });
    assert.deepEqual(r, { ok: false, error: 'repo.read failed; try again or report_blocked' });
    assert.match(last(engine).data!.detail, /EACCES/);
    assert.equal(read.runs.length, 2, 'neither was retried');
  });

  test('a tool the policy allows but this server cannot run fails cleanly and is recorded', async () => {
    const { engine, gateway } = setup([]);
    const { task } = startedTask(engine);
    assert.match((await gateway.call(task.id, 'kai', 'repo.read', {}) as any).error, /not available/);
    assert.equal(last(engine).type, 'tool.failed');
    assert.equal(last(engine).data!.attempts, undefined);
  });

  test('an attempt that runs too long times out; it is not retried unless the tool dedupes by key', async () => {
    const hang = () => new Promise<string>(() => {});
    const write = fakeTool('github.create_branch', hang);
    const read = fakeTool('repo.read', hang, { dedupesByKey: true });
    const settings = { 'github.create_branch': { timeoutMs: 20 }, 'repo.read': { timeoutMs: 20, maxAttempts: 2 } };
    const { engine, gateway, sleeps } = setup([write.executor, read.executor], { settings });
    const { task } = startedTask(engine, { requiredTools: ['repo.read', 'github.create_branch'] });

    const w = await gateway.call(task.id, 'kai', 'github.create_branch', { name: 'a' });
    assert.match((w as any).error, /timed out after 20 ms; it may still have taken effect/);
    assert.equal(write.runs.length, 1, 'not retried: it may have acted');
    assert.deepEqual(last(engine).data, { tool: 'github.create_branch', idempotencyKey: 'gw-1', detail: 'timed out after 20 ms; it may still have taken effect', attempts: 1 });

    const r = await gateway.call(task.id, 'kai', 'repo.read', { path: 'a' });
    assert.match((r as any).error, /timed out after 20 ms$/);
    assert.equal(read.runs.length, 2, 'retried with the same key');
    assert.deepEqual(read.runs.map((x) => x.key), ['gw-2', 'gw-2']);
    assert.equal(last(engine).data!.attempts, 2);
    assert.deepEqual(sleeps, [500]);
  });

  test('transient errors are retried with doubling backoff, then succeed or give up', async () => {
    const flaky = fakeTool('repo.read', (_input, _ctx, n) => {
      if (n <= 2) throw new TransientToolError('503 Service Unavailable');
      return 'finally';
    });
    const { engine, gateway, sleeps } = setup([flaky.executor]);
    const { task } = startedTask(engine);
    assert.deepEqual(await gateway.call(task.id, 'kai', 'repo.read', {}), { ok: true, value: 'finally' });
    assert.deepEqual(sleeps, [500, 1000]);
    assert.equal(last(engine).data!.attempts, 3);
    assert.equal(engine.store.all().filter((e) => e.type === 'tool.allowed').length, 1, 'one allowed call, one result, three attempts');

    const down = fakeTool('repo.read', () => {
      throw new TransientToolError('429 Too Many Requests');
    });
    const second = setup([down.executor], { settings: { 'repo.read': { maxAttempts: 4 } }, maxBackoffMs: 1_500 });
    const { task: t2 } = startedTask(second.engine);
    assert.match((await second.gateway.call(t2.id, 'kai', 'repo.read', {}) as any).error, /temporarily unavailable/);
    assert.deepEqual(second.sleeps, [500, 1000, 1500], 'capped');
    assert.equal(last(second.engine).type, 'tool.failed');
    assert.equal(last(second.engine).data!.attempts, 4);
  });

  test('the kill switch stops retries: a call paused between attempts runs no more', async () => {
    let engineRef!: WorkflowEngine;
    const flaky = fakeTool('repo.read', () => {
      must(engineRef.pauseCompany('CEO pressed stop'));
      throw new TransientToolError('503');
    });
    const { engine, gateway } = setup([flaky.executor], { settings: { 'repo.read': { maxAttempts: 5 } } });
    engineRef = engine;
    const { task } = startedTask(engine);
    assert.match((await gateway.call(task.id, 'kai', 'repo.read', {}) as any).error, /company is paused/);
    assert.equal(flaky.runs.length, 1);
    assert.equal(last(engine).type, 'tool.failed');
    assert.match(last(engine).data!.detail, /paused before it ran; nothing was done/);
  });

  test('a call waiting for its rate limit does not run if the company is paused meanwhile', async () => {
    const read = fakeTool('repo.read', () => 'ok');
    let engineRef!: WorkflowEngine;
    let clock = 0;
    const { engine, gateway } = setup([read.executor], {
      settings: { 'repo.read': { ratePerMinute: 1 } },
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
        must(engineRef.pauseCompany());
      },
    });
    engineRef = engine;
    const { task } = startedTask(engine);
    await gateway.call(task.id, 'kai', 'repo.read', { n: 1 });
    assert.equal((await gateway.call(task.id, 'kai', 'repo.read', { n: 2 })).ok, false);
    assert.equal(read.runs.length, 1);
  });

  test('a rate-limited tool waits for room in its rolling minute', async () => {
    const read = fakeTool('repo.read', () => 'ok');
    const { engine, gateway, sleeps, tick } = setup([read.executor], { settings: { 'repo.read': { ratePerMinute: 2 } } });
    const { task } = startedTask(engine);
    await gateway.call(task.id, 'kai', 'repo.read', { n: 1 });
    tick(10_000);
    await gateway.call(task.id, 'kai', 'repo.read', { n: 2 });
    assert.deepEqual(sleeps, []);
    await gateway.call(task.id, 'kai', 'repo.read', { n: 3 });
    assert.deepEqual(sleeps, [50_000], 'waits until the first call leaves the window');
    assert.equal(read.runs.length, 3);
  });
});

describe('tool gateway: automated checks (gate 3)', () => {
  test('pending submissions are checked once; a failure sends the task back, a crash in a check never waves it through', async () => {
    const seen: unknown[] = [];
    let mode: 'ok' | 'fail' | 'crash' = 'fail';
    const { engine, gateway } = setup([], {
      checks: (submitted) => {
        seen.push(submitted);
        if (mode === 'crash') throw new Error('regex blew up');
        return { results: [{ name: 'files.exist', ok: mode === 'ok', detail: mode === 'ok' ? 'found' : 'brief.md: does not exist' }], files: mode === 'ok' ? { 'brief.md': 'a'.repeat(64) } : ({} as Record<string, string>) };
      },
    });
    const { task } = startedTask(engine);
    const submit = () => must(engine.submitForReview(task.id, 'kai', { summary: 's', selfCheck: allMet(task.acceptanceCriteria), artifacts: ['brief.md'] }));

    submit();
    await gateway.runPendingChecks();
    assert.deepEqual(seen, [{ artifacts: ['brief.md'], finalAction: null }]);
    assert.equal(engine.getTask(task.id)!.state, 'working');
    assert.match(engine.getTask(task.id)!.lastFeedback!, /files\.exist: brief\.md: does not exist/);

    mode = 'crash';
    submit();
    await gateway.runPendingChecks();
    assert.equal(engine.getTask(task.id)!.state, 'working');
    assert.match(engine.getTask(task.id)!.lastFeedback!, /checks could not run: regex blew up/);

    mode = 'ok';
    submit();
    await gateway.recover();
    assert.equal(engine.getTask(task.id)!.state, 'review', 'boot runs checks a crash interrupted');
    assert.deepEqual(engine.getTask(task.id)!.checkResults, [{ name: 'files.exist', ok: true, detail: 'found' }]);
    await gateway.runPendingChecks();
    assert.equal(seen.length, 3, 'a checked submission is not checked again');
  });

  test('a passing run that could not hash a file it was given fails: a review is held to the hashes', async () => {
    const { engine, gateway } = setup([], { checks: () => ({ results: [{ name: 'files.exist', ok: true, detail: 'found' }], files: {} }) });
    const { task } = startedTask(engine);
    must(engine.submitForReview(task.id, 'kai', { summary: 's', selfCheck: allMet(task.acceptanceCriteria), artifacts: ['brief.md'] }));
    await gateway.runPendingChecks();
    assert.equal(engine.getTask(task.id)!.state, 'working');
    assert.match(engine.getTask(task.id)!.lastFeedback!, /files\.hashed: could not be read for a hash: brief\.md/);
  });

  test('the kill switch holds checks: nothing moves while the company is stopped, and they run on resume', async () => {
    let runs = 0;
    const { engine, gateway } = setup([], { checks: () => (runs++, { results: [{ name: 'x', ok: false, detail: 'bad' }], files: {} }) });
    const { task } = startedTask(engine);
    must(engine.submitForReview(task.id, 'kai', { summary: 's', selfCheck: allMet(task.acceptanceCriteria) }));
    must(engine.pauseCompany());
    await gateway.runPendingChecks();
    assert.deepEqual([runs, engine.getTask(task.id)!.state], [0, 'review']);
    must(engine.resumeCompany());
    await gateway.resume();
    assert.deepEqual([runs, engine.getTask(task.id)!.state], [1, 'working']);
  });
});

describe('tool gateway: credentials (invariant 6)', () => {
  const TOKEN = 'ghp_SuperSecretToken123';

  test('a tool gets only the credentials it declared, and their values never leave the gateway', async () => {
    const leaky = fakeTool(
      'repo.read',
      (_input, ctx) => `authorized with ${ctx.credential('github')}`,
      { credentials: ['github'] },
    );
    const greedy = fakeTool('github.create_branch', (_input, ctx) => ctx.credential('github'));
    const credentials = new CredentialStore({ github: new Secret(TOKEN) });
    const { engine, gateway, logs } = setup([leaky.executor, greedy.executor], { credentials });
    const { task } = startedTask(engine, { requiredTools: ['repo.read', 'github.create_branch'] });

    assert.deepEqual(await gateway.call(task.id, 'kai', 'repo.read', {}), { ok: true, value: 'authorized with [secret]' });
    const r = await gateway.call(task.id, 'kai', 'github.create_branch', {});
    assert.equal(r.ok, false);
    assert.match(last(engine).data!.detail, /did not declare credential "github"/);

    const failing = fakeTool('repo.read', (_i, ctx) => {
      throw new Error(`401 for token ${ctx.credential('github')}`);
    }, { credentials: ['github'] });
    const second = setup([failing.executor], { credentials });
    const { task: t2 } = startedTask(second.engine);
    await second.gateway.call(t2.id, 'kai', 'repo.read', {});
    assert.equal(last(second.engine).data!.detail, '401 for token [secret]');

    for (const text of [JSON.stringify(engine.store.all()), JSON.stringify(second.engine.store.all()), logs.join('\n'), second.logs.join('\n')]) {
      assert.ok(!text.includes(TOKEN), 'no credential in events or logs');
    }
    assert.ok(!inspect(credentials).includes(TOKEN) && !JSON.stringify({ credentials }).includes(TOKEN));
  });

  test('overlapping and encoded credential values are removed whole', () => {
    const store = new CredentialStore({ short: new Secret('sk-live-abc'), long: new Secret('sk-live-abc-REST-OF-KEY-9f8e'), odd: new Secret('ab+cd/ef==gh"ij') });
    assert.equal(store.redact('token=sk-live-abc-REST-OF-KEY-9f8e and sk-live-abc'), 'token=[secret] and [secret]');
    assert.equal(store.redact('GET /x?key=ab%2Bcd%2Fef%3D%3Dgh%22ij'), 'GET /x?key=[secret]');
    assert.equal(store.redact(JSON.stringify({ k: 'ab+cd/ef==gh"ij' })), '{"k":"[secret]"}');
    assert.equal(store.redact(`Authorization: ${Buffer.from('sk-live-abc').toString('base64')}`), 'Authorization: [secret]');
    assert.throws(() => new CredentialStore({ pin: new Secret('1234') }), /too short/);
  });

  test('a credential that is not set up fails the call and is named at start', async () => {
    const tool = fakeTool('repo.read', (_i, ctx) => ctx.credential('github'), { credentials: ['github'] });
    const { engine, gateway, logs } = setup([tool.executor]);
    assert.ok(logs.some((l) => /needs credential "github", which is not set up/.test(l)));
    const { task } = startedTask(engine);
    assert.equal((await gateway.call(task.id, 'kai', 'repo.read', {})).ok, false);
    assert.match(last(engine).data!.detail, /credential "github" is not set up/);
  });

  describe('loadCredentials', () => {
    let dir: string;
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    test('reads a private file, refuses one others can read, and treats a missing one as empty', () => {
      dir = mkdtempSync(join(tmpdir(), 'ai-company-creds-'));
      const path = join(dir, 'credentials.json');
      assert.deepEqual(loadCredentials(path).names(), []);
      writeFileSync(path, JSON.stringify({ github: TOKEN }));
      chmodSync(path, 0o644);
      assert.throws(() => loadCredentials(path), /other users; run: chmod 600/);
      chmodSync(path, 0o600);
      const store = loadCredentials(path);
      assert.deepEqual(store.names(), ['github']);
      assert.equal(store.reveal('github'), TOKEN);
      writeFileSync(path, `{"github": "${TOKEN}",`);
      assert.throws(() => loadCredentials(path), (err: Error) => !err.message.includes(TOKEN) && /not valid JSON/.test(err.message));
      writeFileSync(path, JSON.stringify({ github: 42 }));
      assert.throws(() => loadCredentials(path), /non-empty string/);
    });
  });
});

describe('tool gateway: final actions and the outbox', () => {
  function releasedEmail(engine: WorkflowEngine, key = 'mail-1', beforeApproval = () => {}) {
    const { task } = startedTask(engine, { ownerId: 'omar', requiredTools: ['email.send'] });
    const action = { tool: 'email.send', input: { to: 'team@example.com' }, idempotencyKey: key };
    must(engine.submitForReview(task.id, 'omar', { summary: 'Drafted', selfCheck: allMet(task.acceptanceCriteria), finalAction: action }));
    must(engine.recordReview(task.id, 'rex', { passed: true, score: 1, feedback: '' }));
    beforeApproval();
    const outcome = must(engine.decideApproval(task.id, { approved: true }));
    assert.deepEqual(outcome.execute, action);
    return { task, action };
  }

  test('a released action runs once per key, even if released twice, and its result is recorded', async () => {
    const mail = fakeTool('email.send', async () => {
      await new Promise((r) => setTimeout(r, 10));
      return 'sent';
    });
    const { engine, gateway } = setup([mail.executor]);
    const { task, action } = releasedEmail(engine);
    await Promise.all([gateway.release(task.id, action), gateway.release(task.id, action)]);
    assert.deepEqual(mail.runs, [{ input: action.input, key: 'mail-1' }]);
    assert.deepEqual(engine.getTask(task.id)!.actionResult, { ok: true, detail: 'sent', attempts: 1 });
    assert.equal(last(engine).type, 'action.executed');
  });

  test('a released action gets the same timeouts and transient retries', async () => {
    const mail = fakeTool('email.send', (_i, _c, n) => {
      if (n === 1) throw new TransientToolError('SMTP 421 try later');
      return 'sent';
    });
    const { engine, gateway, sleeps } = setup([mail.executor]);
    const { task, action } = releasedEmail(engine);
    await gateway.release(task.id, action);
    assert.deepEqual(engine.getTask(task.id)!.actionResult, { ok: true, detail: 'sent', attempts: 2 });
    assert.deepEqual(sleeps, [500]);
  });

  test('an action approved while the company is paused is held, and runs once on resume', async () => {
    const mail = fakeTool('email.send', () => 'sent');
    const { engine, gateway } = setup([mail.executor]);
    // The CEO approves while the kill switch is on (the engine allows that).
    const { task, action } = releasedEmail(engine, 'mail-1', () => must(engine.pauseCompany()));
    await gateway.release(task.id, action);
    assert.deepEqual(mail.runs, []);
    assert.deepEqual(engine.pendingActions(), [{ taskId: task.id, action }], 'still pending, not recorded as failed');
    must(engine.resumeCompany());
    await gateway.resume();
    await gateway.close();
    assert.equal(mail.runs.length, 1);
    assert.equal(engine.getTask(task.id)!.actionResult!.ok, true);
    await gateway.resume();
    assert.equal(mail.runs.length, 1, 'nothing left to run');
  });

  test('release never runs an action the engine did not release, or one that already has a result', async () => {
    const mail = fakeTool('email.send', () => 'sent');
    const { engine, gateway, logs } = setup([mail.executor]);
    const { task, action } = releasedEmail(engine);
    await gateway.release(task.id, { ...action, input: { to: 'attacker@example.com' }, idempotencyKey: 'forged' });
    await gateway.release('no-such-task', action);
    assert.deepEqual(mail.runs, []);
    await gateway.release(task.id, { ...action, input: { to: 'attacker@example.com' } });
    assert.deepEqual(mail.runs, [{ input: { to: 'team@example.com' }, key: 'mail-1' }], "the engine's copy of the action runs, not the caller's");
    await gateway.release(task.id, action);
    assert.equal(mail.runs.length, 1, 'a recorded action is not run again');
    assert.ok(logs.some((l) => /not released or already has a result/.test(l)));
  });

  test('an action released while the server stops is left for the next start, not run half-recorded', async () => {
    const mail = fakeTool('email.send', () => 'sent');
    const { engine, gateway } = setup([mail.executor]);
    const { task, action } = releasedEmail(engine);
    await gateway.close();
    await gateway.release(task.id, action);
    assert.deepEqual(mail.runs, []);
    assert.equal(engine.pendingActions().length, 1);
  });

  test('an action with no executor is recorded as failed, never left pending', async () => {
    const { engine, gateway } = setup([]);
    const { task, action } = releasedEmail(engine);
    await gateway.release(task.id, action);
    assert.equal(last(engine).type, 'action.failed');
    assert.match(engine.getTask(task.id)!.actionResult!.detail, /no executor/);
    assert.deepEqual(engine.pendingActions(), []);
  });

  test('after a crash: interrupted calls are recorded as failed; released actions re-run only if their tool dedupes', async () => {
    const read = fakeTool('repo.read', () => 'ok');
    const mail = fakeTool('email.send', () => 'sent', { dedupesByKey: true });
    const { engine, gateway } = setup([read.executor, mail.executor]);
    // A call allowed just before the crash, with no result, and an action that had started.
    const { task: working } = startedTask(engine);
    must(engine.requestToolCall(working.id, 'kai', { tool: 'repo.read', input: {}, idempotencyKey: 'lost-1' }));
    const { task: emailTask } = releasedEmail(engine);
    must(engine.recordActionStarted(emailTask.id, 'mail-1'));

    await gateway.recover();
    const failed = engine.store.all().find((e) => e.type === 'tool.failed')!;
    assert.equal(failed.data!.idempotencyKey, 'lost-1');
    assert.match(failed.data!.detail, /interrupted by a restart/);
    assert.deepEqual(read.runs, [], 'a work-time call is never re-run; the worker redoes its turn');
    assert.deepEqual(mail.runs.map((r) => r.key), ['mail-1']);
    assert.equal(engine.getTask(emailTask.id)!.actionResult!.ok, true);

    // A second recovery finds nothing to do.
    await gateway.recover();
    assert.equal(mail.runs.length, 1);
  });

  test('after a crash: an action whose tool cannot detect a repeat is recorded for the CEO, not re-run', async () => {
    const mail = fakeTool('email.send', () => 'sent', { dedupesByKey: false });
    const { engine, gateway } = setup([mail.executor]);
    const { task } = releasedEmail(engine);
    must(engine.recordActionStarted(task.id, 'mail-1'));
    await gateway.recover();
    assert.deepEqual(mail.runs, []);
    assert.match(engine.getTask(task.id)!.actionResult!.detail, /Check it by hand/);
  });

  test('after a crash: an action held by the kill switch never started, so even a non-deduping tool runs on resume', async () => {
    const mail = fakeTool('email.send', () => 'sent', { dedupesByKey: false });
    const { engine, gateway } = setup([mail.executor]);
    const { task, action } = releasedEmail(engine, 'mail-1', () => must(engine.pauseCompany()));
    await gateway.release(task.id, action);
    assert.equal(types(engine).includes('action.started'), false, 'held before it started');

    // Restart: a new gateway on the same log, still paused.
    const restarted = new ToolGateway({ engine: enginePort(engine), tools: new ToolRegistry([mail.executor]), log: () => {}, sleep: async () => {} });
    await restarted.recover();
    assert.deepEqual(mail.runs, []);
    assert.equal(engine.getTask(task.id)!.actionResult, null, 'not written off as interrupted');
    must(engine.resumeCompany());
    await restarted.resume();
    await restarted.close();
    assert.equal(mail.runs.length, 1);
    assert.deepEqual(types(engine).filter((t) => t.startsWith('action.')), ['action.started', 'action.executed']);
  });

  test('a pause between retries of a timed-out deduping tool says an earlier attempt may have acted', async () => {
    let engineRef!: WorkflowEngine;
    const read = fakeTool('repo.read', () => {
      must(engineRef.pauseCompany());
      return new Promise<string>(() => {});
    }, { dedupesByKey: true });
    const { engine, gateway } = setup([read.executor], { settings: { 'repo.read': { timeoutMs: 20 } } });
    engineRef = engine;
    const { task } = startedTask(engine);
    await gateway.call(task.id, 'kai', 'repo.read', {});
    assert.match(last(engine).data!.detail, /paused before a retry; an earlier attempt may have taken effect/);
  });

  test('close refuses new calls and waits for running ones to record their results', async () => {
    let finish!: (v: string) => void;
    const slow = fakeTool('repo.read', () => new Promise<string>((r) => (finish = r)));
    const { engine, gateway } = setup([slow.executor]);
    const { task } = startedTask(engine);
    const running = gateway.call(task.id, 'kai', 'repo.read', { a: 1 });
    await new Promise((r) => setTimeout(r, 5));
    let closed = false;
    const closing = gateway.close().then(() => (closed = true));
    assert.match((await gateway.call(task.id, 'kai', 'repo.read', { a: 2 }) as any).error, /stopping/);
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(closed, false);
    finish('late');
    await closing;
    assert.deepEqual(await running, { ok: true, value: 'late' });
    assert.equal(last(engine).type, 'tool.executed');
  });
});
