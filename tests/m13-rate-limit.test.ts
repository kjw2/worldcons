import assert from "node:assert/strict";
import test from "node:test";
import { consumeRateLimit } from "@/lib/security/rate-limit";
import {
  resolveRateLimitAuthorityConfig,
  setRuntimeRateLimitAuthorityConfig,
} from "@/lib/cloudflare/rate-limit/authority";
import {
  assertRateLimitConsumeInput,
  consumeRateLimitBucket,
} from "@/lib/cloudflare/rate-limit/bucket";
import { consumeRateLimitInD1 } from "@/lib/cloudflare/rate-limit/d1-backend";
import { RateLimitBucketDurableObject } from "@/lib/cloudflare/rate-limit/durable-object";
import {
  consumeRateLimitViaDurableObject,
  rateLimitBucketObjectName,
  setRuntimeRateLimitClock,
  setRuntimeRateLimitDurableObjectBinding,
  type DurableObjectNamespaceLike,
} from "@/lib/cloudflare/rate-limit/runtime-binding";
import { setRuntimeD1Binding } from "@/lib/cloudflare/d1/runtime-binding";

const RATE_LIMIT_PROFILE = "publicApi";
const RATE_WINDOW_MS = 60_000;

const MANAGED_ENV_KEYS = [
  "RATE_LIMIT_ENABLED",
  "RATE_LIMIT_PUBLIC_API_MAX",
  "RATE_LIMIT_PUBLIC_API_WINDOW_MS",
  "RATE_LIMIT_DISTRIBUTED_ENABLED",
  "WORLDCONS_M13_AUTHORITY_PROFILE",
  "WORLDCONS_RATE_LIMIT_AUTHORITY",
  "SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
] as const;

