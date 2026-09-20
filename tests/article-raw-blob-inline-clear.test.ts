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
import { ARTICLE_RAW_BLOB_READ_ENABLED } from "../lib/article-raw/flags";
import {
  classifyArticleRawInlineClear,
  planArticleRawInlineClear,
  runArticleRawInlineClearBatch,
  toSafeArticleRawInlineClearOutcome,
  type ArticleRawInlineClearCandidate,
  type ArticleRawInlineClearDependencies,
  type ArticleRawInlineClearOutcome,
  type ArticleRawInlineClearRepository,
  type ClearArticleRawInlineInput,
} from "../lib/article-raw/inline-clear";
import { createPostgresArticleRawInlineClearRepository } from "../lib/article-raw/inline-clear-repository";
import {
  ArtifactBlobStore,
  sha256Hex,
  type ArtifactBlobGetOptions,
  type ArtifactBlobGetResult,
  type ArtifactBlobHeadResult,
  type ArtifactBlobPutOptions,
  type ArtifactBlobTransport,
} from "../lib/storage/blob";

const repositoryPath = path.join(process.cwd(), "lib/article-raw/inline-clear-repository.ts");
const inlineClearPath = path.join(process.cwd(), "lib/article-raw/inline-clear.ts");
const scriptPath = path.join(process.cwd(), "scripts/clear-article-raw-inline.ts");
const migrationPath = path.join(
  process.cwd(),
  "supabase/migrations/20260919150000_article_raw_blob_inline_clear.sql",
);

const SOURCE_KEY = "us-scotus";
const ARTICLE_ROW_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ROW_ID = "22222222-2222-4222-8222-222222222222";
const CURSOR_ROW_ID = "33333333-3333-4333-8333-333333333333";
const RAW_TEXT = "헌법 §42 raw\n text";
const EXTERNALIZED_AT = "2026-09-19T00:00:00.000Z";

const enabledEnvironment = { [ARTICLE_RAW_BLOB_READ_ENABLED]: "true" };

function streamOf(buffer: Buffer): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(buffer));
      controller.close();
    },
  });
}

class FakeTransport implements ArtifactBlobTransport {
  readonly objects = new Map<string, Buffer>();
  readonly puts: string[] = [];
  readonly gets: string[] = [];
  readonly heads: string[] = [];
  headSizeAdjust = 0;
  getBytesOverride: ((pathname: string) => Buffer | null) | null = null;

  async put(pathname: string, body: Buffer, _options: ArtifactBlobPutOptions) {
    this.puts.push(pathname);
    this.objects.set(pathname, Buffer.from(body));
    return { pathname };
  }

  async get(pathname: string, _options: ArtifactBlobGetOptions): Promise<ArtifactBlobGetResult | null> {
    this.gets.push(pathname);
    const stored = this.getBytesOverride ? this.getBytesOverride(pathname) : this.objects.get(pathname);
    if (!stored) return null;
    return { statusCode: 200, stream: streamOf(stored), size: stored.byteLength };
  }

  async head(pathname: string): Promise<ArtifactBlobHeadResult> {
    this.heads.push(pathname);
    const stored = this.objects.get(pathname);
    if (!stored) return { pathname: `${pathname}.missing`, size: 0 };
    return { pathname, size: stored.byteLength + this.headSizeAdjust };
  }
}

function candidate(overrides: Partial<ArticleRawInlineClearCandidate> = {}): ArticleRawInlineClearCandidate {
  return {
    articleTable: "articles",
    articleRowId: ARTICLE_ROW_ID,
    sourceKey: SOURCE_KEY,
    rawText: RAW_TEXT,
    rawTextStorageRef: null,
    rawTextBlobHash: null,
    rawTextBlobSize: null,
    rawTextExternalizedAt: null,
    rawTextBlobContractVersion: null,
    ...overrides,
  };
}

function externalizedCandidate(
  overrides: Partial<ArticleRawInlineClearCandidate> = {},
): ArticleRawInlineClearCandidate {
  const encoded = encodeArticleRawText(RAW_TEXT);
  return candidate({
    rawTextStorageRef: articleRawBlobStorageRef(SOURCE_KEY, encoded.sha256),
    rawTextBlobHash: encoded.sha256,
    rawTextBlobSize: encoded.size,
    rawTextExternalizedAt: EXTERNALIZED_AT,
    rawTextBlobContractVersion: ARTICLE_RAW_BLOB_CONTRACT_VERSION,
    ...overrides,
  });
}

