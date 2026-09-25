import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test from "node:test";
import { emitDatabaseDdl } from "../lib/cloudflare/d1/ddl";
import { d1Schema } from "../lib/cloudflare/d1/schema";
import type { D1RuntimeDatabase, D1RuntimePreparedStatement } from "../lib/cloudflare/d1/runtime-binding";
import {
  buildSearchProjection,
  planSearchProjectionFullRebuild,
  type SearchArticleTagRow,
  type SearchProjectionDocument,
  type SearchProjectionFtsDocument,
  type SearchPublicationP3Row,
  type SearchTagRow,
  type SearchVersionP3Row,
} from "../lib/cloudflare/search-projection";
import {
  RANKED_SEARCH_SEMANTIC_DEFERRED_MESSAGE,
  RankedSearchError,
  buildRankedSearchQueryPlan,
  primaryCaseReference,
  readRankedSearchPage,
  resolveRankedSearchInput,
  runRankedSearchPage,
  type RankedSearchErrorCode,
  type RankedSearchPageInput,
  type RankedSearchPagePayload,
} from "../lib/cloudflare/search-ranked";

/**
 * M7.3 local, code-only ranked-search page foundation tests.
 *
 * The corpus is synthetic and the executor is the local Node `node:sqlite`
 * binding. Expected results are hand-authored against the documented local D1
 * semantics (exact-case source_key + case_numbers line token, latest ordering and
 * FTS5 bm25 with exact-title priority). This is NOT production Postgres parity
 * evidence and no rank/threshold parity is claimed.
 */

const rootDir = process.cwd();
const NOW = "2026-09-25T12:00:00.000Z";
const CREATED = "2026-01-01T00:00:00.000Z";
const URL = "https://example.test/secret/path?token=abc";
const RAW_TEXT = "RAW TEXT MUST NOT LEAK";

function articleId(index: number): string {
  return `aaaaaaaa-0000-0000-0000-${String(index).padStart(12, "0")}`;
}
function versionId(index: number): string {
  return `bbbbbbbb-0000-0000-0000-${String(index).padStart(12, "0")}`;
}
function publicationId(index: number): string {
  return `cccccccc-0000-0000-0000-${String(index).padStart(12, "0")}`;
}

const TAG_ENV: SearchTagRow = { id: "eeeeeeee-0000-0000-0000-000000000001", slug: "environment", name: "Environment", normalized_name: "environment", type: "topic" };
const TAG_DUE: SearchTagRow = { id: "eeeeeeee-0000-0000-0000-000000000002", slug: "due-process", name: "Due Process", normalized_name: "due process", type: "doctrine" };
const TAG_POLICY: SearchTagRow = { id: "eeeeeeee-0000-0000-0000-000000000003", slug: "policy", name: "Policy", normalized_name: "doctrine", type: "topic" };

interface CorpusRow {
  originalTitle: string | null;
  koreanTitle: string | null;
  sourceKey: string;
  jurisdiction: string;
  contentType: string;
  language: string;
  caseKey: string | null;
  caseNumber: string | null;
  publishedAt: string | null;
  cleanedText: string;
  tags?: SearchTagRow[];
}

const CORPUS: CorpusRow[] = [
  { originalTitle: "Klimaschutz Beschluss", koreanTitle: null, sourceKey: "de-bverfg", jurisdiction: "Germany", contentType: "decision", language: "de", caseKey: "1bvr265618", caseNumber: "1 BvR 2656/18", publishedAt: "2026-08-01T08:00:00.000Z", cleanedText: "constitution klimaschutz grundrechte", tags: [TAG_ENV] },
  { originalTitle: "Wahlrecht Beschluss", koreanTitle: null, sourceKey: "de-bverfg", jurisdiction: "Germany", contentType: "decision", language: "de", caseKey: "1bvr123422", caseNumber: "1 BvR 1234/22", publishedAt: "2026-08-15T08:00:00.000Z", cleanedText: "constitution wahlrecht" },
  { originalTitle: "Décision n° 2026-1194 QPC", koreanTitle: null, sourceKey: "fr-conseil-constitutionnel", jurisdiction: "France", contentType: "decision", language: "fr", caseKey: "20261194qpc", caseNumber: "2026-1194 QPC", publishedAt: "2026-09-15T08:00:00.000Z", cleanedText: "conseil constitutionnel décision" },
  { originalTitle: "Recurso de amparo 123/2025", koreanTitle: null, sourceKey: "es-tribunal-constitucional", jurisdiction: "Spain", contentType: "order", language: "es", caseKey: "1232025", caseNumber: "123/2025", publishedAt: "2026-06-01T08:00:00.000Z", cleanedText: "constitution amparo recurso" },
  { originalTitle: "Loper Bright Enterprises v. Raimondo", koreanTitle: null, sourceKey: "us-scotus", jurisdiction: "United States", contentType: "opinion", language: "en", caseKey: "24781", caseNumber: "24-781", publishedAt: "2026-04-29T08:00:00.000Z", cleanedText: "constitution chevron deference" },
  { originalTitle: "Sub Docket Decision", koreanTitle: null, sourceKey: "us-scotus", jurisdiction: "United States", contentType: "opinion", language: "en", caseKey: "2478", caseNumber: "24-78", publishedAt: "2026-05-01T08:00:00.000Z", cleanedText: "constitution sub doctrine" },
  { originalTitle: "Null Date Decision", koreanTitle: null, sourceKey: "us-scotus", jurisdiction: "United States", contentType: "decision", language: "en", caseKey: null, caseNumber: null, publishedAt: null, cleanedText: "constitution nulldate" },
  { originalTitle: "Tagged Due Process", koreanTitle: null, sourceKey: "us-scotus", jurisdiction: "United States", contentType: "opinion", language: "en", caseKey: null, caseNumber: null, publishedAt: "2026-09-20T08:00:00.000Z", cleanedText: "constitution due process", tags: [TAG_DUE] },
  { originalTitle: "Tagged Doctrine Only", koreanTitle: null, sourceKey: "us-scotus", jurisdiction: "United States", contentType: "opinion", language: "en", caseKey: null, caseNumber: null, publishedAt: "2026-09-19T08:00:00.000Z", cleanedText: "constitution doctrine", tags: [TAG_POLICY] },
  { originalTitle: "Today Decision", koreanTitle: null, sourceKey: "us-scotus", jurisdiction: "United States", contentType: "opinion", language: "en", caseKey: null, caseNumber: null, publishedAt: "2026-09-25T06:00:00.000Z", cleanedText: "constitution today" },
];

