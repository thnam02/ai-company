import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { liveTeam, type LiveTeam } from './live-team.ts';

/**
 * M3b acceptance test against a real model. Opt-in: runs only when
 * OLLAMA_URL is set (LIVE_MODEL defaults to qwen3:8b). RUN_REPORT=<file>
 * appends each run report; LIVE_VERBOSE=1 prints agent logs; LIVE_KEEP=1
 * keeps the workspace.
 */
const OLLAMA_URL = process.env.OLLAMA_URL;
const MODEL = process.env.LIVE_MODEL || 'qwen3:8b';
const MIN = 60_000;

const GOAL = 'Write a one-page product brief for our 3D AI office from the notes in workspace/notes/ and save it as brief.md, then draft a launch email to our team (team@example.com).';
const BRIEF = {
  key: 'brief',
  title: 'Write the product brief in brief.md',
  acceptanceCriteria: ['brief.md exists and covers the problem, the product and the pricing from the notes'],
  ownerId: 'kai',
  requiredTools: ['files.read', 'files.write'],
  dependsOn: [],
  costEstimateTokens: 40_000,
};

describe(`live: the test team on ${MODEL}`, { skip: OLLAMA_URL ? false : 'set OLLAMA_URL to run against a real model' }, () => {
  let team: LiveTeam | undefined;
  afterEach(async () => {
    await team?.stop();
    team = undefined;
  });
  const start = async (limits = {}) => (team = await liveTeam({ ollamaUrl: OLLAMA_URL!, model: MODEL, limits }));
  const types = (t: LiveTeam) => t.store.all();

  test('plan → brief → email → review → CEO approval → outbox exactly once', { timeout: 60 * MIN }, async () => {
    const t = await start();
    const goal = (await t.call('POST', '/goals', { text: GOAL, budgetTokens: 400_000 })).body;
    t.runtime.start();
    const tasks = () => t.engine.listTasks();
    const settled = () =>
      t.engine.getGoal(goal.id)!.status === 'escalated' ||
      tasks().some((x) => x.state === 'escalated' || x.state === 'cancelled') ||
      (tasks().length > 0 && tasks().every((x) => x.state === 'done' || x.state === 'awaiting_approval'));
    try {
      await t.until(settled, 45 * MIN, 'the team to finish or escalate');
    } finally {
      t.report('test team goal');
    }

    // Ava's plan: two tasks, Zara's depending on Kai's.
    const all = tasks();
    assert.equal(all.length, 2, `plan: ${JSON.stringify(all.map((x) => [x.title, x.ownerId]))}`);
    const kai = all.find((x) => x.ownerId === 'kai')!;
    const zara = all.find((x) => x.ownerId === 'zara')!;
    assert.ok(kai && zara, 'one task each for Kai and Zara');
    assert.deepEqual(zara.dependsOn, [kai.id]);
    for (const x of all) assert.ok(x.state === 'done' || x.state === 'awaiting_approval', `"${x.title}" is ${x.state}: ${x.escalationReason ?? ''}`);

    // Zara starts only after Kai's task is done.
    const seqOf = (type: string, taskId: string) => types(t).find((e) => e.type === type && e.taskId === taskId)!.seq;
    assert.ok(seqOf('task.started', zara.id) > seqOf('task.done', kai.id));

    // Kai wrote the brief; Zara proposed email.send; Rex passed both.
    assert.ok(existsSync(join(t.workspace, 'brief.md')), 'workspace/brief.md exists');
    assert.ok(readFileSync(join(t.workspace, 'brief.md'), 'utf8').length > 200, 'the brief has content');
    assert.equal(zara.finalAction?.tool, 'email.send');
    for (const x of all) assert.ok(types(t).some((e) => e.type === 'review.passed' && e.taskId === x.id), `Rex passed "${x.title}"`);

    // Nothing is sent before approval; after it, exactly one email in the outbox.
    assert.equal(zara.state, 'awaiting_approval');
    assert.equal(existsSync(join(t.workspace, 'outbox')), false);
    assert.deepEqual((await t.call('POST', `/tasks/${zara.id}/approval`, { approved: true })).body, { state: 'done' });
    await t.until(() => t.engine.getTask(zara.id)!.actionResult !== null, MIN, 'the email to be written');
    assert.equal(t.engine.getTask(zara.id)!.actionResult!.ok, true);
    assert.equal(readdirSync(join(t.workspace, 'outbox')).length, 1);
  });

  test('impossible criteria escalate instead of looping', { timeout: 30 * MIN }, async () => {
    const t = await start();
    const goal = await t.server.run(() => t.engine.createGoal('Brief with impossible criteria', 400_000));
    assert.ok(goal.ok);
    const plan = await t.server.agentPort.submitPlan(goal.value.id, 'ava', [
      { ...BRIEF, acceptanceCriteria: ['brief.md quotes the signed approval letter from our board of directors, which is in workspace/board/approval.pdf'] },
    ]);
    assert.ok(plan.ok, plan.ok ? '' : plan.error);
    const [task] = plan.value;
    t.runtime.start();
    try {
      await t.until(() => t.engine.getTask(task.id)!.state === 'escalated', 25 * MIN, 'the task to escalate');
    } finally {
      t.report('impossible criteria');
    }
    const reason = t.engine.getTask(task.id)!.escalationReason!;
    // Either Rex failed it three times, or Kai reported it blocked; both hand it to the CEO.
    assert.match(reason, /failed its checks or review 3 times|^Kai: /);
    for (const e of types(t).filter((x) => x.type === 'review.failed')) assert.ok(String(e.data!.feedback).trim(), 'failed reviews carry feedback');
  });

  test('a low step limit escalates the task', { timeout: 20 * MIN }, async () => {
    const t = await start({ maxSteps: 2 });
    const goal = await t.server.run(() => t.engine.createGoal('Brief with a tiny step limit', 400_000));
    assert.ok(goal.ok);
    const plan = await t.server.agentPort.submitPlan(goal.value.id, 'ava', [BRIEF]);
    assert.ok(plan.ok, plan.ok ? '' : plan.error);
    const [task] = plan.value;
    t.runtime.start();
    try {
      await t.until(() => !['assigned', 'working'].includes(t.engine.getTask(task.id)!.state), 15 * MIN, 'the task to stop');
    } finally {
      t.report('low step limit');
    }
    const after = t.engine.getTask(task.id)!;
    // Two turns are rarely enough to read the notes, write and submit.
    if (after.state === 'escalated') assert.match(after.escalationReason!, /step limit/);
    else assert.ok(after.steps <= 2, `finished in ${after.steps} turns`);
  });

  test('the kill switch stops work mid-task', { timeout: 20 * MIN }, async () => {
    const t = await start();
    const goal = await t.server.run(() => t.engine.createGoal('Brief, then stop', 400_000));
    assert.ok(goal.ok);
    const plan = await t.server.agentPort.submitPlan(goal.value.id, 'ava', [BRIEF]);
    assert.ok(plan.ok, plan.ok ? '' : plan.error);
    const [task] = plan.value;
    let pausedAt = 0;
    t.store.subscribe((e) => {
      if (!pausedAt && e.type === 'tool.allowed') {
        pausedAt = e.seq;
        void t.server.run(() => t.engine.pauseCompany('CEO pressed stop'));
      }
    });
    t.runtime.start();
    try {
      await t.until(() => t.engine.isCompanyPaused(), 15 * MIN, 'the first tool call');
      // Let any model call in flight finish, then check nothing else ran.
      await new Promise((r) => setTimeout(r, 90_000));
    } finally {
      t.report('kill switch');
    }
    const pause = types(t).find((e) => e.type === 'company.paused')!;
    const later = types(t).filter((e) => e.seq > pause.seq);
    assert.deepEqual(later.filter((e) => e.type === 'tool.allowed' || e.type === 'task.submitted'), [], 'no tool ran and nothing was submitted after the stop');
    assert.equal(t.engine.getTask(task.id)!.state, 'working', 'the task waits, not lost');
  });
});
