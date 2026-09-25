import assert from "node:assert/strict";
import test from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { D1RuntimeReadError, buildD1RuntimeReadStatement, runD1RuntimeRead } from "../lib/cloudflare/d1/runtime-read";
import type { D1RuntimeDatabase, D1RuntimePreparedStatement } from "../lib/cloudflare/d1/runtime-binding";
import { d1Schema } from "../lib/cloudflare/d1/schema";
import { createD1ReferenceReadRepository, D1ShadowTruncatedError } from "../lib/reference-reads/d1-repository";
import { createSupabaseReferenceReadRepository } from "../lib/reference-reads/supabase-repository";

/**
 * M6.1 D1 read runner + D1 reference-read adapter tests: guarded/bound SQL,
 * fail-closed response validation, JSON/array revival and mapping parity with
 * the authoritative Supabase adapter.
 */

interface CapturedStatement {
  sql: string;
  params: unknown[];
}

interface FakeD1Options {
  failEnvelope?: boolean;
  resultsNotArray?: boolean;
  nonObjectRow?: boolean;
}

function createFakeD1(
  rowsByTable: Record<string, Record<string, unknown>[]>,
  options: FakeD1Options = {},
) {
  const calls: CapturedStatement[] = [];
  const database: D1RuntimeDatabase = {
    prepare(query: string): D1RuntimePreparedStatement {
      const record: CapturedStatement = { sql: query, params: [] };
      calls.push(record);
      const statement: D1RuntimePreparedStatement = {
        bind(...params: unknown[]) {
          record.params = params;
          return statement;
        },
        async all<T = Record<string, unknown>>() {
          if (options.failEnvelope) return { success: false, error: "d1 boom" } as { results?: T[] };
          if (options.resultsNotArray) return { success: true } as { results?: T[] };
          const table = Object.keys(rowsByTable).find((name) => query.includes(` from ${name}`));
          let rows = table ? rowsByTable[table] : [];
          const where = / where ([a-z_][a-z0-9_]*) = \?/.exec(query);
          if (where) rows = rows.filter((row) => row[where[1]] === record.params[0]);
          if (options.nonObjectRow) {
            return { success: true, results: ["not-an-object"] as unknown as T[] };
          }
          return { success: true, results: rows as unknown as T[] };
        },
      };
      return statement;
    },
  };
  return { database, calls };
}

function table(name: string) {
  const found = d1Schema.tables.find((entry) => entry.name === name);
  if (!found) throw new Error(`missing test table ${name}`);
  return found;
}

