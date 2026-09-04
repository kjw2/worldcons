import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { bverfgCaseNumberFromText } from "../lib/crawlee/bverfg-spider";
import type { ArticleListItem } from "../lib/db/types";
import { mapSearchApiArticle, mapSearchApiSource } from "../lib/search/api-contract";
import { extractExactCaseReferences } from "../lib/search/exact-case";
import { caseNumberKey, normalizeCaseNumber } from "../lib/search/case-number";
import { normalizeLegalSearchQuery, rerankLegalSearchItems } from "../lib/search/legal-relevance";
import { parseSearchApiParams } from "../lib/security/public-api-validation";
import {
  fuseHybridArticleItems,
  mergeRankedArticleItems,
  paginateRankedArticleItems,
  rankedLookupFilters,
  rankedSearchWindow,
} from "../lib/search/vector";

const NEUBAUER_ID = "11111111-1111-4111-8111-111111111111";

test("Neubauer comparison queries resolve the German climate decision reference", () => {
  const queries = [
    "한국 헌재 기후결정과 독일 연방헌법재판소 Neubauer 기후결정을 비교",
    "1 BvR 2656/18 climate",
  ];

  for (const query of queries) {
    assert.deepEqual(extractExactCaseReferences(query), [
      {
        sourceKey: "de-bverfg",
        caseNumber: "1 BvR 2656/18",
        caseKey: "1bvr265618",
      },
    ]);
  }
});

test("exact case extraction recognizes French, Spanish, and US case numbers", () => {
  assert.deepEqual(extractExactCaseReferences("2026-912 QPC"), [
    { sourceKey: "fr-conseil-constitutionnel", caseNumber: "2026-912 QPC", caseKey: "2026912qpc" },
  ]);
  assert.deepEqual(extractExactCaseReferences("SENTENCIA 53/2025"), [
    { sourceKey: "es-tribunal-constitucional", caseNumber: "53/2025", caseKey: "532025" },
  ]);
  assert.deepEqual(extractExactCaseReferences("No. 24-109"), [
    { sourceKey: "us-scotus", caseNumber: "24-109", caseKey: "24109" },
  ]);
});

test("source-aware case normalization produces the same canonical key across display variants", () => {
  assert.equal(normalizeCaseNumber("de-bverfg", "1 BVR 2656 / 2018"), "1 BvR 2656/18");
  assert.equal(caseNumberKey("de-bverfg", "1 BvR 2656/18"), "1bvr265618");
  assert.equal(normalizeCaseNumber("fr-conseil-constitutionnel", "Décision n° 2026-912 qpc"), "2026-912 QPC");
  assert.equal(caseNumberKey("fr-conseil-constitutionnel", "2026-912 QPC"), "2026912qpc");
  assert.equal(normalizeCaseNumber("es-tribunal-constitucional", "SENTENCIA 053/2025"), "53/2025");
  assert.equal(caseNumberKey("es-tribunal-constitucional", "53/2025"), "532025");
  assert.equal(normalizeCaseNumber("us-scotus", "No. 24-0109"), "24-109");
  assert.equal(caseNumberKey("us-scotus", "24-109"), "24109");
});

test("public search rejects offsets beyond the shared 10,000-row deep-pagination boundary", () => {
  const accepted = parseSearchApiParams(new URLSearchParams("q=climate&page=101&pageSize=100&mode=hybrid"));
  assert.equal(accepted.ok, true);
  if (accepted.ok) assert.equal(accepted.data.filters.count, "none");
  const rejected = parseSearchApiParams(new URLSearchParams("q=climate&page=102&pageSize=100&mode=hybrid"));
  assert.equal(rejected.ok, false);
});

test("BVerfG compact official URLs preserve the docket number during collection", () => {
  assert.equal(
    bverfgCaseNumberFromText(
      "https://www.bundesverfassungsgericht.de/SharedDocs/Entscheidungen/DE/2021/03/rs20210324_1bvr265618.html",
    ),
    "1 BvR 2656/18",
  );
  assert.equal(bverfgCaseNumberFromText("/2026/07/es20260723_2bve000423.html"), "2 BvE 4/23");
});

test("exact case matches remain above full-text and semantic results", () => {
  const neubauer = article({
    id: NEUBAUER_ID,
    slug: "germany-neubauer-climate-decision",
  });
  const recent = article({
    id: "22222222-2222-4222-8222-222222222222",
    slug: "recent-climate-case",
  });

  const merged = mergeRankedArticleItems([neubauer], [recent, neubauer], [neubauer, recent]);

  assert.deepEqual(
    merged.map((item) => item.id),
    [NEUBAUER_ID, "22222222-2222-4222-8222-222222222222"],
  );
});

test("ranked candidate lookup always starts at page one", () => {
  const lookup = rankedLookupFilters(
    { q: "평등권", page: 3, pageSize: 20, jurisdiction: "Germany" },
    Array.from({ length: 80 }, (_, index) => `candidate-${index + 1}`),
  );

  assert.equal(lookup.page, 1);
  assert.equal(lookup.pageSize, 80);
  assert.equal(lookup.q, undefined);
  assert.equal(lookup.count, "none");
  assert.equal(lookup.jurisdiction, "Germany");
});

