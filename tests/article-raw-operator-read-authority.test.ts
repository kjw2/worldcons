import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  ARTICLE_RAW_BLOB_CONTRACT_VERSION,
  articleRawBlobStorageRef,
  encodeArticleRawText,
} from "../lib/article-raw/codec";
import { createPostgresArticleRawExternalizationRepository } from "../lib/article-raw/externalization-repository";
import { createPostgresArticleRawInlineClearRepository } from "../lib/article-raw/inline-clear-repository";

const migrationPath = path.join(
  process.cwd(),
  "supabase/migrations/20260919160000_article_raw_operator_read_authority.sql",
);
const restrictedGrantsPath = path.join(
  process.cwd(),
  "supabase/migrations/20260903175000_constitutional_case_catalog_view_security.sql",
);
const externalizationRepositoryPath = path.join(process.cwd(), "lib/article-raw/externalization-repository.ts");
const inlineClearRepositoryPath = path.join(process.cwd(), "lib/article-raw/inline-clear-repository.ts");
const externalizeScriptPath = path.join(process.cwd(), "scripts/externalize-article-raw.ts");
const clearScriptPath = path.join(process.cwd(), "scripts/clear-article-raw-inline.ts");

const SOURCE_KEY = "us-scotus";
const ARTICLE_ROW_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ROW_ID = "22222222-2222-4222-8222-222222222222";
const VERSION_ARTICLE_ID = "33333333-3333-4333-8333-333333333333";
const CURSOR_ROW_ID = "44444444-4444-4444-8444-444444444444";
const RAW_TEXT = "헌법 §42 raw\n text";
const EXTERNALIZED_AT = "2026-09-19T00:00:00.000Z";

const encoded = encodeArticleRawText(RAW_TEXT);
const STORAGE_REF = articleRawBlobStorageRef(SOURCE_KEY, encoded.sha256);

function operatorRow(overrides: Record<string, unknown> = {}) {
  return {
    article_table: "articles",
    article_row_id: ARTICLE_ROW_ID,
    article_id: ARTICLE_ROW_ID,
    source_key: SOURCE_KEY,
    raw_text: RAW_TEXT,
    raw_text_storage_ref: STORAGE_REF,
    raw_text_blob_hash: encoded.sha256,
    raw_text_blob_size: encoded.size,
    raw_text_externalized_at: EXTERNALIZED_AT,
    raw_text_blob_contract_version: ARTICLE_RAW_BLOB_CONTRACT_VERSION,
    ...overrides,
  };
}

class FakeOperatorReadClient {
  readonly rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  rows: unknown = [];
  rpcError: unknown = null;

  async rpc(name: string, args: Record<string, unknown>) {
    this.rpcCalls.push({ name, args });
    if (this.rpcError) return { data: null, error: this.rpcError };
    return { data: this.rows, error: null };
  }
}

function externalizationRepository(client: FakeOperatorReadClient) {
  return createPostgresArticleRawExternalizationRepository({
    client: () => client as unknown as SupabaseClient,
  });
}

function inlineClearRepository(client: FakeOperatorReadClient) {
  return createPostgresArticleRawInlineClearRepository({
    client: () => client as unknown as SupabaseClient,
  });
}

// --- migration contract -----------------------------------------------------

test("M6D-A migration is additive, read-only, and adds no table SELECT grant", () => {
  const sql = fs.readFileSync(migrationPath, "utf8");
  assert.doesNotMatch(sql, /\bdrop\s+(table|column)\b/i);
  assert.doesNotMatch(sql, /\b(truncate|vacuum)\b/i);
  assert.doesNotMatch(sql, /\b(insert|update|delete)\b/i);
  assert.doesNotMatch(sql, /alter\s+table/i);
  // No direct table or column grant of any kind is introduced.
  assert.doesNotMatch(sql, /grant\s+select/i);
  assert.doesNotMatch(sql, /grant\s+(insert|update|delete)/i);
  // The only authority granted is EXECUTE on the new function.
  assert.match(sql, /^begin;$/m);
  assert.match(sql, /^commit;$/m);
});

