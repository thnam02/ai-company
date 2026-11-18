import type { ChatMessage } from './model.ts';

/**
 * A worker's conversation for one task, saved after every completed turn
 * (ADR 0003). Working memory, not company state: losing it only means the
 * worker starts the task over from its context pack.
 */
export interface Checkpoint {
  taskId: string;
  agentId: string;
  /** The task's `startedAt`: a restarted or reassigned task begins a new conversation. */
  run: number;
  /** The task's `reviewAttempts` when saved; a higher count means new feedback arrived. */
  attempt: number;
  messages: ChatMessage[];
}

export interface CheckpointStore {
  load(taskId: string, agentId: string): Checkpoint | undefined;
  save(checkpoint: Checkpoint): void;
}

export class MemoryCheckpointStore implements CheckpointStore {
  private readonly checkpoints = new Map<string, Checkpoint>();

  load(taskId: string, agentId: string): Checkpoint | undefined {
    const c = this.checkpoints.get(`${taskId}\u0000${agentId}`);
    return c && structuredClone(c);
  }

  save(checkpoint: Checkpoint): void {
    this.checkpoints.set(`${checkpoint.taskId}\u0000${checkpoint.agentId}`, structuredClone(checkpoint));
  }
}
