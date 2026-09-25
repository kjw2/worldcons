import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  SEARCH_DOCUMENT_COLUMNS,
  SEARCH_FTS_COLUMNS,
  SEARCH_PROJECTION_SCOPE,
  SEARCH_PROJECTION_VERSION,
  SearchProjectionError,
  buildSearchProjection,
  hashSearchProjectionDocuments,
  planSearchProjectionFullRebuild,
  planSearchProjectionIncrementalSync,
  searchDocumentChecksum,
  searchProjectionPlanSummary,
  selectPublishedSearchProjectionSources,
  verifySearchProjection,
  type SearchProjectionDocument,
  type SearchPublicationP3Row,
  type SearchVersionP3Row,
} from "../lib/cloudflare/search-projection";
import { searchTables } from "../lib/cloudflare/d1/schema/worldcons-search";
import { ftsTitleHasExactTitle } from "../lib/cloudflare/search-fts";

const rootDir = process.cwd();
const LIB_DIR = path.join(rootDir, "lib", "cloudflare", "search-projection");
const CLI_PATH = path.join(rootDir, "scripts", "d1-search-projection.ts");

const ARTICLE_A = "11111111-0000-0000-0000-000000000001";
const ARTICLE_B = "22222222-0000-0000-0000-000000000002";
const VERSION_A = "aaaaaaaa-0000-0000-0000-00000000000a";
const VERSION_B = "bbbbbbbb-0000-0000-0000-00000000000b";
const PUB_A = "cccccccc-0000-0000-0000-00000000000c";
const PUB_B = "dddddddd-0000-0000-0000-00000000000d";
const TAG_1 = "eeeeeeee-0000-0000-0000-00000000000e";
const TAG_2 = "ffffffff-0000-0000-0000-00000000000f";

function publication(overrides: Partial<SearchPublicationP3Row> = {}): SearchPublicationP3Row {
  return {
    id: PUB_A,
    article_id: ARTICLE_A,
    state: "published",
    version_id: VERSION_A,
    revision: "1",
    created_at: "2026-01-02T00:00:00.000Z",
    updated_at: "2026-01-03T00:00:00.000Z",
    ...overrides,
  };
}

function version(overrides: Partial<SearchVersionP3Row> = {}): SearchVersionP3Row {
  return {
    id: VERSION_A,
    article_id: ARTICLE_A,
    source_key: "de-bverfg",
    jurisdiction: "Germany",
    institution_name: "Bundesverfassungsgericht",
    content_type: "decision",
    original_language: "de",
    original_title: "Original Title",
    korean_title: "한국어 제목",
    original_published_at: "2026-01-01T00:00:00.000Z",
    cleaned_text: "cleaned body text",
    summary_json: { summary: { coreSummary: ["핵심 요약"] } },
    source_metadata: { caseNumber: "1 BvR 2656/18" },
    case_key: "1bvr265618",
    created_at: "2026-01-02T00:00:00.000Z",
    summarized_at: "2026-01-02T12:00:00.000Z",
    ...overrides,
  };
}

function singleDocument(input: {
  publications?: SearchPublicationP3Row[];
  versions?: SearchVersionP3Row[];
  articles?: { id: string; review_state?: string | null }[];
  tags?: { id: string; slug: string; name?: string | null; normalized_name?: string | null; type?: string | null }[];
  articleTags?: { article_id: string; tag_id: string }[];
}): SearchProjectionDocument {
  const result = buildSearchProjection({
    publications: input.publications ?? [publication()],
    versions: input.versions ?? [version()],
    articles: input.articles ?? [],
    tags: input.tags ?? [],
    articleTags: input.articleTags ?? [],
  });
  assert.equal(result.documents.length, 1, "fixture must project exactly one document");
  return result.documents[0];
}

