import type { EngineEvent, EventListener, NewEvent } from '@ai-company/core';
import type { DurableEventStore } from './durable-store.ts';

/**
 * The in-memory half shared by the database-backed stores.
 *
 * The whole log lives in memory so the engine can rebuild and append
 * synchronously. `append` adds to memory and to `pending`; the subclass's
 * `flush` writes `pending` to the database in one transaction and then calls
 * `committed`, which advances `durableSeq` and tells subscribers. A failed
 * write poisons the store: memory may now be ahead of the database, so the
 * only safe move is to restart and rebuild from the log.
 */
export abstract class BufferedEventStore implements DurableEventStore {
  protected readonly events: EngineEvent[];
  protected pending: EngineEvent[] = [];
  protected failure: Error | null = null;
  protected closed = false;
  private durable: number;
  private readonly listeners = new Set<EventListener>();
  private readonly failureListeners: ((err: Error) => void)[] = [];

  protected constructor(events: EngineEvent[]) {
    events.forEach((e, i) => {
      if (e.seq !== i + 1) throw new Error(`gap in event log: expected seq ${i + 1}, found ${e.seq}`);
    });
    this.events = events;
    this.durable = events.length;
  }

  abstract flush(): Promise<void>;
  abstract close(options?: { flush?: boolean }): Promise<void>;

  get size(): number {
    return this.events.length;
  }

  get durableSeq(): number {
    return this.durable;
  }

  append(event: NewEvent): EngineEvent {
    this.assertWritable();
    if (this.closed) throw new Error('event store is closed');
    const stored: EngineEvent = Object.freeze({ ...event, seq: this.events.length + 1 });
    this.events.push(stored);
    this.pending.push(stored);
    return stored;
  }

  all(): readonly EngineEvent[] {
    return this.events;
  }

  since(seq: number): EngineEvent[] {
    return this.events.slice(Math.max(0, Math.floor(seq)));
  }

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  abort(err: Error): void {
    this.pending = [];
    this.fail(err);
  }

  onFailure(listener: (err: Error) => void): void {
    this.failureListeners.push(listener);
  }

  protected assertWritable(): void {
    if (this.failure) throw new Error(`event store failed: ${this.failure.message}`);
  }

  protected fail(err: unknown): Error {
    if (!this.failure) {
      this.failure = err instanceof Error ? err : new Error(String(err));
      for (const listener of this.failureListeners) {
        try {
          listener(this.failure);
        } catch {
          // Listeners must not break failure handling.
        }
      }
    }
    return this.failure;
  }

  /** Takes the events waiting to be written; they belong to the caller's transaction now. */
  protected takePending(): EngineEvent[] {
    const batch = this.pending;
    this.pending = [];
    return batch;
  }

  /** Call only after `batch` has committed: marks it durable and tells subscribers. */
  protected committed(batch: EngineEvent[]): void {
    if (batch.length === 0) return;
    this.durable = batch[batch.length - 1].seq;
    for (const event of batch) {
      for (const listener of this.listeners) {
        try {
          listener(event);
        } catch {
          // A broken subscriber must never break the write path.
        }
      }
    }
  }
}
