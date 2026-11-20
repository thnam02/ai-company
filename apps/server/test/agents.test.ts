import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkflowEngine, type Limits } from '@ai-company/core';
import {
  AGENT_PORT_METHODS,
  AgentRuntime,
  MemoryCheckpointStore,
  ScriptedProvider,
  type CheckpointStore,
  type ScriptedTurn,
} from '@ai-company/agents';
import { ToolRegistry, Workspace, workspaceTools, type ToolExecutor } from '@ai-company/gateway';
import { createCompanyServer, type CompanyServer } from '../src/app.ts';
import { bootstrapAgents, buildPolicy, loadCompanyConfig, parseCompanyConfig, type CompanyConfig } from '../src/company.ts';
import { MemoryDurableEventStore } from '../src/durable-store.ts';
import { must } from './helpers.ts';

const TEST_TEAM = fileURLToPath(new URL('../config/test-team.json', import.meta.url));
const TOKEN = 'agents-test-token-0123456789';

// The test team's goal, from the M3b acceptance test.
const GOAL = 'Write a one-page product brief for our 3D AI office from the notes in workspace/notes/, then draft a launch email to our team.';
const BRIEF_CRITERIA = ['brief.md covers the problem, the product and pricing'];
const EMAIL_CRITERIA = ['The email announces the launch and links the brief'];
/** A passing review of an email task, given straight to the engine. */
const PASS = { passed: true, score: 1, feedback: '', rubric: EMAIL_CRITERIA.map((criterion) => ({ criterion, met: true })) };
const PLAN = [
  { key: 'brief', title: 'Write the product brief', acceptanceCriteria: BRIEF_CRITERIA, ownerId: 'kai', requiredTools: ['files.read', 'files.write'], dependsOn: [], costEstimateTokens: 20_000 },
  { key: 'email', title: 'Draft the launch email', acceptanceCriteria: EMAIL_CRITERIA, ownerId: 'zara', requiredTools: ['files.read', 'email.send'], dependsOn: ['brief'], costEstimateTokens: 10_000 },
];
const EMAIL = { to: 'team@example.com', subject: 'Our 3D AI office is live', body: 'Hi team, we launched. Brief: brief.md' };

// Scripted model answers.
const plan = (tasks: unknown[]): ScriptedTurn => ({ text: JSON.stringify({ tasks }) });
const call = (name: string, args: Record<string, unknown>): ScriptedTurn => ({ toolCalls: [{ name, arguments: args }] });
const submit = (criteria: string[], extra: Record<string, unknown> = {}): ScriptedTurn =>
  call('submit_work', { summary: 'Done', selfCheck: criteria.map((criterion) => ({ criterion, met: true })), ...extra });
/** A rubric answer for a one-criterion task: met, or not met with `feedback` as the evidence. */
const verdict = (passed: boolean, feedback = ''): ScriptedTurn => ({
  text: JSON.stringify({ criteria: [{ criterion: '1', met: passed, evidence: passed ? 'shown in the output' : feedback }], feedback: '' }),
});

interface Team {
  dir: string;
  engine: WorkflowEngine;
  server: CompanyServer;
  runtime: AgentRuntime;
  models: Record<string, ScriptedProvider>;
  checkpoints: CheckpointStore;
  workspace: Workspace;
  logs: string[];
  newRuntime: (models: Record<string, ScriptedProvider>) => AgentRuntime;
  call: (method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }>;
  types: () => string[];
}

let teams: Team[] = [];

afterEach(async () => {
  for (const t of teams) {
    await t.server.close();
    rmSync(t.dir, { recursive: true, force: true });
  }
  teams = [];
});

async function team(scripts: Record<string, ScriptedTurn[]>, options: { limits?: Partial<Limits>; config?: (c: any) => void; extraTools?: ToolExecutor[] } = {}): Promise<Team> {
  const dir = mkdtempSync(join(tmpdir(), 'ai-company-agents-'));
  mkdirSync(join(dir, 'workspace', 'notes'), { recursive: true });
  writeFileSync(join(dir, 'workspace', 'notes', 'idea.md'), '# 3D office\nAI agents work at desks in a 3D office.');
  const raw = JSON.parse(readFileSync(TEST_TEAM, 'utf8'));
  raw.limits = { ...raw.limits, ...options.limits };
  // Scripted files are short; the live team's 50-word minimum is for real briefs.
  raw.checks = { ...raw.checks, content: { minWords: 1, maxWords: 1_500 } };
  options.config?.(raw);
  const config: CompanyConfig = parseCompanyConfig(raw);
  const store = new MemoryDurableEventStore();
  const engine = new WorkflowEngine({ policy: buildPolicy(config), store, limits: config.limits, strictReview: true });
  must(bootstrapAgents(engine, config));
  const workspace = new Workspace(join(dir, 'workspace'));
  const tools = new ToolRegistry([...workspaceTools(workspace), ...(options.extraTools ?? [])]);
  const logs: string[] = [];
  const server = createCompanyServer({ engine, store, ceoToken: TOKEN, tools, workspace, checks: config.checks, log: (m) => logs.push(m), onFatal: (e) => logs.push(`FATAL ${e.message}`) });
  await new Promise<void>((resolve) => server.http.listen(0, '127.0.0.1', resolve));
  const { port } = server.http.address() as AddressInfo;
  const checkpoints = new MemoryCheckpointStore();
  let keys = 0;
  const newRuntime = (models: Record<string, ScriptedProvider>) =>
    new AgentRuntime({
      port: server.agentPort,
      modelFor: (a) => (models[a.id] ? { provider: models[a.id], model: 'scripted', options: config.modelOptions[a.id] } : undefined),
      workspace,
      checkpoints,
      log: (m) => logs.push(m),
      newKey: () => `key-${++keys}`,
      roleNotes: config.roleNotes,
    });
  const models = Object.fromEntries(Object.entries(scripts).map(([id, turns]) => [id, new ScriptedProvider(turns)]));
  const t: Team = {
    dir,
    engine,
    server,
    runtime: newRuntime(models),
    models,
    checkpoints,
    workspace,
    logs,
    newRuntime,
    async call(method, path, body) {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: { authorization: `Bearer ${TOKEN}`, ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, body: await res.json() };
    },
    types: () => store.all().map((e) => e.type),
  };
  teams.push(t);
  return t;
}

