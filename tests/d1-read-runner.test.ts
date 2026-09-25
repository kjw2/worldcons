import assert from "node:assert/strict";
import test from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { D1RuntimeReadError, buildD1RuntimeReadStatement, runD1RuntimeRead } from "../lib/cloudflare/d1/runtime-read";
import type { D1RuntimeDatabase, D1RuntimePreparedStatement } from "../lib/cloudflare/d1/runtime-binding";
import { d1Schema } from "../lib/cloudflare/d1/schema";
import { createD1ReferenceReadRepository, D1ReferenceReadUnsupportedError } from "../lib/reference-reads/d1-repository";
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

function createFakeSupabase(tables: Record<string, Record<string, unknown>[]>): SupabaseClient {
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
    rpc: async () => ({ data: [], error: null }),
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

test("D1 adapter rejects uncovered methods with an explicit typed error", async () => {
  const d1 = createFakeD1({ sources: SOURCE_ROWS, glossary_terms: GLOSSARY_ROWS });
  const repository = createD1ReferenceReadRepository({ binding: d1.database });
  for (const method of [
    () => repository.listTags(),
    () => repository.listJurisdictionArticleCounts(),
    () => repository.listIngestionRuns(),
    () => repository.getTagBySlug("qpc"),
  ]) {
    await assert.rejects(method, (error: unknown) => error instanceof D1ReferenceReadUnsupportedError);
  }
});