const ID = {
  GER_A: articleId(1),
  GER_B: articleId(2),
  FR_A: articleId(3),
  ES_A: articleId(4),
  US_A: articleId(5),
  US_SUB: articleId(6),
  NULLDATE: articleId(7),
  TAG_A: articleId(8),
  TAG_B: articleId(9),
  TODAY: articleId(10),
} as const;

const LATEST_ORDER = [ID.TODAY, ID.TAG_A, ID.TAG_B, ID.FR_A, ID.GER_B, ID.GER_A, ID.ES_A, ID.US_SUB, ID.US_A, ID.NULLDATE];

function publication(index: number): SearchPublicationP3Row {
  return {
    id: publicationId(index),
    article_id: articleId(index),
    state: "published",
    version_id: versionId(index),
    revision: "1",
    created_at: CREATED,
    updated_at: CREATED,
  };
}

function version(row: CorpusRow, index: number): SearchVersionP3Row {
  return {
    id: versionId(index),
    article_id: articleId(index),
    source_key: row.sourceKey,
    jurisdiction: row.jurisdiction,
    institution_name: null,
    content_type: row.contentType,
    original_language: row.language,
    original_title: row.originalTitle,
    korean_title: row.koreanTitle,
    original_published_at: row.publishedAt,
    cleaned_text: row.cleanedText,
    summary_json: null,
    source_metadata: { caseNumber: row.caseNumber, url: URL, raw_text: RAW_TEXT },
    case_key: row.caseKey,
    created_at: CREATED,
  };
}

function tagRows(): SearchTagRow[] {
  const byId = new Map<string, SearchTagRow>();
  for (const row of CORPUS) for (const tag of row.tags ?? []) byId.set(tag.id, tag);
  return [...byId.values()];
}

function articleTagRows(): SearchArticleTagRow[] {
  const rows: SearchArticleTagRow[] = [];
  CORPUS.forEach((row, index) => {
    for (const tag of row.tags ?? []) rows.push({ article_id: articleId(index + 1), tag_id: tag.id });
  });
  return rows;
}

const built = buildSearchProjection({
  publications: CORPUS.map((_row, index) => publication(index + 1)),
  versions: CORPUS.map((row, index) => version(row, index + 1)),
  articles: [],
  tags: tagRows(),
  articleTags: articleTagRows(),
});

function databaseFor(documents: readonly SearchProjectionDocument[], ftsDocuments: readonly SearchProjectionFtsDocument[]): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(emitDatabaseDdl("worldcons_search", d1Schema));
  for (const statement of planSearchProjectionFullRebuild(documents, ftsDocuments).statements) {
    db.prepare(statement.sql).run(...(statement.params as SQLInputValue[]));
  }
  return db;
}

function freshDatabase(): DatabaseSync {
  return databaseFor(built.documents, built.ftsDocuments);
}

function localBinding(db: DatabaseSync): D1RuntimeDatabase {
  return {
    prepare(sql: string): D1RuntimePreparedStatement {
      const statement = db.prepare(sql);
      let bound: SQLInputValue[] = [];
      const chain: D1RuntimePreparedStatement = {
        bind(...values: unknown[]) {
          bound = values as SQLInputValue[];
          return chain;
        },
        async all<T = Record<string, unknown>>() {
          try {
            return { success: true, results: statement.all(...bound) as unknown as T[] };
          } catch (error) {
            return { success: false, error: error instanceof Error ? error.message : String(error) };
          }
        },
      };
      return chain;
    },
  };
}

function makeInput(overrides: Partial<RankedSearchPageInput> = {}): RankedSearchPageInput {
  return { query: "", limit: 50, referenceNow: NOW, ...overrides };
}

async function run(db: DatabaseSync, overrides: Partial<RankedSearchPageInput> = {}): Promise<RankedSearchPagePayload> {
  return runRankedSearchPage({ binding: localBinding(db), input: makeInput(overrides) });
}

function ids(page: RankedSearchPagePayload): string[] {
  return page.entries.map((entry) => entry.id);
}