/** Snapshot/restore the env keys this suite mutates. */
class ResetEnvironment {
  #snapshot: Record<string, string | undefined> = Object.fromEntries(
    MANAGED_ENV_KEYS.map((key) => [key, process.env[key]]),
  );
  restore(): void {
    for (const key of MANAGED_ENV_KEYS) {
      const value = this.#snapshot[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function resetRuntimeSeams() {
  setRuntimeRateLimitAuthorityConfig(null);
  setRuntimeRateLimitDurableObjectBinding(null);
  setRuntimeRateLimitClock(null);
  setRuntimeD1Binding("worldcons_ops", null);
}

/** A minimal in-memory D1 stub whose `RETURNING` mirrors the bucket algorithm. */
function makeD1Stub() {
  const buckets = new Map<string, { count: number; resetAt: number }>();
  return {
    buckets,
    prepare(query: string) {
      assert.match(query, /INSERT INTO security_rate_limit_buckets_v1/u, "must use the v1 schema");
      return {
        bind(profile: string, identifier: string, freshResetIso: string, nowIso: string) {
          void nowIso;
          return {
            async all() {
              const key = `${profile}:${identifier}`;
              const now = Date.parse(nowIso as string);
              const current = buckets.get(key);
              const freshReset = Date.parse(freshResetIso as string);
              const bucket = current && current.resetAt > now
                ? { count: current.count + 1, resetAt: current.resetAt }
                : { count: 1, resetAt: freshReset };
              buckets.set(key, bucket);
              return { success: true, results: [{ request_count: bucket.count, reset_at: new Date(bucket.resetAt).toISOString() }] };
            },
          };
        },
      };
    },
  };
}

function makeDurableObjectBinding(handler?: (name: string) => Promise<Response> | Response): DurableObjectNamespaceLike {
  return {
    idFromName(name: string) {
      return { toString: () => name };
    },
    get(id) {
      return {
        fetch(request: Request) {
          if (handler) return Promise.resolve(handler(id.toString()));
          return Promise.reject(new Error("do_unavailable"));
        },
      };
    },
  };
}

test("M13 rate-limit authority selector defaults to supabase and the d1 profile overrides it", () => {
  assert.equal(resolveRateLimitAuthorityConfig({}).authority, "supabase");
  assert.equal(resolveRateLimitAuthorityConfig({ WORLDCONS_M13_AUTHORITY_PROFILE: "d1" }).authority, "d1");
  assert.equal(resolveRateLimitAuthorityConfig({ WORLDCONS_RATE_LIMIT_AUTHORITY: "d1" }).authority, "d1");
  // Exact values only; a lookalike is rejected.
  assert.equal(resolveRateLimitAuthorityConfig({ WORLDCONS_RATE_LIMIT_AUTHORITY: "d1-canary" }).authority, "supabase");
});

test("resting supabase authority path is unchanged and never touches Cloudflare", async () => {
  const restore = new ResetEnvironment();
  try {
    process.env.RATE_LIMIT_ENABLED = "true";
    process.env.RATE_LIMIT_PUBLIC_API_MAX = "1";
    process.env.RATE_LIMIT_PUBLIC_API_WINDOW_MS = String(RATE_WINDOW_MS);
    process.env.RATE_LIMIT_DISTRIBUTED_ENABLED = "false";
    delete process.env.WORLDCONS_M13_AUTHORITY_PROFILE;
    delete process.env.WORLDCONS_RATE_LIMIT_AUTHORITY;

    // A DO binding and D1 binding are present, but the selector is decisive.
    setRuntimeRateLimitAuthorityConfig(null);
    setRuntimeRateLimitDurableObjectBinding(makeDurableObjectBinding(() => {
      throw new Error("supabase mode must not call the Durable Object");
    }));
    setRuntimeD1Binding("worldcons_ops", makeD1Stub() as never);

    const request = new Request("https://worldcons.example/api/search", { headers: { "x-forwarded-for": "203.0.113.10" } });
    const first = await consumeRateLimit(request, RATE_LIMIT_PROFILE);
    assert.equal(first?.backend, "local", "supabase resting mode resolves to the legacy/local path");
  } finally {
    restore.restore();
    resetRuntimeSeams();
  }
});

test("d1 mode uses the Durable Object first and never calls Supabase", async () => {
  const restore = new ResetEnvironment();
  try {
    process.env.RATE_LIMIT_ENABLED = "true";
    process.env.RATE_LIMIT_PUBLIC_API_MAX = "2";
    process.env.RATE_LIMIT_PUBLIC_API_WINDOW_MS = String(RATE_WINDOW_MS);
    delete process.env.SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;

    setRuntimeRateLimitAuthorityConfig({ authority: "d1" });
    setRuntimeRateLimitClock(() => 1_000_000);
    let doCalls = 0;
    setRuntimeRateLimitDurableObjectBinding(makeDurableObjectBinding(() => {
      doCalls += 1;
      return Response.json({ count: doCalls, resetAt: 1_000_000 + RATE_WINDOW_MS, limited: false, remaining: 2 - doCalls, retryAfterSeconds: 0 });
    }));

    const request = new Request("https://worldcons.example/api/search", { headers: { "x-forwarded-for": "203.0.113.11" } });
    const first = await consumeRateLimit(request, RATE_LIMIT_PROFILE);
    assert.equal(first?.backend, "distributed");
    assert.equal(doCalls, 1);
    assert.equal(first?.limit, 2);
  } finally {
    restore.restore();
    resetRuntimeSeams();
  }
});

test("DO failure falls back to worldcons_ops D1", async () => {
  const restore = new ResetEnvironment();
  try {
    process.env.RATE_LIMIT_ENABLED = "true";
    process.env.RATE_LIMIT_PUBLIC_API_MAX = "1";
    process.env.RATE_LIMIT_PUBLIC_API_WINDOW_MS = String(RATE_WINDOW_MS);

    setRuntimeRateLimitAuthorityConfig({ authority: "d1" });
    setRuntimeRateLimitClock(() => 2_000_000);
    setRuntimeRateLimitDurableObjectBinding(makeDurableObjectBinding(() => { throw new Error("do_error"); }));
    const d1 = makeD1Stub();
    setRuntimeD1Binding("worldcons_ops", d1 as never);

    const request = new Request("https://worldcons.example/api/search", { headers: { "x-forwarded-for": "203.0.113.12" } });
    const result = await consumeRateLimit(request, RATE_LIMIT_PROFILE);
    assert.equal(result?.backend, "distributed");
    assert.equal(d1.buckets.size, 1, "the D1 fallback consumed the bucket");
  } finally {
    restore.restore();
    resetRuntimeSeams();
  }
});

test("d1 authority with DO and D1 both failing falls back to local and never calls Supabase", async () => {
  const restore = new ResetEnvironment();
  const originalFetch = globalThis.fetch;
  try {
    process.env.RATE_LIMIT_ENABLED = "true";
    process.env.RATE_LIMIT_PUBLIC_API_MAX = "5";
    process.env.RATE_LIMIT_PUBLIC_API_WINDOW_MS = String(RATE_WINDOW_MS);
    // Make getSupabaseAdmin() resolvable so a leaked call would actually
    // attempt a Supabase network request. The forbidden request is observed
    // below via the fetch spy.
    process.env.SUPABASE_URL = "https://rate-limit-forbidden.test.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
    process.env.RATE_LIMIT_DISTRIBUTED_ENABLED = "true";

    let supabaseCalls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input).includes("supabase")) {
        supabaseCalls += 1;
        throw new Error("d1 authority must never call Supabase");
      }
      return new Response(null, { status: 500 });
    }) as typeof fetch;

    setRuntimeRateLimitAuthorityConfig({ authority: "d1" });
    // DO binding is present but errors; D1 binding is present but errors.
    setRuntimeRateLimitDurableObjectBinding(makeDurableObjectBinding(() => { throw new Error("do_error"); }));
    setRuntimeD1Binding("worldcons_ops", {
      prepare() {
        return { bind() { return { async all() { throw new Error("d1_error"); } }; } };
      },
    } as never);

    const request = new Request("https://worldcons.example/api/search", { headers: { "x-forwarded-for": "203.0.113.13" } });
    const result = await consumeRateLimit(request, RATE_LIMIT_PROFILE);
    assert.equal(result?.backend, "local", "both distributed backends failing falls back to the process-local limiter");
    assert.equal(supabaseCalls, 0, "d1 authority must never reach getSupabaseAdmin/worldcons_consume_rate_limit_v1");
  } finally {
    globalThis.fetch = originalFetch;
    restore.restore();
    resetRuntimeSeams();
  }
});

