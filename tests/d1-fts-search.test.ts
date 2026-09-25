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
  type SearchProjectionDocument,
  type SearchProjectionFtsDocument,
  type SearchPublicationP3Row,
  type SearchVersionP3Row,
} from "../lib/cloudflare/search-projection";
import {
  SearchFtsError,
  buildSearchFtsQuery,
  compileSearchFtsQuery,
  compareRankedIds,
  ftsTitleHasExactTitle,
  readSearchFtsQuery,
  runSearchFtsQuery,
  type SearchFtsErrorCode,
  type SearchFtsQueryInput,
  type SearchFtsRankedRow,
} from "../lib/cloudflare/search-fts";

/**
 * M7.2 local, code-only FTS5 lexical foundation tests.
 *
 * The corpus is synthetic and the executor is the local Node `node:sqlite`
 * binding. This is NOT production Postgres parity evidence: the expected
 * ordering is hand-authored against the documented local D1 semantics only.
 */

const rootDir = process.cwd();
const NOW = "2026-09-25T12:00:00.000Z";
const CREATED = "2026-01-01T00:00:00.000Z";

function articleId(index: number): string {
  return `aaaaaaaa-0000-0000-0000-${String(index).padStart(12, "0")}`;
}
function versionId(index: number): string {
  return `bbbbbbbb-0000-0000-0000-${String(index).padStart(12, "0")}`;
}
function publicationId(index: number): string {
  return `cccccccc-0000-0000-0000-${String(index).padStart(12, "0")}`;
}

interface CorpusRow {
  originalTitle: string | null;
  koreanTitle: string | null;
  sourceKey: string;
  jurisdiction: string;
  contentType: string;
  language: string;
  caseKey: string | null;
  caseNumber: string | null;
  publishedAt: string;
  cleanedText: string;
}

const CORPUS: CorpusRow[] = [
  {
    originalTitle: "First Amendment Standing",
    koreanTitle: "수정헌법 제1조 소송",
    sourceKey: "us-scotus",
    jurisdiction: "United States",
    contentType: "opinion",
    language: "en",
    caseKey: null,
    caseNumber: null,
    publishedAt: "2026-09-25T08:00:00.000Z",
    cleanedText: "constitution first amendment standing doctrine",
  },
  {
    originalTitle: "First Amendment Standing and Article III",
    koreanTitle: "연방대법원 판결",
    sourceKey: "us-scotus",
    jurisdiction: "United States",
    contentType: "opinion",
    language: "en",
    caseKey: null,
    caseNumber: null,
    publishedAt: "2026-09-22T08:00:00.000Z",
    cleanedText: "constitution first amendment standing first amendment standing article three",
  },
  {
    originalTitle: "Décision n° 2026-1194 QPC",
    koreanTitle: null,
    sourceKey: "fr-conseil-constitutionnel",
    jurisdiction: "France",
    contentType: "decision",
    language: "fr",
    caseKey: "2026-1194",
    caseNumber: "2026-1194",
    publishedAt: "2026-09-15T08:00:00.000Z",
    cleanedText: "conseil constitutionnel constitution décision",
  },
  {
    originalTitle: "Recurso de amparo 123-2025",
    koreanTitle: null,
    sourceKey: "es-tribunal-constitucional",
    jurisdiction: "Spain",
    contentType: "order",
    language: "es",
    caseKey: null,
    caseNumber: "123-2025",
    publishedAt: "2026-06-01T08:00:00.000Z",
    cleanedText: "constitution amparo recurso tutela",
  },
  {
    originalTitle: "Klimaschutz Beschluss",
    koreanTitle: null,
    sourceKey: "de-bverfg",
    jurisdiction: "Germany",
    contentType: "decision",
    language: "de",
    caseKey: "1bvr265618",
    caseNumber: "1 BvR 2656/18",
    publishedAt: "2026-08-01T08:00:00.000Z",
    cleanedText: "constitution klimaschutz grundrechte",
  },
  {
    originalTitle: "Loper Bright Enterprises v. Raimondo",
    koreanTitle: null,
    sourceKey: "us-scotus",
    jurisdiction: "United States",
    contentType: "opinion",
    language: "en",
    caseKey: "24-781",
    caseNumber: "24-781",
    publishedAt: "2026-04-29T08:00:00.000Z",
    cleanedText: "constitution chevron deference administrative",
  },
  {
    originalTitle: null,
    koreanTitle: "헌법재판소 결정",
    sourceKey: "us-scotus",
    jurisdiction: "United States",
    contentType: "decision",
    language: "ko",
    caseKey: null,
    caseNumber: null,
    publishedAt: "2026-09-24T08:00:00.000Z",
    cleanedText: "constitution 헌법재판소 결정",
  },
  {
    originalTitle: "Tie Break Decision",
    koreanTitle: null,
    sourceKey: "de-bverfg",
    jurisdiction: "Germany",
    contentType: "decision",
    language: "de",
    caseKey: null,
    caseNumber: null,
    publishedAt: "2026-09-01T08:00:00.000Z",
    cleanedText: "constitution tiebreak doctrine",
  },
  {
    originalTitle: "Tie Break Decision",
    koreanTitle: null,
    sourceKey: "de-bverfg",
    jurisdiction: "Germany",
    contentType: "decision",
    language: "de",
    caseKey: null,
    caseNumber: null,
    publishedAt: "2026-09-10T08:00:00.000Z",
    cleanedText: "constitution tiebreak doctrine",
  },
  {
    originalTitle: "Tie Break Decision",
    koreanTitle: null,
    sourceKey: "de-bverfg",
    jurisdiction: "Germany",
    contentType: "decision",
    language: "de",
    caseKey: null,
    caseNumber: null,
    publishedAt: "2026-09-15T08:00:00.000Z",
    cleanedText: "constitution tiebreak doctrine",
  },
  {
    originalTitle: "Tie Break Decision",
    koreanTitle: null,
    sourceKey: "de-bverfg",
    jurisdiction: "Germany",
    contentType: "decision",
    language: "de",
    caseKey: null,
    caseNumber: null,
    publishedAt: "2026-09-15T08:00:00.000Z",
    cleanedText: "constitution tiebreak doctrine",
  },
];