function assertRankedError(action: () => unknown, code: RankedSearchErrorCode): void {
  assert.throws(
    action,
    (error: unknown) => error instanceof RankedSearchError && error.code === code,
    `expected RankedSearchError(${code})`,
  );
}

async function assertRankedRejects(action: () => Promise<unknown>, code: RankedSearchErrorCode, message?: string): Promise<void> {
  await assert.rejects(
    action,
    (error: unknown) => error instanceof RankedSearchError && error.code === code,
    message ?? `expected RankedSearchError(${code})`,
  );
}

test("the projected corpus encodes exact tag boundaries while keeping tags searchable", () => {
  const doc = built.documents.find((document) => document.article_id === ID.TAG_A);
  assert.ok(doc);
  const tagsText = doc.tags_text ?? "";
  assert.ok(tagsText.includes("\u0001due-process\u0001"), "slug must be boundary-wrapped");
  assert.ok(tagsText.includes("\u0001Due Process\u0001"), "multi-word name must be boundary-wrapped");
  assert.ok(!tagsText.includes("\u0001due process\u0001"), "normalized_name must not be boundary-wrapped");
  assert.ok(!tagsText.includes("\u0001doctrine\u0001"), "type must not be boundary-wrapped");
  assert.ok(tagsText.includes("due process"), "normalized_name must stay searchable");
  assert.ok(tagsText.includes("doctrine"), "type must stay searchable");

  for (const document of built.documents) {
    const haystack = `${document.tags_text ?? ""}\n${document.search_text ?? ""}`;
    assert.ok(!haystack.includes(URL), "tags/search text must never contain a URL");
    assert.ok(!haystack.includes(RAW_TEXT), "tags/search text must never contain raw text");
  }
});

test("primary exact-case reference precedence is alias first and returns one reference", () => {
  assert.equal(primaryCaseReference("klimabeschluss")?.sourceKey, "de-bverfg");
  assert.equal(primaryCaseReference("klimabeschluss")?.caseKey, "1bvr265618");

  const aliasAndUs = primaryCaseReference("Neubauer and 24-781");
  assert.equal(aliasAndUs?.sourceKey, "de-bverfg", "the alias must win over a later US reference");
  assert.equal(aliasAndUs?.caseKey, "1bvr265618");

  assert.equal(primaryCaseReference("1 BvR 2656/18")?.sourceKey, "de-bverfg");
  assert.equal(primaryCaseReference("2026-1194 QPC")?.sourceKey, "fr-conseil-constitutionnel");
  assert.equal(primaryCaseReference("123/2025")?.sourceKey, "es-tribunal-constitucional");
  assert.equal(primaryCaseReference("24-781")?.sourceKey, "us-scotus");
  assert.equal(primaryCaseReference("no reference here"), null);
  assert.equal(primaryCaseReference(42 as unknown as string), null, "a non-string query has no reference");
  assert.equal(primaryCaseReference(null as unknown as string), null);

  assert.equal(
    primaryCaseReference("1 BvR 2656/18 and 24-781")?.caseKey,
    "1bvr265618",
    "BVerfG must precede the US docket",
  );
  assert.equal(
    primaryCaseReference("neubauer and 1 BvR 1234/22")?.caseKey,
    "1bvr265618",
    "the alias must precede a BVerfG display form",
  );
  assert.equal(
    primaryCaseReference("2026-1194 QPC and 123/2025")?.sourceKey,
    "fr-conseil-constitutionnel",
    "France must precede Spain",
  );
  assert.equal(
    primaryCaseReference("123/2025 and 24-781")?.sourceKey,
    "es-tribunal-constitucional",
    "Spain must precede the US docket",
  );
});

test("exact-case branch resolves Germany, France, Spain, US and the alias", async () => {
  const db = freshDatabase();
  const expectSingle = async (query: string, id: string, sourceKey: string) => {
    const { page, plan } = await readRankedSearchPage({ binding: localBinding(db), input: makeInput({ query, count: "exact" }) });
    assert.equal(page.retrievalMode, "exact-case");
    assert.equal(plan.exactCase?.sourceKey, sourceKey);
    assert.deepEqual(ids(page), [id]);
    assert.equal(page.total, 1);
    assert.equal(page.totalIsExact, true);
    assert.equal(page.hasMore, false);
  };
  await expectSingle("1 BvR 2656/18", ID.GER_A, "de-bverfg");
  await expectSingle("klimabeschluss", ID.GER_A, "de-bverfg");
  await expectSingle("2026-1194 QPC", ID.FR_A, "fr-conseil-constitutionnel");
  await expectSingle("123/2025", ID.ES_A, "es-tribunal-constitucional");
  await expectSingle("24-781", ID.US_A, "us-scotus");
});

test("the alias wins over another exact reference in the same query", async () => {
  const db = freshDatabase();
  const { page, plan } = await readRankedSearchPage({ binding: localBinding(db), input: makeInput({ query: "Neubauer and 24-781", count: "exact" }) });
  assert.equal(plan.exactCase?.caseKey, "1bvr265618");
  assert.deepEqual(ids(page), [ID.GER_A], "only the alias article must be returned");
  assert.ok(!ids(page).includes(ID.US_A));
});