test("P3 publication authority omits non-published rows and fails closed on ambiguity", () => {
  const draft = publication({ id: PUB_A, article_id: ARTICLE_A, state: "draft", version_id: VERSION_A });
  const review = publication({ id: "cccccccc-0000-0000-0000-0000000000cc", article_id: ARTICLE_B, state: "in_review", version_id: VERSION_B });
  const withdrawn = publication({ id: "cccccccc-0000-0000-0000-0000000000dd", article_id: "33333333-0000-0000-0000-000000000003", state: "withdrawn", version_id: "cccccccc-0000-0000-0000-0000000000ee" });
  const published = publication({ id: "cccccccc-0000-0000-0000-0000000000ff", article_id: "44444444-0000-0000-0000-000000000004", version_id: "aaaaaaaa-0000-0000-0000-000000000044" });
  const versions = [
    version(),
    version({ id: VERSION_B, article_id: ARTICLE_B }),
    version({ id: "aaaaaaaa-0000-0000-0000-000000000044", article_id: "44444444-0000-0000-0000-000000000004" }),
  ];
  const selected = selectPublishedSearchProjectionSources({
    publications: [draft, review, withdrawn, published],
    versions,
  });
  assert.deepEqual(selected.map((entry) => entry.version.article_id), ["44444444-0000-0000-0000-000000000004"]);

  assert.throws(
    () =>
      selectPublishedSearchProjectionSources({
        publications: [publication()],
        versions: [version({ article_id: ARTICLE_B })],
      }),
    (error: unknown) => error instanceof SearchProjectionError && error.code === "publication_version_mismatch",
  );
  assert.throws(
    () =>
      selectPublishedSearchProjectionSources({
        publications: [publication()],
        versions: [],
      }),
    (error: unknown) => error instanceof SearchProjectionError && error.code === "missing_publication_version",
  );
  assert.throws(
    () =>
      selectPublishedSearchProjectionSources({
        publications: [
          publication({ id: PUB_A }),
          publication({ id: PUB_B, article_id: ARTICLE_A, version_id: VERSION_A }),
        ],
        versions: [version()],
      }),
    (error: unknown) => error instanceof SearchProjectionError && error.code === "duplicate_published_authority",
  );
});

test("the authoritative version snapshot wins over legacy base article content", () => {
  const document = singleDocument({
    articles: [
      {
        id: ARTICLE_A,
        review_state: "approved",
        // Deliberately mimics a legacy base article with different content; only
        // review_state may be read.
        original_title: "LEGACY BASE TITLE",
        korean_title: "LEGACY BASE KOREAN",
        cleaned_text: "LEGACY BASE BODY",
      } as { id: string; review_state?: string | null },
    ],
  });
  assert.equal(document.display_title, "한국어 제목");
  assert.equal(document.review_state, "approved");
  assert.ok(document.search_text?.includes("cleaned body text"));
  assert.ok(!document.search_text?.includes("LEGACY BASE BODY"));
  assert.ok(!document.search_text?.includes("LEGACY BASE TITLE"));
  assert.ok(!document.display_title?.includes("LEGACY BASE KOREAN"));
});

test("title, case, search and tag mapping is deterministic and input-order independent", () => {
  const tags = [
    { id: TAG_2, slug: "zeta", name: "Zeta", normalized_name: "zeta", type: "topic" },
    { id: TAG_1, slug: "alpha", name: "Alpha", normalized_name: "alpha", type: "doctrine" },
  ];
  const articleTags = [
    { article_id: ARTICLE_A, tag_id: TAG_2 },
    { article_id: ARTICLE_A, tag_id: TAG_1 },
  ];
  const forward = buildSearchProjection({
    publications: [publication()],
    versions: [version()],
    articles: [{ id: ARTICLE_A, review_state: null }],
    tags,
    articleTags,
  });
  const reversed = buildSearchProjection({
    publications: [publication()],
    versions: [version()],
    articles: [{ id: ARTICLE_A, review_state: null }],
    tags: [...tags].reverse(),
    articleTags: [...articleTags].reverse(),
  });
  assert.deepEqual(reversed.documents, forward.documents);
  assert.deepEqual(reversed.manifest, forward.manifest);

  const document = forward.documents[0];
  assert.equal(document.display_title, "한국어 제목");
  assert.equal(document.case_numbers, "1 BvR 2656/18\n1bvr265618");
  assert.equal(document.tags_text, "alpha Alpha doctrine zeta Zeta topic");
  assert.equal(document.publication_state, "published");
  assert.equal(document.projection_version, SEARCH_PROJECTION_VERSION);
  assert.equal(document.updated_at, "2026-01-03T00:00:00.000Z");

  const body = { ...document };
  delete (body as { checksum?: string }).checksum;
  assert.equal(searchDocumentChecksum(body), document.checksum);
  assert.notEqual(
    hashSearchProjectionDocuments([{ ...document, search_text: "different" }]),
    hashSearchProjectionDocuments([document]),
  );
});

