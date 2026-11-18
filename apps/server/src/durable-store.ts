import { InMemoryEventStore, type EventStore } from '@ai-company/core';

/**
 * An EventStore whose appends become durable asynchronously.
 *
 * The engine appends synchronously (commands stay synchronous and
 * deterministic); the server then awaits `flush()` before any result of that
 * command leaves the process — an HTTP response, a WebSocket message or an
 * action for the gateway. So nothing outside the process ever observes an
 * event that a crash could still lose.
 */
export interface DurableEventStore extends EventStore {
  /** Resolves once every event appended so far is durable. Rejects (and stays failed) if a write fails. */
  flush(): Promise<void>;
  /** Highest seq known to be durable. Subscribers are only told about events up to here. */
  readonly durableSeq: number;
  /**
   * Stops all further writes: pending events are dropped, queued and later
   * flushes reject, appends throw. A write already in flight may still commit.
   * Used when memory can no longer be trusted (e.g. a command threw midway).
   */
  abort(err: Error): void;
  /** Called once, as soon as the store fails on its own (write error, lost connection). */
  onFailure(listener: (err: Error) => void): void;
  close(options?: { flush?: boolean }): Promise<void>;
}

/** Memory-only durable store for tests and local demos: everything is "durable" immediately. */
export class MemoryDurableEventStore extends InMemoryEventStore implements DurableEventStore {
  private failure: Error | null = null;

  get durableSeq(): number {
    return this.size;
  }

  override append(event: Parameters<InMemoryEventStore['append']>[0]) {
    if (this.failure) throw new Error(`event store failed: ${this.failure.message}`);
    return super.append(event);
  }

  async flush(): Promise<void> {
    if (this.failure) throw new Error(`event store failed: ${this.failure.message}`);
  }

  abort(err: Error): void {
    this.failure ??= err;
  }

  onFailure(_listener: (err: Error) => void): void {
    // Memory never fails on its own.
  }

  async close(): Promise<void> {}
}