test("ranked pagination applies exactly once across consecutive pages", () => {
  const ranked = Array.from({ length: 65 }, (_, index) =>
    article({
      id: `ranked-${String(index + 1).padStart(3, "0")}`,
      slug: `ranked-case-${index + 1}`,
    }),
  );

  const page1 = paginateRankedArticleItems(ranked, { page: 1, pageSize: 20 });
  const page2 = paginateRankedArticleItems(ranked, { page: 2, pageSize: 20 });
  const page3 = paginateRankedArticleItems(ranked, { page: 3, pageSize: 20 });

  assert.deepEqual(page1.items.map((item) => item.id), ranked.slice(0, 20).map((item) => item.id));
  assert.deepEqual(page2.items.map((item) => item.id), ranked.slice(20, 40).map((item) => item.id));
  assert.deepEqual(page3.items.map((item) => item.id), ranked.slice(40, 60).map((item) => item.id));
  assert.equal(new Set([...page1.items, ...page2.items, ...page3.items].map((item) => item.id)).size, 60);
  assert.equal(page1.pageInfo.hasMore, true);
  assert.equal(page3.pageInfo.hasMore, true);
  assert.equal(page3.pageInfo.total, 65);
  assert.equal(page3.pageInfo.totalIsExact, false);
});

test("hybrid candidate windows grow with the requested page without exceeding bounded lookup size", () => {
  assert.equal(rankedSearchWindow({ page: 1, pageSize: 20 }, 50), 50);
  assert.equal(rankedSearchWindow({ page: 2, pageSize: 20 }, 50), 60);
  assert.equal(rankedSearchWindow({ page: 3, pageSize: 20 }, 50), 80);
  assert.equal(rankedSearchWindow({ page: 8, pageSize: 20 }, 50), 100);
});

test("legal search normalization removes only generic research-intent noise", () => {
  assert.equal(normalizeLegalSearchQuery("게리맨더링 관련 판례 찾아줘"), "게리맨더링");
  assert.equal(normalizeLegalSearchQuery("1 BvR 2656/18 관련 판례"), "1 BvR 2656/18");
});

test("catalog page reranking promotes exact case identity without changing the candidate set", () => {
  const target = article({
    id: "exact-docket",
    slug: "exact-docket",
    caseNumber: "1 BvR 2656/18",
    koreanTitle: "기후보호법 관련 세대 간 자유 보장 결정",
  });
  const generic = article({ id: "generic", slug: "generic", caseNumber: "2 BvR 1/20" });
  const reranked = rerankLegalSearchItems("1 BvR 2656/18 관련 판례", [generic, target]);
  assert.deepEqual(reranked.map((item) => item.id), ["exact-docket", "generic"]);
});

test("hybrid RRF rewards agreement between lexical and semantic rankings", () => {
  const lexicalFirst = article({ id: "rrf-lexical-first", slug: "rrf-lexical-first", originalPublishedAt: "2026-08-20T00:00:00Z" });
  const shared = article({ id: "rrf-shared", slug: "rrf-shared", originalPublishedAt: "2024-01-01T00:00:00Z" });
  const semanticFirst = article({ id: "rrf-semantic-first", slug: "rrf-semantic-first", originalPublishedAt: "2026-08-21T00:00:00Z" });

  const fused = fuseHybridArticleItems(
    "표현의 자유",
    [lexicalFirst, shared],
    [semanticFirst, shared],
  );

  assert.equal(fused[0]?.id, "rrf-shared");
  assert.deepEqual(new Set(fused.map((item) => item.id)), new Set(["rrf-lexical-first", "rrf-shared", "rrf-semantic-first"]));
});

test("exact normalized title remains above RRF score", () => {
  const consensus = article({ id: "rrf-consensus", slug: "rrf-consensus", koreanTitle: "다른 판례" });
  const exactTitle = article({
    id: "rrf-exact-title",
    slug: "rrf-exact-title",
    koreanTitle: "  표현의   자유 결정  ",
    originalPublishedAt: "2020-01-01T00:00:00Z",
  });

  const fused = fuseHybridArticleItems(
    "표현의 자유 결정",
    [consensus, exactTitle],
    [consensus],
  );

  assert.equal(fused[0]?.id, "rrf-exact-title");
});

test("Korean concept queries can surface semantically retrieved foreign decisions ahead of lower lexical ranks", () => {
  const lexicalFirst = article({ id: "climate-lex-1", slug: "climate-lex-1", koreanTitle: "기후 정책 일반" });
  const lexicalSecond = article({ id: "climate-lex-2", slug: "climate-lex-2", koreanTitle: "환경 정책 일반" });
  const foreignSemantic = article({
    id: "climate-neubauer-semantic",
    slug: "climate-neubauer-semantic",
    originalTitle: "Beschluss des Ersten Senats vom 24. März 2021",
    koreanTitle: "세대 간 자유와 기후보호 의무",
    jurisdiction: "Germany",
    originalPublishedAt: "2021-03-24T00:00:00Z",
  });

  const fused = fuseHybridArticleItems(
    "기후변화 세대 간 자유",
    [lexicalFirst, lexicalSecond],
    [foreignSemantic],
  );

  assert.ok(fused.findIndex((item) => item.id === "climate-neubauer-semantic") < fused.findIndex((item) => item.id === "climate-lex-2"));
});

