import type { TaskState } from './types.ts';

/**
 * The only legal task transitions. Guards (who may trigger a transition and
 * when) live in the WorkflowEngine; this table is the hard outer fence.
 */
export const TRANSITIONS: Readonly<Record<TaskState, readonly TaskState[]>> = {
  planned: ['assigned', 'escalated', 'cancelled'],
  assigned: ['working', 'escalated', 'cancelled'],
  working: ['review', 'escalated', 'cancelled'],
  review: ['working', 'done', 'awaiting_approval', 'escalated', 'cancelled'],
  awaiting_approval: ['done', 'working', 'escalated', 'cancelled'],
  escalated: ['assigned', 'cancelled'],
  done: [],
  cancelled: [],
};

export const TERMINAL_STATES: readonly TaskState[] = ['done', 'cancelled'];

export function canTransition(from: TaskState, to: TaskState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isTerminal(state: TaskState): boolean {
  return TERMINAL_STATES.includes(state);
}