test("M6D-A function is SECURITY DEFINER with a fixed search_path and service_role-only execute", () => {
  const sql = fs.readFileSync(migrationPath, "utf8");
  assert.match(sql, /create or replace function article_raw_operator_candidates_v1\(/);
  assert.match(sql, /security definer/);
  assert.match(sql, /set search_path = public, pg_temp/);
  assert.match(sql, /revoke all on function article_raw_operator_candidates_v1\(text, text, uuid, integer\) from public/);
  assert.match(sql, /revoke all on function article_raw_operator_candidates_v1\(text, text, uuid, integer\) from anon/);
  assert.match(sql, /revoke all on function article_raw_operator_candidates_v1\(text, text, uuid, integer\) from authenticated/);
  assert.match(sql, /grant execute on function article_raw_operator_candidates_v1\(text, text, uuid, integer\) to service_role/);
  assert.doesNotMatch(sql, /to anon/);
  assert.doesNotMatch(sql, /to authenticated/);
  for (const column of [
    "article_table text",
    "article_row_id uuid",
    "article_id uuid",
    "source_key text",
    "raw_text text",
    "raw_text_storage_ref text",
    "raw_text_blob_hash text",
    "raw_text_blob_size bigint",
    "raw_text_externalized_at timestamptz",
    "raw_text_blob_contract_version text",
  ]) {
    assert.ok(sql.includes(column), `missing return column ${column}`);
  }
});

test("M6D-A function is bounded to the two tables, limit 1..100, exact source key, and keyset id > cursor", () => {
  const sql = fs.readFileSync(migrationPath, "utf8");
  assert.match(sql, /p_article_table not in \('articles', 'article_content_versions_p3'\)/);
  assert.match(sql, /ARTICLE_RAW_OPERATOR_TABLE_INVALID/);
  assert.match(sql, /p_limit is null or p_limit < 1 or p_limit > 100/);
  assert.match(sql, /ARTICLE_RAW_OPERATOR_LIMIT_INVALID/);
  assert.match(sql, /p_source_key !~ '\^\[a-z\]\[a-z0-9\._-\]\{0,79\}\$'/);
  assert.match(sql, /ARTICLE_RAW_OPERATOR_SOURCE_KEY_INVALID/);
  assert.match(sql, /a\.raw_text is not null/);
  assert.match(sql, /v\.raw_text is not null/);
  assert.match(sql, /a\.source_key = p_source_key/);
  assert.match(sql, /v\.source_key = p_source_key/);
  assert.match(sql, /a\.id > p_after_row_id/);
  assert.match(sql, /v\.id > p_after_row_id/);
  assert.match(sql, /order by a\.id asc/);
  assert.match(sql, /order by v\.id asc/);
  assert.match(sql, /limit v_limit/);
  assert.ok(
    sql.indexOf("ARTICLE_RAW_OPERATOR_LIMIT_INVALID") < sql.indexOf("from articles a"),
    "the limit gate must precede the reads",
  );
});

test("the pre-existing column-restricted service_role grants on the version table are untouched", () => {
  const restricted = fs.readFileSync(restrictedGrantsPath, "utf8");
  const versionEnd = restricted.indexOf(") on article_content_versions_p3 to service_role;");
  const versionStart = restricted.lastIndexOf("grant select(", versionEnd);
  assert.ok(versionStart >= 0 && versionEnd > versionStart, "the restricted version grant must still exist");
  const versionGrant = restricted.slice(versionStart, versionEnd);
  assert.equal(versionGrant.includes("raw_text"), false, "the restricted grant must still exclude raw_text");
  assert.equal(versionGrant.includes("raw_text_blob"), false, "the restricted grant must still exclude raw blob metadata");

  const sql = fs.readFileSync(migrationPath, "utf8");
  assert.equal(sql.includes("on article_content_versions_p3 to service_role"), false);
  assert.equal(sql.includes("on articles to service_role"), false);
  assert.equal(sql.includes("grant select"), false);
});

// --- repository wiring ------------------------------------------------------

test("both repositories list through the M6D-A RPC and never query the raw tables directly", () => {
  for (const repositoryPath of [externalizationRepositoryPath, inlineClearRepositoryPath]) {
    const source = fs.readFileSync(repositoryPath, "utf8");
    assert.match(source, /article_raw_operator_candidates_v1/);
    assert.equal(source.includes(".from("), false, "candidate listing must not use .from()");
    assert.equal(source.includes(".select("), false, "candidate listing must not use .select()");
    assert.equal(source.includes('from("article_content_versions_p3")'), false);
    assert.equal(source.includes('from("articles")'), false);
    assert.match(source, /p_article_table: input\.articleTable/);
    assert.match(source, /p_source_key: input\.sourceKey \?\? null/);
    assert.match(source, /p_after_row_id: input\.afterArticleRowId \?\? null/);
    assert.match(source, /p_limit: input\.limit/);
  }

  const externalizationSource = fs.readFileSync(externalizationRepositoryPath, "utf8");
  assert.match(externalizationSource, /rpc\("article_raw_externalize_v1"/);
  const inlineClearSource = fs.readFileSync(inlineClearRepositoryPath, "utf8");
  assert.match(inlineClearSource, /rpc\("article_raw_inline_clear_v1"/);
  assert.match(inlineClearSource, /p_dry_run: false/);
});

test("externalization repository maps both table variants and passes the exact RPC args", async () => {
  const client = new FakeOperatorReadClient();
  const repository = externalizationRepository(client);

  client.rows = [operatorRow()];
  const articles = await repository.listArticleRawExternalizationCandidates({
    articleTable: "articles",
    sourceKey: null,
    limit: 25,
    afterArticleRowId: null,
  });
  assert.deepEqual(articles, [{
    articleTable: "articles",
    articleRowId: ARTICLE_ROW_ID,
    articleId: ARTICLE_ROW_ID,
    sourceKey: SOURCE_KEY,
    rawText: RAW_TEXT,
    rawTextStorageRef: STORAGE_REF,
    rawTextBlobHash: encoded.sha256,
    rawTextBlobSize: encoded.size,
    rawTextExternalizedAt: EXTERNALIZED_AT,
    rawTextBlobContractVersion: ARTICLE_RAW_BLOB_CONTRACT_VERSION,
  }]);

  client.rows = [operatorRow({
    article_table: "article_content_versions_p3",
    article_row_id: VERSION_ROW_ID,
    article_id: VERSION_ARTICLE_ID,
  })];
  const versions = await repository.listArticleRawExternalizationCandidates({
    articleTable: "article_content_versions_p3",
    sourceKey: SOURCE_KEY,
    limit: 7,
    afterArticleRowId: CURSOR_ROW_ID,
  });
  assert.deepEqual(versions, [{
    articleTable: "article_content_versions_p3",
    articleRowId: VERSION_ROW_ID,
    articleId: VERSION_ARTICLE_ID,
    sourceKey: SOURCE_KEY,
    rawText: RAW_TEXT,
    rawTextStorageRef: STORAGE_REF,
    rawTextBlobHash: encoded.sha256,
    rawTextBlobSize: encoded.size,
    rawTextExternalizedAt: EXTERNALIZED_AT,
    rawTextBlobContractVersion: ARTICLE_RAW_BLOB_CONTRACT_VERSION,
  }]);

  assert.deepEqual(client.rpcCalls, [
    {
      name: "article_raw_operator_candidates_v1",
      args: { p_article_table: "articles", p_source_key: null, p_after_row_id: null, p_limit: 25 },
    },
    {
      name: "article_raw_operator_candidates_v1",
      args: {
        p_article_table: "article_content_versions_p3",
        p_source_key: SOURCE_KEY,
        p_after_row_id: CURSOR_ROW_ID,
        p_limit: 7,
      },
    },
  ]);
});

test("inline-clear repository maps both table variants and passes the exact RPC args", async () => {
  const client = new FakeOperatorReadClient();
  const repository = inlineClearRepository(client);

  client.rows = [operatorRow()];
  const articles = await repository.listArticleRawInlineClearCandidates({
    articleTable: "articles",
    sourceKey: null,
    limit: 25,
    afterArticleRowId: null,
  });
  assert.deepEqual(articles, [{
    articleTable: "articles",
    articleRowId: ARTICLE_ROW_ID,
    sourceKey: SOURCE_KEY,
    rawText: RAW_TEXT,
    rawTextStorageRef: STORAGE_REF,
    rawTextBlobHash: encoded.sha256,
    rawTextBlobSize: encoded.size,
    rawTextExternalizedAt: EXTERNALIZED_AT,
    rawTextBlobContractVersion: ARTICLE_RAW_BLOB_CONTRACT_VERSION,
  }]);

  client.rows = [operatorRow({
    article_table: "article_content_versions_p3",
    article_row_id: VERSION_ROW_ID,
    article_id: VERSION_ARTICLE_ID,
  })];
  const versions = await repository.listArticleRawInlineClearCandidates({
    articleTable: "article_content_versions_p3",
    sourceKey: SOURCE_KEY,
    limit: 7,
    afterArticleRowId: CURSOR_ROW_ID,
  });
  assert.deepEqual(versions, [{
    articleTable: "article_content_versions_p3",
    articleRowId: VERSION_ROW_ID,
    sourceKey: SOURCE_KEY,
    rawText: RAW_TEXT,
    rawTextStorageRef: STORAGE_REF,
    rawTextBlobHash: encoded.sha256,
    rawTextBlobSize: encoded.size,
    rawTextExternalizedAt: EXTERNALIZED_AT,
    rawTextBlobContractVersion: ARTICLE_RAW_BLOB_CONTRACT_VERSION,
  }]);

  assert.deepEqual(client.rpcCalls, [
    {
      name: "article_raw_operator_candidates_v1",
      args: { p_article_table: "articles", p_source_key: null, p_after_row_id: null, p_limit: 25 },
    },
    {
      name: "article_raw_operator_candidates_v1",
      args: {
        p_article_table: "article_content_versions_p3",
        p_source_key: SOURCE_KEY,
        p_after_row_id: CURSOR_ROW_ID,
        p_limit: 7,
      },
    },
  ]);
});

test("operator read repositories drop rows missing raw_text, source key, or row id", async () => {
  const client = new FakeOperatorReadClient();
  const externalization = externalizationRepository(client);
  const inlineClear = inlineClearRepository(client);
  client.rows = [
    operatorRow(),
    operatorRow({ raw_text: null }),
    operatorRow({ source_key: null }),
    operatorRow({ article_row_id: null }),
    operatorRow({ article_id: null }),
  ];

  assert.equal((await externalization.listArticleRawExternalizationCandidates({
    articleTable: "articles",
    limit: 10,
  })).length, 1);

  client.rows = [
    operatorRow(),
    operatorRow({ raw_text: null }),
    operatorRow({ source_key: null }),
    operatorRow({ article_row_id: null }),
  ];
  assert.equal((await inlineClear.listArticleRawInlineClearCandidates({
    articleTable: "articles",
    limit: 10,
  })).length, 1);
});

test("operator read repositories fall back to the requested table and surface RPC errors", async () => {
  const client = new FakeOperatorReadClient();
  const repository = inlineClearRepository(client);

  client.rows = [operatorRow({ article_table: "unexpected" })];
  const fallback = await repository.listArticleRawInlineClearCandidates({ articleTable: "articles", limit: 10 });
  assert.equal(fallback.length, 1);
  assert.equal(fallback[0].articleTable, "articles");

  client.rpcError = { message: "article_raw_operator_candidates_v1_failed" };
  await assert.rejects(
    () => repository.listArticleRawInlineClearCandidates({ articleTable: "articles", limit: 10 }),
    /article_raw_operator_candidates_v1_failed/,
  );
});

// --- CLI redaction ----------------------------------------------------------

test("article raw CLI entrypoints never project raw text", () => {
  for (const scriptPath of [externalizeScriptPath, clearScriptPath]) {
    const source = fs.readFileSync(scriptPath, "utf8");
    assert.equal(source.includes("rawText"), false, `${scriptPath} must not reference rawText`);
    assert.ok(
      source.includes("toSafeArticleRawExternalizationOutcome")
        || source.includes("toSafeArticleRawInlineClearOutcome"),
      `${scriptPath} must route outcomes through the safe projection`,
    );
    assert.equal(source.includes("outcomes: result.outcomes,"), false);
  }
});
