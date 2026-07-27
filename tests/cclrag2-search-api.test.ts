import assert from "node:assert/strict";
import test from "node:test";
import { bverfgCaseNumberFromText } from "../lib/crawlee/bverfg-spider";
import type { ArticleListItem } from "../lib/db/types";
import { mapSearchApiArticle, mapSearchApiSource } from "../lib/search/api-contract";
import { extractExactCaseReferences } from "../lib/search/exact-case";
import { mergeRankedArticleItems } from "../lib/search/vector";

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
      },
    ]);
  }
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