function fakeRepository(
  candidates: ArticleRawInlineClearCandidate[],
  overrides: {
    clear?: (input: ClearArticleRawInlineInput) => Promise<{ articleRowId: string; idempotent: boolean }>;
  } = {},
) {
  const clearCalls: ClearArticleRawInlineInput[] = [];
  const listCalls: { articleTable: string; sourceKey: string | null; limit: number; afterArticleRowId: string | null }[] = [];
  const repository: Pick<
    ArticleRawInlineClearRepository,
    "listArticleRawInlineClearCandidates" | "clearArticleRawInline"
  > = {
    listArticleRawInlineClearCandidates: async (input) => {
      listCalls.push({
        articleTable: input.articleTable,
        sourceKey: input.sourceKey ?? null,
        limit: input.limit,
        afterArticleRowId: input.afterArticleRowId ?? null,
      });
      const after = input.afterArticleRowId ?? null;
      return candidates
        .filter((entry) => entry.articleTable === input.articleTable)
        .filter((entry) => (after ? entry.articleRowId > after : true))
        .slice(0, input.limit);
    },
    clearArticleRawInline: async (input) => {
      clearCalls.push(input);
      if (overrides.clear) return overrides.clear(input);
      return { articleRowId: input.articleRowId, idempotent: false };
    },
  };
  return { repository, clearCalls, listCalls };
}

function dependencies(
  repository: ReturnType<typeof fakeRepository>["repository"],
  transport = new FakeTransport(),
  environment: Record<string, string | undefined> = enabledEnvironment,
): ArticleRawInlineClearDependencies & { transport: FakeTransport } {
  return { repository, store: new ArtifactBlobStore(transport), transport, environment };
}

function seedBlob(transport: FakeTransport, rawText: string) {
  const encoded = encodeArticleRawText(rawText);
  const storageRef = articleRawBlobStorageRef(SOURCE_KEY, encoded.sha256);
  transport.objects.set(storageRef, encoded.bytes);
  return { storageRef, sha256: encoded.sha256, size: encoded.size };
}

// --- classification / planning ---------------------------------------------

test("classification reports not_ready, metadata_conflict, and ready before any Blob access", () => {
  const encoded = encodeArticleRawText(RAW_TEXT);
  const exactRef = articleRawBlobStorageRef(SOURCE_KEY, encoded.sha256);

  assert.equal(classifyArticleRawInlineClear(candidate()), "not_ready");
  assert.equal(classifyArticleRawInlineClear(externalizedCandidate()), "ready");

  const conflicts: ArticleRawInlineClearCandidate[] = [
    candidate({ rawTextStorageRef: exactRef }),
    candidate({ rawTextBlobHash: encoded.sha256, rawTextBlobSize: encoded.size }),
    externalizedCandidate({ rawTextStorageRef: null }),
    externalizedCandidate({ rawTextBlobHash: null }),
    externalizedCandidate({ rawTextBlobSize: null }),
    externalizedCandidate({ rawTextExternalizedAt: null }),
    externalizedCandidate({ rawTextBlobContractVersion: null }),
    externalizedCandidate({ rawTextExternalizedAt: "   " }),
    externalizedCandidate({ rawTextBlobContractVersion: "worldcons-article-raw-blob-v2" }),
    externalizedCandidate({ rawTextBlobHash: "not-a-hash" }),
    externalizedCandidate({ rawTextBlobSize: -1 }),
    externalizedCandidate({ rawTextBlobSize: 1.5 }),
    externalizedCandidate({ rawTextStorageRef: articleRawBlobStorageRef(SOURCE_KEY, "b".repeat(64)) }),
    externalizedCandidate({ rawTextBlobHash: "b".repeat(64) }),
  ];
  for (const conflict of conflicts) {
    assert.equal(classifyArticleRawInlineClear(conflict), "metadata_conflict");
  }
});

test("plan revalidates the content-addressed ref and returns the recorded ref/hash/size", () => {
  const entry = externalizedCandidate();
  const plan = planArticleRawInlineClear(entry);
  assert.equal(plan.storageRef, entry.rawTextStorageRef);
  assert.equal(plan.contentHash, entry.rawTextBlobHash);
  assert.equal(plan.contentSize, entry.rawTextBlobSize);
});

test("plan fails closed on not-ready and metadata-conflict candidates", () => {
  assert.throws(() => planArticleRawInlineClear(candidate()), /article_raw_inline_clear\.not_ready/);
  assert.throws(
    () => planArticleRawInlineClear(candidate({ rawTextStorageRef: articleRawBlobStorageRef(SOURCE_KEY, "b".repeat(64)) })),
    /article_raw_inline_clear\.metadata_conflict/,
  );
});

