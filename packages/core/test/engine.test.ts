import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { WorkflowEngine } from '../src/engine.ts';
import { allMet, makeCompany, must, startedTask, task } from './helpers.ts';

describe('plan validation (gate 1)', () => {
  test('accepts a valid plan and assigns every task', () => {
    const { engine } = makeCompany();
    const goal = must(engine.createGoal('Ship it', 100_000));
    const tasks = must(engine.submitPlan(goal.id, 'ava', [task(), task({ key: 'email', ownerId: 'omar', dependsOn: ['build'] })]));
    assert.equal(tasks.length, 2);
    assert.ok(tasks.every((t) => t.state === 'assigned'));
    assert.deepEqual(tasks[1].dependsOn, [tasks[0].id]);
  });

  test('rejects plans with problems and lists every reason', () => {
    const { engine } = makeCompany();
    const goal = must(engine.createGoal('Ship it', 15_000));
    const r = engine.submitPlan(goal.id, 'ava', [
      task({ acceptanceCriteria: [] }),
      task({ key: 'b', ownerId: 'omar', requiredTools: ['github.create_branch'], dependsOn: ['c'] }),
      task({ key: 'c', ownerId: 'ava', dependsOn: ['b'] }),
    ]);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.error, /no acceptance criteria/);
    assert.match(r.error, /lacks tool "github.create_branch"/);
    assert.match(r.error, /is a orchestrator, not a worker/);
    assert.match(r.error, /dependency cycle/);
    assert.match(r.error, /exceeds remaining goal budget/);
    assert.equal(engine.listTasks().length, 0);
    assert.equal(engine.store.all().at(-1)!.type, 'plan.rejected');
  });

  test('only the orchestrator may submit plans', () => {
    const { engine } = makeCompany();
    const goal = must(engine.createGoal('Ship it', 100_000));
    assert.equal(engine.submitPlan(goal.id, 'kai', [task()]).ok, false);
  });
});

describe('happy path', () => {
  test('work → review → done, with the expected event trail', () => {
    const { engine } = makeCompany();
    const { task: t } = startedTask(engine);
    must(engine.recordStep(t.id, 'kai', 1200));
    assert.deepEqual(must(engine.requestToolCall(t.id, 'kai', { tool: 'repo.read', input: { path: 'README.md' }, idempotencyKey: 'k1' })), { kind: 'allow', tier: 0 });
    must(engine.submitForReview(t.id, 'kai', { summary: 'Built it', selfCheck: allMet(t.acceptanceCriteria) }));
    const outcome = must(engine.recordReview(t.id, 'rex', { passed: true, score: 0.9, feedback: 'Good' }));
    assert.deepEqual(outcome, { state: 'done', execute: null });
    assert.deepEqual(
      engine.store.all().filter((e) => e.taskId === t.id).map((e) => e.type),
      ['task.assigned', 'task.started', 'task.step', 'tool.allowed', 'task.submitted', 'review.passed', 'task.done'],
    );
  });

  test('tasks cannot start before their dependencies are done', () => {
    const { engine } = makeCompany();
    const goal = must(engine.createGoal('Ship it', 100_000));
    const [a, b] = must(engine.submitPlan(goal.id, 'ava', [task(), task({ key: 'email', ownerId: 'omar', dependsOn: ['build'] })]));
    assert.match((engine.start(b.id, 'omar') as { error: string }).error, /waiting on 1 unfinished/);
    must(engine.start(a.id, 'kai'));
    must(engine.submitForReview(a.id, 'kai', { summary: 'done', selfCheck: allMet(a.acceptanceCriteria) }));
    must(engine.recordReview(a.id, 'rex', { passed: true, score: 1, feedback: '' }));
    must(engine.start(b.id, 'omar'));
  });

  test('only the owner can act on a task', () => {
    const { engine } = makeCompany();
    const { task: t } = startedTask(engine);
    assert.equal(engine.requestToolCall(t.id, 'omar', { tool: 'repo.read', input: {}, idempotencyKey: 'x' }).ok, false);
    assert.equal(engine.recordStep(t.id, 'omar', 10).ok, false);
  });
});

