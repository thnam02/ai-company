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
  ToolRegistry,
  Workspace,
  workspaceTools,
  type CheckpointStore,
  type ScriptedTurn,
  type ToolExecutor,
} from '@ai-company/agents';
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
const verdict = (passed: boolean, feedback = ''): ScriptedTurn => ({ text: JSON.stringify({ passed, score: passed ? 0.9 : 0.4, feedback }) });

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
  options.config?.(raw);
  const config: CompanyConfig = parseCompanyConfig(raw);
  const store = new MemoryDurableEventStore();
  const engine = new WorkflowEngine({ policy: buildPolicy(config), store, limits: config.limits });
  must(bootstrapAgents(engine, config));
  const workspace = new Workspace(join(dir, 'workspace'));
  const tools = new ToolRegistry([...workspaceTools(workspace), ...(options.extraTools ?? [])]);
  const logs: string[] = [];
  const server = createCompanyServer({ engine, store, ceoToken: TOKEN, tools, log: (m) => logs.push(m), onFatal: (e) => logs.push(`FATAL ${e.message}`) });
  await new Promise<void>((resolve) => server.http.listen(0, '127.0.0.1', resolve));
  const { port } = server.http.address() as AddressInfo;
  const checkpoints = new MemoryCheckpointStore();
  let keys = 0;
  const newRuntime = (models: Record<string, ScriptedProvider>) =>
    new AgentRuntime({
      port: server.agentPort,
      modelFor: (a) => (models[a.id] ? { provider: models[a.id], model: 'scripted', options: config.modelOptions[a.id] } : undefined),
      tools,
      workspace,
      checkpoints,
      log: (m) => logs.push(m),
      newKey: () => `key-${++keys}`,
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
    assert.match(lastUser(t.models.kai, 4), /Add a pricing section/);
    assert.ok(t.models.kai.requests[4].messages.length > 8, 'Kai resumed his conversation');
    // Zara's context pack: her task, Kai's result, nothing of Kai's conversation.
    const zaraFirst = text(t.models.zara, 0);
    assert.match(zaraFirst, /Draft the launch email/);
    assert.match(zaraFirst, /Write the product brief: Done Files: brief.md/);
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
    assert.match(task.escalationReason!, /failed review 3 times/);
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
    const goal = must(t.engine.createGoal(GOAL, 100_000));
    const [task] = must(t.engine.submitPlan(goal.id, 'ava', [PLAN[0]]));
    assert.match((await t.server.agentPort.escalate(task.id, 'zara', 'not mine') as any).error, /only the task owner/);
    const view = await t.server.agentPort.view();
    assert.deepEqual(view.agents.find((a) => a.id === 'zara')!.toolAccess, { 'files.read': 'call', 'files.write': 'call', 'email.send': 'final' });
    assert.deepEqual(view.tools.map((x) => x.name), ['files.read', 'files.write', 'email.send']);
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
      must(t.engine.recordReview(task.id, 'rex', { passed: true, score: 1, feedback: '' }));
      must(t.engine.decideApproval(task.id, { approved: true }));
      return task.id;
    };
    // The email's effect happened before the crash; its result was never recorded.
    const mail = released('email.send', 'mail-1', EMAIL);
    await new ToolRegistry(workspaceTools(t.workspace)).executeAction({ tool: 'email.send', input: EMAIL, idempotencyKey: 'mail-1' });
    const smsTask = released('sms.send', 'sms-1', { to: '+1' });
    assert.equal(t.engine.pendingActions().length, 2);

    await t.server.recoverActions();
    assert.equal(readdirSync(join(t.dir, 'workspace', 'outbox')).length, 1, 'the email is not written twice');
    assert.deepEqual(t.engine.getTask(mail)!.actionResult!.ok, true);
    assert.match(t.engine.getTask(mail)!.actionResult!.detail, /already in the outbox/);
    assert.deepEqual(sms, [], 'a tool that cannot detect a repeat is not re-run');
    assert.deepEqual(t.engine.getTask(smsTask)!.actionResult, { ok: false, detail: 'interrupted before its result was recorded; not retried because "sms.send" cannot detect a repeat. Check it by hand.' });
    assert.deepEqual(t.engine.pendingActions(), []);
    await t.server.recoverActions();
    assert.equal(t.types().filter((x) => x.startsWith('action.')).length, 2, 'recovery is idempotent');
  });
});

describe('company config for agents', () => {
  test('the test team config is valid; model refs and options are checked', () => {
    const config = loadCompanyConfig(TEST_TEAM);
    assert.deepEqual(config.modelOptions.kai, { think: false, temperature: 0.2, numCtx: 16384 });
    assert.equal('options' in config.agents[1], false, 'options never reach the engine or the event log');
    const raw = JSON.parse(readFileSync(TEST_TEAM, 'utf8'));
    for (const [mutate, error] of [
      [(c: any) => (c.agents[0].model = 'qwen3'), /"<provider>:<model>"/],
      [(c: any) => (c.agents[0].options = { temperature: 9 }), /temperature/],
      [(c: any) => (c.agents[0].options = { numCtx: 1.5 }), /numCtx/],
      [(c: any) => (c.agents[0].options = { think: 'yes' }), /think/],
      [(c: any) => (c.agents[0].options = { top_p: 1 }), /unknown option/],
    ] as const) {
      const c = structuredClone(raw);
      mutate(c);
      assert.throws(() => parseCompanyConfig(c), error);
    }
  });
});
