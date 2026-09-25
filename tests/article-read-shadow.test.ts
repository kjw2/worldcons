import assert from "node:assert/strict";
import test from "node:test";
import {
  type D1RuntimeDatabase,
  type D1RuntimePreparedStatement,
} from "../lib/cloudflare/d1/runtime-binding";
import {
  D1_SHADOW_ARTICLE_READ_SURFACE,
  D1_SHADOW_DEFAULT_MAX_IN_FLIGHT,
  D1_SHADOW_DEFAULT_MAX_ROWS,
  D1_SHADOW_DEFAULT_SAMPLE_RATE,
  D1_SHADOW_DEFAULT_TIMEOUT_MS,
  resolveD1ShadowConfig,
  type D1ShadowConfig,
} from "../lib/cloudflare/d1/shadow/config";
import { resetShadowInFlight } from "../lib/cloudflare/d1/shadow/inflight";
import type { D1ShadowEvent } from "../lib/cloudflare/d1/shadow/events";
import type { RuntimeBackgroundScheduler } from "../lib/runtime/background";
import { articleReadShadowCoveredMethods, withArticleReadShadow } from "../lib/article-reads/shadow";
import { referenceReadShadowCoveredMethods, withReferenceReadShadow } from "../lib/reference-reads/shadow";
import type { ArticleReadRepository, ArticleSourceTextRecord } from "../lib/article-reads/types";
import type { ReferenceReadRepository } from "../lib/reference-reads/types";

/**
 * M6.3 article-read shadow orchestration tests: gate behavior, projection and
 * search skips, authoritative-result preservation, comparison, truncation,
 * backpressure, timeouts and the M6.1/M6.2 regression. Every test injects its
 * config, binding, scheduler, sampler and sink so nothing depends on ambient
 * environment or wall-clock timing.
 */

const IDENT = "[a-z_][a-z0-9_]*";

interface CapturedStatement {
  sql: string;
  params: unknown[];
  table: string;
}

function evaluate(sql: string, params: unknown[], tables: Record<string, Record<string, unknown>[]>) {
  const fromMatch = new RegExp(` from (${IDENT})`).exec(sql);
  const table = fromMatch?.[1] ?? "";
  let rows = (tables[table] ?? []).map((row) => ({ ...row }));
  let p = 0;
  const whereMatch = new RegExp(` where (.*?)(?= order by | limit | offset |$)`).exec(sql);
  if (whereMatch) {
    for (const predicate of whereMatch[1].split(" and ")) {
      const inMatch = new RegExp(`^(${IDENT}) in \\(([?](, \\?)*)\\)$`).exec(predicate);
      const cmpMatch = new RegExp(`^(${IDENT}) (=|>=|!=) \\?$`).exec(predicate);
      if (inMatch) {
        const values = params.slice(p, p + inMatch[2].split(",").length);
        p += values.length;
        rows = rows.filter((row) => values.includes(row[inMatch[1]]));
      } else if (cmpMatch) {
        const value = params[p];
        p += 1;
        rows = rows.filter((row) => {
          if (cmpMatch[2] === "=") return row[cmpMatch[1]] === value;
          if (cmpMatch[2] === "!=") return row[cmpMatch[1]] !== value;
          return row[cmpMatch[1]] != null && String(row[cmpMatch[1]]) >= String(value);
        });
      }
    }
  }
  const offset = / offset \?/.test(sql) ? Number(params[p++]) : 0;
  const limit = / limit \?/.test(sql) ? Number(params[p++]) : undefined;
  if (offset) rows = rows.slice(offset);
  if (limit !== undefined) rows = rows.slice(0, limit);
  return { table, rows };
}

function createFakeD1(
  tables: Record<string, Record<string, unknown>[]>,
  delayMs = 0,
  failing = false,
) {
  const calls: CapturedStatement[] = [];
  const database: D1RuntimeDatabase = {
    prepare(sql: string): D1RuntimePreparedStatement {
      let params: unknown[] = [];
      const statement: D1RuntimePreparedStatement = {
        bind(...values: unknown[]) {
          params = values;
          return statement;
        },
        async all<T = Record<string, unknown>>() {
          if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
          if (failing) throw Object.assign(new Error("d1 unavailable"), { code: "d1_runtime_read.query_failed" });
          const evaluated = evaluate(sql, params, tables);
          calls.push({ sql, params, table: evaluated.table });
          return { success: true, results: evaluated.rows as unknown as T[] };
        },
      };
      return statement;
    },
  };
  return { database, calls };
}

