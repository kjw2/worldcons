import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { consumeRateLimit } from "../lib/security/rate-limit";
import { validateProductionSecurityConfig } from "../lib/security/production-config";

const rateLimitMigration = path.join(process.cwd(), "supabase/migrations/20260826500000_distributed_rate_limit.sql");

// A 32-byte machine secret and a human-entered admin password are held to different
// standards, so the admin account needs its own explicit floor.
function productionEnvironment(overrides: Record<string, string> = {}) {
  return {
    NODE_ENV: "production",
    ADMIN_PASSWORD: "sufficiently-long-admin-password",
    ADMIN_SESSION_SECRET: "a".repeat(32),
    CRON_SECRET: "b".repeat(32),
    LLM_SETTINGS_SECRET: "c".repeat(32),
    SUPABASE_SERVICE_ROLE_KEY: "d".repeat(32),
    ...overrides,
  };
}

test("production rejects a short admin password even when machine secrets are strong", () => {
  const short = validateProductionSecurityConfig(productionEnvironment({ ADMIN_PASSWORD: "abc123" }));
  assert.equal(short.ok, false);
  assert.ok(short.errors.some((error) => /ADMIN_PASSWORD must be at least 12 characters/u.test(error)));

  assert.equal(validateProductionSecurityConfig(productionEnvironment()).ok, true);
});

test("production still rejects reused or publicly exposed secrets", () => {
  const reused = validateProductionSecurityConfig(productionEnvironment({ CRON_SECRET: "a".repeat(32) }));
  assert.equal(reused.ok, false);
  assert.ok(reused.errors.some((error) => /must not reuse the same value/u.test(error)));

  const leaked = validateProductionSecurityConfig(
    productionEnvironment({ NEXT_PUBLIC_SUPABASE_SERVICE_ROLE: "d".repeat(32) }),
  );
  assert.equal(leaked.ok, false);
});

function withEnvironment(values: Record<string, string | undefined>, run: () => Promise<void>) {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return run().finally(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test("distributed rate limit migration is atomic, bounded, and service-role-only", () => {
  const sql = fs.readFileSync(rateLimitMigration, "utf8");
  assert.match(sql, /create table if not exists security_rate_limit_buckets_v1/iu);
  assert.match(sql, /primary key \(profile, identifier_hash\)/iu);
  assert.match(sql, /on conflict \(profile, identifier_hash\) do update/iu);
  assert.match(sql, /request_count = case[\s\S]*request_count \+ 1/iu);
  assert.match(sql, /alter table security_rate_limit_buckets_v1 enable row level security/iu);
  assert.match(sql, /revoke all on table security_rate_limit_buckets_v1 from public, anon, authenticated/iu);
  assert.match(sql, /grant execute on function worldcons_consume_rate_limit_v1[\s\S]*to service_role/iu);
  assert.match(sql, /reset_at < v_now - interval '1 day'/iu);
});

test("rate limiter remains available through an explicit local fallback", async () => {
  await withEnvironment({
    RATE_LIMIT_ENABLED: "true",
    RATE_LIMIT_DISTRIBUTED_ENABLED: "false",
    RATE_LIMIT_PUBLIC_API_MAX: "1",
    RATE_LIMIT_PUBLIC_API_WINDOW_MS: "60000",
  }, async () => {
    const uniqueIp = `203.0.113.${Math.floor(Math.random() * 100) + 1}`;
    const request = new Request("https://worldcons.example/api/search", { headers: { "x-forwarded-for": uniqueIp } });
    const first = await consumeRateLimit(request, "publicApi");
    const second = await consumeRateLimit(request, "publicApi");
    assert.equal(first?.limited, false);
    assert.equal(first?.backend, "local");
    assert.equal(new Headers(first?.headers).get("x-ratelimit-backend"), "local");
    assert.equal(second?.limited, true);
    assert.equal(second?.remaining, 0);
    assert.ok((second?.retryAfterSeconds ?? 0) > 0);
  });
});

test("production CSP is enforcing by default and removes unsafe-eval", () => {
  const config = fs.readFileSync(path.join(process.cwd(), "next.config.ts"), "utf8");
  assert.match(config, /cspReportOnly \? "Content-Security-Policy-Report-Only" : "Content-Security-Policy"/u);
  assert.match(config, /productionRuntime \? "" : " 'unsafe-eval'"/u);
  assert.doesNotMatch(config, /script-src 'self' 'unsafe-inline' 'unsafe-eval' https:/u);
  assert.match(config, /report-uri \/api\/security\/csp-report/u);
});

test("anonymous public-schema access remains closed after least-privilege hardening", () => {
  const sql = fs.readFileSync(path.join(process.cwd(), "supabase/migrations/20260731010000_secure_public_data_api.sql"), "utf8");
  assert.match(sql, /revoke all privileges on all tables in schema public[\s\S]*from public, anon, authenticated/iu);
  assert.match(sql, /revoke all privileges on all routines in schema public[\s\S]*from public, anon, authenticated/iu);
});
