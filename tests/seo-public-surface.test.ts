import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { SITE_NAME } from "../lib/site-brand";
import { getAppBaseUrl, isIndexablePublicTag, publicAbsoluteUrl, publicPath } from "../lib/seo/public-urls";
import { articleMetadata, siteVerificationMetadata, tagMetadata } from "../lib/seo/metadata";
import { articleBreadcrumbJsonLd, articleJsonLd, websiteJsonLd } from "../lib/seo/jsonld";
import { publicListPaginationMetadata } from "../lib/seo/list-pagination";
import { parseTagDetailPage, paginatedTagMetadata, TAG_DETAIL_PAGE_SIZE, tagDetailPageHref } from "../lib/seo/tag-detail-pagination";
import {
  isOutOfRangeSourceArchivePage,
  parseSourceArchivePage,
  sourceArchiveMetadata,
  sourceArchivePageHref,
  SOURCE_ARCHIVE_PAGE_SIZE,
} from "../lib/seo/source-detail-pagination";
import { readTagDetailSafely, type TagDetailReadFailure } from "../lib/seo/tag-detail-read";
import { TAG_HUB_PAGE_SIZE, paginateTagHub, parseTagHubPage, tagHubMetadata, tagHubPageHref } from "../lib/seo/tag-hub-pagination";
import {
  resilientSitemapRead,
  SITEMAP_SOURCE_RETRY_DELAY_MS,
  SitemapSourceUnavailableError,
  type SitemapReadAttemptLog,
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

test("homepage alone emits the canonical WebSite identity and SEO surfaces share the site name", () => {
  assert.deepEqual(websiteJsonLd(), {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: SITE_NAME,
    alternateName: "WorldCons",
    url: `${getAppBaseUrl()}/`,
  });

  const root = process.cwd();
  const homepage = fs.readFileSync(path.join(root, "app/page.tsx"), "utf8");
  const layout = fs.readFileSync(path.join(root, "app/layout.tsx"), "utf8");
  const pageSources = fs.readdirSync(path.join(root, "app"), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name === "page.tsx")
    .map((entry) => path.join(entry.parentPath, entry.name));
  const websiteSchemaPages = pageSources.filter((file) => /websiteJsonLd\(\)/u.test(fs.readFileSync(file, "utf8")));

  assert.match(homepage, /jsonLdScriptValue\(websiteJsonLd\(\)\)/u);
  assert.deepEqual(websiteSchemaPages, [path.join(root, "app/page.tsx")]);
  assert.match(layout, /openGraph:\s*\{\s*siteName: SITE_NAME,/u);
  assert.match(layout, /template: `%s \| \$\{SITE_NAME\}`/u);
  assert.match(homepage, /title: "세계 헌법판례 데이터베이스"/u);
  assert.match(homepage, /<h1[^>]*>세계 헌법판례 데이터베이스<\/h1>/u);

  const article = {
    slug: "site-name-article",
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
    discoveredAt: "2026-08-01T00:00:00.000Z",
    fetchedAt: "2026-08-02T00:00:00.000Z",
    summarizedAt: "2026-08-03T00:00:00.000Z",
    status: "summarized" as const,
    caseNumber: "1 BvR 1/26",
    summaryJson: null,
    tags: [],
    sourceMetadata: null,
    oneLineSummary: "고유한 판례 요약입니다.",
    viewCount: 0,
  };
  const tag = { slug: "site-name-tag", name: "기본권", normalizedName: "기본권", type: "right" as const, articleCount: 3 };

  assert.equal(articleMetadata(article).openGraph?.siteName, SITE_NAME);
  assert.equal(tagMetadata(tag).openGraph?.siteName, SITE_NAME);
});

test("unfiltered archive pagination uses self-canonical pages while filter/search URLs stay noindex", () => {
  const baseUrl = getAppBaseUrl();
  const base = publicListPaginationMetadata({}, baseUrl);
  assert.deepEqual(base, { alternates: { canonical: `${baseUrl}/list` } });
  for (const page of [2, 3, 229]) {
    assert.deepEqual(
      publicListPaginationMetadata({ page: String(page) }, baseUrl),
      { alternates: { canonical: `${baseUrl}/list?page=${page}` } },
      `archive page ${page} must not canonicalize to the first page`,
    );
  }
  assert.deepEqual(
    publicListPaginationMetadata({ page: "2", range: "latest" }, baseUrl),
    { alternates: { canonical: `${baseUrl}/list?page=2` } },
  );
  for (const params of [
    { page: "2", jurisdiction: "Germany" },
    { page: "2", tag: "bverfgg" },
    { page: "2", q: "free speech" },
    { page: "2", source: "de-bverfg" },
    { page: "2", range: "month" },
  ]) {
    assert.deepEqual(
      publicListPaginationMetadata(params, baseUrl),
      { alternates: { canonical: `${baseUrl}/list` }, robots: { index: false, follow: true } },
    );
  }
  for (const page of ["0", "-1", "2.5", "NaN", "10001"]) {
    assert.deepEqual(
      publicListPaginationMetadata({ page }, baseUrl),
      { alternates: { canonical: `${baseUrl}/list` }, robots: { index: false, follow: true } },
    );
  }
  const listSource = fs.readFileSync(path.join(process.cwd(), "app/list/page.tsx"), "utf8");
  assert.match(listSource, /export async function generateMetadata/u);
  assert.match(listSource, /publicListPaginationMetadata\(params, getAppBaseUrl\(\)\)/u);
});

test("tag hub bounds server-rendered pages and retains a complete reachable set of tag URLs", () => {
  assert.equal(TAG_HUB_PAGE_SIZE, 96);
  assert.equal(parseTagHubPage(undefined), 1);
  assert.equal(parseTagHubPage("2"), 2);
  for (const bad of ["", "0", "01", "-1", "1.5", "10001", "Infinity"]) {
    assert.equal(parseTagHubPage(bad), null);
  }
  assert.equal(parseTagHubPage(["2", "3"]), null);
  assert.equal(tagHubPageHref(1), "/tags");
  assert.equal(tagHubPageHref(3), "/tags?page=3");

  const baseUrl = getAppBaseUrl();
  assert.deepEqual(tagHubMetadata(1, baseUrl), { alternates: { canonical: `${baseUrl}/tags` } });
  assert.deepEqual(tagHubMetadata(2, baseUrl), { alternates: { canonical: `${baseUrl}/tags?page=2` } });
  assert.deepEqual(tagHubMetadata(null, baseUrl), {
    alternates: { canonical: `${baseUrl}/tags` },
    robots: { index: false, follow: true },
  });

  const tags = Array.from({ length: 1256 }, (_, index) => ({
    slug: `tag-${String(index).padStart(4, "0")}`,
    name: `주제 ${index}`,
    normalizedName: `tag-${index}`,
    type: "topic" as const,
    articleCount: index % 11 + 3,
  })).reverse();
  const totalPages = Math.ceil(tags.length / TAG_HUB_PAGE_SIZE);
  const emitted = new Set<string>();
  for (let page = 1; page <= totalPages; page++) {
    const result = paginateTagHub(tags, page);
    assert.ok(result);
    assert.equal(result.totalPages, totalPages);
    assert.ok(result.tags.length > 0 && result.tags.length <= TAG_HUB_PAGE_SIZE);
    for (const tag of result.tags) {
      assert.equal(emitted.has(tag.slug), false, `duplicate tag across pages: ${tag.slug}`);
      emitted.add(tag.slug);
    }
    assert.deepEqual(result.tags, paginateTagHub([...tags].reverse(), page)?.tags, "tie ordering is stable");
  }
  assert.equal(emitted.size, tags.length);
  assert.equal(paginateTagHub(tags, totalPages + 1), null);
  const tagsSource = fs.readFileSync(path.join(process.cwd(), "app/tags/page.tsx"), "utf8");
  assert.match(tagsSource, /export async function generateMetadata/u);
  assert.match(tagsSource, /tagHubMetadata\(parseTagHubPage\(params\.page\)/u);
  assert.match(tagsSource, /href=\{tagHubPageHref\(target\)\}/u);
  assert.match(tagsSource, /<TagHubList tags=\{pagination\.tags\}/u);
});

test("tag detail paginates article cards without losing crawlable page identity", () => {
  assert.equal(TAG_DETAIL_PAGE_SIZE, 10);
  assert.equal(parseTagDetailPage(undefined), 1);
  assert.equal(parseTagDetailPage("2"), 2);
  for (const bad of ["", "0", "01", "-1", "2.3", "10001", "Infinity"]) {
    assert.equal(parseTagDetailPage(bad), null);
  }
  assert.equal(parseTagDetailPage(["2", "3"]), null);
  assert.equal(tagDetailPageHref("bverfgg", 1), "/tags/bverfgg");
  assert.equal(tagDetailPageHref("bverfgg", 5), "/tags/bverfgg?page=5");
  const tag = {
    slug: "bverfgg",
    name: "독일 연방헌법재판소",
    normalizedName: "bverfgg",
    type: "topic" as const,
    articleCount: 50,
  };
  const original = tagMetadata(tag);
  assert.deepEqual(paginatedTagMetadata(tag, 1), original);
  const second = paginatedTagMetadata(tag, 2);
  assert.equal(second.alternates?.canonical, getAppBaseUrl() + "/tags/bverfgg?page=2");
  assert.equal(second.openGraph?.url, getAppBaseUrl() + "/tags/bverfgg?page=2");
  assert.equal(second.robots, undefined);

  const src = fs.readFileSync(path.join(process.cwd(), "app/tags/[slug]/page.tsx"), "utf8");
  assert.match(src, /getPaginatedTagBySlug\(slug, page, TAG_DETAIL_PAGE_SIZE\)/u);
  assert.match(src, /getTagSummaryBySlug\(slug\)/u);
  assert.match(src, /<ArticleGrid articles=\{result\.articles\}/u);
  assert.match(src, /tagDetailPageHref\(result\.tag\.slug, target\)/u);
  assert.match(src, /paginationWindow\(page, totalPages\)/u);
  assert.match(src, /listTags\(\{ sort: "latest", minArticleCount: MIN_INDEXABLE_TAG_ARTICLE_COUNT, limit: 9 \}\)/u);
  assert.match(src, /readTagDetailSafely\("articles"/u);
});

test("source detail paginates its full public archive with self-canonical crawlable pages", () => {
  assert.equal(SOURCE_ARCHIVE_PAGE_SIZE, 30);
  assert.equal(parseSourceArchivePage(undefined), 1);
  assert.equal(parseSourceArchivePage("2"), 2);
  for (const bad of ["", "0", "01", "-1", "2.3", "10001", "Infinity"]) {
    assert.equal(parseSourceArchivePage(bad), null);
  }
  assert.equal(parseSourceArchivePage(["2", "3"]), null);
  assert.equal(sourceArchivePageHref("de-bverfg", 1), "/sources/de-bverfg");
  assert.equal(sourceArchivePageHref("de-bverfg", 2), "/sources/de-bverfg?page=2");
  assert.equal(isOutOfRangeSourceArchivePage(1, 0), false);
  assert.equal(isOutOfRangeSourceArchivePage(2, 0), true);
  assert.equal(isOutOfRangeSourceArchivePage(2, 1), false);

  const source = {
    sourceKey: "de-bverfg",
    name: "Bundesverfassungsgericht",
    jurisdiction: "Germany",
    baseUrl: "https://example.test",
    language: "de",
    isActive: true,
  };
  const baseUrl = getAppBaseUrl();
  assert.deepEqual(sourceArchiveMetadata(source, 1), {
    title: "독일 연방헌재",
    description: "독일 공식 헌법재판 자료 수집 기관",
    alternates: { canonical: `${baseUrl}/sources/de-bverfg` },
  });
  const second = sourceArchiveMetadata(source, 2);
  assert.equal(second.title, "독일 연방헌재 판례 목록 2페이지");
  assert.match(String(second.description), /2페이지/u);
  assert.equal(second.alternates?.canonical, `${baseUrl}/sources/de-bverfg?page=2`);
  assert.equal(second.robots, undefined);
  assert.deepEqual(sourceArchiveMetadata(source, null), {
    alternates: { canonical: `${baseUrl}/sources/de-bverfg` },
    robots: { index: false, follow: true },
  });

  const src = fs.readFileSync(path.join(process.cwd(), "app/sources/[sourceKey]/page.tsx"), "utf8");
  assert.match(src, /export default async function SourceDetailPage/u);
  assert.doesNotMatch(src, /^"use client"/mu);
  assert.match(src, /listArticles\(\{ source: sourceKey, page, pageSize: SOURCE_ARCHIVE_PAGE_SIZE, count \}\)/u);
  assert.match(src, /parseSourceArchivePage\(query\.page\)/u);
  assert.match(src, /SOURCE_ARCHIVE_PAGE_SIZE/u);
  assert.match(src, /page === 1 \? "exact" : "none"/u);
  assert.match(src, /isOutOfRangeSourceArchivePage\(page, articles\.items\.length\)/u);
  assert.match(src, /sourceArchivePageHref\(source\.sourceKey, page - 1\)/u);
  assert.match(src, /sourceArchivePageHref\(source\.sourceKey, page \+ 1\)/u);
  assert.match(src, /rel="prev"/u);
  assert.match(src, /rel="next"/u);
  assert.match(src, /<ArticleGrid articles=\{articles\.items\}/u);
  assert.match(src, /`\/sources\/\$\{source\.sourceKey\}`/u);
  assert.match(src, /\/list\?source=\$\{encodeURIComponent\(source\.sourceKey\)\}/u);
  assert.doesNotMatch(src, /includeUnpublished/u);
});

test("tag detail retries transient read failures twice without logging sensitive messages or leaking content", async () => {
  const log: TagDetailReadFailure[] = [];
  const waits: number[] = [];
  let calls = 0;
  const result = await readTagDetailSafely("articles", async () => {
    calls += 1;
    if (calls === 1) throw new Error("e2e.public_metadata_pending");
    return { articles: ["approved"] };
  }, { wait: async (ms) => { waits.push(ms); }, log: (entry) => log.push(entry) });
  assert.deepEqual(result, { articles: ["approved"] });
  assert.equal(calls, 2);
  assert.deepEqual(waits, [120]);
  assert.deepEqual(log, [{
    event: "worldcons_tag_detail_read_failed",
    stage: "articles",
    attempt: 1,
    reason: "e2e.public_metadata_pending",
  }]);
  const logged: TagDetailReadFailure[] = [];
  await assert.rejects(() => readTagDetailSafely("metadata", async () => {
    throw new Error("SQL select * from secret; customer token abc123");
  }, { wait: async () => {}, log: (entry) => logged.push(entry) }), /SQL select/);
  assert.deepEqual(logged.map((entry) => entry.reason), ["Error", "Error"]);
  assert.doesNotMatch(JSON.stringify(logged), /secret|token|abc123/u);
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
  const attempts: SitemapReadAttemptLog[] = [];
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
        logAttempt: (entry) => {
          attempts.push(entry);
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
  assert.deepEqual(attempts, [1,2].map((attempt) => ({
    event: "sitemap_source_attempt_failed", source: "articles", attempt, reason: "Error",
  })));
  assert.doesNotMatch(JSON.stringify(attempts), /sensitive internal detail/u);
});

test("sitemap diagnostics capture only safe internal codes", async () => {
  const attempts: SitemapReadAttemptLog[] = [];
  await assert.rejects(
    resilientSitemapRead("articles", async () => { throw new Error("e2e.public_metadata_pending"); }, {
      attempts: 1,
      log: () => {},
      logAttempt: (entry) => attempts.push(entry),
    }),
    SitemapSourceUnavailableError,
  );
  assert.deepEqual(attempts, [{
    event: "sitemap_source_attempt_failed",
    source: "articles",
    attempt: 1,
    reason: "e2e.public_metadata_pending",
  }]);
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