function createCollectorScheduler() {
  const tasks: Promise<unknown>[] = [];
  const scheduler: RuntimeBackgroundScheduler = {
    schedule(task: Promise<unknown>) {
      tasks.push(task);
      return true;
    },
  };
  return {
    scheduler,
    async flush() {
      await Promise.allSettled(tasks);
    },
    count: () => tasks.length,
  };
}

function captureEvents() {
  const events: D1ShadowEvent[] = [];
  return { events, sink: (event: D1ShadowEvent) => events.push(event) };
}

const SOURCE_TEXT: ArticleSourceTextRecord = {
  slug: "case-1",
  sourceKey: "us-scotus",
  sourceMetadata: { collection: { publishable: true } },
  officialUrl: "https://example.test/case-1",
  cleanedText: "clean text",
  contentHash: "hash-1",
};

function articleRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "article-1",
    slug: "case-1",
    source_key: "us-scotus",
    jurisdiction: "United States",
    institution_name: "SCOTUS",
    content_type: "opinion",
    original_url: "https://example.test/case-1",
    canonical_url: "https://example.test/case-1",
    original_language: "en",
    original_title: "Original Title",
    korean_title: "한국어 제목",
    original_published_at: "2026-04-29T00:00:00.000Z",
    discovered_at: "2026-05-08T00:00:00.000Z",
    fetched_at: "2026-05-08T00:10:00.000Z",
    summarized_at: "2026-05-08T00:20:00.000Z",
    status: "summarized",
    raw_text: null,
    cleaned_text: "clean text",
    content_hash: "hash-1",
    summary_json: null,
    source_metadata: { collection: { publishable: true } },
    error_metadata: null,
    raw_text_storage_ref: null,
    raw_text_blob_hash: null,
    raw_text_blob_size: null,
    raw_text_externalized_at: null,
    raw_text_blob_contract_version: null,
    catalog_ai_stale_v4: 0,
    ...overrides,
  };
}

const EMPTY_LIST_RESULT = {
  items: [],
  pageInfo: { page: 1, pageSize: 20, total: 0, hasMore: false, totalIsExact: true },
};

function createAuthoritative(overrides: Partial<ArticleReadRepository> = {}): ArticleReadRepository {
  return {
    async listArticles() {
      return EMPTY_LIST_RESULT;
    },
    async listPublicSitemapArticles() {
      return [];
    },
    async listTopViewedArticles() {
      return [];
    },
    async listRelatedArticleIds() {
      return [];
    },
    async getArticleBySelect() {
      return null;
    },
    async getArticleSourceTextBySlug(slug: string) {
      return slug === "case-1" ? SOURCE_TEXT : null;
    },
    ...overrides,
  };
}

function baseConfig(overrides: Partial<D1ShadowConfig> = {}): D1ShadowConfig {
  return {
    readEnabled: true,
    compareEnabled: true,
    surfaces: new Set([D1_SHADOW_ARTICLE_READ_SURFACE]),
    timeoutMs: D1_SHADOW_DEFAULT_TIMEOUT_MS,
    maxRows: D1_SHADOW_DEFAULT_MAX_ROWS,
    maxInFlight: D1_SHADOW_DEFAULT_MAX_IN_FLIGHT,
    sampleRate: 1,
    ...overrides,
  };
}

test("the article shadow covers exactly the six article-read methods", () => {
  assert.deepEqual([...articleReadShadowCoveredMethods()].sort(), [
    "getArticleBySelect",
    "getArticleSourceTextBySlug",
    "listArticles",
    "listPublicSitemapArticles",
    "listRelatedArticleIds",
    "listTopViewedArticles",
  ]);
  assert.equal(referenceReadShadowCoveredMethods().length, 7, "M6.1/M6.2 reference coverage must be unchanged");
});

