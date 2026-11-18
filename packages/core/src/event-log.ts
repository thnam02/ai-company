import type { EngineEvent, NewEvent } from './types.ts';

export type EventListener = (event: EngineEvent) => void;

/**
 * Append-only event store. Current state is always rebuilt from these events,
 * so the store is the single source of truth (and what the 3D office streams).
 *
 * Milestone 2 adds a Postgres implementation of this same interface.
 */
export interface EventStore {
  append(event: NewEvent): EngineEvent;
  all(): readonly EngineEvent[];
  since(seq: number): EngineEvent[];
  subscribe(listener: EventListener): () => void;
  readonly size: number;
}

export class InMemoryEventStore implements EventStore {
  private readonly events: EngineEvent[];
  private readonly listeners = new Set<EventListener>();

  constructor(initial: readonly EngineEvent[] = []) {
    this.events = initial.map((e) => ({ ...e }));
  }

  get size(): number {
    return this.events.length;
  }

  append(event: NewEvent): EngineEvent {
    const stored: EngineEvent = Object.freeze({ ...event, seq: this.events.length + 1 });
    this.events.push(stored);
    for (const listener of this.listeners) {
      try {
        listener(stored);
      } catch {
        // A broken subscriber must never break the write path.
      }
    }
    return stored;
  }

  all(): readonly EngineEvent[] {
    return this.events;
  }

  since(seq: number): EngineEvent[] {
    return this.events.filter((e) => e.seq > seq);
  }

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