// --- dry run ----------------------------------------------------------------

test("dry run plans ready rows without any Blob read or RPC", async () => {
  const { repository, clearCalls } = fakeRepository([externalizedCandidate()]);
  const deps = dependencies(repository);
  const result = await runArticleRawInlineClearBatch(
    { articleTable: "articles", batchSize: 10, actorId: "operator", execute: false },
    deps,
  );
  assert.equal(result.scanned, 1);
  assert.equal(result.cleared, 0);
  assert.equal(result.failed.length, 0);
  assert.equal(result.outcomes[0].status, "planned");
  assert.equal(deps.transport.puts.length, 0);
  assert.equal(deps.transport.heads.length, 0);
  assert.equal(deps.transport.gets.length, 0);
  assert.equal(clearCalls.length, 0);
});

test("dry run reports ready, conflict, and not-ready rows with zero Blob and zero RPC", async () => {
  const encoded = encodeArticleRawText(RAW_TEXT);
  const partial = candidate({ rawTextStorageRef: articleRawBlobStorageRef(SOURCE_KEY, encoded.sha256) });
  const { repository, clearCalls } = fakeRepository([externalizedCandidate(), partial, candidate()]);
  const deps = dependencies(repository);
  const result = await runArticleRawInlineClearBatch(
    { articleTable: "articles", batchSize: 10, actorId: "operator", execute: false },
    deps,
  );
  assert.deepEqual(
    result.outcomes.map((outcome) => outcome.status),
    ["planned", "metadata_conflict", "not_ready"],
  );
  assert.equal(result.conflicts, 1);
  assert.equal(result.notReady, 1);
  assert.deepEqual(result.failed.map((entry) => entry.errorCode), [
    "article_raw_inline_clear.metadata_conflict",
    "article_raw_inline_clear.not_ready",
  ]);
  assert.equal(deps.transport.puts.length, 0);
  assert.equal(deps.transport.heads.length, 0);
  assert.equal(deps.transport.gets.length, 0);
  assert.equal(clearCalls.length, 0);
});

// --- execute gating ---------------------------------------------------------

test("execute requires the Blob read flag ready and fails closed before listing or mutating", async () => {
  const { repository, clearCalls, listCalls } = fakeRepository([externalizedCandidate()]);
  const deps = dependencies(repository, new FakeTransport(), {});
  await assert.rejects(
    () => runArticleRawInlineClearBatch(
      { articleTable: "articles", batchSize: 10, actorId: "operator", execute: true },
      deps,
    ),
    /article_raw_inline_clear\.read_disabled/,
  );
  assert.equal(listCalls.length, 0);
  assert.equal(deps.transport.heads.length, 0);
  assert.equal(deps.transport.gets.length, 0);
  assert.equal(clearCalls.length, 0);
});

// --- success path -----------------------------------------------------------

test("execute heads then gets, verifies size/SHA-256/decoded text, and only then clears with no put", async () => {
  const entry = externalizedCandidate();
  const { repository, clearCalls } = fakeRepository([entry]);
  const deps = dependencies(repository);
  const seed = seedBlob(deps.transport, RAW_TEXT);
  const result = await runArticleRawInlineClearBatch(
    { articleTable: "articles", batchSize: 10, actorId: "operator", execute: true },
    deps,
  );
  assert.equal(result.cleared, 1);
  assert.equal(result.failed.length, 0);
  assert.equal(result.outcomes[0].status, "cleared");
  assert.equal(deps.transport.puts.length, 0);
  assert.deepEqual(deps.transport.heads, [seed.storageRef]);
  assert.deepEqual(deps.transport.gets, [seed.storageRef]);
  assert.deepEqual(clearCalls, [{
    articleTable: "articles",
    articleRowId: ARTICLE_ROW_ID,
    expectedStorageRef: seed.storageRef,
    expectedContentHash: seed.sha256,
    expectedContentSize: seed.size,
    externalizationContractVersion: ARTICLE_RAW_BLOB_CONTRACT_VERSION,
    actorId: "operator",
  }]);
  const clearInput = clearCalls[0] as unknown as Record<string, unknown>;
  assert.equal("rawText" in clearInput, false);
  assert.equal("p_dry_run" in clearInput, false);
});

