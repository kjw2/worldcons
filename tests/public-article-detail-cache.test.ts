import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = process.cwd();

test("public article detail uses runtime D1 rendering instead of persistent static RSC caching", () => {
  const page = fs.readFileSync(path.join(root, "app/articles/[slug]/(detail)/page.tsx"), "utf8");
  const cacheSource = fs.readFileSync(path.join(root, "lib/public-article-detail-cache.ts"), "utf8");

  assert.match(page, /export const dynamic = "force-dynamic"/);
  assert.match(page, /export const revalidate = 0/);
  assert.doesNotMatch(cacheSource, /unstable_cache/);
  assert.match(cacheSource, /cache\(/);
  assert.match(cacheSource, /getArticleDetailPageData/);
});