test("tag hydration is slug-ordered, deduped, and never reads URLs or raw text", () => {
  const url = "https://example.test/secret/path?token=abc";
  const document = singleDocument({
    versions: [
      version({
        source_metadata: { caseNumber: "1 BvR 2656/18", url, originalUrl: url, raw_text: "RAW TEXT MUST NOT LEAK" },
        raw_text: "RAW TEXT MUST NOT LEAK",
      } as Partial<SearchVersionP3Row>),
    ],
    tags: [
      { id: TAG_1, slug: "due-process", name: "Due Process", normalized_name: "due process", type: "doctrine" },
      { id: TAG_2, slug: "due-process", name: "Due Process", normalized_name: "due process", type: "doctrine" },
    ],
    articleTags: [{ article_id: ARTICLE_A, tag_id: TAG_1 }, { article_id: ARTICLE_A, tag_id: TAG_2 }],
  });
  const haystack = `${document.search_text ?? ""}\n${document.tags_text ?? ""}\n${document.case_numbers ?? ""}`;
  assert.ok(!haystack.includes(url));
  assert.ok(!haystack.includes("RAW TEXT MUST NOT LEAK"));
  assert.equal(document.tags_text, "due-process Due Process due process doctrine");

  assert.throws(
    () =>
      buildSearchProjection({
        publications: [publication()],
        versions: [version()],
        tags: [{ id: TAG_1, slug: "alpha" }],
        articleTags: [
          { article_id: ARTICLE_A, tag_id: TAG_1 },
          { article_id: ARTICLE_A, tag_id: TAG_1 },
        ],
      }),
    (error: unknown) => error instanceof SearchProjectionError && error.code === "duplicate_article_tag",
  );
  assert.throws(
    () =>
      buildSearchProjection({
        publications: [publication()],
        versions: [version()],
        tags: [{ id: TAG_1, slug: "alpha" }],
        articleTags: [{ article_id: ARTICLE_A, tag_id: TAG_2 }],
      }),
    (error: unknown) => error instanceof SearchProjectionError && error.code === "missing_tag",
  );
});

test("the projected document shape exactly matches the authored D1 search schema", () => {
  const searchDocuments = searchTables.find((table) => table.name === "search_documents");
  const searchFts = searchTables.find((table) => table.name === "search_fts");
  assert.ok(searchDocuments && searchFts);
  assert.deepEqual([...SEARCH_DOCUMENT_COLUMNS].sort(), searchDocuments.columns.map((column) => column.name).sort());
  const ftsColumns = (searchFts.virtual?.columns ?? []).map((column) => column.replace(/\s+UNINDEXED$/u, ""));
  assert.deepEqual([...SEARCH_FTS_COLUMNS].sort(), ftsColumns.sort());

  const document = singleDocument({});
  assert.deepEqual(Object.keys(document).sort(), [...SEARCH_DOCUMENT_COLUMNS].sort());
  for (const required of ["article_id", "projection_version", "updated_at", "checksum"]) {
    assert.notEqual((document as unknown as Record<string, unknown>)[required], null);
  }
});

test("the FTS sidecar encodes both authoritative titles 1:1 with search_documents", () => {
  const { documents, ftsDocuments } = buildSearchProjection({ publications: [publication()], versions: [version()] });
  assert.equal(ftsDocuments.length, documents.length, "sidecar must stay 1:1 with documents");
  assert.deepEqual(
    ftsDocuments.map((ftsDocument) => ftsDocument.article_id),
    documents.map((document) => document.article_id),
    "sidecar identity/order must match search_documents",
  );

  const ftsDocument = ftsDocuments[0];
  assert.ok(ftsTitleHasExactTitle(ftsDocument.title, "Original Title"), "original title must be exactly matchable");
  assert.ok(ftsTitleHasExactTitle(ftsDocument.title, "한국어 제목"), "Korean title must be exactly matchable");
  assert.ok(!ftsTitleHasExactTitle(ftsDocument.title, "Original"), "a partial title must not be an exact match");
  assert.ok(ftsDocument.title.includes("original title"), "sidecar title must still be searchable text");
  assert.ok(ftsDocument.title.includes("한국어 제목"), "sidecar title must still carry the Korean title");

  const haystack = `${ftsDocument.title}\n${ftsDocument.search_text}`;
  assert.ok(!haystack.includes("https://"), "the sidecar must never contain a URL");
  assert.ok(!haystack.includes("raw_text"), "the sidecar must never contain raw text");

  const missingKorean = buildSearchProjection({
    publications: [publication()],
    versions: [version({ korean_title: null })],
  });
  assert.ok(ftsTitleHasExactTitle(missingKorean.ftsDocuments[0].title, "Original Title"));
  assert.ok(!ftsTitleHasExactTitle(missingKorean.ftsDocuments[0].title, "한국어 제목"));
});

