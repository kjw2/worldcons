import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  M13_AUTHORITY_PROFILE_ENV,
  M13_AUTHORITY_ASSIGNMENTS,
} from "@/lib/cloudflare/m13/authority-profile";

const root = process.cwd();
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

test("M13 profile is wired into the production Worker entry", () => {
  const source = read("worker/index.ts");
  assert.match(source, /applyM13AuthorityProfileToEnvironment/u);
  assert.match(source, /const authorityEnv = applyM13AuthorityProfileToEnvironment/u);
  assert.match(source, /WORLDCONS_M13_AUTHORITY_PROFILE\?: string/u);
  // Every selector must read the M13-resolved env, not the raw env.
  for (const marker of [
    "resolveSiteEventsWriteAuthorityConfig(authorityEnv",
    "resolveAdminAuditWriteAuthorityConfig(authorityEnv",
    "resolveAdminArticleEditWriteAuthorityConfig(authorityEnv",
    "resolveOpsHeartbeatReadAuthorityConfig(authorityEnv",
    "resolveAdminOpsEventsWriteAuthorityConfig(authorityEnv",
    "resolveAdminOpsEventsReadAuthorityConfig(authorityEnv",
    "resolveCoreWriteAuthorityConfig(authorityEnv",
    "resolveRateLimitAuthorityConfig(authorityEnv",
  ]) {
    assert.ok(source.includes(marker), `worker/index.ts must resolve via the M13 env: ${marker}`);
  }
  assert.doesNotMatch(source, /resolveCoreWriteAuthorityConfig\(env as/u, "the raw env must not bypass the M13 profile");
});

test("M13 profile is wired into the ops-write boundary Worker", () => {
  const source = read("workers/ops-write/src/index.ts");
  assert.match(source, /applyM13AuthorityProfileToEnvironment/u);
  assert.match(source, /const authorityEnv = applyM13AuthorityProfileToEnvironment/u);
  assert.match(source, /WORLDCONS_M13_AUTHORITY_PROFILE\?: string/u);
  assert.match(source, /handleOpsHeartbeatBoundary\(request, authorityEnv\)/u);
});

test("M13 profile var rests at supabase in both Worker configs", () => {
  assert.match(read("wrangler.jsonc"), /"WORLDCONS_M13_AUTHORITY_PROFILE": "supabase"/u);
  assert.match(read("workers/ops-write/wrangler.jsonc"), /"WORLDCONS_M13_AUTHORITY_PROFILE": "supabase"/u);
});

test("M13 rate-limit Worker binding, DO export and wrangler migration are wired", () => {
  const worker = read("worker/index.ts");
  assert.match(worker, /WORLDCONS_RATE_LIMIT\?: DurableObjectNamespaceLike/u);
  assert.match(worker, /setRuntimeRateLimitDurableObjectBinding\(env\.WORLDCONS_RATE_LIMIT\)/u);
  assert.match(worker, /resolveRateLimitAuthorityConfig\(authorityEnv/u);
  assert.match(worker, /export \{ RateLimitBucketDurableObject \}/u);

  const wrangler = read("wrangler.jsonc");
  assert.match(wrangler, /"name": "WORLDCONS_RATE_LIMIT"/u);
  assert.match(wrangler, /"class_name": "RateLimitBucketDurableObject"/u);
  assert.match(wrangler, /"new_sqlite_classes": \["RateLimitBucketDurableObject"\]/u);
  assert.match(wrangler, /"WORLDCONS_RATE_LIMIT_AUTHORITY": "supabase"/u);

  const durable = read("lib/cloudflare/rate-limit/durable-object.ts");
  assert.match(durable, /export class RateLimitBucketDurableObject/u);
  assert.match(durable, /async consume\(/u);
});

test("M13 profile var is declared in the generated ops-write Worker types", () => {
  const types = read("workers/ops-write/worker-configuration.d.ts");
  assert.match(types, /WORLDCONS_M13_AUTHORITY_PROFILE: string/u);
});

test("every M13 assignment names a selector owned by an existing M11 domain", () => {
  const envVars = M13_AUTHORITY_ASSIGNMENTS.map((assignment) => assignment.envVar);
  assert.equal(new Set(envVars).size, envVars.length, "no duplicate selector");
  for (const envVar of envVars) {
    assert.match(envVar, /^WORLDCONS_[A-Z0-9_]+_AUTHORITY$/u, envVar);
  }
  assert.ok(envVars.includes("WORLDCONS_CORE_WRITE_AUTHORITY"));
  assert.ok(envVars.includes("WORLDCONS_INGEST_RUN_WRITE_AUTHORITY"));
});

test("the migration plan documents the single M13 authority profile", () => {
  const plan = read("docs/worldcons-cloudflare-full-migration-plan-20260920.md");
  assert.match(plan, new RegExp(M13_AUTHORITY_PROFILE_ENV, "u"));
  assert.match(plan, /pnpm m13:readiness/u);
  assert.match(plan, /pnpm test:m13/u);
});
