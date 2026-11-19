import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { WorkflowEngine } from '@ai-company/core';
import { buildRunReport, formatRunReport } from '../src/run-report.ts';
import { TEST_CONFIG, allMet, makePolicy, must, registerTestAgents } from './helpers.ts';

/** A company on a fake clock: two goals, one re-plan, one rework, one escalation. */
function history() {
  let clock = 0;
  const engine = new WorkflowEngine({ policy: makePolicy(), limits: TEST_CONFIG.limits, now: () => clock });
  const tick = (s: number) => (clock += s * 1_000);
  registerTestAgents(engine);

  const goal = must(engine.createGoal('Ship the release', 100_000));
  must(engine.recordGoalStep(goal.id, 'ava', 1_000));
  assert.equal(engine.submitPlan(goal.id, 'ava', []).ok, false);
  must(engine.recordGoalStep(goal.id, 'ava', 1_500));
  const plan = [
    { key: 'build', title: 'Build it', acceptanceCriteria: ['Builds'], ownerId: 'kai', requiredTools: ['repo.read'], costEstimateTokens: 5_000 },
    { key: 'mail', title: 'Announce it', acceptanceCriteria: ['Clear'], ownerId: 'omar', requiredTools: ['email.send'], dependsOn: ['build'], costEstimateTokens: 5_000 },
  ];
  const [build, mail] = must(engine.submitPlan(goal.id, 'ava', plan));

  tick(10);
  must(engine.start(build.id, 'kai'));
  must(engine.recordStep(build.id, 'kai', 2_000));
  must(engine.requestToolCall(build.id, 'kai', { tool: 'repo.read', input: { path: 'a' }, idempotencyKey: 'k1' }));
  assert.equal(engine.requestToolCall(build.id, 'kai', { tool: 'email.send', input: {}, idempotencyKey: 'k2' }).ok, false);
  tick(30);
  must(engine.recordStep(build.id, 'kai', 3_000));
  must(engine.submitForReview(build.id, 'kai', { summary: 'Built', selfCheck: allMet(build.acceptanceCriteria) }));
  must(engine.recordGoalStep(goal.id, 'rex', 800));
  must(engine.recordReview(build.id, 'rex', { passed: false, score: 0.3, feedback: 'Tests missing' }));
  tick(20);
  must(engine.recordStep(build.id, 'kai', 1_000));
  must(engine.submitForReview(build.id, 'kai', { summary: 'Built with tests', selfCheck: allMet(build.acceptanceCriteria) }));
  must(engine.recordGoalStep(goal.id, 'rex', 700));
  must(engine.recordReview(build.id, 'rex', { passed: true, score: 0.9, feedback: '' }));

  tick(5);
  must(engine.start(mail.id, 'omar'));
  tick(15);
  must(engine.recordStep(mail.id, 'omar', 4_000));
  must(engine.submitForReview(mail.id, 'omar', { summary: 'Drafted', selfCheck: allMet(mail.acceptanceCriteria), finalAction: { tool: 'email.send', input: {}, idempotencyKey: 'm1' } }));
  must(engine.recordGoalStep(goal.id, 'rex', 600));
  must(engine.recordReview(mail.id, 'rex', { passed: true, score: 1, feedback: '' }));
  tick(100); // the CEO takes a while
  must(engine.decideApproval(mail.id, { approved: true }));
  must(engine.recordActionResult(mail.id, 'm1', { ok: true, detail: 'written to outbox/m1.eml' }));

  const other = must(engine.createGoal('Hopeless', 50_000));
  must(engine.recordGoalStep(other.id, 'ava', 500));
  const [stuck] = must(engine.submitPlan(other.id, 'ava', [{ ...plan[0], key: 'x', title: 'Impossible' }]));
  must(engine.start(stuck.id, 'kai'));
  tick(7);
  must(engine.escalate(stuck.id, 'Kai: cannot be done'));
  return { engine, goal, build, mail, stuck };
}

describe('run report', () => {
  test('is built from the event log alone', () => {
    const { engine, goal, build, mail, stuck } = history();
    const report = buildRunReport(engine.store.all());

    assert.deepEqual(report.summary, {
      goals: 2,
      plansAcceptedFirstTry: 1,
      replans: 1,
      tasks: 3,
      tasksDone: 2,
      escalations: 1,
      reviewedTasks: 2,
      firstTryReviewPasses: 1,
      toolCalls: { allowed: 1, denied: 1, duplicate: 0 },
      tokens: 2_500 + 500 + 2_100 + 6_000 + 4_000,
    });
    assert.deepEqual(report.goals.map((g) => [g.id, g.planAttempts, g.planningTokens, g.reviewTokens]), [
      [goal.id, 2, 2_500, 2_100],
      [engine.listGoals()[1].id, 1, 500, 0],
    ]);
    const byId = Object.fromEntries(report.tasks.map((t) => [t.id, t]));
    assert.deepEqual(byId[build.id], {
      id: build.id, goalId: goal.id, title: 'Build it', ownerId: 'kai', state: 'done',
      steps: 3, tokens: 6_000, reviews: ['failed', 'passed'], seconds: 50, escalationReason: null, action: null,
    });
    assert.equal(byId[mail.id].seconds, 15, 'agent time ends when the work goes to the CEO, not at approval');
    assert.deepEqual(byId[mail.id].action, { tool: 'email.send', ok: true, detail: 'written to outbox/m1.eml' });
    assert.equal(byId[stuck.id].state, 'escalated');
    assert.equal(byId[stuck.id].escalationReason, 'Kai: cannot be done');
  });

  test('formats as Markdown with the headline numbers and any memory figures', () => {
    const { engine } = history();
    const md = formatRunReport(buildRunReport(engine.store.all()), { model: 'qwen3:8b', wallSeconds: 200, peakServerRssMb: 180, peakModelMb: 6_100 });
    assert.match(md, /^# Run report: qwen3:8b/);
    assert.match(md, /Plans accepted first try \| 1 of 2/);
    assert.match(md, /Re-plans \| 1/);
    assert.match(md, /First-try review pass rate \| 50% \(1 of 2\)/);
    assert.match(md, /Peak model memory \(Ollama\) \| 6100 MB/);
    assert.match(md, /\| Build it \| kai \| done \| 3 \| 6000 \| failed, passed \| 50 s \|/);
  });
});
