/**
 * In-isolate fixed-window guard for the hot public archive path.
 *
 * This is the Worker-level fallback when WAF rate limiting is not available
 * (for example a `workers.dev` hostname with no customer-managed zone). It is
 * deliberately cheap and approximate: one counter per `path + client IP` in
 * isolate memory, never a D1 or Durable Object round trip. The edge cache is the
 * primary cost control; this guard stops a single client from forcing origin
 * renders that miss the cache.
 */

export interface FixedWindowState {
  count: number;
  resetAt: number;
}

export interface FixedWindowDecision {
  allowed: boolean;
  state: FixedWindowState;
  retryAfterSeconds: number;
}

export function consumeFixedWindow(
  previous: FixedWindowState | undefined,
  limit: number,
  windowMs: number,
  nowMs: number,
): FixedWindowDecision {
  const resetAt = previous && previous.resetAt > nowMs ? previous.resetAt : nowMs + windowMs;
  const count = previous && previous.resetAt > nowMs ? previous.count + 1 : 1;
  return {
    allowed: count <= limit,
    state: { count, resetAt },
    retryAfterSeconds: Math.max(1, Math.ceil((resetAt - nowMs) / 1000)),
  };
}

export interface PublicRateLimitStore {
  get(key: string): FixedWindowState | undefined;
  set(key: string, state: FixedWindowState): void;
  delete(key: string): void;
}

export function createPublicRateLimitStore(): PublicRateLimitStore {
  return new Map<string, FixedWindowState>();
}

/**
 * Prunes expired keys so a bot rotating addresses cannot grow the map without
 * bound. Called opportunistically from the request path.
 */
export function pruneExpiredRateLimitEntries(
  store: PublicRateLimitStore,
  nowMs: number,
  maximumEntries = 5_000,
): void {
  if (maximumEntries <= 0) return;
  const maybeMap = store as unknown as Map<string, FixedWindowState>;
  if (typeof maybeMap.forEach !== "function" || maybeMap.size <= maximumEntries) return;
  for (const [key, state] of maybeMap) {
    if (state.resetAt <= nowMs) maybeMap.delete(key);
  }
}

export function publicRateLimitKey(pathname: string, clientAddress: string): string {
  return `${pathname}:${clientAddress || "unknown"}`;
}