test("legal relevance breaks equal RRF ties before recency", () => {
  const olderRelevant = article({
    id: "tie-relevant",
    slug: "tie-relevant",
    koreanTitle: "부분공개와 분리 가능성 판단",
    originalPublishedAt: "2020-01-01T00:00:00Z",
  });
  const newerGeneric = article({
    id: "tie-generic",
    slug: "tie-generic",
    koreanTitle: "정보공개 일반 결정",
    originalPublishedAt: "2026-01-01T00:00:00Z",
  });
  const fused = fuseHybridArticleItems("부분공개 분리 가능성", [olderRelevant], [newerGeneric]);
  assert.deepEqual(fused.map((item) => item.id), ["tie-relevant", "tie-generic"]);
});

test("recency remains the tie-breaker when RRF and legal relevance are equal", () => {
  const olderLexical = article({ id: "tie-older", slug: "tie-older", originalPublishedAt: "2020-01-01T00:00:00Z" });
  const newerSemantic = article({ id: "tie-newer", slug: "tie-newer", originalPublishedAt: "2026-01-01T00:00:00Z" });
  const fused = fuseHybridArticleItems("평등권", [olderLexical], [newerSemantic]);
  assert.deepEqual(fused.map((item) => item.id), ["tie-newer", "tie-older"]);
});

test("search API items expose cclrag2 normalization and follow-up content URLs", () => {
  const mapped = mapSearchApiArticle(
    article({
      sourceMetadata: { caseNumber: "1 BvR 2656/18" },
    }),
    "https://worldcons.vercel.app/",
  );

  assert.equal(mapped.sourceType, "foreign_constitutional");
  assert.equal(mapped.caseNumber, "1 BvR 2656/18");
  assert.equal(mapped.title, "기후보호법 관련 세대 간 자유 보장 결정");
  assert.equal(mapped.summary, "독일 연방헌법재판소는 기후보호 의무의 세대 간 배분을 심사했다.");
  assert.equal(mapped.url, "https://worldcons.vercel.app/articles/germany-neubauer-climate-decision");
  assert.equal(
    mapped.detailApiUrl,
    "https://worldcons.vercel.app/api/articles/germany-neubauer-climate-decision",
  );
  assert.equal(
    mapped.sourceTextUrl,
    "https://worldcons.vercel.app/api/articles/germany-neubauer-climate-decision/source-text",
  );
  assert.equal(mapped.metadata.officialUrl, mapped.officialUrl);
});

test("ranked full-text migration uses published projection relevance and service-role-only execution", () => {
  const sql = readFileSync("supabase/migrations/20260826200000_public_fulltext_ranked_search.sql", "utf8");
  assert.match(sql, /from public_article_projection_p3 article/i);
  assert.match(sql, /ts_rank_cd\(article\.search_vector, v_query, 32\)/i);
  assert.match(sql, /grant execute on function public_fulltext_ranked_ids_v1[\s\S]+service_role/i);
  assert.match(sql, /revoke all on function public_fulltext_ranked_ids_v1[\s\S]+from anon/i);
  assert.match(sql, /p_limit is null or p_limit not between 1 and 100/i);
});

test("source inventory identifies WorldCons records as foreign constitutional material", () => {
  const mapped = mapSearchApiSource({
    sourceKey: "de-bverfg",
    name: "Bundesverfassungsgericht",
    jurisdiction: "Germany",
    baseUrl: "https://www.bundesverfassungsgericht.de",
    language: "de",
    isActive: true,
  });

  assert.equal(mapped.sourceType, "foreign_constitutional");
});

function article(overrides: Partial<ArticleListItem> = {}): ArticleListItem {
  return {
    id: NEUBAUER_ID,
    slug: "germany-neubauer-climate-decision",
    sourceKey: "de-bverfg",
    jurisdiction: "Germany",
    institutionName: "Bundesverfassungsgericht",
    contentType: "decision",
    originalUrl:
      "https://www.bundesverfassungsgericht.de/SharedDocs/Entscheidungen/DE/2021/03/rs20210324_1bvr265618.html",
    canonicalUrl:
      "https://www.bundesverfassungsgericht.de/SharedDocs/Entscheidungen/DE/2021/03/rs20210324_1bvr265618.html",
    originalLanguage: "de",
    originalTitle: "Beschluss vom 24. März 2021",
    koreanTitle: "기후보호법 관련 세대 간 자유 보장 결정",
    originalPublishedAt: "2021-03-24T00:00:00Z",
    status: "summarized",
    summaryJson: null,
    sourceMetadata: { caseNumber: "1 BvR 2656/18" },
    tags: [],
    oneLineSummary: "독일 연방헌법재판소는 기후보호 의무의 세대 간 배분을 심사했다.",
    ...overrides,
  };
}