test("version rows clear against article_content_versions_p3 with their own ref", async () => {
  const entry = externalizedCandidate({ articleTable: "article_content_versions_p3", articleRowId: VERSION_ROW_ID });
  const { repository, clearCalls } = fakeRepository([entry]);
  const deps = dependencies(repository);
  seedBlob(deps.transport, RAW_TEXT);
  const result = await runArticleRawInlineClearBatch(
    { articleTable: "article_content_versions_p3", batchSize: 10, actorId: "operator", execute: true },
    deps,
  );
  assert.equal(result.cleared, 1);
  assert.equal(clearCalls[0].articleTable, "article_content_versions_p3");
  assert.equal(clearCalls[0].articleRowId, VERSION_ROW_ID);
  assert.match(clearCalls[0].expectedStorageRef, /^artifacts\/article_raw\//);
});

test("an identical rerun reported by the RPC is idempotent", async () => {
  const { repository, clearCalls } = fakeRepository([externalizedCandidate()], {
    clear: async (input) => ({ articleRowId: input.articleRowId, idempotent: true }),
  });
  const deps = dependencies(repository);
  seedBlob(deps.transport, RAW_TEXT);
  const result = await runArticleRawInlineClearBatch(
    { articleTable: "articles", batchSize: 10, actorId: "operator", execute: true },
    deps,
  );
  assert.equal(result.idempotent, 1);
  assert.equal(result.cleared, 0);
  assert.equal(result.outcomes[0].status, "idempotent");
  assert.equal(clearCalls.length, 1);
});

// --- fail-closed verification ----------------------------------------------

test("a head size mismatch blocks the RPC after the size check", async () => {
  const { repository, clearCalls } = fakeRepository([externalizedCandidate()]);
  const deps = dependencies(repository);
  seedBlob(deps.transport, RAW_TEXT);
  deps.transport.headSizeAdjust = 1;
  const result = await runArticleRawInlineClearBatch(
    { articleTable: "articles", batchSize: 10, actorId: "operator", execute: true },
    deps,
  );
  assert.equal(result.cleared, 0);
  assert.deepEqual(result.failed, [
    { articleRowId: ARTICLE_ROW_ID, errorCode: "article_raw_inline_clear.head_verification_failed" },
  ]);
  assert.equal(deps.transport.gets.length, 0);
  assert.equal(clearCalls.length, 0);
});

test("a get SHA-256 mismatch blocks the RPC", async () => {
  const { repository, clearCalls } = fakeRepository([externalizedCandidate()]);
  const deps = dependencies(repository);
  seedBlob(deps.transport, RAW_TEXT);
  deps.transport.getBytesOverride = () => Buffer.from(encodeArticleRawText("tampered").bytes);
  const result = await runArticleRawInlineClearBatch(
    { articleTable: "articles", batchSize: 10, actorId: "operator", execute: true },
    deps,
  );
  assert.equal(result.failed[0].errorCode, "article_raw_inline_clear.get_verification_failed");
  assert.equal(clearCalls.length, 0);
});

test("a stored document that is not a JSON string blocks the RPC", async () => {
  const bytes = Buffer.from("not-json{", "utf8");
  const hash = sha256Hex(bytes);
  const entry = candidate({
    rawTextStorageRef: articleRawBlobStorageRef(SOURCE_KEY, hash),
    rawTextBlobHash: hash,
    rawTextBlobSize: bytes.byteLength,
    rawTextExternalizedAt: EXTERNALIZED_AT,
    rawTextBlobContractVersion: ARTICLE_RAW_BLOB_CONTRACT_VERSION,
  });
  const { repository, clearCalls } = fakeRepository([entry]);
  const deps = dependencies(repository);
  deps.transport.objects.set(entry.rawTextStorageRef as string, bytes);
  const result = await runArticleRawInlineClearBatch(
    { articleTable: "articles", batchSize: 10, actorId: "operator", execute: true },
    deps,
  );
  assert.equal(result.failed[0].errorCode, "article_raw_inline_clear.invalid_document");
  assert.equal(clearCalls.length, 0);
});

test("a stored document whose decoded text differs from inline raw_text blocks the RPC", async () => {
  const stored = encodeArticleRawText("different text");
  const entry = externalizedCandidate({
    rawTextStorageRef: articleRawBlobStorageRef(SOURCE_KEY, stored.sha256),
    rawTextBlobHash: stored.sha256,
    rawTextBlobSize: stored.size,
  });
  const { repository, clearCalls } = fakeRepository([entry]);
  const deps = dependencies(repository);
  deps.transport.objects.set(entry.rawTextStorageRef as string, stored.bytes);
  const result = await runArticleRawInlineClearBatch(
    { articleTable: "articles", batchSize: 10, actorId: "operator", execute: true },
    deps,
  );
  assert.equal(result.failed[0].errorCode, "article_raw_inline_clear.text_mismatch");
  assert.equal(deps.transport.heads.length, 1);
  assert.equal(deps.transport.gets.length, 1);
  assert.equal(clearCalls.length, 0);
});

test("partial metadata is blocked with zero Blob read and zero RPC", async () => {
  const encoded = encodeArticleRawText(RAW_TEXT);
  const entry = candidate({ rawTextStorageRef: articleRawBlobStorageRef(SOURCE_KEY, encoded.sha256) });
  const { repository, clearCalls } = fakeRepository([entry]);
  const deps = dependencies(repository);
  const result = await runArticleRawInlineClearBatch(
    { articleTable: "articles", batchSize: 10, actorId: "operator", execute: true },
    deps,
  );
  assert.equal(result.cleared, 0);
  assert.equal(result.conflicts, 1);
  assert.deepEqual(result.failed, [
    { articleRowId: ARTICLE_ROW_ID, errorCode: "article_raw_inline_clear.metadata_conflict" },
  ]);
  assert.equal(deps.transport.puts.length, 0);
  assert.equal(deps.transport.heads.length, 0);
  assert.equal(deps.transport.gets.length, 0);
  assert.equal(clearCalls.length, 0);
});

test("conflicting full metadata is blocked with zero Blob read and zero RPC", async () => {
  const entry = externalizedCandidate({ rawTextStorageRef: articleRawBlobStorageRef(SOURCE_KEY, "b".repeat(64)) });
  const { repository, clearCalls } = fakeRepository([entry]);
  const deps = dependencies(repository);
  const result = await runArticleRawInlineClearBatch(
    { articleTable: "articles", batchSize: 10, actorId: "operator", execute: true },
    deps,
  );
  assert.equal(result.cleared, 0);
  assert.equal(result.conflicts, 1);
  assert.equal(result.failed[0].errorCode, "article_raw_inline_clear.metadata_conflict");
  assert.equal(deps.transport.heads.length, 0);
  assert.equal(deps.transport.gets.length, 0);
  assert.equal(clearCalls.length, 0);
});

// --- pagination & redaction -------------------------------------------------

test("batches stay bounded and advance with a UUID keyset cursor", async () => {
  const entries = Array.from({ length: 3 }, (_, index) => ({
    ...externalizedCandidate(),
    articleRowId: `0000000${index}-0000-4000-8000-00000000000${index}`,
  }));
  const { repository, listCalls } = fakeRepository(entries);
  const deps = dependencies(repository);
  const first = await runArticleRawInlineClearBatch(
    { articleTable: "articles", batchSize: 2, actorId: "operator", execute: false },
    deps,
  );
  assert.equal(first.scanned, 2);
  assert.equal(first.lastArticleRowId, entries[1].articleRowId);
  const second = await runArticleRawInlineClearBatch(
    { articleTable: "articles", batchSize: 2, actorId: "operator", execute: false, afterArticleRowId: first.lastArticleRowId },
    deps,
  );
  assert.equal(second.scanned, 1);
  assert.equal(second.lastArticleRowId, entries[2].articleRowId);
  assert.deepEqual(listCalls.map((call) => call.limit), [2, 2]);
  assert.equal(listCalls[0].afterArticleRowId, null);
  assert.equal(listCalls[1].afterArticleRowId, entries[1].articleRowId);
});

test("the CLI-safe outcome projection drops the ref, hash, and inline text", () => {
  const encoded = encodeArticleRawText(RAW_TEXT);
  const outcome: ArticleRawInlineClearOutcome = {
    articleTable: "articles",
    articleRowId: ARTICLE_ROW_ID,
    sourceKey: SOURCE_KEY,
    status: "cleared",
    storageRef: articleRawBlobStorageRef(SOURCE_KEY, encoded.sha256),
    contentHash: encoded.sha256,
    contentSize: encoded.size,
  };
  const safe = toSafeArticleRawInlineClearOutcome(outcome);
  assert.deepEqual(Object.keys(safe).sort(), ["articleRowId", "contentSize", "status"]);
  const serialized = JSON.stringify(safe);
  assert.equal(serialized.includes(RAW_TEXT), false);
  assert.equal(serialized.includes("artifacts/article_raw/"), false);
  assert.equal(serialized.includes(encoded.sha256), false);
});

// --- repository -------------------------------------------------------------

test("repository lists candidates through the operator read RPC and never queries raw tables directly", () => {
  const source = fs.readFileSync(repositoryPath, "utf8");
  assert.match(source, /article_raw_operator_candidates_v1/);
  assert.match(source, /article_raw_inline_clear_v1/);
  assert.match(source, /p_dry_run: false/);
  assert.equal(source.includes(".from("), false);
  assert.equal(source.includes(".select("), false);
  assert.equal(source.includes('.is("raw_text_storage_ref", null)'), false);
  assert.equal(source.includes('.not("raw_text", "is", null)'), false);
  assert.equal(source.includes("store.put("), false);
  assert.match(source, /p_article_table: input\.articleTable/);
  assert.match(source, /p_source_key: input\.sourceKey \?\? null/);
  assert.match(source, /p_after_row_id: input\.afterArticleRowId \?\? null/);
  assert.match(source, /p_limit: input\.limit/);
});

test("repository maps operator RPC candidate rows and drops rows without inline raw_text", async () => {
  const encoded = encodeArticleRawText(RAW_TEXT);
  const client = new FakeListRpcClient();
  client.rows = [
    {
      article_table: "article_content_versions_p3",
      article_row_id: VERSION_ROW_ID,
      article_id: ARTICLE_ROW_ID,
      source_key: SOURCE_KEY,
      raw_text: RAW_TEXT,
      raw_text_storage_ref: articleRawBlobStorageRef(SOURCE_KEY, encoded.sha256),
      raw_text_blob_hash: encoded.sha256,
      raw_text_blob_size: encoded.size,
      raw_text_externalized_at: EXTERNALIZED_AT,
      raw_text_blob_contract_version: ARTICLE_RAW_BLOB_CONTRACT_VERSION,
    },
    {
      article_table: "article_content_versions_p3",
      article_row_id: ARTICLE_ROW_ID,
      article_id: ARTICLE_ROW_ID,
      source_key: SOURCE_KEY,
      raw_text: null,
    },
  ];
  const repository = createPostgresArticleRawInlineClearRepository({
    client: () => client as unknown as SupabaseClient,
  });
  const result = await repository.listArticleRawInlineClearCandidates({
    articleTable: "article_content_versions_p3",
    sourceKey: SOURCE_KEY,
    limit: 5,
    afterArticleRowId: CURSOR_ROW_ID,
  });
  assert.deepEqual(client.rpcCalls, [{
    name: "article_raw_operator_candidates_v1",
    args: {
      p_article_table: "article_content_versions_p3",
      p_source_key: SOURCE_KEY,
      p_after_row_id: CURSOR_ROW_ID,
      p_limit: 5,
    },
  }]);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0], {
    articleTable: "article_content_versions_p3",
    articleRowId: VERSION_ROW_ID,
    sourceKey: SOURCE_KEY,
    rawText: RAW_TEXT,
    rawTextStorageRef: articleRawBlobStorageRef(SOURCE_KEY, encoded.sha256),
    rawTextBlobHash: encoded.sha256,
    rawTextBlobSize: encoded.size,
    rawTextExternalizedAt: EXTERNALIZED_AT,
    rawTextBlobContractVersion: ARTICLE_RAW_BLOB_CONTRACT_VERSION,
  });
});