test("case_numbers matching is an exact line token, not a substring", async () => {
  const db = freshDatabase();
  const narrow = await run(db, { query: "24-78", count: "exact" });
  assert.deepEqual(ids(narrow), [ID.US_SUB], "the shorter docket must not be shadowed by the longer one");
  const wider = await run(db, { query: "24-781", count: "exact" });
  assert.deepEqual(ids(wider), [ID.US_A], "the longer docket must match only its own line token");
});

test("a conflicting p_source returns an empty exact-case page", async () => {
  const db = freshDatabase();
  const exact = await readRankedSearchPage({ binding: localBinding(db), input: makeInput({ query: "1 BvR 2656/18", source: "us-scotus", count: "exact" }) });
  assert.equal(exact.page.retrievalMode, "exact-case");
  assert.deepEqual(exact.page.entries, []);
  assert.equal(exact.page.total, 0);
  assert.equal(exact.page.hasMore, false);
  assert.equal(exact.page.totalIsExact, true);
  assert.equal(exact.plan.sourceConflict, true);

  const lower = await run(db, { query: "1 BvR 2656/18", source: "us-scotus", count: "none" });
  assert.deepEqual(lower.entries, []);
  assert.equal(lower.totalIsExact, false);
  assert.equal(lower.total, 0);
});

test("empty query is latest regardless of requested mode, ordered date desc nulls last then id", async () => {
  const db = freshDatabase();
  for (const mode of ["fulltext", "semantic", "hybrid"]) {
    const page = await run(db, { query: "", mode, limit: 100, count: "exact" });
    assert.equal(page.retrievalMode, "latest");
    assert.deepEqual(ids(page), LATEST_ORDER);
    assert.equal(page.total, CORPUS.length);
    assert.equal(page.totalIsExact, true);
  }
  const last = await run(db, { query: "", limit: 100 });
  assert.equal(ids(last).at(-1), ID.NULLDATE, "null published dates must sort last");
});

test("limit/offset pagination trims the +1 window and reports hasMore", async () => {
  const db = freshDatabase();
  const page = await run(db, { query: "", limit: 2, offset: 1, count: "none" });
  assert.deepEqual(ids(page), [ID.TAG_A, ID.TAG_B]);
  assert.equal(page.entries.length, 2);
  assert.equal(page.hasMore, true);
  assert.equal(page.total, 4, "lower-bound total = offset + returned + (hasMore ? 1 : 0)");
  assert.equal(page.totalIsExact, false);

  const tail = await run(db, { query: "", limit: 2, offset: 9 });
  assert.deepEqual(ids(tail), [ID.NULLDATE]);
  assert.equal(tail.hasMore, false);
  assert.equal(tail.total, 10, "a drained page still reports the offset-based lower bound");
});

test("count exact returns the true total, planned/estimated/none return the lower bound", async () => {
  const db = freshDatabase();
  const exact = await run(db, { query: "", limit: 3, count: "exact" });
  assert.equal(exact.total, CORPUS.length);
  assert.equal(exact.totalIsExact, true);
  assert.equal(exact.hasMore, true);

  for (const count of ["planned", "estimated", "none"]) {
    const page = await run(db, { query: "", limit: 3, count });
    assert.equal(page.total, 4);
    assert.equal(page.totalIsExact, false);
    assert.equal(page.hasMore, true);
    assert.notEqual(page.total, exact.total, "a lower bound must not be reported as the true total");
  }

  const exactOffset = await run(db, { query: "", limit: 3, offset: 7, count: "exact" });
  assert.equal(exactOffset.total, CORPUS.length, "the exact total is independent of limit and offset");
  assert.equal(exactOffset.totalIsExact, true);
  assert.equal(exactOffset.hasMore, false);
  assert.deepEqual(ids(exactOffset), [ID.US_SUB, ID.US_A, ID.NULLDATE]);

  const exactLarge = await run(db, { query: "", limit: 100, count: "exact" });
  assert.equal(exactLarge.total, CORPUS.length, "the exact total is independent of the requested limit");
  assert.equal(exactLarge.hasMore, false);

  const ranked = (count: string) =>
    buildRankedSearchQueryPlan(resolveRankedSearchInput(makeInput({ query: "", count })));
  assert.equal(ranked("planned").count, null, "planned must not execute a COUNT");
  assert.equal(ranked("estimated").count, null, "estimated must not fake a COUNT");
  assert.equal(ranked("none").count, null, "none must not execute a COUNT");
  assert.ok(ranked("exact").count, "exact must build a real COUNT statement");
});

test("latest filters bind source/jurisdiction/contentType/language/range", async () => {
  const db = freshDatabase();
  assert.deepEqual(ids(await run(db, { query: "", source: "de-bverfg", limit: 100 })), [ID.GER_B, ID.GER_A]);
  assert.deepEqual(ids(await run(db, { query: "", contentType: "order", limit: 100 })), [ID.ES_A]);
  assert.deepEqual(ids(await run(db, { query: "", language: "fr", limit: 100 })), [ID.FR_A]);
  assert.deepEqual(ids(await run(db, { query: "", jurisdiction: "France", limit: 100 })), [ID.FR_A]);

  const week = await run(db, { query: "", range: "week", limit: 100 });
  assert.deepEqual(new Set(ids(week)), new Set([ID.TODAY, ID.TAG_A, ID.TAG_B]));

  const month = await run(db, { query: "", range: "month", limit: 100 });
  assert.deepEqual(new Set(ids(month)), new Set([ID.TODAY, ID.TAG_A, ID.TAG_B, ID.FR_A]));

  const today = await run(db, { query: "", range: "today", limit: 100 });
  assert.deepEqual(ids(today), [ID.TODAY]);
});