test("all flags off does zero shadow work and returns the authoritative object by identity", async () => {
  resetShadowInFlight();
  const d1 = createFakeD1({ articles: [articleRow()] });
  const collector = createCollectorScheduler();
  const { events, sink } = captureEvents();
  const authoritative = createAuthoritative();
  const repository = withArticleReadShadow(authoritative, {
    config: baseConfig({ readEnabled: false, compareEnabled: false }),
    binding: d1.database,
    scheduler: collector.scheduler,
    sink,
  });

  const result = await repository.getArticleSourceTextBySlug("case-1");
  assert.equal(result, SOURCE_TEXT, "the exact authoritative object must be returned unchanged");
  assert.equal(d1.calls.length, 0);
  assert.equal(collector.count(), 0);
  assert.equal(events.length, 0);
});

test("read-on compare-off runs the background D1 read but never compares", async () => {
  resetShadowInFlight();
  const d1 = createFakeD1({ articles: [articleRow()] });
  const collector = createCollectorScheduler();
  const { events, sink } = captureEvents();
  const repository = withArticleReadShadow(createAuthoritative(), {
    config: baseConfig({ compareEnabled: false }),
    binding: d1.database,
    scheduler: collector.scheduler,
    sink,
    projection: false,
    caseCatalogPublic: false,
  });

  const result = await repository.getArticleSourceTextBySlug("case-1");
  assert.equal(result, SOURCE_TEXT);
  assert.equal(d1.calls.length, 1);
  await collector.flush();
  assert.equal(events[0].outcome, "disabled");
  assert.equal(events[0].reason, "compare_disabled");
  assert.equal(events[0].compared, false);
  assert.equal(events[0].readOutcome, "success");
});

test("compare-on match emits matched with counts/hashes and never row content", async () => {
  resetShadowInFlight();
  const d1 = createFakeD1({ articles: [articleRow({ cleaned_text: "SECRET-CLEANED-TEXT" })] });
  const collector = createCollectorScheduler();
  const { events, sink } = captureEvents();
  const repository = withArticleReadShadow(
    createAuthoritative({
      getArticleSourceTextBySlug: async () => ({ ...SOURCE_TEXT, cleanedText: "SECRET-CLEANED-TEXT" }),
    }),
    {
      config: baseConfig(),
      binding: d1.database,
      scheduler: collector.scheduler,
      sink,
      projection: false,
      caseCatalogPublic: false,
    },
  );

  await repository.getArticleSourceTextBySlug("case-1");
  await collector.flush();
  assert.equal(events[0].outcome, "matched", `diffPath=${events[0].diffPath ?? "null"}`);
  assert.equal(events[0].primaryHash, events[0].shadowHash);
  assert.equal(JSON.stringify(events[0]).includes("SECRET-CLEANED-TEXT"), false, "no row content may be logged");
});

test("compare-on mismatch emits a bounded diff path", async () => {
  resetShadowInFlight();
  const d1 = createFakeD1({ articles: [articleRow({ cleaned_text: "different" })] });
  const collector = createCollectorScheduler();
  const { events, sink } = captureEvents();
  const repository = withArticleReadShadow(createAuthoritative(), {
    config: baseConfig(),
    binding: d1.database,
    scheduler: collector.scheduler,
    sink,
    projection: false,
    caseCatalogPublic: false,
  });

  await repository.getArticleSourceTextBySlug("case-1");
  await collector.flush();
  assert.equal(events[0].outcome, "mismatched");
  assert.equal(events[0].reason, "result_mismatch");
  assert.ok(events[0].diffPath?.startsWith("getArticleSourceTextBySlug"));
});

