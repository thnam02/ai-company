import type { WorkflowEngine } from '@ai-company/core';
import type { CompanyServer } from './app.ts';

export const STUCK_CHECK_INTERVAL_MS = 30_000;

export interface StuckTimerOptions {
  /** The server's command queue, so escalations are durable like any other command. */
  run: CompanyServer['run'];
  engine: WorkflowEngine;
  intervalMs?: number;
  log?: (message: string) => void;
  /** Also run on each tick: automated checks that could not be recorded are retried. */
  alsoEachTick?: () => Promise<void>;
}

/** Calls `engine.checkStuck()` on a timer. Returns a function that stops it. */
export function startStuckTimer(options: StuckTimerOptions): () => void {
  const log = options.log ?? (() => {});
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    options
      .run(() => options.engine.checkStuck())
      .then(async (escalated) => {
        if (escalated.length) log(`stuck check escalated ${escalated.length} task(s): ${escalated.join(', ')}`);
        await options.alsoEachTick?.();
      })
      .catch(() => {
        // A store failure is already fatal through the command queue.
      })
      .finally(() => {
        busy = false;
      });
  }, options.intervalMs ?? STUCK_CHECK_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
