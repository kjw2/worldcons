import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { getAppBaseUrl, isIndexablePublicTag, publicAbsoluteUrl, publicPath } from "../lib/seo/public-urls";
import { articleMetadata, tagMetadata } from "../lib/seo/metadata";
import { articleBreadcrumbJsonLd, articleJsonLd } from "../lib/seo/jsonld";

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
  const tagsPage = fs.readFileSync(path.join(process.cwd(), "app/tags/page.tsx"), "utf8");
  const tagPill = fs.readFileSync(path.join(process.cwd(), "components/tag-pill.tsx"), "utf8");
  const nextConfig = fs.readFileSync(path.join(process.cwd(), "next.config.ts"), "utf8");
  const searchPage = fs.readFileSync(path.join(process.cwd(), "app/search/page.tsx"), "utf8");
  const header = fs.readFileSync(path.join(process.cwd(), "components/public-site-header.tsx"), "utf8");

  assert.match(sitemap, /listPublicSitemapArticles/);
  assert.match(sitemap, /isIndexablePublicTag/);
  assert.match(sitemap, /minArticleCount: MIN_INDEXABLE_TAG_ARTICLE_COUNT/);
  assert.match(tagsPage, /minArticleCount: MIN_INDEXABLE_TAG_ARTICLE_COUNT/);
  assert.match(tagPill, /if \(!isIndexablePublicTag\(tag\)\)/);
  assert.match(tagPill, /return <span \{\.\.\.sharedProps\}>\{content\}<\/span>/);
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

test("indexable article pages emit explicit robots and stronger structured data", () => {
  const article = {
    slug: "example-case",
    sourceKey: "de-bverfg",
    jurisdiction: "Germany",
    institutionName: "Bundesverfassungsgericht",
    contentType: "decision" as const,
    originalUrl: "https://example.test/decision",
    canonicalUrl: "https://example.test/decision",
    originalLanguage: "de",
    originalTitle: "Original title",
    koreanTitle: "한국어 제목",
    originalPublishedAt: "2026-08-01T00:00:00.000Z",
    discoveredAt: "2026-08-02T00:00:00.000Z",
    fetchedAt: "2026-08-02T00:00:00.000Z",
    summarizedAt: "2026-08-03T00:00:00.000Z",
    status: "summarized" as const,
    caseNumber: "1 BvR 1/26",
    summaryJson: null,
    tags: [{ slug: "freedom", name: "기본권", normalizedName: "기본권", type: "right" as const, articleCount: 12 }],
    sourceMetadata: null,
    oneLineSummary: "고유한 판례 요약입니다.",
    viewCount: 0,
  };

  assert.deepEqual(articleMetadata(article).robots, { index: true, follow: true });
  const structured = articleJsonLd(article);
  assert.equal(structured.mainEntityOfPage["@id"], `${getAppBaseUrl()}/articles/example-case`);
  assert.equal(structured.identifier, "1 BvR 1/26");
  assert.deepEqual(structured.keywords, ["기본권"]);
  const breadcrumbs = articleBreadcrumbJsonLd(article);
  assert.equal(breadcrumbs.itemListElement.length, 4);
  assert.equal(breadcrumbs.itemListElement[3].item, `${getAppBaseUrl()}/articles/example-case`);
});