test("UTC range thresholds include the exact boundary instant and exclude one millisecond before", async () => {
  const at = (publishedAt: string | null): CorpusRow => ({
    originalTitle: `Boundary ${publishedAt ?? "null"}`,
    koreanTitle: null,
    sourceKey: "us-scotus",
    jurisdiction: "United States",
    contentType: "decision",
    language: "en",
    caseKey: null,
    caseNumber: null,
    publishedAt,
    cleanedText: "constitution boundary",
  });
  const rows: CorpusRow[] = [
    at("2026-09-25T00:00:00.000Z"),
    at("2026-09-24T23:59:59.999Z"),
    at("2026-09-18T00:00:00.000Z"),
    at("2026-09-17T23:59:59.999Z"),
    at("2026-08-26T00:00:00.000Z"),
    at("2026-08-25T23:59:59.999Z"),
    at(null),
  ];
  const custom = buildSearchProjection({
    publications: rows.map((_row, index) => publication(201 + index)),
    versions: rows.map((row, index) => version(row, 201 + index)),
  });
  const db = databaseFor(custom.documents, custom.ftsDocuments);
  const boundary = (index: number) => articleId(201 + index);

  assert.deepEqual(
    ids(await run(db, { query: "", range: "today", limit: 100 })),
    [boundary(0)],
    "an instant equal to the UTC day start must be included; one millisecond earlier must not",
  );
  assert.deepEqual(
    ids(await run(db, { query: "", range: "week", limit: 100 })),
    [boundary(0), boundary(1), boundary(2)],
    "the week boundary is exactly UTC midnight 7 days before the reference instant",
  );
  assert.deepEqual(
    ids(await run(db, { query: "", range: "month", limit: 100 })),
    [boundary(0), boundary(1), boundary(2), boundary(3), boundary(4)],
    "the month boundary is exactly UTC midnight 30 days before the reference instant",
  );
  assert.deepEqual(
    ids(await run(db, { query: "", limit: 100 })),
    [boundary(0), boundary(1), boundary(2), boundary(3), boundary(4), boundary(5), boundary(6)],
    "latest returns every document and sorts NULL dates last",
  );
});

test("equal published dates tie-break by article_id ascending regardless of input order", async () => {
  const same = (publishedAt: string | null, title: string): CorpusRow => ({
    originalTitle: title,
    koreanTitle: null,
    sourceKey: "us-scotus",
    jurisdiction: "United States",
    contentType: "decision",
    language: "en",
    caseKey: null,
    caseNumber: null,
    publishedAt,
    cleanedText: "constitution tiebreak",
  });
  const first = same("2026-09-10T00:00:00.000Z", "Tie First");
  const second = same("2026-09-10T00:00:00.000Z", "Tie Second");
  const nullDate = same(null, "Tie Null");
  const custom = buildSearchProjection({
    publications: [publication(302), publication(301), publication(303)],
    versions: [version(second, 302), version(first, 301), version(nullDate, 303)],
  });
  const db = databaseFor(custom.documents, custom.ftsDocuments);
  assert.deepEqual(
    ids(await run(db, { query: "", limit: 100 })),
    [articleId(301), articleId(302), articleId(303)],
    "equal dates must order by article_id, then NULL dates last",
  );
});

test("tag exact filters match boundary slug/name but not normalized_name/type/substring", async () => {
  const db = freshDatabase();
  assert.deepEqual(ids(await run(db, { query: "", tag: "due-process", limit: 100 })), [ID.TAG_A], "slug exact match");
  assert.deepEqual(ids(await run(db, { query: "", tag: "Due Process", limit: 100 })), [ID.TAG_A], "multi-word name must match exactly");
  assert.deepEqual(ids(await run(db, { query: "", tag: "environment", limit: 100 })), [ID.GER_A], "slug exact match");
  assert.deepEqual(ids(await run(db, { query: "", tag: "Environment", limit: 100 })), [ID.GER_A], "name exact match");
  assert.deepEqual(ids(await run(db, { query: "", tag: "policy", limit: 100 })), [ID.TAG_B]);
  assert.deepEqual(ids(await run(db, { query: "", tag: "due process", limit: 100 })), [], "normalized_name must not satisfy exact tag");
  assert.deepEqual(ids(await run(db, { query: "", tag: "doctrine", limit: 100 })), [], "normalized_name/type must not satisfy exact tag");
  assert.deepEqual(ids(await run(db, { query: "", tag: "topic", limit: 100 })), [], "type must not satisfy exact tag");
  assert.deepEqual(ids(await run(db, { query: "", tag: "Due", limit: 100 })), [], "a substring must not satisfy exact tag");
  assert.deepEqual(ids(await run(db, { query: "", tag: "Process", limit: 100 })), [], "a substring must not satisfy exact tag");
  assert.deepEqual(ids(await run(db, { query: "", tag: "DUE-PROCESS", limit: 100 })), [], "slug matching is case-sensitive");
  assert.deepEqual(ids(await run(db, { query: "", tag: "ENVIRONMENT", limit: 100 })), [], "name matching is case-sensitive");
  assert.deepEqual(
    ids(await run(db, { query: "", tag: "due\u0001 \u0001process", limit: 100 })),
    [],
    "an injected boundary character must not forge an exact tag",
  );
  assert.deepEqual(
    ids(await run(db, { query: "", tag: "process\u0001due-process", limit: 100 })),
    [],
    "boundary characters must not create a cross-value exact match",
  );
});