test("projection and V4 modes skip before any D1 call", async () => {
  resetShadowInFlight();
  const d1 = createFakeD1({ articles: [articleRow()] });
  const collector = createCollectorScheduler();

  const cases: Array<[string, (repo: ArticleReadRepository) => Promise<unknown>]> = [
    ["listArticles", (repo) => repo.listArticles({})],
    ["listPublicSitemapArticles", (repo) => repo.listPublicSitemapArticles()],
    ["listTopViewedArticles", (repo) => repo.listTopViewedArticles(5, {})],
    ["getArticleBySelect", (repo) => repo.getArticleBySelect("case-1", "detail")],
    ["getArticleSourceTextBySlug", (repo) => repo.getArticleSourceTextBySlug("case-1")],
  ];

  for (const [method, run] of cases) {
    const { events, sink } = captureEvents();
    const repository = withArticleReadShadow(createAuthoritative(), {
      config: baseConfig(),
      binding: d1.database,
      scheduler: collector.scheduler,
      sink,
      projection: true,
      caseCatalogPublic: false,
    });
    await run(repository);
    assert.equal(events[0].reason, "projection_mode", `${method} must skip in projection mode`);
    assert.equal(events[0].outcome, "skipped");
  }
  assert.equal(d1.calls.length, 0, "projection skips must not touch D1");
  assert.equal(collector.count(), 0);

  const v4 = captureEvents();
  const v4Repository = withArticleReadShadow(createAuthoritative(), {
    config: baseConfig(),
    binding: d1.database,
    scheduler: collector.scheduler,
    sink: v4.sink,
    projection: true,
    caseCatalogPublic: true,
  });
  await v4Repository.getArticleBySelect("case-1", "detail");
  assert.equal(v4.events[0].reason, "projection_mode");
  assert.equal(d1.calls.length, 0);
});

test("a direct wrapper construction defaults conservatively to skipping public reads", async () => {
  resetShadowInFlight();
  const d1 = createFakeD1({ articles: [articleRow()] });
  const collector = createCollectorScheduler();
  const { events, sink } = captureEvents();
  const repository = withArticleReadShadow(createAuthoritative(), {
    config: baseConfig(),
    binding: d1.database,
    scheduler: collector.scheduler,
    sink,
  });
  await repository.getArticleSourceTextBySlug("case-1");
  assert.equal(events[0].reason, "projection_mode");
  assert.equal(d1.calls.length, 0);
});

test("includeUnpublished bypasses the projection gate and shadows the legacy base table", async () => {
  resetShadowInFlight();
  const row = articleRow({
    slug: "case-unpublished",
    status: "needs_review",
    source_metadata: { collection: { publishable: false } },
  });
  const record: ArticleSourceTextRecord = {
    slug: "case-unpublished",
    sourceKey: "us-scotus",
    sourceMetadata: { collection: { publishable: false } },
    officialUrl: "https://example.test/case-1",
    cleanedText: "clean text",
    contentHash: "hash-1",
  };
  const d1 = createFakeD1({ articles: [row] });
  const collector = createCollectorScheduler();
  const { events, sink } = captureEvents();
  const repository = withArticleReadShadow(
    createAuthoritative({ getArticleSourceTextBySlug: async () => record }),
    {
      config: baseConfig(),
      binding: d1.database,
      scheduler: collector.scheduler,
      sink,
      projection: true,
      caseCatalogPublic: true,
    },
  );

  await repository.getArticleSourceTextBySlug("case-unpublished", { includeUnpublished: true });
  await collector.flush();
  assert.equal(events[0].outcome, "matched", `diffPath=${events[0].diffPath ?? "null"}`);
  assert.equal(d1.calls.length, 1);
});

test("a filters.q search path is M7 and makes zero D1 calls", async () => {
  resetShadowInFlight();
  const d1 = createFakeD1({ articles: [articleRow()] });
  const collector = createCollectorScheduler();
  const { events, sink } = captureEvents();
  const repository = withArticleReadShadow(createAuthoritative(), {
    config: baseConfig(),
    binding: d1.database,
    scheduler: collector.scheduler,
    sink,
    projection: false,
    caseCatalogPublic: false,
  });

  await repository.listArticles({ q: "표현 자유" });
  assert.equal(events[0].reason, "search_deferred_m7");
  assert.equal(events[0].outcome, "skipped");
  assert.equal(d1.calls.length, 0);
  assert.equal(collector.count(), 0);
});