test("full rebuild plan is deterministic, bound and scoped to worldcons_search only", () => {
  const { documents, ftsDocuments } = buildSearchProjection({
    publications: [publication(), publication({ id: PUB_B, article_id: ARTICLE_B, version_id: VERSION_B })],
    versions: [version(), version({ id: VERSION_B, article_id: ARTICLE_B, source_key: "us-scotus", jurisdiction: "United States", content_type: "opinion", original_language: "en", original_title: "Case B", korean_title: null, case_key: "24-781", source_metadata: { caseNumber: "24-781" } })],
  });
  assert.equal(documents.length, 2);

  const forward = planSearchProjectionFullRebuild(documents, ftsDocuments);
  const reversed = planSearchProjectionFullRebuild([...documents].reverse(), [...ftsDocuments].reverse());
  assert.deepEqual(reversed.statements, forward.statements);
  assert.equal(forward.scope, SEARCH_PROJECTION_SCOPE);
  assert.equal(forward.operation, "full-rebuild");
  assert.equal(forward.destructive, true);
  assert.equal(forward.atomic, false);
  assert.equal(forward.executionDeferred, true);
  assert.equal(forward.statements[0].sql, "DELETE FROM search_fts");
  assert.equal(forward.statements[1].sql, "DELETE FROM search_documents");

  const forbidden = ["articles", "article_publications_p3", "article_content_versions_p3", "article_tags", "worldcons_core", "worldcons_ingest", "worldcons_ops", "tags"];
  for (const statement of forward.statements) {
    for (const name of forbidden) {
      assert.ok(!new RegExp(`\\b${name}\\b`).test(statement.sql), `plan SQL must not mention ${name}: ${statement.sql}`);
    }
    if (statement.params.length > 0) assert.ok(statement.sql.includes("?"));
    assert.ok(!statement.sql.includes(ARTICLE_A));
    assert.ok(!statement.sql.includes("cleaned body text"));
  }
  const documentInserts = forward.statements.filter((statement) => statement.sql.startsWith("INSERT INTO search_documents"));
  const ftsInserts = forward.statements.filter((statement) => statement.sql.startsWith("INSERT INTO search_fts"));
  assert.equal(documentInserts.length, 2);
  assert.equal(ftsInserts.length, 2);
  for (const statement of documentInserts) assert.equal(statement.params.length, SEARCH_DOCUMENT_COLUMNS.length);
  for (const statement of ftsInserts) assert.equal(statement.params.length, SEARCH_FTS_COLUMNS.length);

  const summary = searchProjectionPlanSummary(forward);
  assert.ok(!JSON.stringify(summary).includes("cleaned body text"));
});