test("fulltext reuses the M7.2 compiler with exact-title priority and bound filters", async () => {
  const db = freshDatabase();
  const exactTitle = await run(db, { query: "Klimaschutz Beschluss", mode: "fulltext", limit: 100 });
  assert.equal(exactTitle.retrievalMode, "fulltext");
  assert.equal(ids(exactTitle)[0], ID.GER_A, "an exact title must rank first");
  assert.ok(typeof exactTitle.entries[0].score === "number");

  const tagged = await run(db, { query: "constitution", mode: "fulltext", tag: "due-process", limit: 100 });
  assert.deepEqual(ids(tagged), [ID.TAG_A], "tag filter must apply on the fulltext branch");

  const tagOnly = await run(db, { query: "environment", mode: "fulltext", limit: 100 });
  assert.deepEqual(ids(tagOnly), [ID.GER_A], "boundary-wrapped tag values must remain FTS-searchable");

  const policyOnly = await run(db, { query: "policy", mode: "fulltext", limit: 100 });
  assert.deepEqual(ids(policyOnly), [ID.TAG_B]);

  assert.deepEqual(ids(await run(db, { query: "o", mode: "fulltext", limit: 100 })), [], "no artificial one-letter marker tokens");

  const counted = await run(db, { query: "constitution", mode: "fulltext", count: "exact", limit: 100 });
  assert.equal(counted.totalIsExact, true, "fulltext count exact must run a real COUNT");
  assert.equal(counted.total, counted.entries.length);
  assert.equal(counted.total, 9, "France's 'constitutionnel' must not match the 'constitution' token");
});

test("fulltext exact-title priority beats a higher-bm25, more recent non-exact document", async () => {
  const exactRow: CorpusRow = { originalTitle: "Alpha Beta", koreanTitle: null, sourceKey: "us-scotus", jurisdiction: "United States", contentType: "opinion", language: "en", caseKey: null, caseNumber: null, publishedAt: "2026-01-01T00:00:00.000Z", cleanedText: "alpha beta" };
  const floodRow: CorpusRow = { originalTitle: "Gamma Delta", koreanTitle: null, sourceKey: "es-tribunal-constitucional", jurisdiction: "Spain", contentType: "order", language: "es", caseKey: null, caseNumber: null, publishedAt: "2026-09-25T00:00:00.000Z", cleanedText: Array.from({ length: 40 }, () => "alpha beta").join(" ") };
  const custom = buildSearchProjection({
    publications: [publication(101), publication(102)],
    versions: [version(exactRow, 101), version(floodRow, 102)],
  });
  const db = databaseFor(custom.documents, custom.ftsDocuments);
  const page = await run(db, { query: "Alpha Beta", mode: "fulltext", limit: 100 });
  assert.equal(ids(page)[0], articleId(101), "the exact-title document must rank first");

  const exactEntry = page.entries.find((entry) => entry.id === articleId(101));
  const floodEntry = page.entries.find((entry) => entry.id === articleId(102));
  assert.ok(exactEntry && floodEntry, "both documents must be retrieved");
  assert.ok(typeof exactEntry.score === "number" && typeof floodEntry.score === "number");
  assert.ok(
    (floodEntry.score as number) > (exactEntry.score as number),
    `the non-exact flood document must carry the higher bm25 score (${floodEntry.score} > ${exactEntry.score}); `
      + "otherwise this assertion could pass without the exact-title boost reordering the page",
  );

  const plan = buildRankedSearchQueryPlan(resolveRankedSearchInput(makeInput({ query: "Alpha Beta", mode: "fulltext" })));
  assert.ok(plan.page);
  assert.ok(
    plan.page.sql.includes("(instr(search_fts.title, ?) > 0) desc"),
    "exact-title priority must be an ORDER BY expression, not folded into the score",
  );
  assert.ok(!plan.page.sql.includes("Alpha"), "the query text must never appear in SQL");
});

test("fulltext ordering is deterministic with date/id tie-breaks", async () => {
  const db = freshDatabase();
  const first = await run(db, { query: "constitution", mode: "fulltext", limit: 100 });
  const second = await run(db, { query: "constitution", mode: "fulltext", limit: 100 });
  assert.deepEqual(ids(first), ids(second));
  assert.ok(first.entries.length > 0);
});

test("semantic/hybrid without an exact case fail closed with a stable deferred code", async () => {
  const db = freshDatabase();
  for (const mode of ["semantic", "hybrid"]) {
    await assertRankedRejects(() => run(db, { query: "constitution", mode }), "semantic_deferred");
    await assertRankedRejects(() => run(db, { query: "constitution", mode, embedding: [0.1, 0.2] }), "semantic_deferred");
  }
  await assertRankedRejects(
    () => run(db, { query: "constitution" }),
    "semantic_deferred",
    "the default mode is hybrid, so an omitted mode must fail closed too",
  );
  const exact = await run(db, { query: "1 BvR 2656/18", mode: "semantic", count: "exact" });
  assert.equal(exact.retrievalMode, "exact-case", "an exact case must be supported regardless of mode");

  assert.throws(
    () => buildRankedSearchQueryPlan(resolveRankedSearchInput(makeInput({ query: "constitution", mode: "semantic" }))),
    (error: unknown) =>
      error instanceof RankedSearchError && error.code === "semantic_deferred" && error.message.includes(RANKED_SEARCH_SEMANTIC_DEFERRED_MESSAGE),
  );
});