test("repository clear calls the RPC with exact ref/hash/size/contract/actor and p_dry_run=false", async () => {
  const encoded = encodeArticleRawText(RAW_TEXT);
  const storageRef = articleRawBlobStorageRef(SOURCE_KEY, encoded.sha256);
  const client = new FakeRpcClient();
  const repository = createPostgresArticleRawInlineClearRepository({
    client: () => client as unknown as SupabaseClient,
  });
  const result = await repository.clearArticleRawInline({
    articleTable: "articles",
    articleRowId: ARTICLE_ROW_ID,
    expectedStorageRef: storageRef,
    expectedContentHash: encoded.sha256,
    expectedContentSize: encoded.size,
    externalizationContractVersion: ARTICLE_RAW_BLOB_CONTRACT_VERSION,
    actorId: "operator",
  });
  assert.deepEqual(result, { articleRowId: ARTICLE_ROW_ID, idempotent: false });
  assert.deepEqual(client.rpcCalls, [{
    name: "article_raw_inline_clear_v1",
    args: {
      p_article_table: "articles",
      p_article_row_id: ARTICLE_ROW_ID,
      p_expected_storage_ref: storageRef,
      p_expected_content_hash: encoded.sha256,
      p_expected_content_size: encoded.size,
      p_externalization_contract_version: ARTICLE_RAW_BLOB_CONTRACT_VERSION,
      p_actor_id: "operator",
      p_dry_run: false,
    },
  }]);
});