test("bucket reset/increment/limited semantics match the Supabase RPC", () => {
  const window = RATE_WINDOW_MS;
  const t0 = 5_000;
  const first = consumeRateLimitBucket(null, 3, window, t0);
  assert.deepEqual(
    { count: first.count, resetAt: first.resetAt, limited: first.limited, remaining: first.remaining },
    { count: 1, resetAt: t0 + window, limited: false, remaining: 2 },
  );

  const second = consumeRateLimitBucket({ count: 1, resetAt: t0 + window }, 3, window, t0 + 10);
  assert.equal(second.count, 2);
  assert.equal(second.resetAt, t0 + window, "a live window keeps its resetAt");
  assert.equal(second.remaining, 1);

  const fourth = consumeRateLimitBucket({ count: 3, resetAt: t0 + window }, 3, window, t0 + 20);
  assert.equal(fourth.limited, true);
  assert.equal(fourth.remaining, 0);
  assert.ok(fourth.retryAfterSeconds > 0);

  const expired = consumeRateLimitBucket({ count: 99, resetAt: t0 - 1 }, 3, window, t0);
  assert.equal(expired.count, 1, "an expired bucket resets to 1");
  assert.equal(expired.resetAt, t0 + window);
  assert.equal(expired.limited, false);
});

test("invalid consume inputs fail closed", () => {
  assert.throws(() => consumeRateLimitBucket(null, 0, RATE_WINDOW_MS, 1), /rate_limit_backend\.invalid_limit/u);
  assert.throws(() => consumeRateLimitBucket(null, 1, 10, 1), /rate_limit_backend\.invalid_window/u);
  assert.throws(() => assertRateLimitConsumeInput(1, RATE_WINDOW_MS, Number.NaN), /rate_limit_backend\.invalid_clock/u);
});