function createFakeSupabase(
  tables: Record<string, Record<string, unknown>[]>,
  rpc: (name: string, args: unknown) => { data?: unknown; error?: { message: string } | null } = () => ({ data: [], error: null }),
): SupabaseClient {
  const client = {
    from(name: string) {
      const builder: Record<string, unknown> = {};
      const resolve = () => ({ data: tables[name] ?? [], error: null });
      builder.select = () => builder;
      builder.order = () => builder;
      builder.eq = () => builder;
      builder.gte = () => builder;
      builder.filter = () => builder;
      builder.limit = () => builder;
      builder.maybeSingle = () => Promise.resolve({ data: (tables[name] ?? [])[0] ?? null, error: null });
      builder.then = (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
        Promise.resolve(resolve()).then(onFulfilled, onRejected);
      return builder;
    },
    rpc: async (name: string, args: unknown) => rpc(name, args),
  };
  return client as unknown as SupabaseClient;
}

const SOURCE_ROWS = [
  {
    id: "source-1",
    source_key: "de-bverfg",
    name: "Federal Constitutional Court of Germany",
    jurisdiction: "Germany",
    base_url: "https://www.bundesverfassungsgericht.de",
    language: "de",
    is_active: true,
  },
  {
    id: "source-2",
    source_key: "fr-conseil",
    name: "Conseil constitutionnel",
    jurisdiction: "France",
    base_url: "https://www.conseil-constitutionnel.fr",
    language: "fr",
    is_active: false,
  },
];

const GLOSSARY_ROWS = [
  {
    id: "term-1",
    slug: "qpc",
    term: "Question prioritaire de constitutionnalite",
    korean_term: "우선적 위헌심사절차",
    definition: "프랑스의 사후적 위헌심사 절차",
    jurisdiction: "France",
    related_tags: ["QPC", "Article 61-1"],
  },
  {
    id: "term-2",
    slug: "standing",
    term: "Standing",
    korean_term: "당사자적격",
    definition: "미국 연방법원의 본안 판단 요건",
    jurisdiction: "United States",
    related_tags: [],
  },
];

test("D1 read statement guards authored identifiers and binds every value", () => {
  const statement = buildD1RuntimeReadStatement({
    binding: createFakeD1({}).database,
    table: table("sources"),
    orderBy: ["jurisdiction"],
    limit: 50,
  });
  assert.equal(
    statement.sql,
    "select id, source_key, name, jurisdiction, base_url, language, is_active, created_at, updated_at from sources order by jurisdiction limit ?",
  );
  assert.deepEqual(statement.params, [50]);

  const bounded = buildD1RuntimeReadStatement({
    binding: createFakeD1({}).database,
    table: table("glossary_terms"),
    where: [{ column: "slug", value: "qpc" }],
    orderBy: ["term"],
    limit: 1,
  });
  assert.equal(
    bounded.sql,
    "select id, slug, term, korean_term, definition, jurisdiction, related_tags, created_at, updated_at from glossary_terms where slug = ? order by term limit ?",
  );
  assert.deepEqual(bounded.params, ["qpc", 1]);
});

test("D1 read runner rejects unknown predicate/order columns instead of interpolating", () => {
  assert.throws(
    () =>
      buildD1RuntimeReadStatement({
        binding: createFakeD1({}).database,
        table: table("sources"),
        where: [{ column: "not_a_column", value: "x" }],
      }),
    (error: unknown) => error instanceof D1RuntimeReadError && error.code === "d1_runtime_read.unknown_column",
  );
  assert.throws(
    () =>
      buildD1RuntimeReadStatement({
        binding: createFakeD1({}).database,
        table: table("sources"),
        orderBy: ["; drop table sources"],
      }),
    (error: unknown) => error instanceof D1RuntimeReadError,
  );
});

test("D1 read runner revives JSON/array canonical text and fails closed on invalid JSON", async () => {
  const fake = createFakeD1({ glossary_terms: GLOSSARY_ROWS });
  const rows = await runD1RuntimeRead({
    binding: fake.database,
    table: table("glossary_terms"),
    orderBy: ["term"],
    limit: 10,
  });
  assert.deepEqual(rows[0]?.related_tags, ["QPC", "Article 61-1"]);

  const corrupted = createFakeD1({ glossary_terms: [{ slug: "qpc", term: "QPC", related_tags: "{not json" }] });
  await assert.rejects(
    () => runD1RuntimeRead({ binding: corrupted.database, table: table("glossary_terms"), limit: 1 }),
    (error: unknown) => error instanceof D1RuntimeReadError && error.code === "d1_runtime_read.invalid_json",
  );
});

test("D1 read runner fails closed on a malformed response envelope", async () => {
  const failed = createFakeD1({}, { failEnvelope: true });
  await assert.rejects(
    () => runD1RuntimeRead({ binding: failed.database, table: table("sources"), limit: 5 }),
    (error: unknown) => error instanceof D1RuntimeReadError && error.code === "d1_runtime_read.query_failed",
  );

  const noRows = createFakeD1({}, { resultsNotArray: true });
  await assert.rejects(
    () => runD1RuntimeRead({ binding: noRows.database, table: table("sources"), limit: 5 }),
    (error: unknown) => error instanceof D1RuntimeReadError && error.code === "d1_runtime_read.invalid_response",
  );

  const nonObject = createFakeD1({ sources: SOURCE_ROWS }, { nonObjectRow: true });
  await assert.rejects(
    () => runD1RuntimeRead({ binding: nonObject.database, table: table("sources"), limit: 5 }),
    (error: unknown) => error instanceof D1RuntimeReadError && error.code === "d1_runtime_read.invalid_response",
  );
});

test("D1 read statement projects authored columns and renders eq/gte plus ordered directions", () => {
  const projected = buildD1RuntimeReadStatement({
    binding: createFakeD1({}).database,
    table: table("articles"),
    select: ["jurisdiction", "source_metadata"],
    where: [
      { column: "status", value: "summarized" },
      { column: "original_published_at", op: "gte", value: "2026-05-01T00:00:00.000Z" },
    ],
    orderBy: [],
    limit: 50,
  });
  assert.equal(
    projected.sql,
    "select jurisdiction, source_metadata from articles where status = ? and original_published_at >= ? limit ?",
  );
  assert.deepEqual(projected.params, ["summarized", "2026-05-01T00:00:00.000Z", 50]);

  const ordered = buildD1RuntimeReadStatement({
    binding: createFakeD1({}).database,
    table: table("tags"),
    orderBy: [
      { column: "latest_article_at", direction: "desc", nulls: "last" },
      { column: "name", direction: "asc" },
    ],
    limit: 5,
  });
  assert.equal(
    ordered.sql,
    "select id, slug, name, normalized_name, type, description, article_count, latest_article_at, created_at, updated_at from tags order by latest_article_at desc nulls last, name asc limit ?",
  );
  assert.deepEqual(ordered.params, [5]);
});

test("D1 read runner rejects unknown select columns and unsupported operators instead of interpolating", () => {
  assert.throws(
    () =>
      buildD1RuntimeReadStatement({
        binding: createFakeD1({}).database,
        table: table("tags"),
        select: ["not_a_column"],
      }),
    (error: unknown) => error instanceof D1RuntimeReadError && error.code === "d1_runtime_read.unknown_column",
  );
  assert.throws(
    () =>
      buildD1RuntimeReadStatement({
        binding: createFakeD1({}).database,
        table: table("tags"),
        where: [{ column: "type", op: "like" as never, value: "%" }],
      }),
    (error: unknown) => error instanceof D1RuntimeReadError && error.code === "d1_runtime_read.invalid_operator",
  );
  assert.throws(
    () =>
      buildD1RuntimeReadStatement({
        binding: createFakeD1({}).database,
        table: table("tags"),
        orderBy: [{ column: "name", direction: "sideways" as never }],
      }),
    (error: unknown) => error instanceof D1RuntimeReadError && error.code === "d1_runtime_read.invalid_order",
  );
});

test("D1 read runner revives only the projected columns", async () => {
  const fake = createFakeD1({
    articles: [
      { id: "a1", jurisdiction: "France", status: "summarized", source_metadata: '{"collection":{"publishable":true}}' },
    ],
  });
  const rows = await runD1RuntimeRead({
    binding: fake.database,
    table: table("articles"),
    select: ["jurisdiction", "source_metadata"],
    orderBy: [],
    limit: 5,
  });
  assert.deepEqual(Object.keys(rows[0]).sort(), ["jurisdiction", "source_metadata"]);
  assert.equal((rows[0].source_metadata as { collection: { publishable: boolean } }).collection.publishable, true);
});

test("D1 and Supabase source mapping are identical (boolean 0/1 and true/false)", async () => {
  const supabase = createFakeSupabase({ sources: SOURCE_ROWS });
  const d1Rows = SOURCE_ROWS.map((row) => ({ ...row, is_active: row.is_active ? 1 : 0 }));
  const d1 = createFakeD1({ sources: d1Rows });

  const authoritative = await createSupabaseReferenceReadRepository({
    client: () => supabase,
    environment: {},
  }).listSources();
  const shadow = await createD1ReferenceReadRepository({ binding: d1.database }).listSources();

  assert.deepEqual(shadow, authoritative);
  assert.equal(shadow[0].isActive, true);
  assert.equal(shadow[1].isActive, false);
  assert.deepEqual(d1.calls[0].params, [2000]);
});

test("D1 and Supabase glossary mapping are identical and keep the Korean-label order", async () => {
  const supabase = createFakeSupabase({
    glossary_terms: GLOSSARY_ROWS.map((row) => ({ ...row, related_tags: row.related_tags })),
  });
  const d1 = createFakeD1({
    glossary_terms: GLOSSARY_ROWS.map((row) => ({ ...row, related_tags: JSON.stringify(row.related_tags) })),
  });

  const authoritative = await createSupabaseReferenceReadRepository({
    client: () => supabase,
    environment: {},
  }).listGlossaryTerms();
  const shadow = await createD1ReferenceReadRepository({ binding: d1.database }).listGlossaryTerms();

  assert.deepEqual(shadow, authoritative);

  const found = await createD1ReferenceReadRepository({ binding: d1.database }).getGlossaryTerm("qpc");
  assert.equal(found?.slug, "qpc");
  assert.equal(await createD1ReferenceReadRepository({ binding: d1.database }).getGlossaryTerm("missing"), null);
  const lastCall = d1.calls[d1.calls.length - 1];
  assert.match(lastCall.sql, /where slug = \?/);
  assert.deepEqual(lastCall.params, ["missing", 1]);
});

const TAG_ROWS = [
  {
    id: "tag-1",
    slug: "qpc",
    name: "QPC",
    normalized_name: "QPC",
    type: "procedure",
    description: null,
    article_count: 3,
    latest_article_at: "2026-05-02T00:00:00.000Z",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-05-02T00:00:00.000Z",
  },
  {
    id: "tag-2",
    slug: "amparo",
    name: "Amparo",
    normalized_name: "AMPARO",
    type: "procedure",
    description: null,
    article_count: 7,
    latest_article_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-05-03T00:00:00.000Z",
  },
];

const INGESTION_RUN_ROWS = [
  {
    id: "run-1",
    source_key: "us-scotus",
    started_at: "2026-05-08T00:00:00.000Z",
    finished_at: "2026-05-08T00:02:31.000Z",
    status: "completed",
    discovered_count: 12,
    fetched_count: 4,
    summarized_count: 2,
    failed_count: 0,
    error_message: null,
    metadata: { mode: "mock" },
  },
  {
    id: "run-2",
    source_key: "de-bverfg",
    started_at: "2026-05-07T00:00:00.000Z",
    finished_at: null,
    status: "running",
    discovered_count: 3,
    fetched_count: 1,
    summarized_count: 0,
    failed_count: 1,
    error_message: "timeout",
    metadata: null,
  },
];

test("D1 listTags/getTagBySlug map identically to Supabase and bound the query", async () => {
  const supabase = createFakeSupabase({ tags: TAG_ROWS });
  const d1 = createFakeD1({ tags: TAG_ROWS });

  const authoritative = await createSupabaseReferenceReadRepository({
    client: () => supabase,
    environment: {},
  }).listTags({ limit: 5 });
  const shadow = await createD1ReferenceReadRepository({ binding: d1.database }).listTags({ limit: 5 });
  assert.deepEqual(shadow, authoritative);

  assert.match(d1.calls[0].sql, /from tags order by article_count desc limit \?/);
  assert.deepEqual(d1.calls[0].params, [5]);

  await createD1ReferenceReadRepository({ binding: d1.database }).listTags({
    type: "procedure",
    minArticleCount: 2,
    sort: "latest",
    limit: 4,
  });
  const latestCall = d1.calls[d1.calls.length - 1];
  assert.match(latestCall.sql, /where type = \? and article_count >= \?/);
  assert.match(latestCall.sql, /order by latest_article_at desc nulls last limit \?/);
  assert.deepEqual(latestCall.params, ["procedure", 2, 4]);

  const tag = await createD1ReferenceReadRepository({ binding: d1.database }).getTagBySlug("qpc");
  assert.equal(tag?.slug, "qpc");
  assert.equal(await createD1ReferenceReadRepository({ binding: d1.database }).getTagBySlug("missing"), null);
  const slugCall = d1.calls[d1.calls.length - 1];
  assert.match(slugCall.sql, /from tags where slug = \?/);
  assert.deepEqual(slugCall.params, ["missing", 1]);
});

test("D1 listTags rejects an unbounded read and getTagBySlug orders by name ascending", async () => {
  const d1 = createFakeD1({ tags: TAG_ROWS });
  await assert.rejects(
    () => createD1ReferenceReadRepository({ binding: d1.database }).listTags({ sort: "name" }),
    /explicit bounded limit/,
  );

  await createD1ReferenceReadRepository({ binding: d1.database }).listTags({ sort: "name", limit: 2 });
  assert.match(d1.calls[0].sql, /order by name asc limit \?/);
});

test("D1 listIngestionRuns uses the ingest binding, revives metadata and truncates overflow", async () => {
  const core = createFakeD1({ tags: TAG_ROWS });
  const ingest = createFakeD1({ ingestion_runs: INGESTION_RUN_ROWS });
  const supabase = createFakeSupabase({ ingestion_runs: INGESTION_RUN_ROWS });

  const authoritative = await createSupabaseReferenceReadRepository({
    client: () => supabase,
    environment: {},
  }).listIngestionRuns(5);
  const shadow = await createD1ReferenceReadRepository({
    binding: core.database,
    ingestBinding: ingest.database,
  }).listIngestionRuns(5);
  assert.deepEqual(shadow, authoritative);
  assert.equal(core.calls.length, 0, "ingestion runs must never read worldcons_core");
  assert.match(ingest.calls[0].sql, /from ingestion_runs order by started_at desc limit \?/);
  assert.deepEqual(ingest.calls[0].params, [5]);

  const truncated = createFakeD1({ ingestion_runs: INGESTION_RUN_ROWS });
  await assert.rejects(
    () => createD1ReferenceReadRepository({ binding: core.database, ingestBinding: truncated.database, maxRows: 1 }).listIngestionRuns(5),
    (error: unknown) => error instanceof D1ShadowTruncatedError && error.code === "d1_shadow.truncated",
  );
});

test("D1 listJurisdictionArticleCounts matches the legacy RPC grouping and zero-fills", async () => {
  const articleRows = [
    { id: "a1", status: "summarized", jurisdiction: "France", source_metadata: { collection: { publishable: true } } },
    { id: "a2", status: "summarized", jurisdiction: "France", source_metadata: '{"collection":{"publishable":true}}' },
    { id: "a3", status: "summarized", jurisdiction: "France", source_metadata: { collection: { publishable: false } } },
    { id: "a4", status: "summarized", jurisdiction: "Germany", source_metadata: { collection: { publishable: true } } },
    { id: "a5", status: "discovered", jurisdiction: "Spain", source_metadata: { collection: { publishable: true } } },
    { id: "a6", status: "summarized", jurisdiction: "  ", source_metadata: { collection: { publishable: true } } },
  ];
  const d1 = createFakeD1({ articles: articleRows });
  const supabase = createFakeSupabase({}, () => ({
    data: [
      { jurisdiction: "France", article_count: "2" },
      { jurisdiction: "Germany", article_count: 1 },
    ],
    error: null,
  }));

  const authoritative = await createSupabaseReferenceReadRepository({
    client: () => supabase,
    environment: {},
  }).listJurisdictionArticleCounts(["France", "Spain"]);
  const shadow = await createD1ReferenceReadRepository({ binding: d1.database }).listJurisdictionArticleCounts([
    "France",
    "Spain",
  ]);
  assert.deepEqual(shadow, authoritative);
  assert.deepEqual(shadow, { France: 2, Spain: 0 });

  assert.match(d1.calls[0].sql, /select jurisdiction, source_metadata from articles where status = \? limit \?/);
  assert.deepEqual(d1.calls[0].params, ["summarized", 2001]);
});

test("D1 listJurisdictionArticleCounts truncates overflow and applies the range lower bound", async () => {
  const d1 = createFakeD1({
    articles: [
      { id: "a1", status: "summarized", jurisdiction: "France", source_metadata: { collection: { publishable: true } } },
      { id: "a2", status: "summarized", jurisdiction: "France", source_metadata: { collection: { publishable: true } } },
    ],
  });
  await assert.rejects(
    () => createD1ReferenceReadRepository({ binding: d1.database, maxRows: 1 }).listJurisdictionArticleCounts(["France"]),
    (error: unknown) => error instanceof D1ShadowTruncatedError,
  );

  const ranged = createFakeD1({ articles: [] });
  await createD1ReferenceReadRepository({ binding: ranged.database }).listJurisdictionArticleCounts(["France"], {
    range: "week",
  });
  assert.match(ranged.calls[0].sql, /where status = \? and original_published_at >= \? limit \?/);
  assert.equal(typeof ranged.calls[0].params[1], "string");
});
