import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { createD1ArticleReadRepository } from "../lib/article-reads/d1-repository";
import { D1ShadowTruncatedError } from "../lib/reference-reads/d1-repository";
import type { D1RuntimeDatabase, D1RuntimePreparedStatement } from "../lib/cloudflare/d1/runtime-binding";
import { JSON_ID_BATCH_SIZE, JSON_ID_MAX_INPUT, JSON_ID_MAX_PAYLOAD_BYTES, jsonIdBatches, readBatchedByIds } from "../lib/cloudflare/d1/json-id-batches";
import { currentGenerations, generationProjectionHash, type GenerationRow } from "../lib/cloudflare/e2e/generation-state";
import { overlayPublicGenerationRows } from "../lib/cloudflare/e2e/public-freshness";
import { readPublicMetadataState } from "../lib/cloudflare/search-projection/metadata-repair";
import { SqliteD1, publish, articleId, approval } from "./helpers/e2e-core-fixture";

// Opt in explicitly; the production guard batching path stays disabled by default.
process.env.WORLDCONS_JSON_GUARD_BATCHING_ENABLED = "true";

/**
 * Real-SQLite integration coverage for the bounded public `listArticles` fast
 * path: P3 eligibility (legacy / catalog-stale / anchored enrichment), textual
 * publishability, withdrawn/private/needs_review exclusion, ordering plus
 * hasMore, and a query-shape bound proving only a page-sized window is read.
 */

interface Captured {
  sql: string;
  params: unknown[];
}

interface BindingOptions {
  failJsonEach?: boolean;
  failJsonEachAfter?: number;
}

function binding(sqlite: DatabaseSync, captured?: Captured[], options: BindingOptions = {}): D1RuntimeDatabase {
  let jsonEachReads = 0;
  return {
    prepare(sql: string): D1RuntimePreparedStatement {
      if ((options.failJsonEach || options.failJsonEachAfter !== undefined) && /json_each/i.test(sql)) {
        jsonEachReads += 1;
        if (options.failJsonEach || jsonEachReads > (options.failJsonEachAfter ?? 0)) {
          return {
            bind() {
              return this;
            },
            async all() {
              captured?.push({ sql, params: [] });
              throw new Error("D1_ERROR: no such function: json_each");
            },
          };
        }
      }
      const statement = sqlite.prepare(sql);
      let params: unknown[] = [];
      return {
        bind(...values: unknown[]) {
          params = values;
          return this;
        },
        async all<T>() {
          captured?.push({ sql, params });
          return { success: true, results: statement.all(...(params as SQLInputValue[])) as T[] };
        },
      };
    },
  };
}

const PUBLISHABLE = JSON.stringify({ collection: { publishable: true } });
const NOT_PUBLISHABLE = JSON.stringify({ collection: { publishable: false } });

function createCore() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(new URL("../d1/worldcons_core/0001_init.sql", import.meta.url), "utf8"));
  return sqlite;
}

function addMetadataTables(sqlite: DatabaseSync, publicReadRequired = 1) {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS search_metadata_policy_v1 (id INTEGER PRIMARY KEY, public_read_required INTEGER NOT NULL);
    INSERT OR IGNORE INTO search_metadata_policy_v1(id,public_read_required) VALUES(1,${publicReadRequired});
    CREATE TABLE IF NOT EXISTS search_metadata_repairs_v1 (article_id TEXT PRIMARY KEY, revision INTEGER NOT NULL,
      applied_revision INTEGER, status TEXT NOT NULL, fencing_token INTEGER NOT NULL DEFAULT 0);`);
}

function createGuardCore(publicReadRequired = 1) {
  const sqlite = createCore();
  sqlite.exec(readFileSync(new URL("../d1/worldcons_core/0004_e2e_generations.sql", import.meta.url), "utf8"));
  addMetadataTables(sqlite, publicReadRequired);
  return sqlite;
}

async function insertGeneration(
  sqlite: DatabaseSync,
  id: string,
  overrides: {
    generationId?: string;
    generationSeq?: number;
    versionId?: string;
    versionRevision?: number;
    publicationId?: string;
    publicationRevision?: number;
    publicationState?: string;
    policyVersion?: string;
    reviewState?: string | null;
    projectionHash?: string;
  } = {},
) {
  const versionId = overrides.versionId ?? `pub-${id}`;
  const generationId = overrides.generationId ?? `gen-${id}`;
  const generationSeq = overrides.generationSeq ?? 1;
  const publicationId = overrides.publicationId ?? `p-${id}`;
  const publicationRevision = overrides.publicationRevision ?? 1;
  const publicationState = overrides.publicationState ?? "published";
  const policyVersion = overrides.policyVersion ?? "policy-v1";
  const reviewState = overrides.reviewState === undefined ? null : overrides.reviewState;
  const identity = {
    article_id: id,
    expected_version_id: versionId,
    expected_version_revision: overrides.versionRevision ?? 1,
    approval_snapshot_hash: `approval-${id}`,
    expected_publication_id: publicationId,
    expected_publication_revision: publicationRevision,
    expected_publication_state: publicationState,
    policy_version: policyVersion,
  };
  const projectionInputHash = overrides.projectionHash ?? await generationProjectionHash(identity, [], reviewState);
  sqlite
    .prepare(
      `INSERT INTO e2e_generations_v1(generation_id,article_id,generation_seq,source_key,source_content_hash,approval_key,
        approval_snapshot_hash,approval_hash_schema,projection_input_hash,projection_input_schema,expected_version_id,
        expected_version_revision,expected_publication_id,expected_publication_revision,expected_publication_state,
        approval_mode,policy_version,approval_evidence_ref,source_evidence_ref,created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      generationId,
      id,
      generationSeq,
      "us-scotus",
      `source-${id}`,
      `approval-key-${generationId}`,
      identity.approval_snapshot_hash,
      "worldcons.approval.v2",
      projectionInputHash,
      "worldcons.projection-input.v1",
      versionId,
      identity.expected_version_revision,
      publicationId,
      publicationRevision,
      publicationState,
      "automatic",
      policyVersion,
      "evidence",
      "source-evidence",
      NOW,
    );
  sqlite
    .prepare(
      `INSERT INTO e2e_generation_heads_v1(article_id,generation_id,generation_seq,updated_at) VALUES(?,?,?,?)
       ON CONFLICT(article_id) DO UPDATE SET generation_id=excluded.generation_id,generation_seq=excluded.generation_seq,updated_at=excluded.updated_at`,
    )
    .run(id, generationId, generationSeq, NOW);
  sqlite
    .prepare(
      `INSERT INTO article_version_heads_p3(article_id,current_version_id,current_revision,updated_at) VALUES(?,?,?,?)
       ON CONFLICT(article_id) DO UPDATE SET current_version_id=excluded.current_version_id,current_revision=excluded.current_revision,updated_at=excluded.updated_at`,
    )
    .run(id, versionId, String(identity.expected_version_revision), NOW);
  sqlite
    .prepare(
      `INSERT INTO legacy_version_freshness_classifications_v4(version_id,article_id,freshness,freshness_basis,evidence,classified_at,classified_by)
       VALUES(?,?,?,?,?,?,?)
       ON CONFLICT(version_id) DO UPDATE SET freshness='current'`,
    )
    .run(versionId, id, "current", "legacy_same_version", "{}", NOW, "test");
  if (reviewState !== null) {
    sqlite.prepare("UPDATE articles SET review_state=? WHERE id=?").run(reviewState, id);
  }
  return { generationId, projectionInputHash, identity };
}

function generationSnapshot(map: Map<string, GenerationRow>) {
  return [...map.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, row]) => ({
      id,
      generation_id: row.generation_id,
      input_current: row.input_current,
      review_state: row.review_state ?? null,
      tag_snapshot: row.tag_snapshot,
    }));
}

function metadataSnapshot(map: Map<string, GenerationRow>) {
  return [...map.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, row]) => ({ id, status: row.status, revision: row.revision, applied_revision: row.applied_revision, fencing_token: row.fencing_token }));
}

function guardReads(captured: Captured[], table: string) {
  return captured.filter((call) =>
    call.sql.includes(table) && !call.sql.includes("SELECT article_id FROM search_metadata_repairs_v1"),
  ).length;
}

function jsonGuardReads(captured: Captured[], table: string) {
  return captured.filter((call) => call.sql.includes(table) && call.sql.includes("json_each")).length;
}

