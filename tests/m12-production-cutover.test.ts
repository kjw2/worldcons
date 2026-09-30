import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

function sourceFiles(relativeDir: string): string[] {
  const absolute = path.join(root, relativeDir);
  if (!fs.existsSync(absolute)) return [];
  const entries = fs.readdirSync(absolute, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const relative = path.join(relativeDir, entry.name);
    if (entry.isDirectory()) return sourceFiles(relative);
    return /\.(?:ts|tsx|js|jsx)$/u.test(entry.name) ? [relative] : [];
  });
}

test("M12 production Worker config uses the workers.dev production origin with observability", () => {
  const config = read("wrangler.jsonc");
  assert.match(config, /"name": "worldcons"/u);
  assert.match(config, /"workers_dev": true/u);
  assert.doesNotMatch(config, /"custom_domain": true/u);
  assert.match(config, /"observability": \{/u);
  assert.match(config, /"enabled": true/u);
  assert.match(config, /"preview_urls": false/u);
});

test("M12 production runtime uses the new canonical origin and the proven search binding", () => {
  const config = read("wrangler.jsonc");
  assert.match(config, /"APP_BASE_URL": "https:\/\/worldcons\.cclib\.workers\.dev"/u);
  assert.match(config, /"WORLDCONS_BASE_URL": "https:\/\/worldcons\.cclib\.workers\.dev"/u);
  assert.match(config, /"binding": "WORLDCONS_SEARCH_VECTOR"/u);
  assert.match(config, /"index_name": "worldcons-search"/u);
  assert.match(config, /"ARTIFACT_BLOB_PROVIDER": "r2"/u);
  assert.match(config, /"main": "\.\/worker\/index\.ts"/u);
  assert.doesNotMatch(config, /"no_bundle"/u);
  assert.doesNotMatch(config, /WORLDCONS_SEARCH_SERVICE|"service":\s*"worldcons-search"/u);
  assert.match(config, /"WORLDCONS_CORE_WRITE_AUTHORITY": "d1"/u);
});

test("M12 public production surfaces no longer advertise worldcons.vercel.app", () => {
  const files = [
    "app/api/cclrag2/[...path]/route.ts",
    "app/guide/chatgpt-plugin/page.tsx",
    "lib/admin/command-control-plane/p1-handlers.ts",
    "lib/chatgpt-plugin/case-service.ts",
    "lib/crawler/user-agents.ts",
    "scripts/ops-watchdog.ts",
    "scripts/smoke-chatgpt-plugin.ts",
    "scripts/validate-chatgpt-plugin.ts",
  ];
  for (const file of files) {
    const source = read(file);
    assert.doesNotMatch(source, /worldcons\.vercel\.app/u, file);
    assert.doesNotMatch(source, /worldcons\.soltera\.dev/u, file);
  }
});

test("M12 has no legacy platform hostname redirect", () => {
  const config = read("next.config.ts");
  assert.doesNotMatch(config, /vercel\.app|VERCEL_/u);
});

test("M12 production runtime cannot reacquire Supabase or Vercel credentials", () => {
  assert.equal(fs.existsSync(path.join(root, "vercel.json")), false, "Vercel deployment config must stay removed");
  const runtimeFiles = [
    ...sourceFiles("app"),
    ...sourceFiles("components"),
    ...sourceFiles("worker"),
    ...sourceFiles("workers"),
    "lib/reference-reads/index.ts",
    "lib/article-reads/index.ts",
    "lib/search/repository/index.ts",
    "lib/db/client.ts",
  ];
  for (const file of runtimeFiles) {
    const source = read(file);
    assert.doesNotMatch(source, /SUPABASE_URL|SUPABASE_SERVICE_ROLE_KEY|VERCEL_URL|BLOB_READ_WRITE_TOKEN/u, file);
  }

  const retiredClient = read("lib/db/client.ts");
  assert.match(retiredClient, /hasSupabaseConfig\(\): false/u);
  assert.match(retiredClient, /return false;/u);
  assert.equal((retiredClient.match(/return null;/gu) ?? []).length, 2, "both retired Supabase client helpers must fail closed");

  for (const file of [
    "lib/db/queries.ts",
    "lib/article-reads/shared.ts",
    "lib/search/ranked-page.ts",
    "lib/search/vector.ts",
    "lib/case-catalog/flags.ts",
  ]) {
    assert.doesNotMatch(read(file), /from ["']@\/lib\/article-publication["']/u, `${file} must not pull the legacy publication barrel into production reads`);
  }
});
