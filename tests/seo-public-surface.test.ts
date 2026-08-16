import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { getAppBaseUrl, isIndexablePublicTag, publicAbsoluteUrl, publicPath } from "../lib/seo/public-urls";
import { tagMetadata } from "../lib/seo/metadata";

test("public paths strip the legacy /v2 prefix and keep clean URLs", () => {
  assert.equal(publicPath("/"), "/");
  assert.equal(publicPath("/v2"), "/");
  assert.equal(publicPath("/v2/"), "/");
  assert.equal(publicPath("/v2/list"), "/list");
  assert.equal(publicPath("/articles/example"), "/articles/example");
  assert.equal(publicAbsoluteUrl("/v2/articles/example"), `${getAppBaseUrl()}/articles/example`);
});

test("thin tags are not indexable and do not advertise themselves as sitemap targets", () => {
  assert.equal(isIndexablePublicTag({ articleCount: 1 }), false);
  assert.equal(isIndexablePublicTag({ articleCount: 3 }), true);
  const thin = tagMetadata({
    slug: "thin-tag",
    name: "얇은 태그",
    normalizedName: "얇은 태그",
    type: "topic",
    articleCount: 1,
  });
  assert.deepEqual(thin.robots, { index: false, follow: true });
  const fat = tagMetadata({
    slug: "fat-tag",
    name: "두꺼운 태그",
    normalizedName: "두꺼운 태그",
    type: "topic",
    articleCount: 8,
  });
  assert.equal(fat.robots, undefined);
});

test("sitemap and routing keep clean canonical URLs and drop search/thin-tag noise", () => {
  const sitemap = fs.readFileSync(path.join(process.cwd(), "app/sitemap.ts"), "utf8");
  const nextConfig = fs.readFileSync(path.join(process.cwd(), "next.config.ts"), "utf8");
  const searchPage = fs.readFileSync(path.join(process.cwd(), "app/search/page.tsx"), "utf8");
  const header = fs.readFileSync(path.join(process.cwd(), "components/public-site-header.tsx"), "utf8");

  assert.match(sitemap, /listPublicSitemapArticles/);
  assert.match(sitemap, /isIndexablePublicTag/);
  assert.doesNotMatch(sitemap, /\$\{baseUrl\}\/search/);
  assert.doesNotMatch(sitemap, /\/v2\//);
  assert.match(nextConfig, /source: "\/v2"/);
  assert.match(nextConfig, /destination: "\/"/);
  assert.match(nextConfig, /permanent: true/);
  assert.doesNotMatch(nextConfig, /destination: "\/v2"/);
  assert.match(searchPage, /index: false/);
  assert.match(searchPage, /follow: true/);
  assert.doesNotMatch(header, /\/v2/);
});
