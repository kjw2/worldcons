import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

test("M12 production Worker config owns the Cloudflare production domain with observability", () => {
  const config = read("wrangler.jsonc");
  assert.match(config, /"name": "worldcons"/u);
  assert.match(config, /"pattern": "worldcons\.soltera\.dev"/u);
  assert.match(config, /"custom_domain": true/u);
  assert.match(config, /"observability": \{/u);
  assert.match(config, /"enabled": true/u);
  assert.match(config, /"preview_urls": false/u);
});

test("M12 production runtime uses the new canonical origin and the proven search binding", () => {
  const config = read("wrangler.jsonc");
  assert.match(config, /"APP_BASE_URL": "https:\/\/worldcons\.soltera\.dev"/u);
  assert.match(config, /"WORLDCONS_BASE_URL": "https:\/\/worldcons\.soltera\.dev"/u);
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
    assert.match(source, /worldcons\.soltera\.dev/u, file);
  }
});

test("M12 redirects only the legacy Vercel production hostname and preserves deployment rollback URLs", () => {
  const config = read("next.config.ts");
  assert.match(config, /type: "host" as const, value: "worldcons\.vercel\.app"/u);
  assert.match(config, /destination: "https:\/\/worldcons\.soltera\.dev\/:path\*"/u);
  assert.match(config, /permanent: false/u);
  assert.doesNotMatch(config, /jwkms-projects\.vercel\.app/u);
});