describe('risk tiers and approvals (gate 5)', () => {
  test('tier-3 tool calls during work are refused', () => {
    const { engine } = makeCompany();
    const { task: t } = startedTask(engine, { ownerId: 'omar', requiredTools: ['email.send'] });
    const r = engine.requestToolCall(t.id, 'omar', { tool: 'email.send', input: { to: 'a@b.co' }, idempotencyKey: 'e1' });
    assert.equal(r.ok, false);
    assert.equal(engine.store.all().at(-1)!.type, 'tool.denied');
  });

  test('a tier-3 final action waits for the CEO, then is released once', () => {
    const { engine } = makeCompany();
    const { task: t } = startedTask(engine, { ownerId: 'omar', requiredTools: ['email.send'] });
    const action = { tool: 'email.send', input: { to: 'acme@example.com' }, idempotencyKey: 'send-acme-1' };
    must(engine.submitForReview(t.id, 'omar', { summary: 'Proposal drafted', selfCheck: allMet(t.acceptanceCriteria), finalAction: action }));
    assert.deepEqual(must(engine.recordReview(t.id, 'rex', { passed: true, score: 0.8, feedback: '' })), { state: 'awaiting_approval', execute: null });
    assert.deepEqual(must(engine.decideApproval(t.id, { approved: true })), { state: 'done', execute: action });
    assert.equal(engine.decideApproval(t.id, { approved: true }).ok, false, 'cannot approve twice');
  });

  test('a rejected approval sends the task back with the note', () => {
    const { engine } = makeCompany();
    const { task: t } = startedTask(engine, { ownerId: 'omar', requiredTools: ['email.send'] });
    must(engine.submitForReview(t.id, 'omar', { summary: 's', selfCheck: allMet(t.acceptanceCriteria), finalAction: { tool: 'email.send', input: {}, idempotencyKey: 'e2' } }));
    must(engine.recordReview(t.id, 'rex', { passed: true, score: 0.8, feedback: '' }));
    assert.equal(engine.decideApproval(t.id, { approved: false }).ok, false, 'rejection needs a note');
    must(engine.decideApproval(t.id, { approved: false, note: 'Too pushy, soften the tone' }));
    const after = engine.getTask(t.id)!;
    assert.equal(after.state, 'working');
    assert.equal(after.lastFeedback, 'Too pushy, soften the tone');
    assert.equal(after.reviewAttempts, 1);
  });

  test('auto-approved tier-2 final actions are released at review', () => {
    const { engine } = makeCompany();
    const { task: t } = startedTask(engine, { requiredTools: ['staging.deploy'] });
    const action = { tool: 'staging.deploy', input: {}, idempotencyKey: 'stg-1' };
    must(engine.submitForReview(t.id, 'kai', { summary: 's', selfCheck: allMet(t.acceptanceCriteria), finalAction: action }));
    assert.deepEqual(must(engine.recordReview(t.id, 'rex', { passed: true, score: 1, feedback: '' })), { state: 'done', execute: action });
  });
});

describe('quality gates 2 and 4', () => {
  test('submission without a full self-check is refused', () => {
    const { engine } = makeCompany();
    const { task: t } = startedTask(engine);
    const r = engine.submitForReview(t.id, 'kai', { summary: 's', selfCheck: [{ criterion: 'Page renders', met: true }] });
    assert.equal(r.ok, false);
    assert.equal(engine.getTask(t.id)!.state, 'working');
  });

  test('reviewers must be reviewer agents', () => {
    const { engine } = makeCompany();
    const { task: t } = startedTask(engine);
    must(engine.submitForReview(t.id, 'kai', { summary: 's', selfCheck: allMet(t.acceptanceCriteria) }));
    assert.equal(engine.recordReview(t.id, 'kai', { passed: true, score: 1, feedback: '' }).ok, false);
    assert.equal(engine.recordReview(t.id, 'ava', { passed: true, score: 1, feedback: '' }).ok, false);
  });

  test('three failed reviews escalate the task', () => {
    const { engine } = makeCompany();
    const { task: t } = startedTask(engine);
    for (let i = 1; i <= 3; i++) {
      must(engine.submitForReview(t.id, 'kai', { summary: `try ${i}`, selfCheck: allMet(t.acceptanceCriteria) }));
      must(engine.recordReview(t.id, 'rex', { passed: false, score: 0.3, feedback: 'Tests missing' }));
    }
    const after = engine.getTask(t.id)!;
    assert.equal(after.state, 'escalated');
    assert.match(after.escalationReason!, /failed review 3 times/);
  });
});

