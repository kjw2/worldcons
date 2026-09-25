/**
 * Runtime-neutral Worker background scheduler.
 *
 * Cloudflare Workers expose `ctx.waitUntil(promise)` so background work can
 * outlive the response. Application code must not reference a Worker `ctx`
 * directly: it asks this module for the isolate-scoped scheduler instead. When
 * no scheduler is registered (Node, tests, a host without `waitUntil`) the
 * shadow seam must SKIP background work rather than synchronously await it, so
 * the authoritative response is never blocked or delayed.
 *
 * This module imports no Node builtin and no Cloudflare type.
 */
export interface RuntimeBackgroundScheduler {
  /** Starts a background task. Returns false when the task cannot be accepted. */
  schedule(task: Promise<unknown>): boolean;
}

/** The structural `ctx.waitUntil` surface the Worker entry passes in. */
export interface RuntimeWaitUntilContext {
  waitUntil?(promise: Promise<unknown>): void;
}

interface WorldconsBackgroundGlobal {
  __worldconsBackgroundSchedulerV1?: RuntimeBackgroundScheduler;
}

function runtimeGlobal(): typeof globalThis & WorldconsBackgroundGlobal {
  return globalThis as typeof globalThis & WorldconsBackgroundGlobal;
}

export function setRuntimeBackgroundScheduler(scheduler: RuntimeBackgroundScheduler | null): void {
  const target = runtimeGlobal();
  if (scheduler) target.__worldconsBackgroundSchedulerV1 = scheduler;
  else delete target.__worldconsBackgroundSchedulerV1;
}

export function runtimeBackgroundScheduler(): RuntimeBackgroundScheduler | null {
  return runtimeGlobal().__worldconsBackgroundSchedulerV1 ?? null;
}

/**
 * Wraps a Worker execution context's `waitUntil`. It fails closed: a context
 * without a usable `waitUntil` yields a scheduler whose `schedule` returns
 * false, so callers skip background work instead of throwing.
 */
export function createWaitUntilBackgroundScheduler(
  context: RuntimeWaitUntilContext | null | undefined,
): RuntimeBackgroundScheduler {
  const waitUntil = context?.waitUntil;
  if (typeof waitUntil !== "function") {
    return { schedule: () => false };
  }
  return {
    schedule(task: Promise<unknown>): boolean {
      try {
        waitUntil.call(context, task);
        return true;
      } catch {
        return false;
      }
    },
  };
}
