/**
 * Per-isolate shadow in-flight bound (M6.1 backpressure).
 *
 * The counter lives on an isolate-scoped `globalThis` slot, NOT on the wrapper
 * instance: `referenceReads()` is called per request, so an instance counter
 * would reset before it could ever exert backpressure. Keyed by surface.
 */
interface WorldconsD1ShadowInFlightGlobal {
  __worldconsD1ShadowInFlightV1?: Map<string, number>;
}

function runtimeGlobal(): typeof globalThis & WorldconsD1ShadowInFlightGlobal {
  return globalThis as typeof globalThis & WorldconsD1ShadowInFlightGlobal;
}

function counters(): Map<string, number> {
  const target = runtimeGlobal();
  if (!target.__worldconsD1ShadowInFlightV1) target.__worldconsD1ShadowInFlightV1 = new Map();
  return target.__worldconsD1ShadowInFlightV1;
}

/** Attempts to reserve one in-flight slot. Returns false at the bound. */
export function acquireShadowSlot(key: string, maxInFlight: number): boolean {
  const map = counters();
  const current = map.get(key) ?? 0;
  if (current >= maxInFlight) return false;
  map.set(key, current + 1);
  return true;
}

export function releaseShadowSlot(key: string): void {
  const map = counters();
  const current = map.get(key) ?? 0;
  if (current <= 1) map.delete(key);
  else map.set(key, current - 1);
}

export function shadowInFlight(key: string): number {
  return counters().get(key) ?? 0;
}

export function resetShadowInFlight(): void {
  runtimeGlobal().__worldconsD1ShadowInFlightV1 = new Map();
}