const ID = {
  A: articleId(1),
  B: articleId(2),
  C: articleId(3),
  D: articleId(4),
  E: articleId(5),
  F: articleId(6),
  G: articleId(7),
  T1: articleId(8),
  T2: articleId(9),
  T3: articleId(10),
  T4: articleId(11),
} as const;

const URL = "https://example.test/secret/path?token=abc";
const RAW_TEXT = "RAW TEXT MUST NOT LEAK";

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

const built = buildSearchProjection({
  publications: CORPUS.map((_row, index) => publication(index + 1)),
  versions: CORPUS.map((row, index) => version(row, index + 1)),
});

function databaseFor(
  documents: readonly SearchProjectionDocument[],
  ftsDocuments: readonly SearchProjectionFtsDocument[],
): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(emitDatabaseDdl("worldcons_search", d1Schema));
  const plan = planSearchProjectionFullRebuild(documents, ftsDocuments);
  for (const statement of plan.statements) {
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

function makeInput(overrides: Partial<SearchFtsQueryInput> = {}): SearchFtsQueryInput {
  return { query: "constitution", limit: 50, range: "latest", referenceNow: NOW, ...overrides };
}

async function search(db: DatabaseSync, overrides: Partial<SearchFtsQueryInput> = {}): Promise<SearchFtsRankedRow[]> {
  return runSearchFtsQuery({ binding: localBinding(db), input: makeInput(overrides) });
}

function ids(rows: readonly SearchFtsRankedRow[]): string[] {
  return rows.map((row) => row.article_id);
}

function assertFtsError(action: () => unknown, code: SearchFtsErrorCode): void {
  assert.throws(
    action,
    (error: unknown) => error instanceof SearchFtsError && error.code === code,
    `expected SearchFtsError(${code})`,
  );
}

test("the sidecar encodes both authoritative titles and never carries a URL or raw text", () => {
  assert.equal(built.documents.length, CORPUS.length);
  assert.equal(built.ftsDocuments.length, CORPUS.length);
  assert.deepEqual(
    built.ftsDocuments.map((ftsDocument) => ftsDocument.article_id),
    built.documents.map((document) => document.article_id),
  );

  const ftsA = built.ftsDocuments.find((ftsDocument) => ftsDocument.article_id === ID.A);
  assert.ok(ftsA);
  assert.ok(ftsTitleHasExactTitle(ftsA.title, "First Amendment Standing"));
  assert.ok(ftsTitleHasExactTitle(ftsA.title, "수정헌법 제1조 소송"));
  assert.ok(!ftsTitleHasExactTitle(ftsA.title, "First Amendment"));

  const ftsG = built.ftsDocuments.find((ftsDocument) => ftsDocument.article_id === ID.G);
  assert.ok(ftsG);
  assert.ok(ftsTitleHasExactTitle(ftsG.title, "헌법재판소 결정"));

  for (const ftsDocument of built.ftsDocuments) {
    const haystack = `${ftsDocument.title}\n${ftsDocument.search_text}\n${ftsDocument.tags_text}\n${ftsDocument.case_numbers}`;
    assert.ok(!haystack.includes(URL), "the sidecar must never contain a URL");
    assert.ok(!haystack.includes(RAW_TEXT), "the sidecar must never contain raw text");
  }
});

test("title boundaries never inject artificial single-character tokens", async () => {
  const db = freshDatabase();

  assert.deepEqual(ids(await search(db, { query: "o", limit: 100 })), [], "a bare 'o' must not match every encoded title");
  assert.deepEqual(ids(await search(db, { query: "k", limit: 100 })), [], "a bare 'k' must not match every encoded title");
});

test("exact original-title and exact Korean-title queries win when both titles exist", async () => {
  const db = freshDatabase();

  const original = await search(db, { query: "First Amendment Standing" });
  assert.equal(ids(original)[0], ID.A, "query equal to original_title must take exact-title priority");

  const korean = await search(db, { query: "수정헌법 제1조 소송" });
  assert.equal(ids(korean)[0], ID.A, "query equal to korean_title must take exact-title priority");

  const nearMatch = await search(db, { query: "First Amendment Standing Article" });
  assert.notEqual(ids(nearMatch)[0], ID.A, "a non-exact query must not receive the exact-title priority");
});

test("exact-title priority beats a higher-bm25, more recent non-exact document", async () => {
  const EXACT = articleId(101);
  const FLOOD = articleId(102);
  const exactRow: CorpusRow = {
    originalTitle: "Alpha Beta",
    koreanTitle: null,
    sourceKey: "us-scotus",
    jurisdiction: "United States",
    contentType: "opinion",
    language: "en",
    caseKey: null,
    caseNumber: null,
    publishedAt: "2026-01-01T00:00:00.000Z",
    cleanedText: "alpha beta",
  };
  const floodRow: CorpusRow = {
    originalTitle: "Gamma Delta",
    koreanTitle: null,
    sourceKey: "es-tribunal-constitucional",
    jurisdiction: "Spain",
    contentType: "order",
    language: "es",
    caseKey: null,
    caseNumber: null,
    publishedAt: "2026-09-25T00:00:00.000Z",
    cleanedText: Array.from({ length: 40 }, () => "alpha beta").join(" "),
  };
  const custom = buildSearchProjection({
    publications: [publication(101), publication(102)],
    versions: [version(exactRow, 101), version(floodRow, 102)],
  });
  const db = databaseFor(custom.documents, custom.ftsDocuments);

  const { rows } = await readSearchFtsQuery({ binding: localBinding(db), input: makeInput({ query: "Alpha Beta", limit: 100 }) });
  const flood = rows.find((row) => row.article_id === FLOOD);
  assert.ok(flood, "the flooding document must match");
  assert.equal(rows[0]?.article_id, EXACT, "the exact-title document must rank first");
  assert.ok(
    rows[0].relevance_score < flood.relevance_score,
    "the exact-title document must win even though its bm25 score is lower",
  );
});

test("plain terms AND, quoted phrases, OR and negative terms follow the documented subset", async () => {
  const db = freshDatabase();

  const andResult = await search(db, { query: "constitution amparo" });
  assert.deepEqual(ids(andResult), [ID.D], "plain terms must be AND semantics");

  const phrase = await search(db, { query: '"conseil constitutionnel"' });
  assert.deepEqual(ids(phrase), [ID.C], "a quoted phrase must match adjacent tokens");

  const orResult = await search(db, { query: "amparo OR klimaschutz", limit: 100 });
  assert.deepEqual(new Set(ids(orResult)), new Set([ID.D, ID.E]), "OR must union positive clauses");

  const negative = await search(db, { query: "constitution -amparo", limit: 100 });
  assert.ok(ids(negative).includes(ID.A), "negative must not exclude the positive matches");
  assert.ok(!ids(negative).includes(ID.D), "negative term must exclude the negated article");
});

test("optional source, jurisdiction, contentType and language filters bind correctly", async () => {
  const db = freshDatabase();

  const us = await search(db, { query: "constitution", jurisdiction: "United States", limit: 100 });
  assert.deepEqual(new Set(ids(us)), new Set([ID.A, ID.B, ID.F, ID.G]));

  const france = await search(db, { query: "constitution", source: "fr-conseil-constitutionnel", limit: 100 });
  assert.deepEqual(ids(france), [ID.C]);

  const orders = await search(db, { query: "constitution", contentType: "order", limit: 100 });
  assert.deepEqual(ids(orders), [ID.D]);

  const french = await search(db, { query: "constitution", language: "fr", limit: 100 });
  assert.deepEqual(ids(french), [ID.C]);

  const combined = await search(db, { query: "constitution", jurisdiction: "Spain", contentType: "order", limit: 100 });
  assert.deepEqual(ids(combined), [ID.D]);
});

test("latest/today/week/month ranges follow the injected UTC clock", async () => {
  const db = freshDatabase();

  const latest = await search(db, { query: "constitution", range: "latest", limit: 100 });
  assert.equal(latest.length, CORPUS.length);

  const today = await search(db, { query: "constitution", range: "today", limit: 100 });
  assert.deepEqual(ids(today), [ID.A]);

  const week = await search(db, { query: "constitution", range: "week", limit: 100 });
  assert.deepEqual(new Set(ids(week)), new Set([ID.A, ID.B, ID.G]));

  const month = await search(db, { query: "constitution", range: "month", limit: 100 });
  assert.deepEqual(
    new Set(ids(month)),
    new Set([ID.A, ID.B, ID.C, ID.G, ID.T1, ID.T2, ID.T3, ID.T4]),
  );
  assert.ok(!ids(month).includes(ID.E), "an article older than 30 UTC days must be excluded from month");

  const shifted = await search(db, { query: "constitution", range: "today", referenceNow: "2026-09-26T00:00:00.000Z" });
  assert.deepEqual(ids(shifted), [], "the range boundary must follow the injected clock");
});

test("bm25 ordering is deterministic with exact-title, date and id tie-breaks", async () => {
  const db = freshDatabase();

  const first = await search(db, { query: "constitution", limit: 100 });
  const second = await search(db, { query: "constitution", limit: 100 });
  assert.deepEqual(ids(first), ids(second), "the same query must produce the same order");
  assert.equal(first.length, CORPUS.length);

  const tieIds = ids(first).filter((id) => [ID.T1, ID.T2, ID.T3, ID.T4].includes(id));
  assert.deepEqual(
    tieIds,
    [ID.T3, ID.T4, ID.T2, ID.T1],
    "equal bm25 must break by original_published_at DESC then article_id ASC",
  );
});

test("multilingual terms and case-number identifiers are searchable and filterable", async () => {
  const db = freshDatabase();

  const germanCase = await search(db, { query: '"1 BvR 2656/18"', limit: 100 });
  assert.ok(ids(germanCase).includes(ID.E), "German case number must be searchable");
  const byCaseKey = await search(db, { query: "1bvr265618", limit: 100 });
  assert.ok(ids(byCaseKey).includes(ID.E), "canonical German case key must be searchable");

  const usDocket = await search(db, { query: "24-781", limit: 100 });
  assert.ok(ids(usDocket).includes(ID.F), "US docket number must be searchable");

  const french = await search(db, { query: "conseil", limit: 100 });
  assert.ok(ids(french).includes(ID.C));
  const spanish = await search(db, { query: "amparo", limit: 100 });
  assert.deepEqual(ids(spanish), [ID.D]);
  const korean = await search(db, { query: "헌법재판소", limit: 100 });
  assert.ok(ids(korean).includes(ID.G), "Korean legal term must be searchable");
});

test("invalid query, limit, range, filter and clock inputs fail closed with stable codes", () => {
  assertFtsError(() => compileSearchFtsQuery(""), "invalid_query");
  assertFtsError(() => compileSearchFtsQuery("   "), "invalid_query");
  assertFtsError(() => compileSearchFtsQuery("a".repeat(201)), "invalid_query");
  assertFtsError(() => compileSearchFtsQuery(42), "invalid_query");
  assertFtsError(() => compileSearchFtsQuery('"unbalanced'), "malformed_query");
  assertFtsError(() => compileSearchFtsQuery("foo OR"), "malformed_query");
  assertFtsError(() => compileSearchFtsQuery("OR foo"), "malformed_query");
  assertFtsError(() => compileSearchFtsQuery("-only"), "negative_only");
  assertFtsError(() => compileSearchFtsQuery("???"), "malformed_query");

  assertFtsError(() => buildSearchFtsQuery(makeInput({ limit: 0 })), "invalid_limit");
  assertFtsError(() => buildSearchFtsQuery(makeInput({ limit: 101 })), "invalid_limit");
  assertFtsError(() => buildSearchFtsQuery(makeInput({ limit: 1.5 })), "invalid_limit");
  assertFtsError(() => buildSearchFtsQuery(makeInput({ limit: "5" as unknown as number })), "invalid_limit");
  assertFtsError(() => buildSearchFtsQuery(makeInput({ range: "year" })), "invalid_range");
  assertFtsError(() => buildSearchFtsQuery(makeInput({ source: "" })), "invalid_filter");
  assertFtsError(() => buildSearchFtsQuery(makeInput({ referenceNow: "not-a-date" })), "invalid_clock");
});

test("the MATCH expression is bound and user text never enters SQL", () => {
  const benign = buildSearchFtsQuery(makeInput({ query: "constitution" }));
  const hostile = buildSearchFtsQuery(makeInput({ query: "constitution' OR 1=1" }));
  assert.equal(hostile.sql, benign.sql, "user text must never change the SQL text");
  assert.notEqual(hostile.params[0], benign.params[0]);
  assert.ok(benign.sql.includes("search_fts match ?"), "MATCH must be a bound parameter");
  assert.ok(benign.sql.includes("instr(search_fts.title, ?)"), "exact title must be a bound parameter");
  assert.ok(!benign.sql.includes("constitution"));
  const forbidden = ["articles", "article_publications_p3", "article_content_versions_p3", "worldcons_core"];
  for (const name of forbidden) assert.ok(!new RegExp(`\\b${name}\\b`).test(benign.sql));

  const ftsOperators = buildSearchFtsQuery(makeInput({ query: "NEAR foo* (bar) :baz ^qux" }));
  assert.ok(!ftsOperators.sql.includes("NEAR"));
  assert.ok(ftsOperators.matchExpression.includes('"NEAR"'));
  assert.ok(ftsOperators.matchExpression.includes('"foo*"'));
});

test("the runtime reader fails closed on malformed D1 responses", async () => {
  const db = freshDatabase();
  const validBinding = localBinding(db);
  const input = makeInput();

  await assert.rejects(
    runSearchFtsQuery({ binding: { prepare: () => ({}) } as unknown as D1RuntimeDatabase, input }),
    (error: unknown) => error instanceof SearchFtsError && error.code === "unavailable",
  );

  const nonArray: D1RuntimeDatabase = { prepare: () => makePrepared({ success: true, results: null }) };
  await assert.rejects(
    runSearchFtsQuery({ binding: nonArray, input }),
    (error: unknown) => error instanceof SearchFtsError && error.code === "invalid_response",
  );

  const failed: D1RuntimeDatabase = { prepare: () => makePrepared({ success: false, error: "boom" }) };
  await assert.rejects(
    runSearchFtsQuery({ binding: failed, input }),
    (error: unknown) => error instanceof SearchFtsError && error.code === "query_failed",
  );

  const badId: D1RuntimeDatabase = { prepare: () => makePrepared({ success: true, results: [{ article_id: 7, relevance_score: 1 }] }) };
  await assert.rejects(
    runSearchFtsQuery({ binding: badId, input }),
    (error: unknown) => error instanceof SearchFtsError && error.code === "invalid_response",
  );

  const badScore: D1RuntimeDatabase = { prepare: () => makePrepared({ success: true, results: [{ article_id: "a", relevance_score: "x" }] }) };
  await assert.rejects(
    runSearchFtsQuery({ binding: badScore, input }),
    (error: unknown) => error instanceof SearchFtsError && error.code === "invalid_response",
  );

  const nullRow: D1RuntimeDatabase = { prepare: () => makePrepared({ success: true, results: [null] }) };
  await assert.rejects(
    runSearchFtsQuery({ binding: nullRow, input }),
    (error: unknown) => error instanceof SearchFtsError && error.code === "invalid_response",
  );

  const ok = await readSearchFtsQuery({ binding: validBinding, input });
  assert.ok(ok.rows.length > 0);
  assert.ok(ok.statement.params.length > 0);
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

test("parity metrics are deterministic and order-sensitive", () => {
  const expected = ["a", "b", "c", "d"];
  const report = compareRankedIds(expected, ["a", "b", "c", "d"], { k: 3 });
  assert.deepEqual(report, compareRankedIds(expected, ["a", "b", "c", "d"], { k: 3 }));
  assert.equal(report.exactOrder, true);
  assert.equal(report.sameSet, true);
  assert.equal(report.overlapAtKCount, 3);
  assert.equal(report.overlapAtK, 1);
  assert.equal(report.prefixMatchCount, 4);
  assert.deepEqual(report.missing, []);
  assert.deepEqual(report.extra, []);

  const reordered = compareRankedIds(expected, ["a", "c", "b", "d"], { k: 2 });
  assert.equal(reordered.exactOrder, false);
  assert.equal(reordered.sameSet, true);
  assert.equal(reordered.overlapAtKCount, 1);
  assert.equal(reordered.prefixMatchCount, 1);

  const partial = compareRankedIds(["a", "b"], ["a", "b", "z"], { k: 5 });
  assert.deepEqual(partial.missing, []);
  assert.deepEqual(partial.extra, ["z"]);
  assert.equal(partial.prefixMatchCount, 2);

  const missing = compareRankedIds(["a", "b", "c"], ["a", "c"], { k: 5 });
  assert.deepEqual(missing.missing, ["b"]);
  assert.deepEqual(missing.extra, []);
});

test("SearchRepository stays Supabase-authoritative and search_m7 stays a blocker", () => {
  const selection = fs.readFileSync(path.join(rootDir, "lib", "search", "repository", "index.ts"), "utf8");
  assert.ok(selection.includes("createSupabaseSearchRepository"));
  assert.ok(selection.includes("failClosedSearchRepository"));
  assert.ok(!/d1/i.test(selection), "no D1 search adapter may be selected in M7.2");
  assert.ok(!fs.existsSync(path.join(rootDir, "lib", "search", "repository", "d1-repository.ts")));

  const coverage = fs.readFileSync(path.join(rootDir, "lib", "cloudflare", "d1", "shadow", "coverage.ts"), "utf8");
  assert.ok(coverage.includes("search_m7"), "M6.5 must keep the search_m7 blocker");

  const packageJson = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  assert.equal(packageJson.scripts["test:d1-fts-search"], "tsx --test tests/d1-fts-search.test.ts");
  const verifyRelease = packageJson.scripts["verify:release"];
  const occurrences = verifyRelease.split("test:d1-fts-search").length - 1;
  assert.equal(occurrences, 1, "test:d1-fts-search must run exactly once in verify:release");
});

test("the search-fts and search-projection libraries stay runtime-neutral with no network code", () => {
  for (const relative of [
    path.join("lib", "cloudflare", "search-fts"),
    path.join("lib", "cloudflare", "search-projection"),
  ]) {
    const directory = path.join(rootDir, relative);
    for (const entry of fs.readdirSync(directory)) {
      if (!entry.endsWith(".ts")) continue;
      const source = fs.readFileSync(path.join(directory, entry), "utf8");
      const label = `${relative}/${entry}`;
      assert.ok(!source.includes('from "node:'), `${label} must not import a Node builtin`);
      assert.ok(!source.includes("from 'node:"), `${label} must not import a Node builtin`);
      assert.ok(!source.includes("require("), `${label} must not require()`);
      assert.ok(!source.includes("fetch("), `${label} must not perform network I/O`);
      assert.ok(!source.includes("process.env"), `${label} must not read process.env`);
      assert.ok(!source.includes("d1 execute"), `${label} must not shell out to D1`);
    }
  }
});
