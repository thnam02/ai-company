import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PolicyEngine } from '../src/policy.ts';
import type { AgentProfile } from '../src/types.ts';
import { makePolicy, TOOLS } from './helpers.ts';

const worker = (tools: string[], extra: Partial<AgentProfile> = {}): AgentProfile => ({
  id: 'w', name: 'Worker', kind: 'worker', role: 'r', model: 'm', tools, paused: false, benched: false, ...extra,
});

test('tier 0 and 1 tools on the allowlist are allowed', () => {
  const p = makePolicy();
  assert.equal(p.check(worker(['repo.read']), 'repo.read').kind, 'allow');
  assert.equal(p.check(worker(['github.create_branch']), 'github.create_branch').kind, 'allow');
});

test('tools off the allowlist are denied', () => {
  const d = makePolicy().check(worker(['repo.read']), 'github.create_branch');
  assert.equal(d.kind, 'deny');
});

test('unknown tools are denied', () => {
  assert.equal(makePolicy().check(worker(['nope']), 'nope').kind, 'deny');
});

test('tier 2 needs approval unless auto-approved', () => {
  const p = makePolicy();
  assert.equal(p.check(worker(['staging.deploy']), 'staging.deploy').kind, 'allow');
  assert.equal(p.check(worker(['social.schedule_post']), 'social.schedule_post').kind, 'needs_approval');
});

test('tier 3 always needs approval', () => {
  assert.equal(makePolicy().check(worker(['email.send']), 'email.send').kind, 'needs_approval');
});

test('orchestrators and reviewers cannot call real-world tools', () => {
  const p = makePolicy();
  assert.equal(p.check(worker(['repo.read'], { kind: 'orchestrator' }), 'repo.read').kind, 'deny');
  assert.equal(p.check(worker(['repo.read'], { kind: 'reviewer' }), 'repo.read').kind, 'deny');
});

test('paused or benched agents are denied', () => {
  const p = makePolicy();
  assert.equal(p.check(worker(['repo.read'], { paused: true }), 'repo.read').kind, 'deny');
  assert.equal(p.check(worker(['repo.read'], { benched: true }), 'repo.read').kind, 'deny');
});

test('auto-approve list may only name tier-2 tools', () => {
  assert.throws(() => new PolicyEngine({ tools: TOOLS, autoApproveTier2: ['email.send'] }));
});