test("incremental plan updates both sides for add/change/remove and is a no-op when identical", () => {
  const ARTICLE_C = "33333333-0000-0000-0000-000000000003";
  const VERSION_C = "cccccccc-0000-0000-0000-0000000000cc";
  const PUB_C = "cccccccc-0000-0000-0000-0000000000c1";
  const { documents, ftsDocuments } = buildSearchProjection({
    publications: [
      publication(),
      publication({ id: PUB_B, article_id: ARTICLE_B, version_id: VERSION_B }),
      publication({ id: PUB_C, article_id: ARTICLE_C, version_id: VERSION_C }),
    ],
    versions: [
      version(),
      version({ id: VERSION_B, article_id: ARTICLE_B, source_key: "us-scotus", jurisdiction: "United States", content_type: "opinion", original_language: "en", original_title: "Case B", korean_title: null, cleaned_text: "B body", case_key: "24-781" }),
      version({ id: VERSION_C, article_id: ARTICLE_C, source_key: "fr-conseil-constitutionnel", jurisdiction: "France", content_type: "decision", original_language: "fr", original_title: "Case C", korean_title: null, cleaned_text: "C body", case_key: "2026-1194" }),
    ],
  });
  const [docA, docB, docC] = documents;
  assert.deepEqual(documents.map((document) => document.article_id), [ARTICLE_A, ARTICLE_B, ARTICLE_C]);

  const ftsById = new Map(ftsDocuments.map((ftsDocument) => [ftsDocument.article_id, ftsDocument]));
  const changedA: SearchProjectionDocument = { ...docA, checksum: "changed-checksum-a" };
  const current = [docA, docC];
  const next = [changedA, docB];
  const plan = planSearchProjectionIncrementalSync(current, next, next.map((document) => ftsById.get(document.article_id)!));
  assert.equal(plan.operation, "incremental");
  assert.equal(plan.noop, false);
  assert.deepEqual(plan.changes, { added: 1, changed: 1, removed: 1, unchanged: 0 });

  const idsFor = (sql: string) =>
    new Set(
      plan.statements
        .filter((statement) => statement.sql === sql)
        .map((statement) => String(statement.params[0])),
    );
  const ftsDeletes = idsFor("DELETE FROM search_fts WHERE article_id = ?");
  const documentDeletes = idsFor("DELETE FROM search_documents WHERE article_id = ?");
  assert.deepEqual(ftsDeletes, documentDeletes, "every removed/changed id must delete from both sides");
  assert.deepEqual(ftsDeletes, new Set([docC.article_id, docA.article_id]));
  assert.deepEqual(
    idsFor("INSERT INTO search_fts (article_id, title, case_numbers, search_text, tags_text) VALUES (?, ?, ?, ?, ?)"),
    new Set([docA.article_id, docB.article_id]),
  );
  assert.deepEqual(
    idsFor(`INSERT INTO search_documents (${SEARCH_DOCUMENT_COLUMNS.join(", ")}) VALUES (${SEARCH_DOCUMENT_COLUMNS.map(() => "?").join(", ")})`),
    new Set([docA.article_id, docB.article_id]),
  );

  const changedPlan = planSearchProjectionIncrementalSync([docA], [{ ...docA, checksum: "new-checksum" }], [ftsById.get(docA.article_id)!]);
  assert.deepEqual(changedPlan.changes, { added: 0, changed: 1, removed: 0, unchanged: 0 });
  assert.equal(changedPlan.statements.filter((statement) => statement.sql.startsWith("DELETE")).length, 2);
  assert.equal(changedPlan.statements.filter((statement) => statement.sql.startsWith("INSERT")).length, 2);

  const noop = planSearchProjectionIncrementalSync(documents, documents, ftsDocuments);
  assert.equal(noop.noop, true);
  assert.deepEqual(noop.statements, []);
  assert.deepEqual(noop.changes, { added: 0, changed: 0, removed: 0, unchanged: 3 });
});

test("the plan fails closed unless FTS sidecar rows are exactly 1:1 with documents", () => {
  const { documents, ftsDocuments } = buildSearchProjection({
    publications: [publication(), publication({ id: PUB_B, article_id: ARTICLE_B, version_id: VERSION_B })],
    versions: [version(), version({ id: VERSION_B, article_id: ARTICLE_B })],
  });
  assert.equal(documents.length, 2);
  assert.equal(ftsDocuments.length, 2);

  assert.throws(
    () => planSearchProjectionFullRebuild(documents, [ftsDocuments[0], ftsDocuments[0]]),
    (error: unknown) => error instanceof SearchProjectionError && error.code === "duplicate_fts_document_id",
  );
  assert.throws(
    () => planSearchProjectionFullRebuild(documents, [ftsDocuments[0]]),
    (error: unknown) => error instanceof SearchProjectionError && error.code === "fts_document_count_mismatch",
  );
  assert.throws(
    () =>
      planSearchProjectionFullRebuild(documents, [
        ftsDocuments[0],
        { ...ftsDocuments[1], article_id: "99999999-0000-0000-0000-000000000009" },
      ]),
    (error: unknown) => error instanceof SearchProjectionError && error.code === "missing_fts_document",
  );
});

