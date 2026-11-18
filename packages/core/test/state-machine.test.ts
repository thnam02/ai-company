import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canTransition, isTerminal, TRANSITIONS } from '../src/state-machine.ts';

test('happy path transitions are legal', () => {
  assert.ok(canTransition('planned', 'assigned'));
  assert.ok(canTransition('assigned', 'working'));
  assert.ok(canTransition('working', 'review'));
  assert.ok(canTransition('review', 'done'));
  assert.ok(canTransition('review', 'awaiting_approval'));
  assert.ok(canTransition('awaiting_approval', 'done'));
});

test('shortcuts around review are illegal', () => {
  assert.equal(canTransition('working', 'done'), false);
  assert.equal(canTransition('assigned', 'review'), false);
  assert.equal(canTransition('working', 'awaiting_approval'), false);
});

test('terminal states have no exits', () => {
  assert.ok(isTerminal('done'));
  assert.ok(isTerminal('cancelled'));
  assert.deepEqual(TRANSITIONS.done, []);
  assert.deepEqual(TRANSITIONS.cancelled, []);
});

test('escalated tasks can only be reassigned or cancelled', () => {
  assert.deepEqual([...TRANSITIONS.escalated].sort(), ['assigned', 'cancelled']);
});