test("repository reports an idempotent RPC result", async () => {
  const client = new FakeRpcClient();
  client.rpcRow = { articleTable: "articles", articleRowId: ARTICLE_ROW_ID, dryRun: false, idempotent: true };
  const repository = createPostgresArticleRawInlineClearRepository({
    client: () => client as unknown as SupabaseClient,
  });
  const result = await repository.clearArticleRawInline({
    articleTable: "articles",
    articleRowId: ARTICLE_ROW_ID,
    expectedStorageRef: articleRawBlobStorageRef(SOURCE_KEY, "a".repeat(64)),
    expectedContentHash: "a".repeat(64),
    expectedContentSize: 1,
    externalizationContractVersion: ARTICLE_RAW_BLOB_CONTRACT_VERSION,
    actorId: "operator",
  });
  assert.equal(result.idempotent, true);
});

// --- static ordering & CLI gates -------------------------------------------

test("lib verifies head and get and decoded text before calling the repository, and never puts or deletes", () => {
  const source = fs.readFileSync(inlineClearPath, "utf8");
  const headIndex = source.indexOf("await dependencies.store.head(");
  const getIndex = source.indexOf("await dependencies.store.get(");
  const decodeIndex = source.indexOf("decodeArticleRawText(bytes)");
  const equalityIndex = source.indexOf("decoded !== candidate.rawText");
  const clearIndex = source.indexOf("await dependencies.repository.clearArticleRawInline(");
  assert.ok(headIndex >= 0 && getIndex > headIndex && decodeIndex > getIndex && equalityIndex > decodeIndex && clearIndex > equalityIndex);
  const dryRunIndex = source.indexOf("if (!input.execute)");
  const executeIndex = source.indexOf("await clearArticleRawInlinePlan(");
  assert.ok(dryRunIndex >= 0 && executeIndex > dryRunIndex);
  assert.doesNotMatch(source, /store\.put\(/);
  assert.doesNotMatch(source, /store\.delete\(/);
  assert.match(source, /articleRawBlobReadReady/);
});

test("metadata classification happens before any Blob read in the batch loop", () => {
  const source = fs.readFileSync(inlineClearPath, "utf8");
  const planIndex = source.indexOf("const plan = planArticleRawInlineClear(candidate)");
  const dryRunIndex = source.indexOf("if (!input.execute)", planIndex);
  const executeIndex = source.indexOf("await clearArticleRawInlinePlan(", planIndex);
  assert.ok(planIndex >= 0, "planning must exist");
  assert.ok(dryRunIndex > planIndex, "planning must precede the dry-run branch");
  assert.ok(executeIndex > planIndex, "planning must precede the execute path");
  const planDefinitionIndex = source.indexOf("export function planArticleRawInlineClear(");
  const classifyIndex = source.indexOf("const classification = classifyArticleRawInlineClear(candidate)");
  assert.ok(planDefinitionIndex >= 0 && planDefinitionIndex < planIndex);
  assert.ok(classifyIndex > planDefinitionIndex, "classification runs inside planning, before Blob access");
});

test("CLI execute gates on --acknowledge-inline-clear and the read flag before the store or a batch", () => {
  const source = fs.readFileSync(scriptPath, "utf8");
  const executeIndex = source.indexOf('const execute = flag("execute")');
  const gateIndex = source.indexOf("if (execute)");
  const ackIndex = source.indexOf('flag("acknowledge-inline-clear")');
  const readIndex = source.indexOf("articleRawBlobReadEnabled()");
  const storeIndex = source.indexOf("createOperatorArtifactBlobStore()");
  const batchIndex = source.indexOf("runArticleRawInlineClearBatch(");
  assert.ok(executeIndex >= 0 && gateIndex > executeIndex, "the execute flag is read before the gate");
  assert.ok(ackIndex > gateIndex && readIndex > gateIndex, "the gates live inside the execute branch");
  assert.ok(storeIndex > ackIndex && storeIndex > readIndex, "the Blob store is created only after the gates");
  assert.ok(batchIndex > ackIndex && batchIndex > readIndex, "no batch runs before the gates");
  assert.match(source, /article_raw_inline_clear\.acknowledge_required/);
  assert.match(source, /article_raw_inline_clear\.read_disabled/);
  assert.equal(source.includes("ARTICLE_RAW_BLOB_WRITE_ENABLED"), false);
  assert.equal(source.includes("articleRawBlobWriteEnabled"), false);
  assert.equal(source.includes("articleRawBlobWriteReady"), false);
});

test("CLI output is redacted through the safe outcome projection", () => {
  const source = fs.readFileSync(scriptPath, "utf8");
  assert.match(source, /toSafeArticleRawInlineClearOutcome/);
  assert.match(source, /result\.outcomes\.map\(toSafeArticleRawInlineClearOutcome\)/);
  assert.equal(source.includes("outcomes: result.outcomes,"), false);
  assert.equal(source.includes("storageRef"), false);
  assert.equal(source.includes("contentHash"), false);
});

test("script defaults to dry run with a bounded batch, cursor, and explicit table", () => {
  const source = fs.readFileSync(scriptPath, "utf8");
  assert.match(source, /const execute = flag\("execute"\)/);
  assert.match(source, /const articleTable = tableArgument\(\)/);
  assert.match(source, /integerArgument\("batch-size", 25, 1, 100\)/);
  assert.match(source, /integerArgument\("max-batches", 20, 1, 1000\)/);
  assert.match(source, /optionalUuid\("after"\)/);
  assert.match(source, /ARTICLE_RAW_INLINE_CLEAR_TABLES/);
  assert.match(source, /createOperatorArtifactBlobStore\(\)/);
  assert.match(source, /runArticleRawInlineClearBatch\(/);
  assert.equal(source.includes("store.put("), false);
  assert.equal(source.includes("store.delete("), false);
});

// --- migration contract -----------------------------------------------------

test("the M6C migration is additive and clears only the redundant inline raw_text", () => {
  const sql = fs.readFileSync(migrationPath, "utf8");
  assert.doesNotMatch(sql, /\bdrop\s+(table|column)\b/i);
  assert.doesNotMatch(sql, /\btruncate\b/i);
  assert.doesNotMatch(sql, /\bvacuum\b/i);
  assert.doesNotMatch(sql, /\bdelete\s+from\s+(articles|article_content_versions_p3)\b/i);
  assert.doesNotMatch(sql, /cleaned_text\s*=/i);
  assert.doesNotMatch(sql, /search_vector\s*=/i);

  assert.match(sql, /create table if not exists article_raw_inline_clear_permits/);
  assert.match(sql, /alter table article_raw_inline_clear_permits enable row level security/);
  assert.match(sql, /create or replace function article_raw_inline_clear_v1\(/);
  assert.match(sql, /p_dry_run boolean default true/);
  assert.match(sql, /security definer/);
  assert.match(sql, /update articles set raw_text = null where id = p_article_row_id;/);
  assert.match(sql, /update article_content_versions_p3 set raw_text = null where id = p_article_row_id;/);
  assert.match(sql, /revoke all on table article_raw_inline_clear_permits from service_role/);
  assert.match(sql, /grant execute on function article_raw_inline_clear_v1/);
  assert.doesNotMatch(sql, /grant\s+(insert|update|delete)/i);
});

test("both ledger EXISTS checks bind content_kind='raw_text' and the exact article_id", () => {
  const sql = fs.readFileSync(migrationPath, "utf8");
  const blocks = [...sql.matchAll(/if not exists \(\s*select 1\s*from article_raw_externalization_ledger l[\s\S]*?\) then/g)].map(
    (match) => match[0],
  );
  assert.equal(blocks.length, 2, "there must be exactly two ledger EXISTS checks");

  const guard = blocks.find((block) => block.includes("new.article_id"));
  const rpc = blocks.find((block) => block.includes("v_article_id"));
  assert.ok(guard, "the guard ledger check must bind NEW.article_id");
  assert.ok(rpc, "the RPC ledger check must bind v_article_id");

  assert.match(guard as string, /l\.content_kind = 'raw_text'/);
  assert.match(guard as string, /l\.article_id = new\.article_id/);
  assert.doesNotMatch(guard as string, /v_article_id/);

  assert.match(rpc as string, /l\.content_kind = 'raw_text'/);
  assert.match(rpc as string, /l\.article_id = v_article_id/);
  assert.doesNotMatch(rpc as string, /new\.article_id/);
});

// --- fakes ------------------------------------------------------------------

class FakeRpcClient {
  readonly rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  rpcRow: Record<string, unknown> = {
    articleTable: "articles",
    articleRowId: ARTICLE_ROW_ID,
    dryRun: false,
    idempotent: false,
    cleared: true,
  };
  rpcError: unknown = null;

  async rpc(name: string, args: Record<string, unknown>) {
    this.rpcCalls.push({ name, args });
    if (this.rpcError) return { data: null, error: this.rpcError };
    return { data: this.rpcRow, error: null };
  }
}

class FakeListRpcClient {
  readonly rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  rows: Record<string, unknown>[] = [];
  rpcError: unknown = null;

  async rpc(name: string, args: Record<string, unknown>) {
    this.rpcCalls.push({ name, args });
    if (this.rpcError) return { data: null, error: this.rpcError };
    return { data: this.rows, error: null };
  }
}
