import {
  assertRateLimitIdentity,
  assertRateLimitConsumeInput,
  consumeRateLimitBucket,
  type RateLimitBucketState,
  type RateLimitConsumeOutcome,
} from "@/lib/cloudflare/rate-limit/bucket";

/**
 * M13 Cloudflare Durable Object hot-path rate limiter.
 *
 * One object per `profile + identifier` bucket (the caller derives the object
 * name from the same stable key), so consumption is atomic and sequential within
 * a bucket. The class is intentionally runtime-neutral: it imports no `node:*`,
 * `next/*` or `cloudflare:workers` symbol and relies only on the structural
 * Worker globals (`Request`, `Response`), so it can be typechecked by the base
 * repository and exported by the Worker entry.
 *
 * State is persisted under a single storage key and an alarm is scheduled at the
 * window boundary to delete stale state. Inputs are validated fail-closed before
 * any storage mutation.
 */

export const RATE_LIMIT_DO_CONSUME_PATH = "/consume";
const STATE_KEY = "bucket";

interface DurableObjectStorageLike {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T = unknown>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  setAlarm?(scheduledTime: number): Promise<void>;
}

export interface RateLimitDurableObjectStateLike {
  storage: DurableObjectStorageLike;
}

export interface RateLimitDurableObjectEnvLike {
  [key: string]: unknown;
}

interface RateLimitConsumeRequestBody {
  profile: string;
  identifier: string;
  limit: number;
  windowMs: number;
  nowMs?: number;
}

function parseBucketState(value: unknown): RateLimitBucketState | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const count = record.count;
  const resetAt = record.resetAt;
  if (!Number.isSafeInteger(count) || typeof resetAt !== "number" || !Number.isFinite(resetAt)) return null;
  return { count: count as number, resetAt };
}

function jsonError(code: string, status = 400): Response {
  return Response.json({ error: code }, { status, headers: { "cache-control": "no-store" } });
}

export class RateLimitBucketDurableObject {
  readonly #storage: DurableObjectStorageLike;
  #loaded: Promise<void> | null = null;
  #state: RateLimitBucketState | null = null;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(ctx: RateLimitDurableObjectStateLike, _env: RateLimitDurableObjectEnvLike = {}) {
    this.#storage = ctx.storage;
  }

  async #ensureLoaded(): Promise<void> {
    if (!this.#loaded) {
      this.#loaded = this.#storage.get(STATE_KEY).then((value) => {
        this.#state = parseBucketState(value);
      });
    }
    return this.#loaded;
  }

  /** Serialized consumption so concurrent requests to one bucket are atomic. */
  async consume(input: RateLimitConsumeRequestBody): Promise<RateLimitConsumeOutcome> {
    const run = async (): Promise<RateLimitConsumeOutcome> => {
      await this.#ensureLoaded();
      const nowMs = Number.isSafeInteger(input.nowMs) ? (input.nowMs as number) : Date.now();
      assertRateLimitIdentity(input.profile, input.identifier);
      assertRateLimitConsumeInput(input.limit, input.windowMs, nowMs);
      const outcome = consumeRateLimitBucket(this.#state, input.limit, input.windowMs, nowMs);
      this.#state = { count: outcome.count, resetAt: outcome.resetAt };
      await this.#storage.put(STATE_KEY, this.#state);
      await this.#scheduleCleanup(outcome.resetAt);
      return outcome;
    };
    const result = this.#queue.then(run, run);
    this.#queue = result.then(() => undefined, () => undefined);
    return result;
  }

  async #scheduleCleanup(resetAt: number): Promise<void> {
    if (typeof this.#storage.setAlarm === "function") {
      await this.#storage.setAlarm(resetAt);
    }
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") return jsonError("method_not_allowed", 405);
    let body: RateLimitConsumeRequestBody;
    try {
      const parsed = await request.json();
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return jsonError("invalid_request");
      body = parsed as RateLimitConsumeRequestBody;
    } catch {
      return jsonError("invalid_request");
    }
    try {
      const outcome = await this.consume(body);
      return Response.json(outcome, { headers: { "cache-control": "no-store" } });
    } catch (error) {
      return jsonError(error instanceof Error ? error.message : "rate_limit_backend.invalid", 422);
    }
  }

  /** Deletes expired state so a dormant bucket does not retain storage forever. */
  async alarm(): Promise<void> {
    await this.#ensureLoaded();
    if (!this.#state || this.#state.resetAt <= Date.now()) {
      await this.#storage.delete(STATE_KEY);
      this.#state = null;
    } else {
      await this.#scheduleCleanup(this.#state.resetAt);
    }
  }
}
