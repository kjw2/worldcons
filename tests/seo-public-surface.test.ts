import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { getAppBaseUrl, isIndexablePublicTag, publicAbsoluteUrl, publicPath } from "../lib/seo/public-urls";
import { articleMetadata, siteVerificationMetadata, tagMetadata } from "../lib/seo/metadata";
import { articleBreadcrumbJsonLd, articleJsonLd } from "../lib/seo/jsonld";
import {
  resilientSitemapRead,
  SITEMAP_SOURCE_RETRY_DELAY_MS,
  SitemapSourceUnavailableError,
  type SitemapSourceUnavailableLog,
} from "../lib/seo/sitemap-source";

test("public paths strip the legacy /v2 prefix and keep clean URLs", () => {
  assert.equal(publicPath("/"), "/");
  assert.equal(publicPath("/v2"), "/");
  assert.equal(publicPath("/v2/"), "/");
  assert.equal(publicPath("/v2/list"), "/list");
  assert.equal(publicPath("/articles/example"), "/articles/example");
  assert.equal(publicAbsoluteUrl("/v2/articles/example"), `${getAppBaseUrl()}/articles/example`);
});

test("Google and Naver ownership verification surfaces stay deployable on the Workers host", () => {
  const metadata = siteVerificationMetadata({
    GOOGLE_SITE_VERIFICATION: "google-meta-token",
    NAVER_SITE_VERIFICATION: "naver-meta-token",
  });
  assert.deepEqual(metadata.verification, {
    google: "google-meta-token",
    other: { "naver-site-verification": "naver-meta-token" },
  });

  const googleRoute = fs.readFileSync(
    path.join(process.cwd(), "app/googlebc13342811fc3fd7.html/route.ts"),
    "utf8",
  );
  assert.match(googleRoute, /google-site-verification: googlebc13342811fc3fd7[.]html\\n/u);
  assert.match(googleRoute, /status:\s*200/u);
  assert.equal(fs.existsSync(path.join(process.cwd(), "public/googlebc13342811fc3fd7.html")), false);
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

test("sitemap source reads retry transient failures and recover", async () => {
  const waits: number[] = [];
  const logs: SitemapSourceUnavailableLog[] = [];
  let calls = 0;

  const result = await resilientSitemapRead(
    "articles",
    async () => {
      calls += 1;
      if (calls === 1) throw new Error("transient connection failure");
      return [{ slug: "recovered-article" }];
    },
    {
      wait: async (delayMs) => {
        waits.push(delayMs);
      },
      log: (entry) => {
        logs.push(entry);
      },
    },
  );

  assert.deepEqual(result, [{ slug: "recovered-article" }]);
  assert.equal(calls, 2);
  assert.deepEqual(waits, [SITEMAP_SOURCE_RETRY_DELAY_MS]);
  assert.deepEqual(logs, []);
});

test("sitemap source reads fail closed after retries without partial results", async () => {
  const waits: number[] = [];
  const logs: SitemapSourceUnavailableLog[] = [];
  let calls = 0;

  await assert.rejects(
    resilientSitemapRead(
      "articles",
      async () => {
        calls += 1;
        throw new Error("sensitive internal detail");
      },
      {
        wait: async (delayMs) => {
          waits.push(delayMs);
        },
        log: (entry) => {
          logs.push(entry);
        },
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof SitemapSourceUnavailableError);
      assert.equal(error.code, "sitemap_source_unavailable");
      assert.equal(error.source, "articles");
      assert.doesNotMatch(error.message, /sensitive internal detail/u);
      return true;
    },
  );

  assert.equal(calls, 2);
  assert.deepEqual(waits, [SITEMAP_SOURCE_RETRY_DELAY_MS]);
  assert.deepEqual(logs, [{ event: "sitemap_source_unavailable", source: "articles", attempts: 2 }]);
  assert.deepEqual(Object.keys(logs[0]).sort(), ["attempts", "event", "source"]);
});

test("sitemap and routing keep clean canonical URLs and drop search/thin-tag noise", () => {
  const sitemap = fs.readFileSync(path.join(process.cwd(), "app/sitemap.ts"), "utf8");
  const sitemapSource = fs.readFileSync(path.join(process.cwd(), "lib/seo/sitemap-source.ts"), "utf8");
  const tagsPage = fs.readFileSync(path.join(process.cwd(), "app/tags/page.tsx"), "utf8");
  const tagPill = fs.readFileSync(path.join(process.cwd(), "components/tag-pill.tsx"), "utf8");
  const nextConfig = fs.readFileSync(path.join(process.cwd(), "next.config.ts"), "utf8");
  const searchPage = fs.readFileSync(path.join(process.cwd(), "app/search/page.tsx"), "utf8");
  const header = fs.readFileSync(path.join(process.cwd(), "components/public-site-header.tsx"), "utf8");

  assert.match(sitemap, /listPublicSitemapArticles/);
  assert.match(sitemap, /resilientSitemapRead/);
  assert.match(sitemap, /from "@\/lib\/seo\/sitemap-source"/);
  assert.doesNotMatch(sitemap, /return \[\]/);
  assert.doesNotMatch(sitemap, /catch/u);
  assert.match(sitemapSource, /SITEMAP_SOURCE_RETRY_DELAY_MS = 150/);
  assert.match(sitemapSource, /setTimeout\(resolve, delayMs\)/);
  assert.match(sitemapSource, /sitemap_source_unavailable/);
  assert.match(sitemapSource, /throw new SitemapSourceUnavailableError\(source\)/);
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

test("France article and print surfaces render the shared Korean DILA attribution", () => {
  const root = process.cwd();
  const detailPage = fs.readFileSync(path.join(root, "app/articles/[slug]/(detail)/page.tsx"), "utf8");
  const printPage = fs.readFileSync(path.join(root, "app/articles/[slug]/print/page.tsx"), "utf8");
  const attribution = fs.readFileSync(path.join(root, "components/article-source-attribution.tsx"), "utf8");
  const parser = fs.readFileSync(path.join(root, "lib/case-catalog/source-attribution.ts"), "utf8");

  assert.match(detailPage, /publicSourceAttribution\(article[.]sourceKey, article[.]sourceMetadata, article[.]originalUrl\)/u);
  assert.match(detailPage, /<ArticleSourceAttribution attribution=\{sourceAttribution\}/u);
  assert.match(printPage, /공식 데이터 출처와 이용조건/u);
  assert.match(attribution, /자료 파일 기준시각/u);
  assert.match(attribution, /라이선스/u);
  assert.match(parser, /프랑스 법률·행정정보국/u);
  assert.match(parser, /공식 원문은 AI 생성물이 아닙니다/u);
  assert.match(attribution, /발견 보조 자료/u);
  assert.match(parser, /독일 연방헌법재판소/u);
  assert.match(parser, /외부 인덱스 보조 수집/u);
  assert.match(parser, /독일어 공식 원문만 권위 있는 자료/u);
  assert.match(parser, /보증을 의미하지 않습니다/u);
});