describe('limits and safety controls', () => {
  test('exceeding the step limit escalates', () => {
    const { engine } = makeCompany({ maxSteps: 2 });
    const { task: t } = startedTask(engine);
    must(engine.recordStep(t.id, 'kai', 10));
    must(engine.recordStep(t.id, 'kai', 10));
    assert.equal(must(engine.recordStep(t.id, 'kai', 10)), 'escalated');
  });

  test('budget warning at 80%, escalation at 100%', () => {
    const { engine } = makeCompany();
    const { goal, task: t } = startedTask(engine, {}, 10_000);
    must(engine.recordStep(t.id, 'kai', 8_500));
    assert.equal(engine.getGoal(goal.id)!.warned, true);
    assert.equal(engine.store.all().filter((e) => e.type === 'budget.warning').length, 1);
    must(engine.recordStep(t.id, 'kai', 2_000));
    assert.equal(engine.getTask(t.id)!.escalationReason, 'goal budget exhausted');
  });

  test('the same idempotency key is never allowed twice', () => {
    const { engine } = makeCompany();
    const { task: t } = startedTask(engine);
    const call = { tool: 'github.create_branch', input: { name: 'feat' }, idempotencyKey: 'branch-feat' };
    assert.equal(must(engine.requestToolCall(t.id, 'kai', call)).kind, 'allow');
    assert.equal(must(engine.requestToolCall(t.id, 'kai', call)).kind, 'duplicate');
  });

  test('an agent repeating the same call is treated as looping', () => {
    const { engine } = makeCompany();
    const { task: t } = startedTask(engine);
    const call = (k: string) => ({ tool: 'repo.read', input: { path: 'a.ts' }, idempotencyKey: k });
    must(engine.requestToolCall(t.id, 'kai', call('1')));
    must(engine.requestToolCall(t.id, 'kai', call('2')));
    assert.equal(engine.requestToolCall(t.id, 'kai', call('3')).ok, false);
    assert.equal(engine.getTask(t.id)!.state, 'escalated');
  });

  test('kill switch blocks starts and tool calls until resumed', () => {
    const { engine } = makeCompany();
    const { task: t } = startedTask(engine);
    must(engine.pauseCompany());
    assert.equal(engine.requestToolCall(t.id, 'kai', { tool: 'repo.read', input: {}, idempotencyKey: 'p1' }).ok, false);
    must(engine.resumeCompany());
    assert.equal(engine.requestToolCall(t.id, 'kai', { tool: 'repo.read', input: {}, idempotencyKey: 'p1' }).ok, true);
  });

  test('stuck detection escalates quiet tasks', () => {
    const { engine, advance } = makeCompany({ stuckAfterMs: 60_000 });
    const { task: t } = startedTask(engine);
    advance(30_000);
    assert.deepEqual(engine.checkStuck(), []);
    advance(31_000);
    assert.deepEqual(engine.checkStuck(), [t.id]);
    assert.match(engine.getTask(t.id)!.escalationReason!, /no progress/);
  });

  test('circuit breaker benches an agent after repeated escalations', () => {
    const { engine } = makeCompany({ circuitBreakerEscalations: 2 });
    const goal = must(engine.createGoal('g', 100_000));
    const [a, b] = must(engine.submitPlan(goal.id, 'ava', [task(), task({ key: 'two' })]));
    must(engine.escalate(a.id, 'stuck'));
    assert.equal(engine.getAgent('kai')!.benched, false);
    must(engine.escalate(b.id, 'stuck again'));
    assert.equal(engine.getAgent('kai')!.benched, true);
    assert.equal(engine.resolveEscalation(a.id, { kind: 'retry' }).ok, false, 'benched agent cannot take work');
    must(engine.unbenchAgent('kai'));
    must(engine.resolveEscalation(a.id, { kind: 'retry' }));
  });

  test('escalated work can be reassigned with fresh counters', () => {
    const { engine } = makeCompany({ maxSteps: 1 });
    must(engine.registerAgent({ id: 'mina', name: 'Mina', kind: 'worker', role: 'frontend-engineer', model: 'sonnet', tools: ['repo.read'] }));
    const { task: t } = startedTask(engine);
    must(engine.recordStep(t.id, 'kai', 10));
    must(engine.recordStep(t.id, 'kai', 10));
    must(engine.resolveEscalation(t.id, { kind: 'reassign', ownerId: 'mina' }));
    const after = engine.getTask(t.id)!;
    assert.equal(after.state, 'assigned');
    assert.equal(after.ownerId, 'mina');
    assert.equal(after.steps, 0);
  });
});

describe('event sourcing', () => {
  test('an engine rebuilt from the log has identical state', () => {
    const { engine, options } = makeCompany();
    const { task: t } = startedTask(engine, { ownerId: 'omar', requiredTools: ['email.send'] });
    must(engine.recordStep(t.id, 'omar', 500));
    must(engine.submitForReview(t.id, 'omar', { summary: 's', selfCheck: allMet(t.acceptanceCriteria), finalAction: { tool: 'email.send', input: {}, idempotencyKey: 'r1' } }));
    must(engine.recordReview(t.id, 'rex', { passed: true, score: 1, feedback: '' }));

    const rebuilt = WorkflowEngine.fromEvents(engine.store.all(), { policy: options.policy, now: options.now });
    assert.deepEqual(rebuilt.listTasks(), engine.listTasks());
    assert.deepEqual(rebuilt.listAgents(), engine.listAgents());
    assert.equal(rebuilt.getTask(t.id)!.state, 'awaiting_approval');
    must(rebuilt.decideApproval(t.id, { approved: true }));
  });

  test('subscribers see every event as it is appended', () => {
    const { engine } = makeCompany();
    const seen: string[] = [];
    engine.store.subscribe((e) => seen.push(e.type));
    startedTask(engine);
    assert.deepEqual(seen, ['goal.created', 'plan.accepted', 'task.assigned', 'task.started']);
  });
});