const lastUser = (p: ScriptedProvider, i: number) => [...p.requests[i].messages].reverse().find((m) => m.role === 'user')!.content;
const text = (p: ScriptedProvider, i: number) => p.requests[i].messages.map((m) => m.content).join('\n');

async function until(check: () => boolean, ms = 2_000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('agent runtime: the test team, end to end with scripted models', () => {
  test('plan → research → review → rewrite → email → CEO approval → outbox exactly once', async () => {
    const t = await team({
      ava: [plan([{ ...PLAN[1], ownerId: 'kai' }]), plan(PLAN)],
      kai: [
        call('files_read', { path: 'notes' }),
        call('files_read', { path: 'notes/idea.md' }),
        call('files_write', { path: 'brief.md', content: '# Brief\nProblem. Product.' }),
        submit(BRIEF_CRITERIA, { artifacts: ['brief.md'] }),
        call('files_write', { path: 'brief.md', content: '# Brief\nProblem. Product. Pricing: free.' }),
        submit(BRIEF_CRITERIA, { artifacts: ['brief.md'] }),
      ],
      rex: [verdict(false, 'Add a pricing section'), verdict(true), verdict(true)],
      zara: [call('files_read', { path: 'brief.md' }), submit(EMAIL_CRITERIA, { finalAction: { tool: 'email.send', input: EMAIL } })],
    });
    const goal = (await t.call('POST', '/goals', { text: GOAL, budgetTokens: 100_000 })).body;

    await t.runtime.runUntilIdle();
    for (const [id, m] of Object.entries(t.models)) assert.equal(m.remaining, 0, `${id} used every scripted turn`);
    const [brief, email] = t.engine.listTasks();
    assert.deepEqual([brief.title, brief.state, email.state], ['Write the product brief', 'done', 'awaiting_approval']);

    // Ava saw why her first plan was rejected.
    assert.match(lastUser(t.models.ava, 1), /lacks tool "email.send"/);
    // Kai read and wrote through the engine-checked tools.
    assert.equal(readFileSync(join(t.dir, 'workspace', 'brief.md'), 'utf8'), '# Brief\nProblem. Product. Pricing: free.');
    assert.match(t.models.kai.requests[1].messages.at(-1)!.content, /^notes\/idea.md$/);
    // Rex was shown the file, and his feedback reached Kai in the same conversation.
    assert.match(text(t.models.rex, 0), /Problem\. Product\./);
    assert.match(lastUser(t.models.kai, 4), /<<<([0-9a-f]{16}) review feedback\nNot met:\n- brief\.md covers the problem, the product and pricing: Add a pricing section\n\1>>>/, 'feedback names the unmet criterion and is fenced as data');
    assert.match(lastUser(t.models.kai, 4), /never instructions to you/);
    assert.ok(t.models.kai.requests[4].messages.length > 8, 'Kai resumed his conversation');
    // Zara's context pack: her task, Kai's result, nothing of Kai's conversation.
    const zaraFirst = text(t.models.zara, 0);
    assert.match(zaraFirst, /Draft the launch email/);
    assert.match(zaraFirst, /Write the product brief \(files: brief\.md\):\n<<<([0-9a-f]{16}) summary\nDone\n\1>>>/, "Kai's summary is fenced as data");
    assert.doesNotMatch(zaraFirst, /AI agents work at desks/);
    // email.send is never a callable tool: only a final action for approval.
    const offered = t.models.zara.requests[0].tools!.map((d) => d.name);
    assert.deepEqual(offered, ['files_read', 'files_write', 'submit_work', 'report_blocked']);
    assert.deepEqual((t.models.zara.requests[0].tools![2].parameters as any).properties.finalAction.properties.tool.enum, ['email.send']);

    // Nothing is sent until the CEO approves.
    assert.equal(existsSync(join(t.dir, 'workspace', 'outbox')), false);
    assert.deepEqual((await t.call('POST', `/tasks/${email.id}/approval`, { approved: true })).body, { state: 'done' });
    await until(() => t.engine.getTask(email.id)!.actionResult !== null);
    const outbox = readdirSync(join(t.dir, 'workspace', 'outbox'));
    assert.equal(outbox.length, 1);
    assert.match(readFileSync(join(t.dir, 'workspace', 'outbox', outbox[0]), 'utf8'), /^To: team@example.com\nSubject: Our 3D AI office is live\n/);
    assert.equal(t.engine.getTask(email.id)!.actionResult!.ok, true);
    assert.deepEqual(t.engine.pendingActions(), []);

    // Every model turn was recorded with its tokens: 2 + 3 goal steps, 6 + 2 task steps.
    const types = t.types();
    assert.equal(types.filter((x) => x === 'goal.step').length, 5);
    assert.equal(types.filter((x) => x === 'task.step').length, 8);
    assert.equal(t.engine.getGoal(goal.id)!.spentTokens, 13 * 120);
    assert.equal(types.filter((x) => x === 'tool.allowed').length, 5);
    assert.equal(types.filter((x) => x === 'action.executed').length, 1);

    // The gateway ran every allowed call, with keys it made, and recorded each result once.
    const events = t.engine.store.all();
    const allowedKeys = events.filter((e) => e.type === 'tool.allowed').map((e) => e.data!.idempotencyKey);
    const resultKeys = events.filter((e) => e.type === 'tool.executed' || e.type === 'tool.failed').map((e) => e.data!.idempotencyKey);
    assert.deepEqual(resultKeys, allowedKeys);
    assert.ok(allowedKeys.every((k) => !/^key-/.test(k)), 'tool-call keys come from the gateway, not the agent runtime');
    for (const e of events.filter((x) => x.type === 'tool.executed')) {
      const allowed = events.find((x) => x.type === 'tool.allowed' && x.data!.idempotencyKey === e.data!.idempotencyKey)!;
      assert.ok(allowed.seq < e.seq);
    }
    assert.deepEqual(t.engine.pendingToolCalls(), []);
  });

  test('the kill switch stops a worker between turns; nothing runs after it', async () => {
    const t = await team({
      kai: [
        (() => {
          t.engine.pauseCompany('CEO pressed stop');
          return call('files_write', { path: 'after-stop.md', content: 'x' });
        }) as ScriptedTurn,
        submit(BRIEF_CRITERIA, { artifacts: [] }),
      ],
    });
    const goal = must(t.engine.createGoal(GOAL, 100_000));
    must(t.engine.submitPlan(goal.id, 'ava', [PLAN[0]]));
    await t.runtime.runUntilIdle();
    const [task] = t.engine.listTasks();
    assert.equal(task.state, 'working');
    assert.equal(existsSync(join(t.dir, 'workspace', 'after-stop.md')), false, 'no tool ran after the kill switch');
    assert.equal(t.models.kai.remaining, 1);
    assert.match(t.types().filter((x) => x.startsWith('tool.')).join(), /^$/, 'the call was refused before policy (company paused)');

    must(t.engine.resumeCompany());
    await t.runtime.runUntilIdle();
    assert.equal(t.engine.getTask(task.id)!.state, 'review');
    assert.match(text(t.models.kai, 1), /company is paused/, 'resumed with the refused call in context');
  });

  test('a low step limit escalates the task and the worker stops', async () => {
    const t = await team(
      { kai: [call('files_read', { path: 'notes' }), call('files_read', { path: 'notes/idea.md' }), call('files_read', { path: '.' }), call('files_read', { path: 'x' })] },
      { limits: { maxSteps: 2 } },
    );
    const goal = must(t.engine.createGoal(GOAL, 100_000));
    must(t.engine.submitPlan(goal.id, 'ava', [PLAN[0]]));
    await t.runtime.runUntilIdle();
    const [task] = t.engine.listTasks();
    assert.equal(task.state, 'escalated');
    assert.match(task.escalationReason!, /step limit/);
    assert.equal(t.models.kai.remaining, 1);
  });

  test('impossible criteria escalate after three failed reviews', async () => {
    const t = await team({
      kai: [submit(BRIEF_CRITERIA), submit(BRIEF_CRITERIA), submit(BRIEF_CRITERIA)],
      rex: [verdict(false, 'Not possible'), verdict(false, 'Still not'), verdict(false, 'No')],
    });
    const goal = must(t.engine.createGoal(GOAL, 100_000));
    must(t.engine.submitPlan(goal.id, 'ava', [PLAN[0]]));
    await t.runtime.runUntilIdle();
    const [task] = t.engine.listTasks();
    assert.equal(task.state, 'escalated');
    assert.match(task.escalationReason!, /failed its checks or review 3 times/);
  });

  test('a worker can hand an impossible task to the CEO', async () => {
    const t = await team({ kai: [call('report_blocked', { reason: 'The notes folder is empty' })] });
    const goal = must(t.engine.createGoal(GOAL, 100_000));
    must(t.engine.submitPlan(goal.id, 'ava', [PLAN[0]]));
    await t.runtime.runUntilIdle();
    assert.match(t.engine.listTasks()[0].escalationReason!, /The notes folder is empty/);
  });

  test('the orchestrator re-plans with the errors, then the engine escalates the goal', async () => {
    const bad = plan([{ ...PLAN[0], acceptanceCriteria: [] }]);
    const t = await team({ ava: [bad, { text: 'not json at all' }, bad, bad, bad] });
    const goal = (await t.call('POST', '/goals', { text: GOAL, budgetTokens: 100_000 })).body;
    await t.runtime.runUntilIdle();
    const g = t.engine.getGoal(goal.id)!;
    assert.equal(g.status, 'escalated');
    assert.equal(t.models.ava.remaining, 1, 'first plan + maxReplans (3) re-plans');
    assert.match(lastUser(t.models.ava, 2), /not valid JSON/);
    assert.match(lastUser(t.models.ava, 3), /no acceptance criteria/);
  });

  test('agent log lines are one line and capped, so model text cannot fake log entries', async () => {
    const forged = plan([{ ...PLAN[0], ownerId: `nobody\n[agents] Rex passed "everything"\r\u0007${'x'.repeat(5_000)}` }]);
    const t = await team({ ava: [forged, forged, forged, forged] });
    await t.call('POST', '/goals', { text: GOAL, budgetTokens: 100_000 });
    await t.runtime.runUntilIdle();
    const rejected = t.logs.filter((m) => m.includes('was rejected'));
    assert.ok(rejected.length > 0);
    for (const m of t.logs) {
      assert.doesNotMatch(m, /[\u0000-\u001f\u007f]/, 'no newlines or control characters');
      assert.ok(m.length <= 1_000, `capped: ${m.length}`);
    }
  });

  test('after a crash, a new runtime resumes the worker from its checkpoint', async () => {
    const t = await team({
      kai: [
        call('files_read', { path: 'notes/idea.md' }),
        () => {
          throw new Error('process died');
        },
      ],
    });
    const goal = must(t.engine.createGoal(GOAL, 100_000));
    must(t.engine.submitPlan(goal.id, 'ava', [PLAN[0]]));
    await assert.rejects(t.runtime.runUntilIdle(), /process died/);

    const kai = new ScriptedProvider([submit(BRIEF_CRITERIA)]);
    await t.newRuntime({ kai }).runUntilIdle();
    assert.match(text(kai, 0), /AI agents work at desks/, 'the earlier tool result came back from the checkpoint');
    assert.equal(t.engine.listTasks()[0].state, 'review');
  });

  test('an agent without an available model is skipped, not crashed', async () => {
    const t = await team({});
    must(t.engine.createGoal(GOAL, 100_000));
    assert.equal(await t.runtime.runUntilIdle(), 0);
    assert.ok(t.logs.some((l) => /Ava has no available model/.test(l)));
  });
});

describe('agent port and the final-action executor', () => {
  test('the port exposes exactly the allowlisted commands and nothing for the CEO', async () => {
    const t = await team({});
    assert.deepEqual(Object.keys(t.server.agentPort).sort(), [...AGENT_PORT_METHODS].sort());
    assert.ok(Object.isFrozen(t.server.agentPort));
    // Agents cannot ask for an `allow` and act on it themselves: tools run only in the gateway.
    assert.equal('requestToolCall' in t.server.agentPort, false);
    const goal = must(t.engine.createGoal(GOAL, 100_000));
    const [task] = must(t.engine.submitPlan(goal.id, 'ava', [PLAN[0]]));
    assert.match((await t.server.agentPort.escalate(task.id, 'zara', 'not mine') as any).error, /only the task owner/);
    const view = await t.server.agentPort.view();
    assert.deepEqual(view.agents.find((a) => a.id === 'zara')!.toolAccess, { 'files.read': 'call', 'files.write': 'call', 'email.send': 'final' });
    assert.deepEqual(view.tools.map((x) => x.name), ['files.read', 'files.write', 'email.send']);
    // Agents see how to call a tool, never its code or credentials.
    assert.deepEqual(Object.keys(view.tools[0].runnable!).sort(), ['description', 'parameters']);
    assert.equal(typeof (view.tools[0].runnable as any).run, 'undefined');
  });

  test('a worker whose tool fails gets the reason as text; the failure is recorded, not hidden', async () => {
    const t = await team({
      kai: [call('files_read', { path: 'nowhere.md' }), call('report_blocked', { reason: 'no notes' })],
    });
    const goal = must(t.engine.createGoal(GOAL, 100_000));
    must(t.engine.submitPlan(goal.id, 'ava', [PLAN[0]]));
    await t.runtime.runUntilIdle();
    const failed = t.engine.store.all().find((e) => e.type === 'tool.failed')!;
    assert.equal(failed.data!.tool, 'files.read');
    assert.match(failed.data!.detail, /"nowhere.md" does not exist/);
    const toolMessage = t.models.kai.requests[1].messages.find((m) => m.role === 'tool')!;
    assert.match(toolMessage.content, /^error: "nowhere.md" does not exist/);
  });

  test('on boot, an action released before a crash is re-run only if its tool dedupes by key', async () => {
    const sms: string[] = [];
    const t = await team(
      {},
      {
        config: (c) => {
          c.tools.push({ name: 'sms.send', tier: 3 });
          c.agents.find((a: any) => a.id === 'zara').tools.push('sms.send');
        },
        extraTools: [
          { name: 'sms.send', description: '', parameters: {}, dedupesByKey: false, run: async () => (sms.push('sent'), 'sent') },
        ],
      },
    );
    const released = (tool: string, key: string, input: unknown) => {
      const [task] = must(t.engine.submitPlan(must(t.engine.createGoal(`g ${key}`, 100_000)).id, 'ava', [{ ...PLAN[1], dependsOn: [], requiredTools: [tool] }]));
      must(t.engine.start(task.id, 'zara'));
      must(t.engine.submitForReview(task.id, 'zara', { summary: 's', selfCheck: EMAIL_CRITERIA.map((criterion) => ({ criterion, met: true })), finalAction: { tool, input, idempotencyKey: key } }));
      must(t.engine.recordChecks(task.id, t.engine.getTask(task.id)!.submissions, []));
      must(t.engine.recordReview(task.id, 'rex', PASS));
      must(t.engine.decideApproval(task.id, { approved: true }));
      return task.id;
    };
    // The email's effect happened before the crash; its result was never recorded.
    const mail = released('email.send', 'mail-1', EMAIL);
    const signal = new AbortController().signal;
    await new ToolRegistry(workspaceTools(t.workspace)).get('email.send')!.run(EMAIL, { idempotencyKey: 'mail-1', signal, credential: () => '' });
    must(t.engine.recordActionStarted(mail, 'mail-1'));
    const smsTask = released('sms.send', 'sms-1', { to: '+1' });
    must(t.engine.recordActionStarted(smsTask, 'sms-1'));
    assert.equal(t.engine.pendingActions().length, 2);

    await t.server.recover();
    assert.equal(readdirSync(join(t.dir, 'workspace', 'outbox')).length, 1, 'the email is not written twice');
    assert.deepEqual(t.engine.getTask(mail)!.actionResult!.ok, true);
    assert.match(t.engine.getTask(mail)!.actionResult!.detail, /already in the outbox/);
    assert.deepEqual(sms, [], 'a tool that cannot detect a repeat is not re-run');
    assert.deepEqual(t.engine.getTask(smsTask)!.actionResult, { ok: false, detail: 'interrupted before its result was recorded; not retried because "sms.send" cannot detect a repeat. Check it by hand.' });
    assert.deepEqual(t.engine.pendingActions(), []);
    await t.server.recover();
    assert.equal(t.types().filter((x) => x === 'action.executed' || x === 'action.failed').length, 2, 'recovery is idempotent');
  });
});

describe('automated checks run before the reviewer (M5)', () => {
  test('failed checks send work back with the reasons; the reviewer sees only checked work and judges each criterion', async () => {
    const t = await team({
      kai: [
        call('files_write', { path: 'brief.md', content: '# Brief\nProblem, product and pricing. TODO: prices. See [notes](notes/nope.md).' }),
        submit(BRIEF_CRITERIA, { artifacts: ['brief.md'] }),
        call('files_write', { path: 'brief.md', content: '# Brief\nProblem, product and pricing: free. See [notes](notes/idea.md).' }),
        submit(BRIEF_CRITERIA, { artifacts: ['brief.md'] }),
      ],
      rex: [
        // Two items for one criterion: the reviewer is asked again, nothing is recorded.
        { text: JSON.stringify({ criteria: [{ criterion: '1', met: true, evidence: 'x' }, { criterion: '2', met: true, evidence: 'y' }], feedback: '' }) },
        verdict(true),
      ],
    });
    const goal = must(t.engine.createGoal(GOAL, 100_000));
    must(t.engine.submitPlan(goal.id, 'ava', [PLAN[0]]));
    await t.runtime.runUntilIdle();
    for (const [id, m] of Object.entries(t.models)) assert.equal(m.remaining, 0, `${id} used every scripted turn`);
    const [task] = t.engine.listTasks();
    assert.equal(task.state, 'done');

    // Kai got the failed checks as feedback, fenced as data, in the same conversation.
    const feedback = lastUser(t.models.kai, 2);
    assert.match(feedback, /<<<([0-9a-f]{16}) review feedback\nAutomated checks failed:\n- content\.placeholders: brief\.md still has a placeholder: "TODO"\n- content\.links: brief\.md: "notes\/nope\.md" does not exist in the workspace\n\1>>>/);
    // Rex was never asked about the first submission; he saw the passed checks and the criteria.
    const rexFirst = text(t.models.rex, 0);
    assert.match(rexFirst, /pricing: free/);
    assert.match(rexFirst, /Automated checks already passed[^\n]*:\n<<<([0-9a-f]{16}) checks\nfiles\.exist: 1 file\(s\) found\ncontent\.length: [^\n]+\ncontent\.placeholders: no placeholders\ncontent\.links: every link resolves\n\1>>>/, 'check details are fenced as data');
    assert.match(rexFirst, /1\. brief\.md covers the problem, the product and pricing/);
    assert.match(lastUser(t.models.rex, 1), /Give exactly 1 criteria items/);

    // The log: checks failed, checks passed, then a review whose rubric is stored.
    const events = t.engine.store.all().filter((e) => e.taskId === task.id && /^(checks|review)\./.test(e.type));
    assert.deepEqual(events.map((e) => e.type), ['checks.failed', 'checks.passed', 'review.passed']);
    assert.deepEqual(events[2].data!.rubric, [{ criterion: BRIEF_CRITERIA[0], met: true, note: 'shown in the output' }]);
    assert.equal(task.reviewAttempts, 1, 'a failed check run counts as a failed review');
  });

  test('an email to a recipient off the allowlist fails its checks every time, then escalates; nothing is sent and no reviewer runs', async () => {
    const offList = submit(EMAIL_CRITERIA, { finalAction: { tool: 'email.send', input: { ...EMAIL, to: 'boss@evil.test' } } });
    const t = await team({ zara: [offList, offList, offList], rex: [verdict(true)] });
    const goal = must(t.engine.createGoal(GOAL, 100_000));
    must(t.engine.submitPlan(goal.id, 'ava', [{ ...PLAN[1], dependsOn: [] }]));
    await t.runtime.runUntilIdle();
    const [task] = t.engine.listTasks();
    assert.equal(task.state, 'escalated');
    assert.match(task.escalationReason!, /failed its checks or review 3 times/);
    assert.equal(t.models.rex.requests.length, 0, 'the reviewer never saw work that failed its checks');
    assert.match(lastUser(t.models.zara, 1), /email\.recipients: boss@evil\.test is not on the allowed recipients list \(@example\.com\)/);
    assert.equal(t.types().filter((x) => x === 'checks.failed').length, 3);
    assert.deepEqual(t.engine.pendingActions(), []);
    assert.equal(existsSync(join(t.dir, 'workspace', 'outbox')), false);
  });

  test('a file changed after its checks is checked again, and only a review of the new version counts', async () => {
    const t = await team({ rex: [verdict(true), verdict(true)] });
    const brief = join(t.dir, 'workspace', 'brief.md');
    writeFileSync(brief, '# Brief\nProblem, product and pricing.');
    const [task] = must(t.engine.submitPlan(must(t.engine.createGoal(GOAL, 100_000)).id, 'ava', [PLAN[0]]));
    must(t.engine.start(task.id, 'kai'));
    must(t.engine.submitForReview(task.id, 'kai', { summary: 's', selfCheck: BRIEF_CRITERIA.map((criterion) => ({ criterion, met: true })), artifacts: ['brief.md'] }));
    await t.server.runPendingChecks();
    const firstHash = t.engine.getTask(task.id)!.checkedFiles!['brief.md'];
    // Another task's worker rewrites the file while this one waits for review.
    writeFileSync(brief, '# Brief\nProblem, product and pricing: free for teams.');
    await t.runtime.runUntilIdle();

    assert.equal(t.engine.getTask(task.id)!.state, 'done');
    const types = t.engine.store.all().filter((e) => e.taskId === task.id && /^(checks|review)\./.test(e.type)).map((e) => e.type);
    assert.deepEqual(types, ['checks.passed', 'checks.reset', 'checks.passed', 'review.passed'], 'the first verdict was refused and the files re-checked');
    assert.notEqual(t.engine.getTask(task.id)!.checkedFiles!['brief.md'], firstHash);
    assert.equal(t.models.rex.requests.length, 2, 'a fresh review of the new version');
    assert.match(text(t.models.rex, 1), /free for teams/);
  });

  test('a submission left unchecked by a crash waits for its checks; recovery runs them before any review', async () => {
    const t = await team({ rex: [verdict(true)] });
    const [task] = must(t.engine.submitPlan(must(t.engine.createGoal(GOAL, 100_000)).id, 'ava', [PLAN[0]]));
    must(t.engine.start(task.id, 'kai'));
    // Submitted straight to the engine: as if the server died before the checks ran.
    must(t.engine.submitForReview(task.id, 'kai', { summary: 's', selfCheck: BRIEF_CRITERIA.map((criterion) => ({ criterion, met: true })) }));
    await t.runtime.runUntilIdle();
    assert.equal(t.models.rex.requests.length, 0, 'no reviewer turn on unchecked work');
    await t.server.recover();
    assert.deepEqual(t.engine.getTask(task.id)!.checkResults, []);
    await t.runtime.runUntilIdle();
    assert.equal(t.engine.getTask(task.id)!.state, 'done');
  });
});

describe('agent runtime: safety holes found in review', () => {
  test('a worker that calls email.send directly is refused, and nothing reaches the outbox', async () => {
    const t = await team({
      zara: [
        call('email_send', EMAIL),
        call('email.send', EMAIL),
        call('files_write', { path: 'outbox/fake.eml', content: 'To: everyone' }),
        call('files_write', { path: 'OUTBOX/fake.eml', content: 'To: everyone' }),
        call('report_blocked', { reason: 'cannot send' }),
      ],
    });
    const goal = must(t.engine.createGoal(GOAL, 100_000));
    must(t.engine.submitPlan(goal.id, 'ava', [{ ...PLAN[1], dependsOn: [] }]));
    await t.runtime.runUntilIdle();
    const denied = t.engine.store.all().filter((e) => e.type === 'tool.denied').map((e) => e.data!.tool);
    assert.deepEqual(denied, ['email_send', 'email.send']);
    assert.match(text(t.models.zara, 2), /propose it as the task's finalAction/);
    assert.match(text(t.models.zara, 4), /outbox/i);
    assert.equal(existsSync(join(t.dir, 'workspace', 'outbox')), false);
    assert.equal(existsSync(join(t.dir, 'workspace', 'OUTBOX')), false);
    assert.equal(t.types().filter((x) => x.startsWith('action.')).length, 0);
  });

  test('a worker is offered a final action only for tools its task was planned with', async () => {
    const t = await team({ zara: [call('report_blocked', { reason: 'stop here' })] });
    const goal = must(t.engine.createGoal(GOAL, 100_000));
    must(t.engine.submitPlan(goal.id, 'ava', [{ ...PLAN[1], title: 'Write the brief', dependsOn: [], requiredTools: ['files.read', 'files.write'] }]));
    await t.runtime.runUntilIdle();
    const submit = t.models.zara.requests[0].tools!.find((d) => d.name === 'submit_work')!;
    assert.equal('finalAction' in (submit.parameters as any).properties, false, 'no finalAction on a task without email.send');
    assert.doesNotMatch(text(t.models.zara, 0), /To use email\.send/);
  });

  test('a reviewer that never gives a usable verdict does not loop: the goal budget ends it', async () => {
    const useless: ScriptedTurn = { text: JSON.stringify({ passed: false, score: 0, feedback: '' }) };
    const t = await team({ kai: [submit(BRIEF_CRITERIA)], rex: Array(9).fill(useless) });
    const goal = must(t.engine.createGoal(GOAL, 1_000));
    const [task] = must(t.engine.submitPlan(goal.id, 'ava', [{ ...PLAN[0], costEstimateTokens: 500 }]));
    await t.runtime.runUntilIdle();
    assert.equal(t.engine.getTask(task.id)!.state, 'review');
    assert.equal(t.models.rex.remaining, 6, 'three attempts, then the runtime moves on instead of looping');
    for (let i = 0; i < 5 && t.engine.getTask(task.id)!.state === 'review'; i++) await t.runtime.runUntilIdle();
    assert.equal(t.engine.getTask(task.id)!.state, 'escalated');
    assert.equal(t.engine.getTask(task.id)!.escalationReason, 'goal budget exhausted');
    assert.ok(t.engine.getGoal(goal.id)!.spentTokens >= 1_000);
  });

  test('the kill switch during a review: the verdict is refused and nothing is released until resume', async () => {
    const final = { tool: 'files.write', input: { path: 'final.md', content: 'shipped' } };
    const t = await team({
      kai: [submit(BRIEF_CRITERIA, { finalAction: final })],
      rex: [
        (() => {
          t.engine.pauseCompany('CEO pressed stop');
          return verdict(true);
        }) as ScriptedTurn,
        verdict(true),
      ],
    });
    const goal = must(t.engine.createGoal(GOAL, 100_000));
    const [task] = must(t.engine.submitPlan(goal.id, 'ava', [PLAN[0]]));
    await t.runtime.runUntilIdle();
    assert.equal(t.engine.getTask(task.id)!.state, 'review');
    assert.equal(t.models.rex.remaining, 1, 'Rex stopped at the pause instead of retrying');
    assert.equal(existsSync(join(t.dir, 'workspace', 'final.md')), false);
    assert.deepEqual(t.engine.pendingActions(), []);

    must(t.engine.resumeCompany());
    await t.runtime.runUntilIdle();
    assert.equal(t.engine.getTask(task.id)!.state, 'done');
    await until(() => t.engine.getTask(task.id)!.actionResult !== null);
    assert.equal(readFileSync(join(t.dir, 'workspace', 'final.md'), 'utf8'), 'shipped');
  });

  test('closing the server waits for a running final action to record its result', async () => {
    let finish!: () => void;
    const t = await team(
      {},
      {
        config: (c) => {
          c.tools.push({ name: 'slow.send', tier: 3 });
          c.agents.find((a: any) => a.id === 'zara').tools.push('slow.send');
        },
        extraTools: [{ name: 'slow.send', description: '', parameters: {}, dedupesByKey: false, run: () => new Promise((r) => (finish = () => r('sent'))) }],
      },
    );
    const [task] = must(t.engine.submitPlan(must(t.engine.createGoal('g', 100_000)).id, 'ava', [{ ...PLAN[1], dependsOn: [], requiredTools: ['slow.send'] }]));
    must(t.engine.start(task.id, 'zara'));
    must(t.engine.submitForReview(task.id, 'zara', { summary: 's', selfCheck: EMAIL_CRITERIA.map((criterion) => ({ criterion, met: true })), finalAction: { tool: 'slow.send', input: {}, idempotencyKey: 'slow-1' } }));
    must(t.engine.recordChecks(task.id, t.engine.getTask(task.id)!.submissions, []));
    must(t.engine.recordReview(task.id, 'rex', PASS));
    assert.deepEqual((await t.call('POST', `/tasks/${task.id}/approval`, { approved: true })).body, { state: 'done' });
    let closed = false;
    const closing = t.server.close().then(() => (closed = true));
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(closed, false, 'close waits while the action runs');
    finish();
    await closing;
    assert.deepEqual(t.engine.getTask(task.id)!.actionResult, { ok: true, detail: 'sent', attempts: 1 });
    assert.equal(t.logs.some((l) => l.startsWith('FATAL')), false);
    teams = teams.filter((x) => x !== t);
    rmSync(t.dir, { recursive: true, force: true });
  });
});

describe('role memory', () => {
  test("the CEO's notes and lessons from reviewed work reach the next agent with that role, and only them", async () => {
    const brief = (title: string) => ({ ...PLAN[0], title, key: title });
    const t = await team(
      {
        kai: [submit(BRIEF_CRITERIA), submit(BRIEF_CRITERIA), submit(BRIEF_CRITERIA)],
        rex: [verdict(false, 'Add a pricing section'), verdict(true), verdict(true), verdict(true)],
        zara: [submit(EMAIL_CRITERIA)],
      },
      { config: (c) => (c.roles = { researcher: 'Always say which notes file you used.', writer: 'Keep emails under 120 words.' }) },
    );
    const first = must(t.engine.createGoal('First brief', 100_000));
    must(t.engine.submitPlan(first.id, 'ava', [brief('Write the first brief')]));
    await t.runtime.runUntilIdle();
    assert.equal(t.engine.listTasks()[0].state, 'done');

    const second = must(t.engine.createGoal('Second brief', 100_000));
    must(t.engine.submitPlan(second.id, 'ava', [brief('Write the second brief'), { ...PLAN[1], dependsOn: [] }]));
    await t.runtime.runUntilIdle();

    // Kai's first turn on the new task: the CEO's notes, then the lesson, fenced as data.
    const kaiNew = t.models.kai.requests.find((r) => r.messages.some((m) => m.content.includes('Write the second brief')))!;
    const kaiText = kaiNew.messages.map((m) => m.content).join('\n');
    assert.match(kaiText, /How to do your job \(from the CEO\):\nAlways say which notes file you used\./);
    assert.match(kaiText, /A past task that was sent back, fixed and passed:\n<<<([0-9a-f]{16}) lesson\nTask: Write the first brief\nFeedback: Not met:\n- brief\.md covers the problem, the product and pricing: Add a pricing section\n\1>>>/);
    // On his first task there was nothing to learn from yet.
    assert.doesNotMatch(text(t.models.kai, 0), /Lessons from reviews/);
    // Zara has another role: her own notes, none of Kai's lessons.
    const zaraText = text(t.models.zara, 0);
    assert.match(zaraText, /Keep emails under 120 words\./);
    assert.doesNotMatch(zaraText, /Add a pricing section|Always say which notes file/);
  });

  test('role notes are checked at boot', () => {
    const raw = JSON.parse(readFileSync(TEST_TEAM, 'utf8'));
    assert.deepEqual(parseCompanyConfig({ ...raw, roles: undefined }).roleNotes, {});
    assert.throws(() => parseCompanyConfig({ ...raw, roles: { writer: 5 } }), /notes for role "writer"/);
    assert.throws(() => parseCompanyConfig({ ...raw, roles: { writer: 'x'.repeat(4_001) } }), /at most 4000/);
    assert.throws(() => parseCompanyConfig({ ...raw, roles: ['x'] }), /"roles" must be an object/);
  });
});

describe('company config for agents', () => {
  test('the test team config is valid; model refs and options are checked', () => {
    const config = loadCompanyConfig(TEST_TEAM);
    assert.deepEqual(config.modelOptions.kai, { think: false, temperature: 0.2, numCtx: 12288, maxTokens: 4096 });
    assert.deepEqual(Object.keys(config.roleNotes), ['chief-of-staff', 'researcher', 'writer', 'reviewer']);
    assert.equal('options' in config.agents[1], false, 'options never reach the engine or the event log');
    const raw = JSON.parse(readFileSync(TEST_TEAM, 'utf8'));
    for (const [mutate, error] of [
      [(c: any) => (c.agents[0].model = 'qwen3'), /"<provider>:<model>"/],
      [(c: any) => (c.agents[0].options = { temperature: 9 }), /temperature/],
      [(c: any) => (c.agents[0].options = { numCtx: 1.5 }), /numCtx/],
      [(c: any) => (c.agents[0].options = { think: 'yes' }), /think/],
      [(c: any) => (c.agents[0].options = { maxTokens: 100 }), /maxTokens/],
      [(c: any) => (c.agents[0].options = { top_p: 1 }), /unknown option/],
    ] as const) {
      const c = structuredClone(raw);
      mutate(c);
      assert.throws(() => parseCompanyConfig(c), error);
    }
  });
});