test("malformed fulltext queries fail closed instead of falling back to a lexical scan", async () => {
  const db = freshDatabase();
  await assertRankedRejects(() => run(db, { query: '"unbalanced', mode: "fulltext" }), "invalid_query");
  await assertRankedRejects(() => run(db, { query: '"trailing quote', mode: "fulltext" }), "invalid_query");
  await assertRankedRejects(() => run(db, { query: "constitution -", mode: "fulltext" }), "invalid_query");
  await assertRankedRejects(() => run(db, { query: "-negative", mode: "fulltext" }), "invalid_query");
});

test("invalid query/mode/count/limit/offset/range/filter/clock fail closed with stable codes", () => {
  assertRankedError(() => resolveRankedSearchInput(makeInput({ query: 42 as unknown as string })), "invalid_query");
  assertRankedError(() => resolveRankedSearchInput(makeInput({ query: "a".repeat(201) })), "invalid_query");
  assertRankedError(() => resolveRankedSearchInput(makeInput({ mode: "unexpected" })), "invalid_mode");
  assertRankedError(() => resolveRankedSearchInput(makeInput({ count: "maybe" })), "invalid_count");
  assertRankedError(() => resolveRankedSearchInput(makeInput({ limit: 0 })), "invalid_limit");
  assertRankedError(() => resolveRankedSearchInput(makeInput({ limit: 101 })), "invalid_limit");
  assertRankedError(() => resolveRankedSearchInput(makeInput({ limit: 1.5 })), "invalid_limit");
  assertRankedError(() => resolveRankedSearchInput(makeInput({ offset: -1 })), "invalid_offset");
  assertRankedError(() => resolveRankedSearchInput(makeInput({ offset: 10001 })), "invalid_offset");
  assertRankedError(() => resolveRankedSearchInput(makeInput({ offset: 1.5 })), "invalid_offset");
  assertRankedError(() => resolveRankedSearchInput(makeInput({ range: "year" })), "invalid_range");
  assertRankedError(() => resolveRankedSearchInput(makeInput({ range: "TODAY" })), "invalid_range");
  assertRankedError(() => resolveRankedSearchInput(makeInput({ range: " today" })), "invalid_range");
  assertRankedError(() => resolveRankedSearchInput(makeInput({ source: "" })), "invalid_filter");
  assertRankedError(() => resolveRankedSearchInput(makeInput({ tag: " " })), "invalid_filter");
  assertRankedError(() => resolveRankedSearchInput(makeInput({ referenceNow: "not-a-date" })), "invalid_clock");
});

test("queries are fully parameterized and user text never enters SQL", () => {
  const benign = buildRankedSearchQueryPlan(resolveRankedSearchInput(makeInput({ query: "constitution", mode: "fulltext", tag: "due-process" })));
  const hostile = buildRankedSearchQueryPlan(resolveRankedSearchInput(makeInput({ query: "constitution' OR 1=1", mode: "fulltext", tag: "due-process" })));
  assert.ok(benign.page && hostile.page);
  assert.equal(hostile.page.sql, benign.page.sql, "user text must never change the SQL text");
  assert.notDeepEqual(hostile.page.params, benign.page.params);
  assert.ok(benign.page.sql.includes("search_fts match ?"), "MATCH must be a bound parameter");
  assert.ok(!benign.page.sql.includes("constitution"));
  assert.ok(!benign.page.sql.includes("due-process"));

  const tagPlan = buildRankedSearchQueryPlan(resolveRankedSearchInput(makeInput({ query: "", tag: "due-process" })));
  assert.ok(tagPlan.page);
  assert.ok(tagPlan.page.sql.includes("instr(search_documents.tags_text, ?) > 0"));
  assert.ok(!tagPlan.page.sql.includes("due-process"));

  const exactPlan = buildRankedSearchQueryPlan(resolveRankedSearchInput(makeInput({ query: "24-781", count: "exact" })));
  assert.ok(exactPlan.page && exactPlan.count);
  assert.ok(exactPlan.page.sql.includes("char(10)"), "exact case matching must use separator-safe line tokens");
  assert.ok(!exactPlan.page.sql.includes("24781"));
  assert.ok(exactPlan.page.params.includes("24781"), "the case key must be bound, not interpolated");
  assert.ok(exactPlan.page.params.includes("us-scotus"), "the exact source key must be bound");

  const benignSource = buildRankedSearchQueryPlan(resolveRankedSearchInput(makeInput({ query: "", source: "us-scotus" })));
  const hostileSource = buildRankedSearchQueryPlan(
    resolveRankedSearchInput(makeInput({ query: "", source: "de-bverfg' OR '1'='1" })),
  );
  const benignTag = buildRankedSearchQueryPlan(resolveRankedSearchInput(makeInput({ query: "", tag: "due-process" })));
  const hostileTag = buildRankedSearchQueryPlan(
    resolveRankedSearchInput(makeInput({ query: "", tag: "due-process' OR 1=1 --" })),
  );
  assert.ok(benignSource.page && hostileSource.page && benignTag.page && hostileTag.page);
  assert.equal(hostileSource.page.sql, benignSource.page.sql, "a hostile source must not change the SQL text");
  assert.equal(hostileTag.page.sql, benignTag.page.sql, "a hostile tag must not change the SQL text");
  assert.ok(!hostileTag.page.sql.includes("OR 1=1"));
  for (const statement of [hostileSource.page, hostileTag.page, benign.page]) {
    for (const param of statement.params) {
      assert.ok(typeof param === "string" || typeof param === "number", "every bound value must be a primitive");
    }
  }

  const forbidden = ["articles", "article_publications_p3", "article_content_versions_p3", "worldcons_core"];
  for (const name of forbidden) assert.ok(!new RegExp(`\\b${name}\\b`).test(benign.page.sql));
});