function legacyGuardReads(captured: Captured[], table: string) {
  return captured.filter((call) =>
    call.sql.includes(table) && !call.sql.includes("json_each")
    && !call.sql.includes("SELECT article_id FROM search_metadata_repairs_v1"),
  ).length;
}

const NOW = "2026-01-01T00:00:00.000Z";

interface ArticleOverrides {
  jurisdiction?: string;
  publishedAt?: string | null;
  status?: string;
  stale?: number;
  metadata?: string;
  versionId?: string;
  p3State?: string;
  versionRole?: string | null;
  anchor?: string | null;
  sourceHash?: string | null;
  enrichmentHash?: string | null;
  catalogState?: string | null;
  contentHash?: string;
  revision?: string;
}

function insertVersion(sqlite: DatabaseSync, id: string, versionId: string, overrides: ArticleOverrides) {
  sqlite
    .prepare(
      `INSERT INTO article_content_versions_p3(id,article_id,revision,content_hash,provenance_actor_type,slug,
        source_key,jurisdiction,institution_name,content_type,original_url,canonical_url,original_language,created_at,
        version_role,source_anchor_version_id,enrichment_source_content_hash,source_content_hash,original_published_at,
        source_metadata)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      versionId,
      id,
      overrides.revision ?? "1",
      overrides.contentHash ?? `hash-${id}`,
      "human",
      id,
      "us-scotus",
      overrides.jurisdiction ?? "United States",
      "SCOTUS",
      "opinion",
      `https://example.test/${id}`,
      `https://example.test/${id}`,
      "en",
      NOW,
      overrides.versionRole === undefined ? null : overrides.versionRole,
      overrides.anchor ?? null,
      overrides.enrichmentHash ?? null,
      overrides.sourceHash ?? null,
      overrides.publishedAt === undefined ? "2026-01-01T00:00:00.000Z" : overrides.publishedAt,
      overrides.metadata ?? PUBLISHABLE,
    );
}