test("verification detects count, hash, checksum, version and FTS identity drift", () => {
  const { documents } = buildSearchProjection({
    publications: [publication(), publication({ id: PUB_B, article_id: ARTICLE_B, version_id: VERSION_B })],
    versions: [version(), version({ id: VERSION_B, article_id: ARTICLE_B })],
  });
  const [docA, docB] = documents;

  const clean = verifySearchProjection({
    projected: documents,
    documents: documents.map((document) => ({ article_id: document.article_id, checksum: document.checksum, projection_version: document.projection_version })),
    ftsArticleIds: documents.map((document) => document.article_id),
  });
  assert.equal(clean.ok, true);
  assert.deepEqual(clean.issues, []);

  const drift = verifySearchProjection({
    projected: documents,
    documents: [
      { article_id: docA.article_id, checksum: "wrong", projection_version: 99 },
      { article_id: "99999999-0000-0000-0000-000000000009", checksum: "x", projection_version: 1 },
    ],
    ftsArticleIds: [docA.article_id, docA.article_id, "88888888-0000-0000-0000-000000000008"],
  });
  assert.equal(drift.ok, false);
  const codes = new Set(drift.issues.map((entry) => entry.code));
  assert.ok(codes.has("checksum_mismatch"));
  assert.ok(codes.has("projection_version_mismatch"));
  assert.ok(codes.has("missing_document"));
  assert.ok(codes.has("extra_document"));
  assert.ok(codes.has("duplicate_fts"));
  assert.ok(codes.has("missing_fts"));
  assert.ok(codes.has("extra_fts"));
  assert.ok(drift.issues.some((entry) => entry.articleId === docB.article_id && entry.code === "missing_document"));

  const corrupt: SearchProjectionDocument = { ...docA, checksum: "corrupt" };
  const selfCheck = verifySearchProjection({ projected: [corrupt] });
  assert.equal(selfCheck.ok, false);
  assert.ok(selfCheck.issues.some((entry) => entry.code === "checksum_mismatch"));

  assert.notEqual(hashSearchProjectionDocuments([docA, docB]), hashSearchProjectionDocuments([docA]));
});

test("the empty corpus is deterministic and valid", () => {
  const first = buildSearchProjection({ publications: [], versions: [], articles: [], tags: [], articleTags: [] });
  const second = buildSearchProjection({ publications: [], versions: [], articles: [], tags: [], articleTags: [] });
  assert.deepEqual(first, second);
  assert.deepEqual(first.documents, []);
  assert.equal(first.manifest.documentCount, 0);

  const plan = planSearchProjectionFullRebuild([], []);
  assert.equal(plan.scope, SEARCH_PROJECTION_SCOPE);
  assert.deepEqual(plan.statements.map((statement) => statement.sql), ["DELETE FROM search_fts", "DELETE FROM search_documents"]);

  const report = verifySearchProjection({ projected: [], documents: [], ftsArticleIds: [] });
  assert.equal(report.ok, true);
  assert.deepEqual(report.issues, []);
});

test("the projection library stays runtime-neutral (no Node builtins)", () => {
  for (const entry of fs.readdirSync(LIB_DIR)) {
    if (!entry.endsWith(".ts")) continue;
    const source = fs.readFileSync(path.join(LIB_DIR, entry), "utf8");
    assert.ok(!source.includes('from "node:'), `${entry} must not import a Node builtin`);
    assert.ok(!source.includes("from 'node:"), `${entry} must not import a Node builtin`);
    assert.ok(!source.includes("require("), `${entry} must not require()`);
  }
  const barrel = fs.readFileSync(path.join(LIB_DIR, "index.ts"), "utf8");
  assert.ok(!/from\s+["']node:/u.test(barrel), "the runtime barrel must not import a Node builtin");
  assert.ok(!barrel.includes("require("), "the runtime barrel must not require()");
});

test("the SearchRepository stays Supabase-authoritative and search_m7 stays a blocker", () => {
  const selection = fs.readFileSync(path.join(rootDir, "lib", "search", "repository", "index.ts"), "utf8");
  assert.ok(selection.includes("createSupabaseSearchRepository"));
  assert.ok(selection.includes("failClosedSearchRepository"));
  assert.ok(!/d1/i.test(selection), "no D1 search adapter may be selected in M7.1");
  assert.ok(!fs.existsSync(path.join(rootDir, "lib", "search", "repository", "d1-repository.ts")));

  const coverage = fs.readFileSync(path.join(rootDir, "lib", "cloudflare", "d1", "shadow", "coverage.ts"), "utf8");
  assert.ok(coverage.includes("search_m7"), "M6.5 must keep the search_m7 blocker");

  const packageJson = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  assert.equal(packageJson.scripts["test:d1-search-projection"], "tsx --test tests/d1-search-projection.test.ts");
  assert.equal(packageJson.scripts["d1:search-projection"], "tsx scripts/d1-search-projection.ts");
});

test("the operator CLI is local-only and never executes a remote write", () => {
  assert.ok(fs.existsSync(CLI_PATH), "the M7.1 local CLI must exist");
  const source = fs.readFileSync(CLI_PATH, "utf8");
  assert.ok(source.includes("@/lib/cloudflare/search-projection"));
  assert.ok(source.includes("--apply"));
  assert.ok(!source.includes("d1 execute"));
  assert.ok(!source.includes("fetch("));
  assert.ok(!source.includes("process.env"));
});