test("the runtime reader fails closed on malformed D1 responses", async () => {
  const db = freshDatabase();
  const input = makeInput({ query: "", count: "none" });

  await assertRankedRejects(() => readRankedSearchPage({ binding: { prepare: () => ({}) } as unknown as D1RuntimeDatabase, input }), "unavailable");

  const nonArray: D1RuntimeDatabase = { prepare: () => makePrepared({ success: true, results: null }) };
  await assertRankedRejects(() => readRankedSearchPage({ binding: nonArray, input }), "invalid_response");

  const failed: D1RuntimeDatabase = { prepare: () => makePrepared({ success: false, error: "boom" }) };
  await assertRankedRejects(() => readRankedSearchPage({ binding: failed, input }), "query_failed");

  const badId: D1RuntimeDatabase = { prepare: () => makePrepared({ success: true, results: [{ article_id: 7 }] }) };
  await assertRankedRejects(() => readRankedSearchPage({ binding: badId, input }), "invalid_response");

  const nullRow: D1RuntimeDatabase = { prepare: () => makePrepared({ success: true, results: [null] }) };
  await assertRankedRejects(() => readRankedSearchPage({ binding: nullRow, input }), "invalid_response");

  const badCount: D1RuntimeDatabase = {
    prepare(sql: string) {
      return makePrepared(sql.includes("count(*)") ? { success: true, results: [{ total: -1 }] } : { success: true, results: [] });
    },
  };
  await assertRankedRejects(() => readRankedSearchPage({ binding: badCount, input: makeInput({ query: "", count: "exact" }) }), "invalid_response");

  const badScore: D1RuntimeDatabase = { prepare: () => makePrepared({ success: true, results: [{ article_id: "a", score: "x" }] }) };
  await assertRankedRejects(() => readRankedSearchPage({ binding: badScore, input: makeInput({ query: "constitution", mode: "fulltext" }) }), "invalid_response");

  const ok = await readRankedSearchPage({ binding: localBinding(db), input: makeInput({ query: "", count: "exact" }) });
  assert.ok(ok.page.entries.length > 0);
  assert.ok(ok.plan.page?.params.length);
});

function makePrepared(payload: Record<string, unknown>): D1RuntimePreparedStatement {
  const chain: D1RuntimePreparedStatement = {
    bind() {
      return chain;
    },
    async all<T = Record<string, unknown>>() {
      return payload as { success?: boolean; results?: T[]; error?: string | null };
    },
  };
  return chain;
}

test("the ranked library stays runtime-neutral with no network code", () => {
  const directory = path.join(rootDir, "lib", "cloudflare", "search-ranked");
  for (const entry of fs.readdirSync(directory)) {
    if (!entry.endsWith(".ts")) continue;
    const source = fs.readFileSync(path.join(directory, entry), "utf8");
    assert.ok(!source.includes('from "node:'), `${entry} must not import a Node builtin`);
    assert.ok(!source.includes("from 'node:"), `${entry} must not import a Node builtin`);
    assert.ok(!source.includes("require("), `${entry} must not require()`);
    assert.ok(!source.includes("fetch("), `${entry} must not perform network I/O`);
    assert.ok(!source.includes("process.env"), `${entry} must not read process.env`);
    assert.ok(!source.includes("d1 execute"), `${entry} must not shell out to D1`);
  }
});

test("SearchRepository stays Supabase-authoritative and search_m7 stays a blocker", () => {
  const selection = fs.readFileSync(path.join(rootDir, "lib", "search", "repository", "index.ts"), "utf8");
  assert.ok(selection.includes("createSupabaseSearchRepository"));
  assert.ok(selection.includes("failClosedSearchRepository"));
  assert.ok(!/d1/i.test(selection), "no D1 search adapter may be selected in M7.3");
  assert.ok(!fs.existsSync(path.join(rootDir, "lib", "search", "repository", "d1-repository.ts")));

  const coverage = fs.readFileSync(path.join(rootDir, "lib", "cloudflare", "d1", "shadow", "coverage.ts"), "utf8");
  assert.ok(coverage.includes("search_m7"), "M6.5 must keep the search_m7 blocker");

  const packageJson = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  assert.equal(packageJson.scripts["test:d1-ranked-search"], "tsx --test tests/d1-ranked-search.test.ts");
  const verifyRelease = packageJson.scripts["verify:release"];
  assert.equal(verifyRelease.split("test:d1-ranked-search").length - 1, 1, "test:d1-ranked-search must run exactly once in verify:release");
});