test("D1 fallback statement is a single atomic upsert and preserves expiry reset", async () => {
  const d1 = makeD1Stub();
  const first = await consumeRateLimitInD1(d1 as never, "publicApi", "hash:abcdefgh", 2, RATE_WINDOW_MS, 1_000);
  assert.equal(first.count, 1);
  const second = await consumeRateLimitInD1(d1 as never, "publicApi", "hash:abcdefgh", 2, RATE_WINDOW_MS, 1_100);
  assert.equal(second.count, 2);
  const third = await consumeRateLimitInD1(d1 as never, "publicApi", "hash:abcdefgh", 2, RATE_WINDOW_MS, 1_200);
  assert.equal(third.limited, true);
  assert.equal(third.remaining, 0);
});

test("DO object name is the stable profile+identifier bucket key", () => {
  assert.equal(rateLimitBucketObjectName("publicApi", "hash:abcdefgh"), "publicApi:hash:abcdefgh");
});

test("consumeRateLimitViaDurableObject returns null on a malformed object response", async () => {
  const binding = makeDurableObjectBinding(() => Response.json({ nonsense: true }));
  const outcome = await consumeRateLimitViaDurableObject(binding, {
    profile: "publicApi",
    identifier: "hash:abcdefgh",
    limit: 2,
    windowMs: RATE_WINDOW_MS,
  });
  assert.equal(outcome, null);
});

function makeDurableObjectStorage() {
  const store = new Map<string, unknown>();
  let alarm: number | null = null;
  return {
    store,
    alarms: { get value() { return alarm; } },
    async get(key: string) { return store.get(key); },
    async put(key: string, value: unknown) { store.set(key, value); },
    async delete(key: string) { return store.delete(key); },
    async setAlarm(time: number) { alarm = time; },
  };
}

test("the Durable Object persists state, increments, limits and garbage-collects on alarm", async () => {
  const storage = makeDurableObjectStorage();
  const object = new RateLimitBucketDurableObject({ storage } as never);
  const body = (nowMs: number) => JSON.stringify({ profile: "publicApi", identifier: "hash:abcdefgh", limit: 2, windowMs: RATE_WINDOW_MS, nowMs });

  const first = await object.fetch(new Request("https://rate-limit.internal/consume", { method: "POST", body: body(1_000) }));
  assert.equal(first.status, 200);
  assert.equal((await first.json() as { count: number }).count, 1);
  assert.equal(storage.store.has("bucket"), true, "state is persisted");
  assert.equal(storage.alarms.value, 1_000 + RATE_WINDOW_MS, "an alarm is scheduled at the window boundary");

  const third = await object.fetch(new Request("https://rate-limit.internal/consume", { method: "POST", body: body(1_100) }));
  const thirdBody = await third.json() as { count: number; limited: boolean; remaining: number; retryAfterSeconds: number };
  assert.equal(thirdBody.count, 2);
  assert.equal(thirdBody.limited, false);
  assert.equal(thirdBody.remaining, 0);

  const limited = await object.fetch(new Request("https://rate-limit.internal/consume", { method: "POST", body: body(1_200) }));
  const limitedBody = await limited.json() as { limited: boolean; remaining: number; retryAfterSeconds: number };
  assert.equal(limitedBody.limited, true);
  assert.equal(limitedBody.remaining, 0);
  assert.ok(limitedBody.retryAfterSeconds > 0);

  await object.alarm();
  assert.equal(storage.store.has("bucket"), false, "the alarm clears stale state");
});

test("the Durable Object rejects invalid inputs fail-closed", async () => {
  const object = new RateLimitBucketDurableObject({ storage: makeDurableObjectStorage() } as never);
  const bad = await object.fetch(new Request("https://rate-limit.internal/consume", {
    method: "POST",
    body: JSON.stringify({ profile: "publicApi", identifier: "hash:abcdefgh", limit: 0, windowMs: RATE_WINDOW_MS }),
  }));
  assert.equal(bad.status, 422);

  const notPost = await object.fetch(new Request("https://rate-limit.internal/consume"));
  assert.equal(notPost.status, 405);
});

test("an invalid rate-limit selector fails closed rather than resting on supabase", () => {
  assert.throws(
    () => resolveRateLimitAuthorityConfig({ WORLDCONS_M13_AUTHORITY_PROFILE: "d1-canary" }),
    /m13_authority_profile\.invalid_authority_profile/u,
  );
});
