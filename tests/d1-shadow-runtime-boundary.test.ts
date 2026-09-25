import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

/**
 * M6.1 runtime-boundary guard: the Worker shadow path must stay free of Node
 * builtins and remote-operator modules, must read D1 (never write), and the
 * Worker entry must wire all four bindings, the `waitUntil` scheduler and the
 * (default-off) shadow config.
 */
const RUNTIME_SAFE_FILES = [
  "lib/cloudflare/d1/runtime-binding.ts",
  "lib/cloudflare/d1/runtime-read.ts",
  "lib/cloudflare/d1/canonical-kind.ts",
  "lib/cloudflare/d1/canonical-values.ts",
  "lib/cloudflare/d1/mapping.ts",
  "lib/cloudflare/d1/types.ts",
  "lib/cloudflare/d1/shadow/config.ts",
  "lib/cloudflare/d1/shadow/events.ts",
  "lib/cloudflare/d1/shadow/digest.ts",
  "lib/cloudflare/d1/shadow/compare.ts",
  "lib/cloudflare/d1/shadow/inflight.ts",
  "lib/cloudflare/d1/shadow/index.ts",
  "lib/cloudflare/d1/schema/index.ts",
  "lib/cloudflare/d1/schema/shared.ts",
  "lib/cloudflare/d1/schema/worldcons-core.ts",
  "lib/cloudflare/d1/schema/worldcons-ingest.ts",
  "lib/cloudflare/d1/schema/worldcons-ops.ts",
  "lib/cloudflare/d1/schema/worldcons-search.ts",
  "lib/cloudflare/d1/schema/ownership.ts",
  "lib/backfill/canonical-json.ts",
  "lib/runtime/background.ts",
  "lib/reference-reads/shared.ts",
  "lib/reference-reads/d1-repository.ts",
  "lib/reference-reads/shadow.ts",
  "lib/article-reads/d1-repository.ts",
  "lib/article-reads/shadow.ts",
];

function source(file: string): string {
  return fs.readFileSync(path.join(process.cwd(), file), "utf8");
}

/** Strips comments so prose in a docblock can never trip a source assertion. */
function code(file: string): string {
  return source(file)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

test("M6.1 runtime-safe files import no Node builtin and no remote-operator module", () => {
  for (const file of RUNTIME_SAFE_FILES) {
    const text = code(file);
    assert.doesNotMatch(text, /from\s+["']node:/, `${file} must not import a node: builtin`);
    assert.doesNotMatch(text, /cloudflare\/d1\/remote/, `${file} must not import the remote operator`);
    assert.doesNotMatch(text, /child_process/, `${file} must stay runtime-safe`);
  }
});

test("the shadow read path only reads: no INSERT/UPDATE/DELETE/UPSERT and only prepare().bind().all()", () => {
  const text = code("lib/cloudflare/d1/runtime-read.ts");
  assert.match(text, /prepare\(sql\)\.bind\(\.\.\.params\)/);
  assert.match(text, /\.all</);
  assert.doesNotMatch(text, /\binsert\s+into\b|\bupdate\s+\w+\s+set\b|\bdelete\s+from\b|\bon\s+conflict\b/i);
  assert.doesNotMatch(text, /\.run\(|\.batch\(/);
  const repository = code("lib/reference-reads/d1-repository.ts");
  assert.doesNotMatch(repository, /\binsert\s+into\b|\bupdate\s+\w+\s+set\b|\bdelete\s+from\b/i);
  const articleRepository = code("lib/article-reads/d1-repository.ts");
  assert.doesNotMatch(articleRepository, /\binsert\s+into\b|\bupdate\s+\w+\s+set\b|\bdelete\s+from\b|\bon\s+conflict\b/i);
  assert.doesNotMatch(articleRepository, /\.run\(|\.batch\(/);
});

test("the shadow comparison uses canonicalJson and a non-crypto digest", () => {
  const compare = code("lib/cloudflare/d1/shadow/compare.ts");
  assert.match(compare, /canonicalJson/);
  assert.match(compare, /shadowDigest/);
  const digest = code("lib/cloudflare/d1/shadow/digest.ts");
  assert.match(digest, /Math\.imul/);
  assert.doesNotMatch(digest, /from\s+["']node:|require\(|createHash|createHmac/);
});

test("runtime revival uses the shared canonical JSON parser, not a private JSON.parse", () => {
  const runtimeRead = code("lib/cloudflare/d1/runtime-read.ts");
  assert.match(runtimeRead, /parseCanonicalJsonText/, "runtime revival must reuse the shared parser");
  assert.doesNotMatch(runtimeRead, /\bJSON\.parse\(/, "runtime revival must not fork its own parser");
});

test("the runtime shadow seam never couples to a Node global", () => {
  for (const file of RUNTIME_SAFE_FILES) {
    const text = code(file);
    assert.doesNotMatch(text, /\bprocess\.env\b|\bglobalThis\.process\b|require\s*\(/, `${file} must not read a Node global`);
  }
});

test("the Worker entry wires all four D1 bindings, the waitUntil scheduler and the shadow config", () => {
  const worker = source("worker/index.ts");
  assert.match(worker, /setRuntimeD1Bindings\(/);
  assert.match(worker, /env\.WORLDCONS_CORE/);
  assert.match(worker, /env\.WORLDCONS_INGEST/);
  assert.match(worker, /env\.WORLDCONS_OPS/);
  assert.match(worker, /env\.WORLDCONS_SEARCH/);
  assert.match(worker, /createWaitUntilBackgroundScheduler\(ctx\)/);
  assert.match(worker, /setRuntimeBackgroundScheduler\(/);
  assert.match(worker, /resolveD1ShadowConfig\(/);
  assert.match(worker, /setRuntimeD1ShadowConfig\(/);
});

test("wrangler.jsonc declares every shadow var with a safe default, all off", () => {
  const config = source("wrangler.jsonc");
  assert.match(config, /"WORLDCONS_D1_SHADOW_READ_ENABLED":\s*"false"/);
  assert.match(config, /"WORLDCONS_D1_SHADOW_COMPARE_ENABLED":\s*"false"/);
  assert.match(config, /"WORLDCONS_D1_SHADOW_SURFACES":\s*"reference"/);
  assert.match(config, /"WORLDCONS_D1_SHADOW_TIMEOUT_MS":\s*"1500"/);
  assert.match(config, /"WORLDCONS_D1_SHADOW_MAX_ROWS":\s*"2000"/);
  assert.match(config, /"WORLDCONS_D1_SHADOW_MAX_IN_FLIGHT":\s*"2"/);
  assert.match(config, /"WORLDCONS_D1_SHADOW_SAMPLE_RATE":\s*"0\.1"/);
});