function insertArticle(sqlite: DatabaseSync, id: string, overrides: ArticleOverrides = {}) {
  const versionId = overrides.versionId ?? `pub-${id}`;
  sqlite
    .prepare(
      `INSERT INTO articles(id,source_key,jurisdiction,institution_name,content_type,original_url,canonical_url,
        original_language,original_title,korean_title,original_published_at,discovered_at,fetched_at,summarized_at,
        status,slug,summary_json,source_metadata,catalog_ai_stale_v4,content_hash,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      id,
      "us-scotus",
      overrides.jurisdiction ?? "United States",
      "SCOTUS",
      "opinion",
      `https://example.test/${id}`,
      `https://example.test/${id}`,
      "en",
      `Title ${id}`,
      `제목 ${id}`,
      overrides.publishedAt === undefined ? "2026-01-01T00:00:00.000Z" : overrides.publishedAt,
      "2026-01-02T00:00:00.000Z",
      "2026-01-02T00:00:00.000Z",
      "2026-01-03T00:00:00.000Z",
      overrides.status ?? "summarized",
      id,
      JSON.stringify({ summary: { coreSummary: ["요약"] }, koreanTitle: `요약 ${id}` }),
      overrides.metadata ?? PUBLISHABLE,
      overrides.stale ?? 0,
      overrides.contentHash ?? `hash-${id}`,
      NOW,
      "2026-01-03T00:00:00.000Z",
    );
  sqlite
    .prepare(
      `INSERT INTO article_publications_p3(id,article_id,state,version_id,revision,decided_by_type,reason,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?)`,
    )
    .run(`p-${id}`, id, overrides.p3State ?? "published", versionId, "1", "human", "test", NOW, NOW);
  insertVersion(sqlite, id, versionId, overrides);
  if (overrides.catalogState) {
    const anchor = overrides.anchor ?? `anchor-${id}`;
    sqlite
      .prepare(
        `INSERT INTO case_catalog_publications_v1(id,article_id,state,source_anchor_version_id,revision,
          source_policy_version,decided_by_type,reason,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(`cat-${id}`, id, overrides.catalogState, anchor, "1", "v1", "human", "test", NOW, NOW);
  }
}

test("fast list returns only eligible published P3 rows and preserves ordering + hasMore", async () => {
  const sqlite = createCore();
  try {
    insertArticle(sqlite, "a", { publishedAt: "2026-03-01T00:00:00.000Z" });
    insertArticle(sqlite, "b", { publishedAt: "2026-02-01T00:00:00.000Z" });
    insertArticle(sqlite, "c", { publishedAt: null });
    const repo = createD1ArticleReadRepository({ binding: binding(sqlite), fastList: true, maxRows: 10_000 });

    const page1 = await repo.listArticles({ page: 1, pageSize: 2, count: "none", includeViewCounts: false });
    assert.deepEqual(page1.items.map((item) => item.slug), ["a", "b"]);
    assert.equal(page1.pageInfo.hasMore, true);
    assert.equal(page1.pageInfo.totalIsExact, false);

    const page2 = await repo.listArticles({ page: 2, pageSize: 2, count: "none", includeViewCounts: false });
    assert.deepEqual(page2.items.map((item) => item.slug), ["c"]);
    assert.equal(page2.pageInfo.hasMore, false);
  } finally {
    sqlite.close();
  }
});

test("fast list enforces textual publishability, catalog-stale and withdrawn/private exclusion", async () => {
  const sqlite = createCore();
  try {
    insertArticle(sqlite, "ok");
    insertArticle(sqlite, "string-true", { metadata: JSON.stringify({ collection: { publishable: "true" } }) });
    insertArticle(sqlite, "numeric-one", { metadata: JSON.stringify({ collection: { publishable: 1 } }) });
    insertArticle(sqlite, "private", { metadata: NOT_PUBLISHABLE });
    insertArticle(sqlite, "needs-review", { status: "needs_review" });
    insertArticle(sqlite, "stale", { stale: 1 });
    insertArticle(sqlite, "withdrawn", { p3State: "withdrawn" });
    insertArticle(sqlite, "not-published", { p3State: "in_review" });
    const repo = createD1ArticleReadRepository({ binding: binding(sqlite), fastList: true, maxRows: 10_000 });

    const result = await repo.listArticles({ pageSize: 50, count: "none", includeViewCounts: false });
    assert.deepEqual(
      result.items.map((item) => item.slug).sort(),
      ["ok", "string-true"],
      "only textual JSON-true/native-true publishable published P3 rows are public",
    );
  } finally {
    sqlite.close();
  }
});

test("fast list mirrors the Catalog anchor anti-join for a corrected source", async () => {
  const sqlite = createCore();
  try {
    // Legacy publication with no catalog correction stays public.
    insertArticle(sqlite, "legacy");
    // Catalog correction exists but the published P3 is a stale legacy version.
    insertArticle(sqlite, "blocked", {
      versionRole: null,
      anchor: "official-v2",
      catalogState: "published",
    });
    // Catalog correction superseded by a matching anchored enrichment snapshot.
    insertArticle(sqlite, "enriched", {
      versionRole: "enrichment_full",
      anchor: "official-v3",
      enrichmentHash: "official-hash",
      versionId: "enrichment-v3",
      catalogState: "published",
    });
    insertVersion(sqlite, "enriched", "official-v3", {
      versionRole: "authoritative_source",
      sourceHash: "official-hash",
      revision: "2",
      contentHash: "anchor-hash-enriched",
    });
    // Catalog correction with a mismatched source hash stays blocked.
    insertArticle(sqlite, "wrong-hash", {
      versionRole: "enrichment_full",
      anchor: "official-v4",
      enrichmentHash: "obsolete-hash",
      versionId: "enrichment-v4",
      catalogState: "published",
    });
    insertVersion(sqlite, "wrong-hash", "official-v4", {
      versionRole: "authoritative_source",
      sourceHash: "official-hash",
      revision: "2",
      contentHash: "anchor-hash-wrong",
    });

    const repo = createD1ArticleReadRepository({ binding: binding(sqlite), fastList: true, maxRows: 10_000 });
    const result = await repo.listArticles({ pageSize: 50, count: "none", includeViewCounts: false });
    assert.deepEqual(result.items.map((item) => item.slug).sort(), ["enriched", "legacy"]);
  } finally {
    sqlite.close();
  }
});

test("fast list reads a bounded window, never the full corpus, and applies source/jurisdiction/range filters", async () => {
  const sqlite = createCore();
  try {
    for (let index = 0; index < 400; index += 1) {
      insertArticle(sqlite, `a-${String(index).padStart(3, "0")}`, {
        publishedAt: `2026-01-${String((index % 28) + 1).padStart(2, "0")}T00:00:00.000Z`,
        jurisdiction: index % 2 === 0 ? "United States" : "Germany",
      });
    }
    const captured: Captured[] = [];
    const repo = createD1ArticleReadRepository({ binding: binding(sqlite, captured), fastList: true, maxRows: 10_000 });

    const result = await repo.listArticles({ page: 1, pageSize: 10, count: "none", includeViewCounts: false });
    assert.equal(result.items.length, 10);

    const articleReads = captured.filter((call) => call.sql.includes("from article_publications_p3 p"));
    assert.equal(articleReads.length, 1, "the eligible window is one authored query");
    const limit = Number(articleReads[0].params[articleReads[0].params.length - 1]);
    assert.ok(limit <= 10 + 60 + 1, `the fast query must bound rows well below the corpus, got limit=${limit}`);
    assert.match(articleReads[0].sql, /from article_publications_p3 p/);
    assert.doesNotMatch(articleReads[0].sql, /count\(\*\)/i);

    const filtered = await repo.listArticles({ jurisdiction: "Germany", pageSize: 5, count: "none", includeViewCounts: false });
    assert.ok(filtered.items.length > 0);
    assert.ok(filtered.items.every((item) => item.jurisdiction === "Germany"));
  } finally {
    sqlite.close();
  }
});

test("fast list falls back to the full composition for tags, q and ids", async () => {
  const sqlite = createCore();
  try {
    insertArticle(sqlite, "a");
    insertArticle(sqlite, "b");
    sqlite
      .prepare("INSERT INTO tags(id,slug,name,normalized_name,type,article_count,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)")
      .run("tag-1", "first-amendment", "First Amendment", "First Amendment", "article", 1, NOW, NOW);
    sqlite.prepare("INSERT INTO article_tags(article_id,tag_id,confidence,created_at) VALUES(?,?,?,?)").run("a", "tag-1", 0.9, NOW);
    const captured: Captured[] = [];
    const repo = createD1ArticleReadRepository({ binding: binding(sqlite, captured), fastList: true, maxRows: 10_000 });

    assert.deepEqual((await repo.listArticles({ tag: "first-amendment" })).items.map((i) => i.slug), ["a"]);
    assert.deepEqual((await repo.listArticles({ ids: ["b"] })).items.map((i) => i.slug), ["b"]);
    assert.deepEqual((await repo.listArticles({ tag: "missing" })).items, []);
    // q is not a D1 in-memory filter (search is a separate M7 surface); the
    // fallback must engage and never issue the fast eligible SQL.
    await repo.listArticles({ q: "Title a" });
    assert.equal(captured.filter((call) => call.sql.includes("from article_publications_p3 p")).length, 0,
      "the fast path must never run for q");
  } finally {
    sqlite.close();
  }
});

test("fast list never leaks a removed article after the approved P3 withdrawal", async (t) => {
  const core = new SqliteD1();
  t.after(() => core.close());
  await publish(core, "a");
  const repo = createD1ArticleReadRepository({ binding: core, fastList: true, maxRows: 10_000 });

  const before = await repo.listArticles({ count: "none", includeViewCounts: false });
  assert.deepEqual(before.items.map((item) => item.slug), ["m1-fixture"]);

  const pub = core.db.prepare("SELECT version_id FROM article_publications_p3 WHERE article_id=?").get(articleId) as { version_id: string };
  await publish(core, "withdraw", {
    captureLegacy: false,
    versionId: pub.version_id,
    targetState: "withdrawn",
  });

  const after = await repo.listArticles({ count: "none", includeViewCounts: false });
  assert.deepEqual(after.items.map((item) => item.slug), [], "a withdrawn publication must never appear publicly");
});

test("fast list serves approved immutable P3 content, never mutable core drafts", async (t) => {
  const core = new SqliteD1();
  t.after(() => core.close());
  await publish(core, "a");
  const repo = createD1ArticleReadRepository({ binding: core, fastList: true, maxRows: 10_000 });

  core.db.exec("UPDATE articles SET korean_title='미승인 초안', original_published_at='1999-01-01T00:00:00.000Z'");
  const result = await repo.listArticles({ count: "none", includeViewCounts: false });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].koreanTitle, "시험 판결", "the immutable P3 title must override the mutable draft");
  assert.notEqual(result.items[0].originalPublishedAt, "1999-01-01T00:00:00.000Z");
});

test("fast list drops a row withdrawn between the eligible window read and the overlay", async (t) => {
  const core = new SqliteD1();
  t.after(() => core.close());
  await publish(core, "a");
  let withdrawn = false;
  core.beforeStatement = (sql) => {
    if (!withdrawn && sql.includes("from article_publications_p3 p") && sql.includes("order by v.original_published_at")) {
      withdrawn = true;
      core.db.exec("UPDATE article_publications_p3 SET state='withdrawn'");
    }
  };
  const repo = createD1ArticleReadRepository({ binding: core, fastList: true, maxRows: 10_000 });
  const result = await repo.listArticles({ count: "none", includeViewCounts: false });
  assert.equal(withdrawn, true, "the race must have been triggered");
  assert.deepEqual(result.items, [], "the immutable overlay must never serve a row withdrawn before hydration");
});

test("fast list honors the eligible-row overflow bound", async () => {
  const sqlite = createCore();
  try {
    for (let index = 0; index < 5; index += 1) insertArticle(sqlite, `a-${index}`);
    const repo = createD1ArticleReadRepository({ binding: binding(sqlite), fastList: true, maxRows: 1 });
    // The legacy path fails closed when the matched corpus exceeds maxRows; the
    // fast path refuses and the fallback raises the typed truncation.
    await assert.rejects(
      () => repo.listArticles({ count: "none", includeViewCounts: false }),
      (error: unknown) => error instanceof D1ShadowTruncatedError,
    );
  } finally {
    sqlite.close();
  }
});

function sitemapRepository(
  sqlite: DatabaseSync,
  fastSitemap: boolean,
  captured?: Captured[],
  maxRows = 10_000,
  options: BindingOptions = {},
) {
  return createD1ArticleReadRepository({ binding: binding(sqlite, captured, options), fastSitemap, maxRows });
}

function sortedSitemap(entries: { slug: string; lastModified: string | null }[]) {
  return [...entries].sort((left, right) => left.slug.localeCompare(right.slug));
}

interface SitemapSwitchCombo {
  label: string;
  fastSitemap: boolean;
  jsonGuard: boolean;
}

const SITEMAP_SWITCH_MATRIX: readonly SitemapSwitchCombo[] = [
  { label: "fastSitemap=false,jsonGuard=false", fastSitemap: false, jsonGuard: false },
  { label: "fastSitemap=true,jsonGuard=false", fastSitemap: true, jsonGuard: false },
  { label: "fastSitemap=false,jsonGuard=true", fastSitemap: false, jsonGuard: true },
  { label: "fastSitemap=true,jsonGuard=true", fastSitemap: true, jsonGuard: true },
];

async function runSitemapSwitchCombo(sqlite: DatabaseSync, combo: SitemapSwitchCombo) {
  const original = process.env.WORLDCONS_JSON_GUARD_BATCHING_ENABLED;
  if (combo.jsonGuard) process.env.WORLDCONS_JSON_GUARD_BATCHING_ENABLED = "true";
  else delete process.env.WORLDCONS_JSON_GUARD_BATCHING_ENABLED;
  const captured: Captured[] = [];
  const startedAt = performance.now();
  try {
    const entries = await sitemapRepository(sqlite, combo.fastSitemap, captured).listPublicSitemapArticles();
    return { entries, captured, elapsedMs: performance.now() - startedAt };
  } finally {
    if (original === undefined) delete process.env.WORLDCONS_JSON_GUARD_BATCHING_ENABLED;
    else process.env.WORLDCONS_JSON_GUARD_BATCHING_ENABLED = original;
  }
}

function sitemapHeadReads(captured: Captured[]) {
  return captured.filter((call) => call.sql.includes("from article_publications_p3 where state = ?")).length;
}

function sitemapFastCandidateReads(captured: Captured[]) {
  return captured.filter(
    (call) => call.sql.includes("from article_publications_p3 p") && call.sql.includes("left join case_catalog_publications_v1"),
  ).length;
}

test("fast sitemap matches the legacy batched sitemap across public eligibility states", async () => {
  const sqlite = createCore();
  try {
    insertArticle(sqlite, "ok");
    insertArticle(sqlite, "string-true", { metadata: JSON.stringify({ collection: { publishable: "true" } }) });
    insertArticle(sqlite, "numeric-one", { metadata: JSON.stringify({ collection: { publishable: 1 } }) });
    insertArticle(sqlite, "private", { metadata: NOT_PUBLISHABLE });
    insertArticle(sqlite, "needs-review", { status: "needs_review" });
    insertArticle(sqlite, "stale", { stale: 1 });
    insertArticle(sqlite, "withdrawn", { p3State: "withdrawn" });
    insertArticle(sqlite, "not-published", { p3State: "in_review" });
    insertArticle(sqlite, "catalog-blocked", {
      versionRole: null,
      anchor: "official-v2",
      catalogState: "published",
    });
    insertArticle(sqlite, "catalog-enriched", {
      versionRole: "enrichment_full",
      anchor: "official-v3",
      enrichmentHash: "official-hash",
      versionId: "enrichment-v3",
      catalogState: "published",
    });
    insertVersion(sqlite, "catalog-enriched", "official-v3", {
      versionRole: "authoritative_source",
      sourceHash: "official-hash",
      revision: "2",
      contentHash: "anchor-hash-enriched",
    });
    insertArticle(sqlite, "catalog-wrong-hash", {
      versionRole: "enrichment_full",
      anchor: "official-v4",
      enrichmentHash: "obsolete-hash",
      versionId: "enrichment-v4",
      catalogState: "published",
    });
    insertVersion(sqlite, "catalog-wrong-hash", "official-v4", {
      versionRole: "authoritative_source",
      sourceHash: "official-hash",
      revision: "2",
      contentHash: "anchor-hash-wrong",
    });

    const fast = await sitemapRepository(sqlite, true).listPublicSitemapArticles();
    const legacy = await sitemapRepository(sqlite, false).listPublicSitemapArticles();
    assert.deepEqual(sortedSitemap(fast), sortedSitemap(legacy));
    assert.deepEqual(
      fast.map((entry) => entry.slug).sort(),
      ["catalog-enriched", "ok", "string-true"],
      "only published, summarized, non-stale, textually publishable, catalog-eligible rows are public",
    );
  } finally {
    sqlite.close();
  }
});

test("fast sitemap admits anchored enrichment and excludes catalog mismatches through a lazy EXISTS", async () => {
  const sqlite = createCore();
  try {
    insertArticle(sqlite, "legacy");
    insertArticle(sqlite, "anchored-enrichment", {
      versionRole: "enrichment_full",
      anchor: "official-valid",
      enrichmentHash: "source-hash-valid",
      versionId: "enrichment-valid",
      catalogState: "published",
    });
    insertVersion(sqlite, "anchored-enrichment", "official-valid", {
      versionRole: "authoritative_source",
      sourceHash: "source-hash-valid",
      revision: "2",
      contentHash: "anchor-hash-valid",
    });
    insertArticle(sqlite, "catalog-mismatch", {
      versionRole: "enrichment_full",
      anchor: "official-mismatch",
      enrichmentHash: "stale-enrichment-hash",
      versionId: "enrichment-mismatch",
      catalogState: "published",
    });
    insertVersion(sqlite, "catalog-mismatch", "official-mismatch", {
      versionRole: "authoritative_source",
      sourceHash: "current-source-hash",
      revision: "2",
      contentHash: "anchor-hash-mismatch",
    });
    insertArticle(sqlite, "wrong-anchor-role", {
      versionRole: "enrichment_full",
      anchor: "official-wrong-role",
      enrichmentHash: "source-hash-wrong-role",
      versionId: "enrichment-wrong-role",
      catalogState: "published",
    });
    insertVersion(sqlite, "wrong-anchor-role", "official-wrong-role", {
      versionRole: "enrichment_full",
      sourceHash: "source-hash-wrong-role",
      revision: "2",
      contentHash: "anchor-hash-wrong-role",
    });

    const captured: Captured[] = [];
    const fast = await sitemapRepository(sqlite, true, captured).listPublicSitemapArticles();
    const legacy = await sitemapRepository(sqlite, false).listPublicSitemapArticles();
    assert.deepEqual(sortedSitemap(fast), sortedSitemap(legacy));
    assert.deepEqual(
      fast.map((entry) => entry.slug).sort(),
      ["anchored-enrichment", "legacy"],
      "only rows without a correction or with a valid anchored enrichment are public",
    );

    const candidate = captured.find(
      (call) => call.sql.includes("from article_publications_p3 p") && call.sql.includes("left join case_catalog_publications_v1"),
    );
    assert.ok(candidate, "the fast sitemap candidate query must be issued");
    assert.ok(candidate.sql.includes("exists ("), "the catalog policy must be a correlated EXISTS");
    assert.ok(
      !candidate.sql.includes("left join article_content_versions_p3"),
      "version lookups must not run unconditionally for uncorrected rows",
    );
  } finally {
    sqlite.close();
  }
});

test("fast sitemap keeps lastModified precedence, one set-based candidate read and the overflow bound", async () => {
  const sqlite = createCore();
  try {
    insertArticle(sqlite, "a", { publishedAt: "2026-01-01T00:00:00.000Z" });
    insertArticle(sqlite, "b", { publishedAt: "2026-02-01T00:00:00.000Z" });
    sqlite.prepare("UPDATE articles SET summarized_at=NULL,fetched_at=NULL,discovered_at=? WHERE id=?").run(
      "2026-01-01T00:00:00.000Z",
      "a",
    );
    sqlite.prepare("UPDATE articles SET summarized_at=?,fetched_at=NULL WHERE id=?").run(
      "2026-06-01T00:00:00.000Z",
      "b",
    );
    insertArticle(sqlite, "missing-slug");
    sqlite.prepare("UPDATE articles SET slug='' WHERE id=?").run("missing-slug");

    const captured: Captured[] = [];
    const entries = await sitemapRepository(sqlite, true, captured).listPublicSitemapArticles();
    assert.deepEqual(sortedSitemap(entries), [
      { slug: "a", lastModified: "2026-01-01T00:00:00.000Z" },
      { slug: "b", lastModified: "2026-06-01T00:00:00.000Z" },
    ]);

    const candidateReads = captured.filter(
      (call) => call.sql.includes("from article_publications_p3 p") && call.sql.includes("left join case_catalog_publications_v1"),
    );
    assert.equal(candidateReads.length, 1, "the eligible sitemap candidates are one authored query");
    assert.equal(
      captured.filter((call) => call.sql.includes("from article_publications_p3 where state = ?")).length,
      1,
      "the published-head bound is one aggregate-free read",
    );

    const bounded = sitemapRepository(sqlite, true, undefined, 1);
    await assert.rejects(
      () => bounded.listPublicSitemapArticles(),
      (error: unknown) => error instanceof D1ShadowTruncatedError,
    );
  } finally {
    sqlite.close();
  }
});

test("fast sitemap keeps real distinct ids and measures the JSON1 guard read shape for 200 published articles", async () => {
  const sqlite = createGuardCore();
  try {
    for (let index = 0; index < 200; index += 1) {
      insertArticle(sqlite, `query-${String(index).padStart(3, "0")}`, {
        publishedAt: `2026-01-${String((index % 28) + 1).padStart(2, "0")}T00:00:00.000Z`,
      });
    }

    const legacyCaptured: Captured[] = [];
    const fastCaptured: Captured[] = [];
    const legacy = await sitemapRepository(sqlite, false, legacyCaptured).listPublicSitemapArticles();
    const fast = await sitemapRepository(sqlite, true, fastCaptured).listPublicSitemapArticles();

    assert.deepEqual(sortedSitemap(fast), sortedSitemap(legacy));
    assert.equal(fast.length, 200);
    assert.equal(
      legacyCaptured.length,
      14,
      "legacy: one head read, three catalog batches, three article batches, five guards, and two withholding reads",
    );
    assert.equal(
      fastCaptured.length,
      9,
      "fast: one head bound, one candidate query, five guards, and two withholding reads",
    );
    assert.equal(guardReads(fastCaptured, "e2e_generation_heads_v1"), 1);
    assert.equal(guardReads(fastCaptured, "search_metadata_repairs_v1"), 1);
    assert.equal(
      fastCaptured.filter(
        (call) => call.sql.includes("from article_publications_p3 p") && call.sql.includes("left join case_catalog_publications_v1"),
      ).length,
      1,
    );
  } finally {
    sqlite.close();
  }
});

test("fast sitemap propagates ids so an active generation overrides mutable article fields and withdrawal removes the URL", async (t) => {
  const core = new SqliteD1();
  t.after(() => core.close());
  await publish(core, "a");
  core.db.exec("UPDATE articles SET slug='mutable-draft', summarized_at='1999-01-01T00:00:00.000Z'");
  const repository = createD1ArticleReadRepository({ binding: core, fastSitemap: true, maxRows: 10_000 });

  const entries = await repository.listPublicSitemapArticles();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].slug, "m1-fixture", "the immutable P3 slug must win over the mutable draft slug");

  const pub = core.db.prepare("SELECT version_id FROM article_publications_p3 WHERE article_id=?").get(articleId) as { version_id: string };
  await publish(core, "withdraw", {
    captureLegacy: false,
    versionId: pub.version_id,
    targetState: "withdrawn",
  });
  assert.deepEqual(await repository.listPublicSitemapArticles(), [], "a withdrawn publication must never remain in the sitemap");
});

test("sitemap withholds pending, leased, and revision-mismatched metadata without hiding approved URLs", async () => {
  const sqlite = createCore();
  try {
    sqlite.exec(readFileSync(new URL("../d1/worldcons_core/0004_e2e_generations.sql", import.meta.url), "utf8"));
    sqlite.exec(`CREATE TABLE search_metadata_policy_v1 (id INTEGER PRIMARY KEY, public_read_required INTEGER NOT NULL);
      INSERT INTO search_metadata_policy_v1(id,public_read_required) VALUES(1,1);
      CREATE TABLE search_metadata_repairs_v1 (article_id TEXT PRIMARY KEY, revision INTEGER NOT NULL,
        applied_revision INTEGER, status TEXT NOT NULL, fencing_token INTEGER NOT NULL DEFAULT 0);`);
    insertArticle(sqlite, "pending-metadata");
    insertArticle(sqlite, "leased-metadata");
    insertArticle(sqlite, "revision-mismatch");
    insertArticle(sqlite, "healthy-metadata");
    sqlite.prepare(
      "INSERT INTO search_metadata_repairs_v1(article_id,revision,applied_revision,status,fencing_token) VALUES(?,?,?,?,?)",
    ).run("pending-metadata", 2, 1, "pending", 4);
    sqlite.prepare(
      "INSERT INTO search_metadata_repairs_v1(article_id,revision,applied_revision,status,fencing_token) VALUES(?,?,?,?,?)",
    ).run("leased-metadata", 3, 2, "leased", 5);
    sqlite.prepare(
      "INSERT INTO search_metadata_repairs_v1(article_id,revision,applied_revision,status,fencing_token) VALUES(?,?,?,?,?)",
    ).run("revision-mismatch", 4, 3, "verified", 6);

    for (const fastSitemap of [true, false]) {
      const entries = await sitemapRepository(sqlite, fastSitemap).listPublicSitemapArticles();
      assert.deepEqual(
        entries.map((entry) => entry.slug),
        ["healthy-metadata"],
        `pending metadata must be withheld with fastSitemap=${fastSitemap}`,
      );
    }
  } finally {
    sqlite.close();
  }
});

test("generation and metadata guard reads dedupe repeated article ids", async (t) => {
  const core = new SqliteD1();
  t.after(() => core.close());
  core.db.exec(`CREATE TABLE search_metadata_policy_v1 (id INTEGER PRIMARY KEY, public_read_required INTEGER NOT NULL);
    INSERT INTO search_metadata_policy_v1(id,public_read_required) VALUES(1,1);
    CREATE TABLE search_metadata_repairs_v1 (article_id TEXT PRIMARY KEY, revision INTEGER NOT NULL,
      applied_revision INTEGER, status TEXT NOT NULL, fencing_token INTEGER NOT NULL DEFAULT 0);`);
  const duplicates = Array.from({ length: 200 }, () => articleId);

  core.queries = [];
  await currentGenerations(core, duplicates);
  const generationReads = core.queries.filter((sql) => sql.includes("e2e_generation_heads_v1"));
  assert.equal(generationReads.length, 1, "200 copies of one key must not become three bounded generation reads");
  assert.match(
    generationReads[0],
    /FROM json_each\(\?\) AS ids\s+JOIN e2e_generation_heads_v1 h ON h\.article_id=ids\.value/,
    "the deduplicated JSON1 read must expand ids before joining the generation head",
  );

  core.queries = [];
  const states = await readPublicMetadataState(core, duplicates, new Set());
  assert.equal(states.size, 0);
  const metadataReads = core.queries.filter(
    (sql) => sql.includes("search_metadata_repairs_v1") && sql.includes("json_each"),
  );
  assert.equal(metadataReads.length, 1, "200 copies of one key must not become three bounded metadata reads");
  assert.match(
    metadataReads[0],
    /FROM json_each\(\?\) AS ids JOIN search_metadata_repairs_v1 m ON m\.article_id=ids\.value/,
    "the deduplicated JSON1 read must expand ids before joining the repair table",
  );
});

test("duplicate metadata guard ids still fail closed while a repair is pending", async (t) => {
  const core = new SqliteD1();
  t.after(() => core.close());
  core.db.exec(`CREATE TABLE search_metadata_policy_v1 (id INTEGER PRIMARY KEY, public_read_required INTEGER NOT NULL);
    INSERT INTO search_metadata_policy_v1(id,public_read_required) VALUES(1,1);
    CREATE TABLE search_metadata_repairs_v1 (article_id TEXT PRIMARY KEY, revision INTEGER NOT NULL,
      applied_revision INTEGER, status TEXT NOT NULL, fencing_token INTEGER NOT NULL DEFAULT 0);`);
  core.db.prepare("INSERT INTO search_metadata_repairs_v1(article_id,revision,applied_revision,status,fencing_token) VALUES(?,?,?,?,?)").run(
    articleId,
    2,
    1,
    "pending",
    4,
  );
  await assert.rejects(
    () => readPublicMetadataState(core, [articleId, articleId, articleId], new Set()),
    /e2e\.public_metadata_pending/,
  );
});

test("JSON1 id batches bound the input count, payload bytes and per-query key count", () => {
  const longIds = Array.from({ length: 1000 }, (_, index) => `id-${String(index).padStart(300, "0")}`);
  const batches = jsonIdBatches(longIds);
  assert.equal(batches.flat().length, longIds.length);
  assert.ok(batches.length > 1);
  assert.ok(batches.every((batch) => batch.length <= JSON_ID_BATCH_SIZE));
  assert.ok(batches.every((batch) => new TextEncoder().encode(JSON.stringify(batch)).length <= JSON_ID_MAX_PAYLOAD_BYTES));
  assert.throws(
    () => jsonIdBatches(Array.from({ length: JSON_ID_MAX_INPUT + 1 }, (_, index) => `id-${index}`)),
    /e2e\.id_batch_overflow/,
  );
  assert.throws(() => jsonIdBatches(["x".repeat(JSON_ID_MAX_PAYLOAD_BYTES + 1)]), /e2e\.id_batch_payload_exceeded/);
  assert.deepEqual(jsonIdBatches([]), []);
});

test("JSON1 generation and metadata guards match the legacy 80-id composition across batches", async () => {
  const sqlite = createGuardCore();
  try {
    const ids = Array.from({ length: 1200 }, (_, index) => `guard-${String(index).padStart(4, "0")}`);
    sqlite.exec("BEGIN");
    try {
      for (const id of ids) insertArticle(sqlite, id);
    } finally {
      sqlite.exec("COMMIT");
    }
    for (const id of [ids[0], ids[499], ids[500], ids[1199]]) await insertGeneration(sqlite, id);
    for (const id of [ids[1], ids[498], ids[501], ids[1198]]) {
      sqlite
        .prepare("INSERT INTO search_metadata_repairs_v1(article_id,revision,applied_revision,status,fencing_token) VALUES(?,?,?,?,?)")
        .run(id, 1, 1, "verified", 0);
    }

    const jsonGeneration: Captured[] = [];
    const legacyGeneration: Captured[] = [];
    const json = await currentGenerations(binding(sqlite, jsonGeneration), ids);
    const legacy = await currentGenerations(binding(sqlite, legacyGeneration, { failJsonEach: true }), ids);
    assert.deepEqual(generationSnapshot(json), generationSnapshot(legacy));
    assert.equal(json.size, 4);
    assert.ok([...json.values()].every((row) => row.input_current === true));
    assert.equal(jsonGuardReads(jsonGeneration, "e2e_generation_heads_v1"), Math.ceil(ids.length / JSON_ID_BATCH_SIZE));
    assert.equal(legacyGuardReads(legacyGeneration, "e2e_generation_heads_v1"), Math.ceil(ids.length / 80));

    const jsonMetadata: Captured[] = [];
    const legacyMetadata: Captured[] = [];
    const jsonStates = await readPublicMetadataState(binding(sqlite, jsonMetadata), ids, new Set());
    const legacyStates = await readPublicMetadataState(binding(sqlite, legacyMetadata, { failJsonEach: true }), ids, new Set());
    assert.deepEqual(metadataSnapshot(jsonStates), metadataSnapshot(legacyStates));
    assert.equal(jsonStates.size, 4);
    assert.equal(jsonGuardReads(jsonMetadata, "search_metadata_repairs_v1"), Math.ceil(ids.length / JSON_ID_BATCH_SIZE));
    assert.equal(legacyGuardReads(legacyMetadata, "search_metadata_repairs_v1"), Math.ceil(ids.length / 80));
  } finally {
    sqlite.close();
  }
});

test("JSON1 guard fallback discards an earlier JSON batch instead of returning partial rows", async () => {
  const sqlite = createGuardCore();
  try {
    const ids = Array.from({ length: 1200 }, (_, index) => `partial-${String(index).padStart(4, "0")}`);
    sqlite.exec("BEGIN");
    try {
      for (const id of ids) insertArticle(sqlite, id);
    } finally {
      sqlite.exec("COMMIT");
    }
    for (const id of [ids[0], ids[650]]) await insertGeneration(sqlite, id);
    for (const id of [ids[1], ids[651]]) {
      sqlite
        .prepare("INSERT INTO search_metadata_repairs_v1(article_id,revision,applied_revision,status,fencing_token) VALUES(?,?,?,?,?)")
        .run(id, 1, 1, "verified", 0);
    }

    const expectedGenerations = await currentGenerations(binding(sqlite), ids);
    const partialGenerations = await currentGenerations(binding(sqlite, undefined, { failJsonEachAfter: 1 }), ids);
    assert.deepEqual(generationSnapshot(partialGenerations), generationSnapshot(expectedGenerations));
    assert.equal(partialGenerations.size, 2);

    const expectedMetadata = await readPublicMetadataState(binding(sqlite), ids, new Set());
    const partialMetadata = await readPublicMetadataState(binding(sqlite, undefined, { failJsonEachAfter: 1 }), ids, new Set());
    assert.deepEqual(metadataSnapshot(partialMetadata), metadataSnapshot(expectedMetadata));
    assert.equal(partialMetadata.size, 2);
  } finally {
    sqlite.close();
  }
});

test("JSON1 metadata guards fail closed when a pending repair sits in a later batch", async () => {
  const sqlite = createGuardCore();
  try {
    const ids = Array.from({ length: 700 }, (_, index) => `pending-${index}`);
    sqlite
      .prepare("INSERT INTO search_metadata_repairs_v1(article_id,revision,applied_revision,status,fencing_token) VALUES(?,?,?,?,?)")
      .run(ids[0], 1, 1, "verified", 0);
    sqlite
      .prepare("INSERT INTO search_metadata_repairs_v1(article_id,revision,applied_revision,status,fencing_token) VALUES(?,?,?,?,?)")
      .run(ids[650], 2, 1, "pending", 4);
    for (const failJsonEach of [false, true]) {
      await assert.rejects(
        () => readPublicMetadataState(binding(sqlite, undefined, { failJsonEach }), ids, new Set()),
        /e2e\.public_metadata_pending/,
        `pending metadata must fail closed with failJsonEach=${failJsonEach}`,
      );
    }
  } finally {
    sqlite.close();
  }
});

test("JSON1 guard reads preserve projection-changed, needs_review and withdrawn exclusion", async () => {
  const sqlite = createGuardCore();
  try {
    const ids = ["changed", "needs-review", "revoked", "ok"];
    sqlite.exec("BEGIN");
    try {
      for (const id of ids) insertArticle(sqlite, id);
    } finally {
      sqlite.exec("COMMIT");
    }
    await insertGeneration(sqlite, "changed", { projectionHash: "0".repeat(64) });
    await insertGeneration(sqlite, "needs-review", { reviewState: "needs_review" });
    await insertGeneration(sqlite, "revoked", { publicationState: "withdrawn" });
    await insertGeneration(sqlite, "ok");

    const generations = await currentGenerations(binding(sqlite), ids);
    assert.equal(generations.get("changed")?.input_current, false);
    assert.equal(generations.get("needs-review")?.input_current, false);
    assert.equal(generations.get("revoked")?.input_current, false);
    assert.equal(generations.get("ok")?.input_current, true);

    const approved = await overlayPublicGenerationRows(binding(sqlite), ids.map((id) => ({ id, slug: id })));
    assert.deepEqual(approved.map((row) => row.id), ["ok"]);
  } finally {
    sqlite.close();
  }
});

test("fast sitemap 2216-head fixture keeps two-pass guard parity and cuts guard round trips", async () => {
  const sqlite = createGuardCore();
  try {
    const ids: string[] = [];
    sqlite.exec("BEGIN");
    try {
      for (let index = 0; index < 2216; index += 1) {
        const id = `sitemap-${String(index).padStart(4, "0")}`;
        ids.push(id);
        insertArticle(sqlite, id, {
          publishedAt: `2026-01-${String((index % 28) + 1).padStart(2, "0")}T00:00:00.000Z`,
        });
      }
    } finally {
      sqlite.exec("COMMIT");
    }
    await insertGeneration(sqlite, ids[1]);
    sqlite
      .prepare("INSERT INTO search_metadata_repairs_v1(article_id,revision,applied_revision,status,fencing_token) VALUES(?,?,?,?,?)")
      .run(ids[0], 1, 1, "verified", 0);
    sqlite
      .prepare(
        `INSERT INTO legacy_version_freshness_classifications_v4(version_id,article_id,freshness,freshness_basis,evidence,classified_at,classified_by)
         VALUES(?,?,?,?,?,?,?)
         ON CONFLICT(version_id) DO UPDATE SET freshness='current'`,
      )
      .run(`pub-${ids[0]}`, ids[0], "current", "legacy_same_version", "{}", NOW, "test");

    const jsonCaptured: Captured[] = [];
    const legacyCaptured: Captured[] = [];
    const json = await sitemapRepository(sqlite, true, jsonCaptured).listPublicSitemapArticles();
    const legacy = await sitemapRepository(sqlite, true, legacyCaptured, 10_000, { failJsonEach: true }).listPublicSitemapArticles();

    assert.equal(json.length, 2216);
    assert.deepEqual(sortedSitemap(json), sortedSitemap(legacy));

    const jsonGenerationSql = jsonCaptured.find(
      (call) => call.sql.includes("e2e_generation_heads_v1") && call.sql.includes("json_each"),
    );
    const jsonMetadataSql = jsonCaptured.find(
      (call) => call.sql.includes("search_metadata_repairs_v1") && call.sql.includes("json_each"),
    );
    assert.ok(jsonGenerationSql, "the 2216 fixture must exercise the JSON1 generation read");
    assert.ok(jsonMetadataSql, "the 2216 fixture must exercise the JSON1 metadata read");
    assert.match(
      jsonGenerationSql!.sql,
      /FROM json_each\(\?\) AS ids\s+JOIN e2e_generation_heads_v1 h ON h\.article_id=ids\.value\s+JOIN e2e_generations_v1 g ON g\.generation_id=h\.generation_id\s+LEFT JOIN articles a ON a\.id=g\.article_id\s+LIMIT \?/,
      "the generation JSON1 read must start from json_each and join the head by article id",
    );
    assert.match(jsonGenerationSql!.sql, /CASE WHEN h\.generation_id=g\.generation_id/);
    assert.match(jsonGenerationSql!.sql, /AS identity_current/);
    assert.match(jsonGenerationSql!.sql, /AS tag_snapshot/);
    assert.doesNotMatch(jsonGenerationSql!.sql, /IN \(SELECT value FROM json_each/);
    assert.match(
      jsonMetadataSql!.sql,
      /FROM json_each\(\?\) AS ids JOIN search_metadata_repairs_v1 m ON m\.article_id=ids\.value LIMIT \?/,
      "the metadata JSON1 read must start from json_each and join the repair row by article id",
    );
    assert.doesNotMatch(jsonMetadataSql!.sql, /IN \(SELECT value FROM json_each/);

    const jsonGenerationReads = jsonGuardReads(jsonCaptured, "e2e_generation_heads_v1");
    const jsonMetadataReads = jsonGuardReads(jsonCaptured, "search_metadata_repairs_v1");
    const legacyGenerationReads = legacyGuardReads(legacyCaptured, "e2e_generation_heads_v1");
    const legacyMetadataReads = legacyGuardReads(legacyCaptured, "search_metadata_repairs_v1");
    assert.equal(jsonGenerationReads, 2 * Math.ceil(2216 / JSON_ID_BATCH_SIZE));
    assert.equal(jsonMetadataReads, 2 * Math.ceil(2215 / JSON_ID_BATCH_SIZE));
    assert.equal(legacyGenerationReads, 2 * Math.ceil(2216 / 80));
    assert.equal(legacyMetadataReads, 2 * Math.ceil(2215 / 80));
    assert.ok(jsonGenerationReads < legacyGenerationReads);
    assert.ok(jsonMetadataReads < legacyMetadataReads);
    assert.ok(jsonCaptured.length < legacyCaptured.length);
    assert.ok(jsonCaptured.length <= 40, `JSON1 fast path should stay near 30 reads, got ${jsonCaptured.length}`);
  } finally {
    sqlite.close();
  }
});

test("isolated four-switch sitemap A/B matrix preserves exact slug+lastModified parity on one 2240-head snapshot", async (t) => {
  const sqlite = createGuardCore();
  try {
    const basePublished = 2237;
    sqlite.exec("BEGIN");
    try {
      for (let index = 0; index < basePublished; index += 1) {
        insertArticle(sqlite, `matrix-${String(index).padStart(4, "0")}`, {
          publishedAt: `2026-01-${String((index % 28) + 1).padStart(2, "0")}T00:00:00.000Z`,
        });
      }
    } finally {
      sqlite.exec("COMMIT");
    }
    insertArticle(sqlite, "matrix-withdrawn", { p3State: "withdrawn" });
    insertArticle(sqlite, "matrix-catalog-mismatch", {
      versionRole: null,
      anchor: "official-matrix",
      catalogState: "published",
    });
    insertArticle(sqlite, "matrix-metadata-approved");
    sqlite
      .prepare("INSERT INTO search_metadata_repairs_v1(article_id,revision,applied_revision,status,fencing_token) VALUES(?,?,?,?,?)")
      .run("matrix-metadata-approved", 1, 1, "verified", 0);
    sqlite
      .prepare(
        `INSERT INTO legacy_version_freshness_classifications_v4(version_id,article_id,freshness,freshness_basis,evidence,classified_at,classified_by)
         VALUES(?,?,?,?,?,?,?)`,
      )
      .run("pub-matrix-metadata-approved", "matrix-metadata-approved", "current", "legacy_same_version", "{}", NOW, "test");
    insertArticle(sqlite, "matrix-protected-generation");
    await insertGeneration(sqlite, "matrix-protected-generation");

    const runs: { combo: SitemapSwitchCombo; entries: { slug: string; lastModified: string | null }[]; captured: Captured[]; elapsedMs: number }[] = [];
    for (const combo of SITEMAP_SWITCH_MATRIX) {
      runs.push({ combo, ...(await runSitemapSwitchCombo(sqlite, combo)) });
    }

    const baseline = sortedSitemap(runs[0].entries);
    assert.equal(baseline.length, 2239, "2237 healthy rows plus the metadata-approved and protected-generation rows");
    const baselineSlugs = new Set(baseline.map((entry) => entry.slug));
    assert.equal(baselineSlugs.has("matrix-withdrawn"), false, "a withdrawn publication must never be public");
    assert.equal(baselineSlugs.has("matrix-catalog-mismatch"), false, "a catalog mismatch must never be public");
    assert.equal(baselineSlugs.has("matrix-metadata-approved"), true, "an approved metadata repair must stay public");
    assert.equal(baselineSlugs.has("matrix-protected-generation"), true, "a current protected generation must stay public");

    // Do not fetch ~20MB of approved source texts merely to produce URL and
    // lastmod metadata; normal public reads still require the complete P3 row.
    const sitemapVersionReads = runs[0].captured.filter((call) =>
      call.sql.includes("SELECT v.id,v.article_id,v.slug,v.summarized_at"),
    );
    assert.equal(sitemapVersionReads.length, 2, "both immutable P3 overlay paths use the narrow sitemap projection");
    assert.equal(runs[0].captured.filter((call) => call.sql.includes("SELECT v.*")).length, 0);
    const normalReads: Captured[] = [];
    await overlayPublicGenerationRows(binding(sqlite, normalReads), [{ id: "matrix-metadata-approved", slug: "draft" }]);
    assert.ok(normalReads.some((call) => call.sql.includes("SELECT v.*")), "regular public readers retain full P3 projection");

    const expectedGenerationIds = 2239;
    const expectedMetadataIds = 2238;
    for (const run of runs) {
      const { combo } = run;
      assert.deepEqual(
        sortedSitemap(run.entries),
        baseline,
        `${combo.label} must return the exact baseline slug+lastModified set, not just a matching count`,
      );

      const headReads = sitemapHeadReads(run.captured);
      const candidateReads = sitemapFastCandidateReads(run.captured);
      const jsonGenerationReads = jsonGuardReads(run.captured, "e2e_generation_heads_v1");
      const legacyGenerationReads = legacyGuardReads(run.captured, "e2e_generation_heads_v1");
      const jsonMetadataReads = jsonGuardReads(run.captured, "search_metadata_repairs_v1");
      const legacyMetadataReads = legacyGuardReads(run.captured, "search_metadata_repairs_v1");

      assert.equal(headReads, 1, `${combo.label}: exactly one published-head bound`);
      assert.equal(candidateReads, combo.fastSitemap ? 1 : 0, `${combo.label}: fast candidate read only when enabled`);
      assert.equal(
        jsonGenerationReads,
        combo.jsonGuard ? 2 * Math.ceil(expectedGenerationIds / JSON_ID_BATCH_SIZE) : 0,
        `${combo.label}: JSON1 generation guard read count`,
      );
      assert.equal(
        legacyGenerationReads,
        combo.jsonGuard ? 0 : 2 * Math.ceil(expectedGenerationIds / 80),
        `${combo.label}: legacy generation guard read count`,
      );
      assert.equal(
        jsonMetadataReads,
        combo.jsonGuard ? 2 * Math.ceil(expectedMetadataIds / JSON_ID_BATCH_SIZE) : 0,
        `${combo.label}: JSON1 metadata guard read count`,
      );
      assert.equal(
        legacyMetadataReads,
        combo.jsonGuard ? 0 : 2 * Math.ceil(expectedMetadataIds / 80),
        `${combo.label}: legacy metadata guard read count`,
      );

      t.diagnostic(
        `${combo.label}: urls=${run.entries.length} statements=${run.captured.length} head=${headReads} fastCandidate=${candidateReads} ` +
          `generationJson=${jsonGenerationReads} generationLegacy=${legacyGenerationReads} ` +
          `metadataJson=${jsonMetadataReads} metadataLegacy=${legacyMetadataReads} localElapsedMs=${run.elapsedMs.toFixed(1)}`,
      );
    }

    const fastLegacy = runs[1];
    const legacyJson = runs[2];
    const fastJson = runs[3];
    assert.ok(fastJson.captured.length < fastLegacy.captured.length, "fastSitemap+JSON1 must issue fewer statements than fastSitemap alone");
    assert.ok(fastJson.captured.length < legacyJson.captured.length, "fastSitemap+JSON1 must issue fewer statements than JSON1 alone");
  } finally {
    sqlite.close();
  }
});

test("isolated four-switch sitemap A/B matrix withholds pending metadata in every combination", async () => {
  const sqlite = createGuardCore();
  try {
    insertArticle(sqlite, "matrix-pending");
    insertArticle(sqlite, "matrix-stable");
    sqlite
      .prepare("INSERT INTO search_metadata_repairs_v1(article_id,revision,applied_revision,status,fencing_token) VALUES(?,?,?,?,?)")
      .run("matrix-pending", 2, 1, "pending", 4);

    for (const combo of SITEMAP_SWITCH_MATRIX) {
      const entries = (await runSitemapSwitchCombo(sqlite, combo)).entries;
      assert.deepEqual(
        entries.map((entry) => entry.slug),
        ["matrix-stable"],
        `${combo.label} must withhold the pending case while retaining the approved case`,
      );
    }
  } finally {
    sqlite.close();
  }
});

test("two-pass overlay detects a metadata CAS change after the first guard pass", async (t) => {
  const core = new SqliteD1();
  t.after(() => core.close());
  addMetadataTables(core.db);
  const ids = [articleId, ...Array.from({ length: 399 }, (_, index) => `cas-${index}`)];
  core.db.exec("BEGIN");
  try {
    for (const id of ids.slice(1)) insertArticle(core.db, id);
  } finally {
    core.db.exec("COMMIT");
  }
  core.db
    .prepare("INSERT INTO search_metadata_repairs_v1(article_id,revision,applied_revision,status,fencing_token) VALUES(?,?,?,?,?)")
    .run(articleId, 1, 1, "verified", 0);

  let metadataReads = 0;
  core.beforeStatement = (sql) => {
    if (!sql.includes("search_metadata_repairs_v1")) return;
    metadataReads += 1;
    if (metadataReads === 2) {
      core.beforeStatement = undefined;
      core.db.prepare("UPDATE search_metadata_repairs_v1 SET fencing_token=fencing_token+1 WHERE article_id=?").run(articleId);
    }
  };

  await assert.rejects(
    () => overlayPublicGenerationRows(core, ids.map((id) => ({ id, slug: id }))),
    /e2e\.public_metadata_changed/,
  );
});

test("two-pass overlay re-reads currentGenerations and drops a row whose generation changed", async (t) => {
  const core = new SqliteD1();
  t.after(() => core.close());
  addMetadataTables(core.db);
  await publish(core, "a");
  const ids = [articleId, ...Array.from({ length: 399 }, (_, index) => `cas-gen-${index}`)];
  core.db.exec("BEGIN");
  try {
    for (const id of ids.slice(1)) insertArticle(core.db, id);
  } finally {
    core.db.exec("COMMIT");
  }

  let metadataReads = 0;
  core.beforeStatement = async (sql) => {
    if (!sql.includes("search_metadata_repairs_v1")) return;
    metadataReads += 1;
    if (metadataReads === 1) {
      core.beforeStatement = undefined;
      await publish(core, "changed", { e2eApproval: { ...approval, policyVersion: "v2" } });
    }
  };

  const result = await overlayPublicGenerationRows(core, ids.map((id) => ({ id, slug: id })));
  assert.equal(result.some((row) => row.id === articleId), false, "the generation changed after the first read and must be dropped");
  assert.equal(result.length, 399);
});

test("fast sitemap and JSON1 guard batching remain OFF by default", async () => {
  const originalFast = process.env.WORLDCONS_FAST_SITEMAP_ENABLED;
  const originalJson = process.env.WORLDCONS_JSON_GUARD_BATCHING_ENABLED;
  delete process.env.WORLDCONS_FAST_SITEMAP_ENABLED;
  delete process.env.WORLDCONS_JSON_GUARD_BATCHING_ENABLED;
  try {
    const sqlite = createGuardCore();
    try {
      insertArticle(sqlite, "default-off");
      await insertGeneration(sqlite, "default-off");
      insertArticle(sqlite, "legacy-meta");
      sqlite
        .prepare(
          `INSERT INTO legacy_version_freshness_classifications_v4(version_id,article_id,freshness,freshness_basis,evidence,classified_at,classified_by)
           VALUES(?,?,?,?,?,?,?)`,
        )
        .run("pub-legacy-meta", "legacy-meta", "current", "legacy_same_version", "{}", NOW, "test");
      sqlite
        .prepare("INSERT INTO search_metadata_repairs_v1(article_id,revision,applied_revision,status,fencing_token) VALUES(?,?,?,?,?)")
        .run("legacy-meta", 1, 1, "verified", 0);

      const captured: Captured[] = [];
      const entries = await createD1ArticleReadRepository({ binding: binding(sqlite, captured), maxRows: 10_000 })
        .listPublicSitemapArticles();
      assert.deepEqual(entries.map((entry) => entry.slug), ["default-off", "legacy-meta"]);
      assert.equal(
        captured.filter((call) => call.sql.includes("left join case_catalog_publications_v1")).length,
        0,
        "the fast sitemap candidate query must stay off without an explicit opt-in",
      );
      assert.equal(
        captured.filter((call) => call.sql.includes("json_each")).length,
        0,
        "the JSON1 guard batching must stay off without an explicit opt-in",
      );
      assert.ok(
        captured.some((call) => call.sql.includes("e2e_generation_heads_v1") && call.sql.includes("WHERE h.article_id IN (")),
        "the default generation guard read must keep the legacy 80-id composition",
      );
      assert.ok(
        captured.some((call) => call.sql.includes("FROM search_metadata_repairs_v1 WHERE article_id IN (")),
        "the default metadata guard read must keep the legacy 80-id composition",
      );
    } finally {
      sqlite.close();
    }
  } finally {
    if (originalFast === undefined) delete process.env.WORLDCONS_FAST_SITEMAP_ENABLED;
    else process.env.WORLDCONS_FAST_SITEMAP_ENABLED = originalFast;
    if (originalJson === undefined) delete process.env.WORLDCONS_JSON_GUARD_BATCHING_ENABLED;
    else process.env.WORLDCONS_JSON_GUARD_BATCHING_ENABLED = originalJson;
  }
});

test("JSON1 guard batching is disabled unless explicitly opted in", async () => {
  const original = process.env.WORLDCONS_JSON_GUARD_BATCHING_ENABLED;
  delete process.env.WORLDCONS_JSON_GUARD_BATCHING_ENABLED;
  try {
    let jsonCalls = 0;
    let legacyCalls = 0;
    const result = await readBatchedByIds({
      ids: ["one", "two", "one"],
      readJsonBatch: async () => { jsonCalls += 1; throw new Error("unexpected_json_query"); },
      readLegacyBatch: async (ids) => { legacyCalls += 1; return [...ids]; },
    });
    assert.deepEqual(result, ["one", "two"]);
    assert.equal(jsonCalls, 0);
    assert.equal(legacyCalls, 1);
  } finally {
    if (original === undefined) delete process.env.WORLDCONS_JSON_GUARD_BATCHING_ENABLED;
    else process.env.WORLDCONS_JSON_GUARD_BATCHING_ENABLED = original;
  }
});

test("sitemap-scoped JSON1 uses local opt-in without changing ordinary public guard reads", async () => {
  const original = process.env.WORLDCONS_JSON_GUARD_BATCHING_ENABLED;
  delete process.env.WORLDCONS_JSON_GUARD_BATCHING_ENABLED;
  const sqlite = createGuardCore();
  try {
    insertArticle(sqlite, "sitemap-scope");
    await insertGeneration(sqlite, "sitemap-scope");

    const sitemapCalls: Captured[] = [];
    const optimized = await createD1ArticleReadRepository({
      binding: binding(sqlite, sitemapCalls),
      maxRows: 10_000,
      sitemapJsonGuard: true,
    }).listPublicSitemapArticles();
    assert.deepEqual(optimized.map((entry) => entry.slug), ["sitemap-scope"]);
    assert.ok(sitemapCalls.some((call) => call.sql.includes("FROM json_each(?) AS ids")));

    const ordinaryCalls: Captured[] = [];
    await currentGenerations(binding(sqlite, ordinaryCalls), ["sitemap-scope"]);
    assert.ok(ordinaryCalls.some((call) => call.sql.includes("WHERE h.article_id IN (")));
    assert.equal(ordinaryCalls.filter((call) => call.sql.includes("json_each")).length, 0);

    const fallbackCalls: Captured[] = [];
    const fallback = await createD1ArticleReadRepository({
      binding: binding(sqlite, fallbackCalls, { failJsonEach: true }),
      maxRows: 10_000,
      sitemapJsonGuard: true,
    }).listPublicSitemapArticles();
    assert.deepEqual(fallback, optimized);
    assert.ok(fallbackCalls.some((call) => call.sql.includes("FROM json_each(?) AS ids")));
    assert.ok(fallbackCalls.some((call) => call.sql.includes("WHERE h.article_id IN (")));

    process.env.WORLDCONS_JSON_GUARD_BATCHING_ENABLED = "true";
    const forcedLegacyCalls: Captured[] = [];
    const forcedLegacy = await createD1ArticleReadRepository({
      binding: binding(sqlite, forcedLegacyCalls),
      maxRows: 10_000,
      sitemapJsonGuard: false,
    }).listPublicSitemapArticles();
    assert.deepEqual(forcedLegacy, optimized);
    assert.equal(forcedLegacyCalls.filter((call) => call.sql.includes("json_each")).length, 0);
  } finally {
    sqlite.close();
    if (original === undefined) delete process.env.WORLDCONS_JSON_GUARD_BATCHING_ENABLED;
    else process.env.WORLDCONS_JSON_GUARD_BATCHING_ENABLED = original;
  }
});