test("missing binding, missing scheduler and disallowed surface all skip", async () => {
  resetShadowInFlight();
  const d1 = createFakeD1({ articles: [articleRow()] });
  const collector = createCollectorScheduler();

  const noBinding = captureEvents();
  const bindingRepository = withArticleReadShadow(createAuthoritative(), {
    config: baseConfig(),
    binding: null,
    scheduler: collector.scheduler,
    sink: noBinding.sink,
    projection: false,
    caseCatalogPublic: false,
  });
  await bindingRepository.getArticleSourceTextBySlug("case-1");
  assert.equal(noBinding.events[0].reason, "no_binding");
  assert.equal(noBinding.events[0].db, "worldcons_core");
  assert.equal(d1.calls.length, 0);

  const noScheduler = captureEvents();
  const schedulerRepository = withArticleReadShadow(createAuthoritative(), {
    config: baseConfig(),
    binding: d1.database,
    scheduler: null,
    sink: noScheduler.sink,
    projection: false,
    caseCatalogPublic: false,
  });
  await schedulerRepository.getArticleSourceTextBySlug("case-1");
  assert.equal(noScheduler.events[0].reason, "no_scheduler");
  assert.equal(collector.count(), 0);
  assert.equal(d1.calls.length, 0);

  const wrongSurface = captureEvents();
  const surfaceRepository = withArticleReadShadow(createAuthoritative(), {
    config: baseConfig({ surfaces: new Set(["reference"]) }),
    binding: d1.database,
    scheduler: collector.scheduler,
    sink: wrongSurface.sink,
    projection: false,
    caseCatalogPublic: false,
  });
  await surfaceRepository.getArticleSourceTextBySlug("case-1");
  assert.equal(wrongSurface.events[0].reason, "surface_not_allowed");
  assert.equal(d1.calls.length, 0);

  const sampledOut = captureEvents();
  const sampleRepository = withArticleReadShadow(createAuthoritative(), {
    config: baseConfig({ sampleRate: 0.1 }),
    binding: d1.database,
    scheduler: collector.scheduler,
    sink: sampledOut.sink,
    projection: false,
    caseCatalogPublic: false,
    random: () => 0.9,
  });
  await sampleRepository.getArticleSourceTextBySlug("case-1");
  assert.equal(sampledOut.events[0].reason, "sampled_out");
  assert.equal(d1.calls.length, 0);
});

test("listRelatedArticleIds enforces a positive bounded limit with zero D1 calls otherwise", async () => {
  resetShadowInFlight();
  const d1 = createFakeD1({ article_tags: [] });
  const collector = createCollectorScheduler();

  const unbounded = captureEvents();
  const unboundedRepository = withArticleReadShadow(createAuthoritative(), {
    config: baseConfig(),
    binding: d1.database,
    scheduler: collector.scheduler,
    sink: unbounded.sink,
  });
  await unboundedRepository.listRelatedArticleIds("tag-9", { limit: 0 });
  assert.equal(unbounded.events[0].reason, "unbounded");
  assert.equal(d1.calls.length, 0);

  const exceeds = captureEvents();
  const exceedsRepository = withArticleReadShadow(createAuthoritative(), {
    config: baseConfig({ maxRows: 3 }),
    binding: d1.database,
    scheduler: collector.scheduler,
    sink: exceeds.sink,
  });
  await exceedsRepository.listRelatedArticleIds("tag-9", { limit: 5 });
  assert.equal(exceeds.events[0].reason, "limit_exceeds_max_rows");
  assert.equal(d1.calls.length, 0);
});

test("shadow truncation is a skip, never a partial comparison", async () => {
  resetShadowInFlight();
  const d1 = createFakeD1({ articles: [articleRow({ id: "a", slug: "a" }), articleRow({ id: "b", slug: "b" })] });
  const collector = createCollectorScheduler();
  const { events, sink } = captureEvents();
  const repository = withArticleReadShadow(
    createAuthoritative({ listArticles: async () => EMPTY_LIST_RESULT }),
    {
      config: baseConfig({ maxRows: 1 }),
      binding: d1.database,
      scheduler: collector.scheduler,
      sink,
      projection: false,
      caseCatalogPublic: false,
    },
  );

  await repository.listArticles({});
  await collector.flush();
  assert.equal(events[0].outcome, "skipped");
  assert.equal(events[0].reason, "shadow_truncated");
  assert.equal(events[0].compared, false);
  assert.equal(events[0].readOutcome, "success");
});

