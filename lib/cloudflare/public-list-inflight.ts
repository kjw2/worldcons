/**
 * Bounded, isolate-local coalescing for concurrent public `/list` cache misses.
 *
 * Cloudflare may run many simultaneous requests in one isolate. When they all
 * miss the same public edge-cache key, each one would otherwise render the page
 * and run the same bounded D1 reads. This module lets exactly one request become
 * the leader for a key; the other requests wait for its cacheable result and
 * build their own response body from a buffered snapshot.
 *
 * Safety properties:
 *
 * - the entry is keyed by the already-canonicalized public edge-cache key, so
 *   only requests that the guard classifies as cacheable can ever participate;
 * - a leader may publish `null`, meaning "do not share this response" (for
 *   example a non-HTML or `set-cookie` response). Waiters then fall back to their
 *   own origin read instead of receiving an unsafe response;
 * - every participant receives its own `Response` over a fresh body copy, so a
 *   body is never consumed twice and no stream is teed to an unread branch;
 * - the map is bounded by key count and by waiters per key, and a waiter stops
 *   waiting after a bounded timeout;
 * - the entry is removed as soon as it settles, including on failure, so a
 *   failed leader cannot strand the key.
 */

export interface PublicListInflightSnapshot {
  readonly body: ArrayBuffer;
  readonly status: number;
  readonly statusText: string;
  readonly headers: ReadonlyArray<[string, string]>;
}

export interface PublicListInflightLeader {
  readonly role: "leader";
  /** Publishes the shared snapshot, or `null` when the response must not be shared. */
  settle(snapshot: PublicListInflightSnapshot | null): void;
}

export interface PublicListInflightFollower {
  readonly role: "follower";
  readonly result: Promise<PublicListInflightSnapshot | null>;
}

export interface PublicListInflightBypass {
  readonly role: "bypass";
}

export type PublicListInflightJoin =
  | PublicListInflightLeader
  | PublicListInflightFollower
  | PublicListInflightBypass;

export interface PublicListInflightOptions {
  /** Maximum distinct keys being produced at once across the isolate. */
  maxKeys?: number;
  /** Maximum waiters attached to one key (the leader is not counted). */
  maxWaitersPerKey?: number;
  /** A waiter falls back to its own origin read after this many milliseconds. */
  maxWaitMs?: number;
}

export interface PublicListInflight {
  join(key: string): PublicListInflightJoin;
  /** Distinct keys currently producing a response. Exposed for tests/metrics. */
  size(): number;
}

export const PUBLIC_LIST_INFLIGHT_MAX_KEYS = 32;
export const PUBLIC_LIST_INFLIGHT_MAX_WAITERS = 8;
export const PUBLIC_LIST_INFLIGHT_MAX_WAIT_MS = 10_000;
/**
 * Largest response body kept in isolate memory for sharing. A page beyond this
 * is still served and cached, but it is not fanned out to concurrent waiters.
 */
export const PUBLIC_LIST_INFLIGHT_MAX_BODY_BYTES = 1_000_000;

interface InflightEntry {
  readonly promise: Promise<PublicListInflightSnapshot | null>;
  readonly resolve: (snapshot: PublicListInflightSnapshot | null) => void;
  waiters: number;
  settled: boolean;
}

function waitWithTimeout(
  promise: Promise<PublicListInflightSnapshot | null>,
  timeoutMs: number,
): Promise<PublicListInflightSnapshot | null> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  return new Promise((resolve) => {
    let finished = false;
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      resolve(null);
    }, timeoutMs);
    const finish = (snapshot: PublicListInflightSnapshot | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve(snapshot);
    };
    promise.then(finish, () => finish(null));
  });
}

export function createPublicListInflight(
  options: PublicListInflightOptions = {},
): PublicListInflight {
  const maxKeys = Math.max(1, Math.floor(options.maxKeys ?? PUBLIC_LIST_INFLIGHT_MAX_KEYS));
  const maxWaitersPerKey = Math.max(
    0,
    Math.floor(options.maxWaitersPerKey ?? PUBLIC_LIST_INFLIGHT_MAX_WAITERS),
  );
  const maxWaitMs = Math.max(0, Math.floor(options.maxWaitMs ?? PUBLIC_LIST_INFLIGHT_MAX_WAIT_MS));
  const entries = new Map<string, InflightEntry>();

  return {
    join(key: string): PublicListInflightJoin {
      const existing = entries.get(key);
      if (existing) {
        if (existing.settled || existing.waiters >= maxWaitersPerKey) {
          return { role: "bypass" };
        }
        existing.waiters += 1;
        return {
          role: "follower",
          result: waitWithTimeout(existing.promise, maxWaitMs),
        };
      }

      if (entries.size >= maxKeys) return { role: "bypass" };

      let resolve!: (snapshot: PublicListInflightSnapshot | null) => void;
      const promise = new Promise<PublicListInflightSnapshot | null>((done) => {
        resolve = done;
      });
      const entry: InflightEntry = { promise, resolve, waiters: 0, settled: false };
      entries.set(key, entry);

      return {
        role: "leader",
        settle(snapshot: PublicListInflightSnapshot | null) {
          if (entry.settled) return;
          entry.settled = true;
          entries.delete(key);
          resolve(snapshot);
        },
      };
    },

    size(): number {
      return entries.size;
    },
  };
}

/** The isolate-wide registry used by the Worker guard. */
export const publicListInflight: PublicListInflight = createPublicListInflight();
