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

  test('a final action must use a tool the plan gave the task', () => {
    const { engine } = makeCompany();
    const { task: t } = startedTask(engine, { ownerId: 'omar', requiredTools: ['repo.read'] });
    const r = engine.submitForReview(t.id, 'omar', {
      summary: 's',
      selfCheck: allMet(t.acceptanceCriteria),
      finalAction: { tool: 'email.send', input: {}, idempotencyKey: 'not-planned' },
    });
    assert.equal(r.ok, false);
    assert.match(r.ok ? '' : r.error, /email\.send is not in this task's requiredTools/);
    assert.equal(engine.getTask(t.id)!.state, 'working', 'nothing was submitted');
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
    assert.match(after.escalationReason!, /failed its checks or review 3 times/);
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

  test('updateAgent changes a live agent through an event that replays', () => {
    const { engine, options } = makeCompany();
    const { task: t } = startedTask(engine);
    must(engine.updateAgent('kai', { model: 'haiku', tools: ['github.create_branch'] }));
    assert.equal(engine.getAgent('kai')!.model, 'haiku');
    // A revoked tool is denied from the next call on, even mid-task.
    assert.equal(engine.requestToolCall(t.id, 'kai', { tool: 'repo.read', input: {}, idempotencyKey: 'k1' }).ok, false);

    const rebuilt = WorkflowEngine.fromEvents(engine.store.all(), { policy: options.policy, now: options.now });
    assert.deepEqual(rebuilt.listAgents(), engine.listAgents());
    assert.equal(engine.store.all().at(-2)!.type, 'agent.updated');
  });

  test('updateAgent refuses unknown agents, unknown tools, tools for non-workers and no-op changes', () => {
    const { engine } = makeCompany();
    assert.match((engine.updateAgent('nobody', { model: 'x' }) as any).error, /unknown agent/);
    assert.match((engine.updateAgent('kai', { tools: ['laser'] }) as any).error, /unknown tools/);
    assert.match((engine.updateAgent('rex', { tools: ['repo.read'] }) as any).error, /only workers/);
    const before = engine.store.size;
    must(engine.updateAgent('kai', { model: 'sonnet' }));
    assert.equal(engine.store.size, before, 'no event when nothing changes');
  });

  test('listGoals returns copies of every goal, including goals without tasks', () => {
    const { engine } = makeCompany();
    const a = must(engine.createGoal('First', 1_000));
    const b = must(engine.createGoal('Second', 2_000));
    const goals = engine.listGoals();
    assert.deepEqual(goals.map((g) => g.id), [a.id, b.id]);
    goals[0].spentTokens = 999;
    assert.equal(engine.getGoal(a.id)!.spentTokens, 0);
  });

  test('subscribers see every event as it is appended', () => {
    const { engine } = makeCompany();
    const seen: string[] = [];
    engine.store.subscribe((e) => seen.push(e.type));
    startedTask(engine);
    assert.deepEqual(seen, ['goal.created', 'plan.accepted', 'task.assigned', 'task.started']);
  });
});

describe('goal planning (agent runtime support)', () => {
  test('a goal is open until a plan is accepted, then planned; it is planned only once', () => {
    const { engine } = makeCompany();
    const goal = must(engine.createGoal('Ship it', 100_000));
    assert.equal(goal.status, 'open');
    must(engine.submitPlan(goal.id, 'ava', [task()]));
    assert.equal(engine.getGoal(goal.id)!.status, 'planned');
    assert.match((engine.submitPlan(goal.id, 'ava', [task()]) as any).error, /goal is planned, not open/);
  });

  test('after maxReplans re-plans the engine escalates the goal', () => {
    const { engine, options } = makeCompany({ maxReplans: 2 });
    const goal = must(engine.createGoal('Ship it', 100_000));
    const bad = [task({ acceptanceCriteria: [] })];
    for (let i = 1; i <= 2; i++) {
      assert.equal(engine.submitPlan(goal.id, 'ava', bad).ok, false);
      assert.deepEqual([engine.getGoal(goal.id)!.status, engine.getGoal(goal.id)!.planRejections], ['open', i]);
    }
    // First plan + 2 re-plans rejected: the third rejection escalates.
    assert.equal(engine.submitPlan(goal.id, 'ava', bad).ok, false);
    const escalated = engine.getGoal(goal.id)!;
    assert.equal(escalated.status, 'escalated');
    assert.match(escalated.escalationReason!, /plan rejected 3 times/);
    assert.equal(engine.store.all().at(-1)!.type, 'goal.escalated');
    assert.match((engine.submitPlan(goal.id, 'ava', [task()]) as any).error, /goal is escalated, not open/);

    const rebuilt = WorkflowEngine.fromEvents(engine.store.all(), { policy: options.policy, now: options.now });
    assert.deepEqual(rebuilt.listGoals(), engine.listGoals());
  });

  test('goals from older logs (no status field) replay as open', () => {
    const { engine, options } = makeCompany();
    const events = [...engine.store.all(), { seq: engine.store.size + 1, at: 1, type: 'goal.created', goalId: 'old', data: { goal: { id: 'old', text: 'Old goal', budgetTokens: 1_000, spentTokens: 0, warned: false } } }];
    const rebuilt = WorkflowEngine.fromEvents(events, { policy: options.policy, now: options.now });
    assert.deepEqual(rebuilt.getGoal('old'), { id: 'old', text: 'Old goal', budgetTokens: 1_000, spentTokens: 0, warned: false, status: 'open', planRejections: 0, escalationReason: null });
  });
});

describe('goal steps: orchestrator and reviewer turns are recorded', () => {
  test('recordGoalStep charges the goal budget and replays', () => {
    const { engine, options } = makeCompany();
    const goal = must(engine.createGoal('Ship it', 10_000));
    must(engine.recordGoalStep(goal.id, 'ava', 1_200));
    must(engine.recordGoalStep(goal.id, 'rex', 300));
    assert.equal(engine.getGoal(goal.id)!.spentTokens, 1_500);
    assert.deepEqual(engine.store.all().at(-1), { seq: engine.store.size, at: 1_000_000, type: 'goal.step', goalId: goal.id, agentId: 'rex', data: { tokens: 300 } });
    const rebuilt = WorkflowEngine.fromEvents(engine.store.all(), { policy: options.policy, now: options.now });
    assert.equal(rebuilt.getGoal(goal.id)!.spentTokens, 1_500);
  });

  test('only orchestrators and reviewers record goal steps, with sane token counts', () => {
    const { engine } = makeCompany();
    const goal = must(engine.createGoal('Ship it', 10_000));
    assert.match((engine.recordGoalStep(goal.id, 'kai', 10) as any).error, /workers record steps on their task/);
    assert.match((engine.recordGoalStep(goal.id, 'nobody', 10) as any).error, /unknown agent/);
    assert.match((engine.recordGoalStep('nope', 'ava', 10) as any).error, /unknown goal/);
    assert.match((engine.recordGoalStep(goal.id, 'ava', -1) as any).error, /non-negative/);
  });

  test('planning that exhausts the budget escalates the goal', () => {
    const { engine } = makeCompany();
    const goal = must(engine.createGoal('Ship it', 1_000));
    must(engine.recordGoalStep(goal.id, 'ava', 1_000));
    const g = engine.getGoal(goal.id)!;
    assert.equal(g.status, 'escalated');
    assert.equal(g.escalationReason, 'goal budget exhausted');
  });
});

describe('artifacts and the final-action execution record', () => {
  function releasedEmail(engine: WorkflowEngine) {
    const { task: t } = startedTask(engine, { ownerId: 'omar', requiredTools: ['email.send'] });
    const action = { tool: 'email.send', input: { to: 'team@example.com' }, idempotencyKey: 'mail-1' };
    must(engine.submitForReview(t.id, 'omar', { summary: 'Drafted', selfCheck: allMet(t.acceptanceCriteria), artifacts: ['launch/email.md'], finalAction: action }));
    must(engine.recordReview(t.id, 'rex', { passed: true, score: 1, feedback: '' }));
    return { task: t, action };
  }

  test('a submission records the files it produced', () => {
    const { engine } = makeCompany();
    const { task: t } = releasedEmail(engine);
    assert.deepEqual(engine.getTask(t.id)!.artifacts, ['launch/email.md']);
    const { task: other } = startedTask(engine);
    for (const artifacts of [[''], ['a', 3], Array.from({ length: 21 }, (_, i) => `f${i}`)] as any[]) {
      assert.match((engine.submitForReview(other.id, 'kai', { summary: 's', selfCheck: allMet(other.acceptanceCriteria), artifacts }) as any).error, /artifacts/);
    }
  });

  test('a released action is pending until its result is recorded, exactly once', () => {
    const { engine, options } = makeCompany();
    const { task: t, action } = releasedEmail(engine);
    assert.deepEqual(engine.pendingActions(), [], 'not released before approval');
    assert.match((engine.recordActionResult(t.id, 'mail-1', { ok: true, detail: 'sent' }) as any).error, /not done/);
    must(engine.decideApproval(t.id, { approved: true }));
    assert.deepEqual(engine.pendingActions(), [{ taskId: t.id, action }]);

    assert.match((engine.recordActionResult(t.id, 'other-key', { ok: true, detail: '' }) as any).error, /does not match/);
    must(engine.recordActionResult(t.id, 'mail-1', { ok: true, detail: 'written to outbox/mail-1.eml' }));
    assert.deepEqual(engine.pendingActions(), []);
    assert.deepEqual(engine.getTask(t.id)!.actionResult, { ok: true, detail: 'written to outbox/mail-1.eml' });
    assert.equal(engine.store.all().at(-1)!.type, 'action.executed');
    assert.match((engine.recordActionResult(t.id, 'mail-1', { ok: true, detail: '' }) as any).error, /already recorded/);

    const rebuilt = WorkflowEngine.fromEvents(engine.store.all(), { policy: options.policy, now: options.now });
    assert.deepEqual(rebuilt.listTasks(), engine.listTasks());
    assert.deepEqual(rebuilt.pendingActions(), []);
  });

  test('a failed execution is recorded as failed and is not pending', () => {
    const { engine } = makeCompany();
    const { task: t } = releasedEmail(engine);
    must(engine.decideApproval(t.id, { approved: true }));
    must(engine.recordActionResult(t.id, 'mail-1', { ok: false, detail: 'interrupted; not retried' }));
    assert.equal(engine.store.all().at(-1)!.type, 'action.failed');
    assert.deepEqual(engine.pendingActions(), []);
  });
});

describe('automated checks and rubric reviews (M5)', () => {
  const strict = () => makeCompany({}, { strictReview: true });
  const passing = [{ name: 'files.exist', ok: true, detail: 'brief.md' }];
  const checks = (engine: WorkflowEngine, id: string, results: any, files?: Record<string, string>) => engine.recordChecks(id, engine.getTask(id)!.submissions, results, files);
  const rubric = (criteria: string[], met = true) => criteria.map((criterion) => ({ criterion, met, ...(met ? {} : { note: 'missing' }) }));

  test('checks are recorded once per submission; a pass keeps the task in review for the reviewer', () => {
    const { engine, options } = strict();
    const { task: t } = startedTask(engine);
    assert.match((checks(engine, t.id, passing) as any).error, /not in review/);
    must(engine.submitForReview(t.id, 'kai', { summary: 'Built', selfCheck: allMet(t.acceptanceCriteria) }));
    assert.equal(engine.getTask(t.id)!.checkResults, null);
    for (const bad of [[{ name: '', ok: true, detail: '' }], [{ name: 'x', ok: 'yes', detail: '' }], 'nope'] as any[]) {
      assert.match((checks(engine, t.id, bad) as any).error, /results of \{ name, ok, detail \}/);
    }
    assert.equal(must(checks(engine, t.id, passing)), 'review');
    assert.deepEqual(engine.getTask(t.id)!.checkResults, passing);
    assert.equal(engine.store.all().at(-1)!.type, 'checks.passed');
    assert.match((checks(engine, t.id, passing) as any).error, /already recorded/);
    const rebuilt = WorkflowEngine.fromEvents(engine.store.all(), { policy: options.policy, now: options.now });
    assert.deepEqual(rebuilt.listTasks(), engine.listTasks());
  });

  test('a failed check sends the task back with feedback naming each failure, and counts as a review attempt', () => {
    const { engine, options } = strict();
    const { task: t } = startedTask(engine);
    const failing = [...passing, { name: 'content.links', ok: false, detail: 'notes/missing.md does not exist' }];
    for (let i = 1; i <= 3; i++) {
      must(engine.submitForReview(t.id, 'kai', { summary: 'Built', selfCheck: allMet(t.acceptanceCriteria) }));
      must(checks(engine, t.id, failing));
      const now = engine.getTask(t.id)!;
      if (i < 3) {
        assert.equal(now.state, 'working');
        assert.equal(now.reviewAttempts, i);
        assert.equal(now.lastFeedback, 'Automated checks failed:\n- content.links: notes/missing.md does not exist');
      }
    }
    assert.equal(engine.getTask(t.id)!.state, 'escalated');
    assert.match(engine.getTask(t.id)!.escalationReason!, /failed its checks or review 3 times/);
    // Failed check runs replay to the same state, attempts and feedback.
    const rebuilt = WorkflowEngine.fromEvents(engine.store.all(), { policy: options.policy, now: options.now });
    assert.deepEqual(rebuilt.listTasks(), engine.listTasks());
  });

  test('checks name their submission and the files they read; stale results and bad hashes are refused', () => {
    const { engine, options } = strict();
    const { task: t } = startedTask(engine);
    const hash = 'a'.repeat(64);
    must(engine.submitForReview(t.id, 'kai', { summary: 'Built', selfCheck: allMet(t.acceptanceCriteria), artifacts: ['app.ts'] }));
    const [pending] = engine.awaitingChecks();
    assert.equal(pending.submission, 1);
    assert.match((engine.recordChecks(t.id, 0, passing) as any).error, /for submission 0; the task is on submission 1/);
    for (const bad of [{ 'other.ts': hash }, { 'app.ts': 'abc' }, ['app.ts']] as any[]) {
      assert.match((checks(engine, t.id, passing, bad) as any).error, /artifact paths to sha256/);
    }
    must(checks(engine, t.id, passing, { 'app.ts': hash }));
    assert.deepEqual(engine.checkedFiles(t.id), { artifacts: ['app.ts'], files: { 'app.ts': hash } });
    assert.equal(engine.store.all().at(-1)!.agentId, undefined, 'checks are the gateway, not an agent');

    // Files changed after the checks: the results are dropped and the work waits for new checks.
    must(engine.resetChecks(t.id, 'app.ts changed'));
    assert.equal(engine.getTask(t.id)!.checkResults, null);
    assert.equal(engine.checkedFiles(t.id), null);
    assert.equal(engine.awaitingChecks()[0].submission, 1);
    assert.match((engine.resetChecks(t.id, 'again') as any).error, /no recorded checks/);
    must(checks(engine, t.id, passing, { 'app.ts': 'b'.repeat(64) }));
    const rebuilt = WorkflowEngine.fromEvents(engine.store.all(), { policy: options.policy, now: options.now });
    assert.deepEqual(rebuilt.listTasks(), engine.listTasks());
  });

  test('the rubric sets the score; a malformed note is refused, not thrown', () => {
    const { engine } = strict();
    const { task: t } = startedTask(engine);
    const [a, b] = t.acceptanceCriteria;
    must(engine.submitForReview(t.id, 'kai', { summary: 'Built', selfCheck: allMet(t.acceptanceCriteria) }));
    must(checks(engine, t.id, passing));
    for (const note of [5, 'x'.repeat(2_001)] as any[]) {
      const r = engine.recordReview(t.id, 'rex', { passed: false, score: 0, feedback: 'f', rubric: [{ criterion: a, met: true }, { criterion: b, met: false, note }] });
      assert.match((r as any).error, /note of at most 2000 characters/);
    }
    must(engine.recordReview(t.id, 'rex', { passed: false, score: 0.99, feedback: 'f', rubric: [{ criterion: a, met: true }, { criterion: b, met: false, note: 'no tests' }] }));
    assert.equal(engine.store.all().at(-1)!.data!.score, 0.5, "the reviewer's own score is not kept");
  });

  test('a plan with blank or repeated criteria is refused: each criterion must be judged once', () => {
    const { engine } = strict();
    const goal = must(engine.createGoal('g', 100_000));
    const task = { key: 'a', title: 'A', ownerId: 'kai', requiredTools: [], dependsOn: [], costEstimateTokens: 1_000 };
    const r = engine.submitPlan(goal.id, 'ava', [{ ...task, acceptanceCriteria: ['Covers pricing', ' covers PRICING ', ''] }]);
    assert.match((r as any).error, /repeats the acceptance criterion "covers PRICING"/);
    assert.match((r as any).error, /blank acceptance criterion/);
  });

  test('in strict mode a review needs passed checks and a rubric that covers every criterion and agrees with the verdict', () => {
    const { engine } = strict();
    const { task: t } = startedTask(engine);
    const criteria = t.acceptanceCriteria;
    must(engine.submitForReview(t.id, 'kai', { summary: 'Built', selfCheck: allMet(criteria) }));
    const verdict = { passed: true, score: 1, feedback: '', rubric: rubric(criteria) };
    assert.match((engine.recordReview(t.id, 'rex', verdict) as any).error, /automated checks have not passed/);
    must(checks(engine, t.id, passing));

    assert.match((engine.recordReview(t.id, 'rex', { passed: true, score: 1, feedback: '' }) as any).error, /needs a rubric/);
    assert.match((engine.recordReview(t.id, 'rex', { ...verdict, rubric: rubric(criteria).slice(1) }) as any).error, /does not cover: Page renders/);
    assert.match((engine.recordReview(t.id, 'rex', { ...verdict, rubric: [...rubric(criteria), { criterion: 'Extra', met: true }] }) as any).error, /not an acceptance criterion: Extra/);
    const mixed = [{ criterion: criteria[0], met: true }, { criterion: criteria[1], met: false, note: 'no tests' }];
    assert.match((engine.recordReview(t.id, 'rex', { ...verdict, rubric: mixed }) as any).error, /passes but a criterion is not met/);
    assert.match((engine.recordReview(t.id, 'rex', { passed: false, score: 0.5, feedback: 'Fix', rubric: rubric(criteria) }) as any).error, /fails but every criterion is met/);
    assert.match((engine.recordReview(t.id, 'rex', { passed: false, score: 0.5, feedback: 'Fix', rubric: [mixed[0], { criterion: criteria[1], met: false }] }) as any).error, /needs a note/);

    must(engine.recordReview(t.id, 'rex', { passed: false, score: 0.5, feedback: 'Add tests', rubric: mixed }));
    const failed = engine.store.all().at(-1)!;
    assert.equal(failed.type, 'review.failed');
    assert.deepEqual(failed.data!.rubric, mixed);

    // The next submission needs its own checks.
    must(engine.submitForReview(t.id, 'kai', { summary: 'With tests', selfCheck: allMet(criteria) }));
    assert.match((engine.recordReview(t.id, 'rex', verdict) as any).error, /automated checks have not passed/);
    must(checks(engine, t.id, passing));
    must(engine.recordReview(t.id, 'rex', verdict));
    assert.equal(engine.getTask(t.id)!.state, 'done');
  });

  test('outside strict mode reviews work as before, and a rubric given is still checked', () => {
    const { engine } = makeCompany();
    const { task: t } = startedTask(engine);
    must(engine.submitForReview(t.id, 'kai', { summary: 'Built', selfCheck: allMet(t.acceptanceCriteria) }));
    assert.match((engine.recordReview(t.id, 'rex', { passed: true, score: 1, feedback: '', rubric: [] }) as any).error, /does not cover/);
    must(engine.recordReview(t.id, 'rex', { passed: true, score: 1, feedback: '' }));
  });

  test('older logs have no check fields; replay fills them in and counts submissions from the log', () => {
    const { engine, options } = makeCompany({}, { strictReview: true });
    const { task: t } = startedTask(engine);
    must(engine.submitForReview(t.id, 'kai', { summary: 'Built', selfCheck: allMet(t.acceptanceCriteria) }));
    const old = engine.store.all().map((e) =>
      e.type === 'plan.accepted' ? { ...e, data: { tasks: e.data!.tasks.map(({ checkResults: _c, checkedFiles: _f, submissions: _s, checkResets: _r, ...rest }: any) => rest) } } : e,
    );
    const rebuilt = WorkflowEngine.fromEvents(old, { policy: options.policy, now: options.now, strictReview: true });
    const task = rebuilt.getTask(t.id)!;
    assert.deepEqual([task.checkResults, task.checkedFiles, task.submissions, task.checkResets], [null, null, 1, 0]);
    assert.equal(rebuilt.awaitingChecks()[0].submission, 1);
    must(rebuilt.recordChecks(t.id, 1, []));
  });

  test('files that keep changing during review escalate instead of resetting forever', () => {
    const { engine, options } = strict();
    const { task: t } = startedTask(engine);
    const hash = (c: string) => c.repeat(64);
    must(engine.submitForReview(t.id, 'kai', { summary: 'Built', selfCheck: allMet(t.acceptanceCriteria), artifacts: ['app.ts'] }));
    assert.match((checks(engine, t.id, passing) as any).error, /passed without a hash of: app\.ts/, 'strict: a pass names the content that passed');
    for (const c of ['a', 'b', 'c']) {
      must(checks(engine, t.id, passing, { 'app.ts': hash(c) }));
      must(engine.resetChecks(t.id, 'app.ts changed'));
    }
    assert.equal(engine.getTask(t.id)!.state, 'escalated');
    assert.match(engine.getTask(t.id)!.escalationReason!, /files kept changing during review \(3 times\)/);
    assert.equal(engine.getTask(t.id)!.reviewAttempts, 0, 'resets are not failed reviews');
    const rebuilt = WorkflowEngine.fromEvents(engine.store.all(), { policy: options.policy, now: options.now });
    assert.deepEqual(rebuilt.listTasks(), engine.listTasks());
  });
});

describe('tool results (M4)', () => {
  const read = (key: string, path = 'README.md') => ({ tool: 'repo.read', input: { path }, idempotencyKey: key });

  test('every allowed call gets one recorded result, and replay keeps it', () => {
    const { engine, options } = makeCompany();
    const { task: t } = startedTask(engine);
    must(engine.requestToolCall(t.id, 'kai', read('k1')));
    assert.deepEqual(engine.pendingToolCalls(), [{ taskId: t.id, tool: 'repo.read', idempotencyKey: 'k1' }]);

    must(engine.recordToolResult(t.id, 'k1', { ok: true, detail: '# Readme', attempts: 1 }));
    const last = engine.store.all().at(-1)!;
    assert.equal(last.type, 'tool.executed');
    assert.deepEqual(last.data, { tool: 'repo.read', idempotencyKey: 'k1', detail: '# Readme', attempts: 1 });
    assert.deepEqual(engine.pendingToolCalls(), []);
    assert.match((engine.recordToolResult(t.id, 'k1', { ok: true, detail: '' }) as any).error, /no open tool call/);

    must(engine.requestToolCall(t.id, 'kai', read('k2', 'b')));
    must(engine.recordToolResult(t.id, 'k2', { ok: false, detail: 'timed out' }));
    assert.equal(engine.store.all().at(-1)!.type, 'tool.failed');

    const rebuilt = WorkflowEngine.fromEvents(engine.store.all(), { policy: options.policy, now: options.now });
    assert.deepEqual(rebuilt.pendingToolCalls(), []);
    assert.deepEqual(rebuilt.listTasks(), engine.listTasks());
  });

  test('only a key the engine allowed for that task can get a result', () => {
    const { engine } = makeCompany();
    const { task: t } = startedTask(engine);
    const { task: other } = startedTask(engine);
    assert.match((engine.recordToolResult(t.id, 'never-allowed', { ok: true, detail: '' }) as any).error, /no open tool call/);
    must(engine.requestToolCall(t.id, 'kai', read('k1')));
    assert.match((engine.recordToolResult(other.id, 'k1', { ok: true, detail: '' }) as any).error, /no open tool call/);
    assert.match((engine.recordToolResult('nope', 'k1', { ok: true, detail: '' }) as any).error, /unknown task/);
    // A denied call has no result to record.
    assert.equal(engine.requestToolCall(t.id, 'kai', { tool: 'prod.deploy', input: {}, idempotencyKey: 'k9' }).ok, false);
    assert.match((engine.recordToolResult(t.id, 'k9', { ok: true, detail: '' }) as any).error, /no open tool call/);
  });

  test('a call that was running when the company stopped or the task moved on still records its result', () => {
    const { engine } = makeCompany();
    const { task: t } = startedTask(engine);
    must(engine.requestToolCall(t.id, 'kai', read('k1')));
    must(engine.pauseCompany());
    must(engine.escalate(t.id, 'CEO stepped in'));
    must(engine.recordToolResult(t.id, 'k1', { ok: true, detail: 'done' }));
  });

  test('an open call is pending whatever its task state, and its result goes to the agent that made it', () => {
    const { engine } = makeCompany();
    const { task: t } = startedTask(engine);
    must(engine.requestToolCall(t.id, 'kai', read('k1')));
    must(engine.escalate(t.id, 'stuck'));
    must(engine.resolveEscalation(t.id, { kind: 'reassign', ownerId: 'omar' }));
    assert.deepEqual(engine.pendingToolCalls(), [{ taskId: t.id, tool: 'repo.read', idempotencyKey: 'k1' }]);
    must(engine.recordToolResult(t.id, 'k1', { ok: false, detail: 'interrupted' }));
    assert.equal(engine.store.all().at(-1)!.agentId, 'kai');
  });

  test('calls allowed before M4 never expected a result, so an upgraded log has nothing pending', () => {
    const { engine, options } = makeCompany();
    const { task: t } = startedTask(engine);
    must(engine.requestToolCall(t.id, 'kai', read('k1')));
    const old = engine.store.all().map((e) => (e.type === 'tool.allowed' ? { ...e, data: { ...e.data, tracked: undefined } } : e));
    const rebuilt = WorkflowEngine.fromEvents(old, { policy: options.policy, now: options.now });
    assert.deepEqual(rebuilt.pendingToolCalls(), []);
    assert.equal(rebuilt.requestToolCall(t.id, 'kai', read('k1')).ok && (rebuilt.requestToolCall(t.id, 'kai', read('k1')) as any).value.kind, 'duplicate', 'the key is still used');
  });

  test('a released action records when it starts, so a crash can tell "never ran" from "interrupted"', () => {
    const { engine, options } = makeCompany();
    const { task: t } = startedTask(engine, { ownerId: 'omar', requiredTools: ['email.send'] });
    const action = { tool: 'email.send', input: {}, idempotencyKey: 'm1' };
    must(engine.submitForReview(t.id, 'omar', { summary: 's', selfCheck: allMet(t.acceptanceCriteria), finalAction: action }));
    must(engine.recordReview(t.id, 'rex', { passed: true, score: 1, feedback: '' }));
    assert.match((engine.recordActionStarted(t.id, 'm1') as any).error, /not done/);
    must(engine.decideApproval(t.id, { approved: true }));
    assert.deepEqual(engine.pendingActions(), [{ taskId: t.id, action }], 'released, not started');
    assert.match((engine.recordActionStarted(t.id, 'other') as any).error, /does not match/);
    must(engine.recordActionStarted(t.id, 'm1'));
    must(engine.recordActionStarted(t.id, 'm1'));
    assert.equal(engine.store.all().filter((e) => e.type === 'action.started').length, 1, 'recorded once');
    assert.deepEqual(engine.pendingActions(), [{ taskId: t.id, action, started: true }]);
    const rebuilt = WorkflowEngine.fromEvents(engine.store.all(), { policy: options.policy, now: options.now });
    assert.deepEqual(rebuilt.pendingActions(), engine.pendingActions());

    // A release from before M4 has no start record: it may have run.
    const old = engine.store.all().filter((e) => e.type !== 'action.started').map((e) => (e.type === 'task.done' ? { ...e, data: { ...e.data, startTracked: undefined } } : e));
    assert.deepEqual(WorkflowEngine.fromEvents(old, { policy: options.policy, now: options.now }).pendingActions(), [{ taskId: t.id, action, started: true }]);
  });

  test('attempts on an action result survive replay', () => {
    const { engine, options } = makeCompany();
    const { task: t } = startedTask(engine, { ownerId: 'omar', requiredTools: ['email.send'] });
    must(engine.submitForReview(t.id, 'omar', { summary: 's', selfCheck: allMet(t.acceptanceCriteria), finalAction: { tool: 'email.send', input: {}, idempotencyKey: 'm1' } }));
    must(engine.recordReview(t.id, 'rex', { passed: true, score: 1, feedback: '' }));
    must(engine.decideApproval(t.id, { approved: true }));
    must(engine.recordActionResult(t.id, 'm1', { ok: true, detail: 'sent', attempts: 2 }));
    const rebuilt = WorkflowEngine.fromEvents(engine.store.all(), { policy: options.policy, now: options.now });
    assert.deepEqual(rebuilt.getTask(t.id)!.actionResult, { ok: true, detail: 'sent', attempts: 2 });
  });
});

describe('agent runtime safety: kill switch, budgets and usage', () => {
  test('while the company is paused no review is recorded and no plan is accepted, so nothing is released', () => {
    const { engine } = makeCompany();
    const { task: t } = startedTask(engine, { requiredTools: ['repo.read', 'github.create_branch'] });
    const action = { tool: 'github.create_branch', input: { name: 'x' }, idempotencyKey: 'branch-1' };
    must(engine.submitForReview(t.id, 'kai', { summary: 'Done', selfCheck: allMet(t.acceptanceCriteria), finalAction: action }));
    must(engine.pauseCompany('stop'));
    assert.match((engine.recordReview(t.id, 'rex', { passed: true, score: 1, feedback: '' }) as any).error, /company is paused/);
    assert.equal(engine.getTask(t.id)!.state, 'review');
    assert.deepEqual(engine.pendingActions(), []);
    const other = must(engine.createGoal('Another', 50_000));
    assert.match((engine.submitPlan(other.id, 'ava', [task()]) as any).error, /company is paused/);
    must(engine.resumeCompany());
    const outcome = must(engine.recordReview(t.id, 'rex', { passed: true, score: 1, feedback: '' }));
    assert.deepEqual(outcome.execute, action);
  });

  test('a paused or benched orchestrator cannot get a plan accepted', () => {
    const { engine } = makeCompany();
    const goal = must(engine.createGoal('Plan me', 50_000));
    must(engine.pauseAgent('ava'));
    assert.match((engine.submitPlan(goal.id, 'ava', [task()]) as any).error, /Ava is paused/);
    must(engine.resumeAgent('ava'));
    must(engine.submitPlan(goal.id, 'ava', [task()]));
  });

  test('an exhausted goal budget also escalates a task waiting in review', () => {
    const { engine } = makeCompany();
    const { goal, task: t } = startedTask(engine, {}, 20_000);
    must(engine.submitForReview(t.id, 'kai', { summary: 'Done', selfCheck: allMet(t.acceptanceCriteria) }));
    must(engine.recordGoalStep(goal.id, 'rex', 25_000));
    assert.equal(engine.getTask(t.id)!.state, 'escalated');
    assert.equal(engine.getTask(t.id)!.escalationReason, 'goal budget exhausted');
  });

  test('tokens of a turn that ends after the task left working are still charged', () => {
    const { engine, options } = makeCompany();
    const { goal, task: t } = startedTask(engine);
    must(engine.recordStep(t.id, 'kai', 1_000));
    must(engine.escalate(t.id, 'CEO stopped it'));
    assert.match((engine.recordStep(t.id, 'kai', 4_000) as any).error, /task is escalated, not working/);
    assert.equal(engine.getTask(t.id)!.tokens, 5_000);
    assert.equal(engine.getTask(t.id)!.steps, 1, 'usage after the task stopped is not a step');
    assert.equal(engine.getGoal(goal.id)!.spentTokens, 5_000);
    assert.equal(engine.store.all().at(-1)!.type, 'task.usage');
    assert.match((engine.recordStep(t.id, 'omar', 1) as any).error, /owner/);
    assert.equal(engine.store.all().at(-1)!.type, 'task.usage', 'only the owner can charge usage');
    const rebuilt = WorkflowEngine.fromEvents(engine.store.all(), { policy: options.policy, now: options.now });
    assert.deepEqual(rebuilt.getTask(t.id), engine.getTask(t.id));
    assert.deepEqual(rebuilt.getGoal(goal.id), engine.getGoal(goal.id));
  });

  test('the stuck timer ignores work stopped by a pause, and resuming restarts the clock', () => {
    const { engine, advance } = makeCompany();
    const { task: t } = startedTask(engine);
    must(engine.pauseCompany('lunch'));
    advance(10 * 60_000);
    assert.deepEqual(engine.checkStuck(), []);
    must(engine.resumeCompany());
    assert.deepEqual(engine.checkStuck(), [], 'resuming gives the task a fresh activity time');
    must(engine.pauseAgent('kai'));
    advance(10 * 60_000);
    assert.deepEqual(engine.checkStuck(), []);
    must(engine.resumeAgent('kai'));
    assert.deepEqual(engine.checkStuck(), []);
    advance(6 * 60_000);
    assert.deepEqual(engine.checkStuck(), [t.id]);
  });

  test('an action approved before executions were recorded (an older log) is not run on upgrade', () => {
    const { engine, options } = makeCompany();
    const { task: t } = startedTask(engine, { ownerId: 'omar', requiredTools: ['email.send'] });
    must(engine.submitForReview(t.id, 'omar', { summary: 'Drafted', selfCheck: allMet(t.acceptanceCriteria), finalAction: { tool: 'email.send', input: {}, idempotencyKey: 'old-mail' } }));
    must(engine.recordReview(t.id, 'rex', { passed: true, score: 1, feedback: '' }));
    must(engine.decideApproval(t.id, { approved: true }));
    assert.equal(engine.pendingActions().length, 1);
    // An M2 log: no artifacts, no actionResult, no release marker.
    const old = engine.store.all().map((e) => {
      if (e.type === 'task.done') return { ...e, data: { summary: e.data!.summary } };
      if (e.type === 'task.submitted') {
        const { artifacts: _a, ...data } = e.data!;
        return { ...e, data };
      }
      if (e.type === 'plan.accepted') {
        return { ...e, data: { tasks: e.data!.tasks.map(({ artifacts: _a, actionResult: _r, ...rest }: any) => rest) } };
      }
      return e;
    });
    const rebuilt = WorkflowEngine.fromEvents(old, { policy: options.policy, now: options.now });
    assert.deepEqual(rebuilt.pendingActions(), []);
    assert.deepEqual(rebuilt.getTask(t.id)!.artifacts, []);
    assert.equal(rebuilt.getTask(t.id)!.actionResult!.ok, false);
    assert.match(rebuilt.getTask(t.id)!.actionResult!.detail, /not executed/);
  });

  test('action.failed replays', () => {
    const { engine, options } = makeCompany();
    const { task: t } = startedTask(engine, { requiredTools: ['repo.read', 'github.create_branch'] });
    must(engine.submitForReview(t.id, 'kai', { summary: 'Done', selfCheck: allMet(t.acceptanceCriteria), finalAction: { tool: 'github.create_branch', input: {}, idempotencyKey: 'b-1' } }));
    must(engine.recordReview(t.id, 'rex', { passed: true, score: 1, feedback: '' }));
    must(engine.recordActionResult(t.id, 'b-1', { ok: false, detail: 'boom' }));
    const rebuilt = WorkflowEngine.fromEvents(engine.store.all(), { policy: options.policy, now: options.now });
    assert.deepEqual(rebuilt.getTask(t.id)!.actionResult, { ok: false, detail: 'boom' });
    assert.deepEqual(rebuilt.pendingActions(), []);
  });
});