test("per-isolate max in-flight applies backpressure to a second read", async () => {
  resetShadowInFlight();
  const d1 = createFakeD1({ articles: [articleRow()] }, 20);
  const collector = createCollectorScheduler();
  const { events, sink } = captureEvents();
  const repository = withArticleReadShadow(createAuthoritative(), {
    config: baseConfig({ maxInFlight: 1 }),
    binding: d1.database,
    scheduler: collector.scheduler,
    sink,
    projection: false,
    caseCatalogPublic: false,
  });

  await repository.getArticleSourceTextBySlug("case-1");
  await repository.getArticleSourceTextBySlug("case-1");
  await collector.flush();
  assert.ok(events.map((event) => event.reason).includes("backpressure"));
  assert.equal(d1.calls.length, 1, "the backpressured read must not touch D1");
});

test("D1 errors and timeouts are swallowed into events and preserve the primary", async () => {
  resetShadowInFlight();
  const failing = createFakeD1({ articles: [articleRow()] }, 0, true);
  const collector = createCollectorScheduler();
  const { events, sink } = captureEvents();
  const repository = withArticleReadShadow(createAuthoritative(), {
    config: baseConfig(),
    binding: failing.database,
    scheduler: collector.scheduler,
    sink,
    projection: false,
    caseCatalogPublic: false,
  });
  assert.equal(await repository.getArticleSourceTextBySlug("case-1"), SOURCE_TEXT);
  await collector.flush();
  assert.equal(events[0].outcome, "error");
  assert.equal(events[0].errorCode, "d1_runtime_read.query_failed");

  resetShadowInFlight();
  const slow = createFakeD1({ articles: [articleRow()] }, 40);
  const timeoutCollector = createCollectorScheduler();
  const timeoutEvents = captureEvents();
  const timeoutRepository = withArticleReadShadow(createAuthoritative(), {
    config: baseConfig({ timeoutMs: 1 }),
    binding: slow.database,
    scheduler: timeoutCollector.scheduler,
    sink: timeoutEvents.sink,
    projection: false,
    caseCatalogPublic: false,
  });
  assert.equal(await timeoutRepository.getArticleSourceTextBySlug("case-1"), SOURCE_TEXT);
  await timeoutCollector.flush();
  assert.equal(timeoutEvents.events[0].outcome, "timeout");
  assert.equal(timeoutEvents.events[0].readOutcome, "timeout");
});

test("M6.1/M6.2 reference shadow still compares and returns authoritative identity", async () => {
  resetShadowInFlight();
  const primarySources = [
    {
      id: "de-bverfg",
      sourceKey: "de-bverfg",
      name: "BVerfG",
      jurisdiction: "Germany",
      baseUrl: "https://b",
      language: "de",
      isActive: true,
    },
  ];
  const d1 = createFakeD1({
    sources: [
      {
        id: "de-bverfg",
        source_key: "de-bverfg",
        name: "BVerfG",
        jurisdiction: "Germany",
        base_url: "https://b",
        language: "de",
        is_active: 1,
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
      },
    ],
  });
  const collector = createCollectorScheduler();
  const { events, sink } = captureEvents();
  const authoritative: ReferenceReadRepository = {
    async listSources() {
      return primarySources;
    },
    async listGlossaryTerms() {
      return [];
    },
    async getGlossaryTerm() {
      return null;
    },
    async listTags() {
      return [];
    },
    async getTagBySlug() {
      return null;
    },
    async listIngestionRuns() {
      return [];
    },
    async listJurisdictionArticleCounts() {
      return {};
    },
  };
  const repository = withReferenceReadShadow(authoritative, {
    config: {
      ...baseConfig(),
      surfaces: new Set(["reference"]),
    },
    binding: d1.database,
    scheduler: collector.scheduler,
    sink,
    projection: false,
  });

  assert.equal(await repository.listSources(), primarySources);
  await collector.flush();
  assert.equal(events[0].outcome, "matched", `diffPath=${events[0].diffPath ?? "null"}`);
});

test("resolveD1ShadowConfig keeps the default surfaces reference-only (article shadows stay opt-in)", () => {
  const off = resolveD1ShadowConfig({});
  assert.equal(off.readEnabled, false);
  assert.equal(off.surfaces.has(D1_SHADOW_ARTICLE_READ_SURFACE), false);
  assert.equal(off.sampleRate, D1_SHADOW_DEFAULT_SAMPLE_RATE);
});
