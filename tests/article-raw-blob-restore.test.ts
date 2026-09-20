import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  ARTICLE_RAW_BLOB_CONTRACT_VERSION,
  ARTICLE_RAW_BLOB_MAX_BYTES,
  articleRawBlobStorageRef,
  encodeArticleRawText,
} from "../lib/article-raw/codec";
import { ARTICLE_RAW_BLOB_READ_ENABLED } from "../lib/article-raw/flags";
import {
  classifyArticleRawRestore,
  planArticleRawRestore,
  runArticleRawRestoreBatch,
  toSafeArticleRawRestoreOutcome,
  type ArticleRawRestoreCandidate,
  type ArticleRawRestoreDependencies,
  type ArticleRawRestoreOutcome,
  type ArticleRawRestoreRepository,
  type RestoreArticleRawInlineInput,
} from "../lib/article-raw/restore";
import { createPostgresArticleRawRestoreRepository } from "../lib/article-raw/restore-repository";
import {
  ArtifactBlobStore,
  sha256Hex,
  type ArtifactBlobGetOptions,
  type ArtifactBlobGetResult,
  type ArtifactBlobHeadResult,
  type ArtifactBlobPutOptions,
  type ArtifactBlobTransport,
} from "../lib/storage/blob";

const repositoryPath = path.join(process.cwd(), "lib/article-raw/restore-repository.ts");
const restorePath = path.join(process.cwd(), "lib/article-raw/restore.ts");
const scriptPath = path.join(process.cwd(), "scripts/restore-article-raw-inline.ts");
const migrationPath = path.join(
  process.cwd(),
  "supabase/migrations/20260919180000_article_raw_blob_restore.sql",
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

function candidate(overrides: Partial<ArticleRawRestoreCandidate> = {}): ArticleRawRestoreCandidate {
  return {
    articleTable: "articles",
    articleRowId: ARTICLE_ROW_ID,
    sourceKey: SOURCE_KEY,
    rawTextStorageRef: null,
    rawTextBlobHash: null,
    rawTextBlobSize: null,
    rawTextExternalizedAt: null,
    rawTextBlobContractVersion: null,
    ...overrides,
  };
}

function coherentCandidate(
  overrides: Partial<ArticleRawRestoreCandidate> = {},
): ArticleRawRestoreCandidate {
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
  candidates: ArticleRawRestoreCandidate[],
  overrides: {
    restore?: (input: RestoreArticleRawInlineInput) => Promise<{ articleRowId: string; idempotent: boolean }>;
  } = {},
) {
  const restoreCalls: RestoreArticleRawInlineInput[] = [];
  const listCalls: { articleTable: string; sourceKey: string | null; limit: number; afterArticleRowId: string | null }[] = [];
  const repository: Pick<
    ArticleRawRestoreRepository,
    "listArticleRawRestoreCandidates" | "restoreArticleRawInline"
  > = {
    listArticleRawRestoreCandidates: async (input) => {
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
    restoreArticleRawInline: async (input) => {
      restoreCalls.push(input);
      if (overrides.restore) return overrides.restore(input);
      return { articleRowId: input.articleRowId, idempotent: false };
    },
  };
  return { repository, restoreCalls, listCalls };
}

function dependencies(
  repository: ReturnType<typeof fakeRepository>["repository"],
  transport = new FakeTransport(),
  environment: Record<string, string | undefined> = enabledEnvironment,
): ArticleRawRestoreDependencies & { transport: FakeTransport } {
  return { repository, store: new ArtifactBlobStore(transport), transport, environment };
}

function seedBlob(transport: FakeTransport, rawText: string) {
  const encoded = encodeArticleRawText(rawText);
  const storageRef = articleRawBlobStorageRef(SOURCE_KEY, encoded.sha256);
  transport.objects.set(storageRef, encoded.bytes);
  return { storageRef, sha256: encoded.sha256, size: encoded.size };
}

// --- classification / planning ---------------------------------------------

test("classification reports not_ready, conflict, and ready before any Blob access", () => {
  const encoded = encodeArticleRawText(RAW_TEXT);
  const exactRef = articleRawBlobStorageRef(SOURCE_KEY, encoded.sha256);

  assert.equal(classifyArticleRawRestore(candidate()), "not_ready");
  assert.equal(classifyArticleRawRestore(coherentCandidate()), "ready");

  const conflicts: ArticleRawRestoreCandidate[] = [
    candidate({ rawTextStorageRef: exactRef }),
    candidate({ rawTextBlobHash: encoded.sha256, rawTextBlobSize: encoded.size }),
    coherentCandidate({ rawTextStorageRef: null }),
    coherentCandidate({ rawTextBlobHash: null }),
    coherentCandidate({ rawTextBlobSize: null }),
    coherentCandidate({ rawTextExternalizedAt: null }),
    coherentCandidate({ rawTextBlobContractVersion: null }),
    coherentCandidate({ rawTextExternalizedAt: "   " }),
    coherentCandidate({ rawTextBlobContractVersion: "worldcons-article-raw-blob-v2" }),
    coherentCandidate({ rawTextBlobHash: "not-a-hash" }),
    coherentCandidate({ rawTextBlobSize: -1 }),
    coherentCandidate({ rawTextBlobSize: 1.5 }),
    coherentCandidate({ rawTextStorageRef: articleRawBlobStorageRef(SOURCE_KEY, "b".repeat(64)) }),
    coherentCandidate({ rawTextBlobHash: "b".repeat(64) }),
  ];
  for (const conflict of conflicts) {
    assert.equal(classifyArticleRawRestore(conflict), "conflict");
  }
});

test("plan revalidates the content-addressed ref and returns the recorded ref/hash/size", () => {
  const entry = coherentCandidate();
  const plan = planArticleRawRestore(entry);
  assert.equal(plan.storageRef, entry.rawTextStorageRef);
  assert.equal(plan.contentHash, entry.rawTextBlobHash);
  assert.equal(plan.contentSize, entry.rawTextBlobSize);
});

test("plan fails closed on not-ready and conflicting candidates", () => {
  assert.throws(() => planArticleRawRestore(candidate()), /article_raw_restore\.not_ready/);
  assert.throws(
    () => planArticleRawRestore(candidate({ rawTextStorageRef: articleRawBlobStorageRef(SOURCE_KEY, "b".repeat(64)) })),
    /article_raw_restore\.conflict/,
  );
});

test("a recorded size above the 4 MiB codec bound is a conflict with zero Blob read and zero RPC", async () => {
  // The bound is the codec constant, so the metadata gate can never drift below the
  // encoder/decoder limit and an oversized size is rejected in classify/plan.
  assert.equal(
    classifyArticleRawRestore(coherentCandidate({ rawTextBlobSize: ARTICLE_RAW_BLOB_MAX_BYTES })),
    "ready",
  );
  const oversized = coherentCandidate({ rawTextBlobSize: ARTICLE_RAW_BLOB_MAX_BYTES + 1 });
  assert.equal(classifyArticleRawRestore(oversized), "conflict");
  assert.throws(() => planArticleRawRestore(oversized), /article_raw_restore\.conflict/);

  const { repository, restoreCalls } = fakeRepository([oversized]);
  const deps = dependencies(repository);
  const result = await runArticleRawRestoreBatch(
    { articleTable: "articles", batchSize: 10, actorId: "operator", execute: true },
    deps,
  );
  assert.equal(result.restored, 0);
  assert.equal(result.conflicts, 1);
  assert.deepEqual(result.failed, [
    { articleRowId: ARTICLE_ROW_ID, errorCode: "article_raw_restore.conflict" },
  ]);
  assert.equal(deps.transport.puts.length, 0);
  assert.equal(deps.transport.heads.length, 0);
  assert.equal(deps.transport.gets.length, 0);
  assert.equal(restoreCalls.length, 0);
});

// --- dry run ----------------------------------------------------------------

test("dry run plans ready rows without any Blob read or restore RPC", async () => {
  const { repository, restoreCalls } = fakeRepository([coherentCandidate()]);
  const deps = dependencies(repository);
  const result = await runArticleRawRestoreBatch(
    { articleTable: "articles", batchSize: 10, actorId: "operator", execute: false },
    deps,
  );
  assert.equal(result.scanned, 1);
  assert.equal(result.restored, 0);
  assert.equal(result.failed.length, 0);
  assert.equal(result.outcomes[0].status, "planned");
  assert.equal(deps.transport.puts.length, 0);
  assert.equal(deps.transport.heads.length, 0);
  assert.equal(deps.transport.gets.length, 0);
  assert.equal(restoreCalls.length, 0);
});

test("dry run needs only the repository and works with no Blob store at all", async () => {
  const { repository, restoreCalls } = fakeRepository([coherentCandidate()]);
  const result = await runArticleRawRestoreBatch(
    { articleTable: "articles", batchSize: 10, actorId: "operator", execute: false },
    { repository },
  );
  assert.equal(result.scanned, 1);
  assert.equal(result.restored, 0);
  assert.equal(result.failed.length, 0);
  assert.deepEqual(result.outcomes.map((outcome) => outcome.status), ["planned"]);
  assert.equal(restoreCalls.length, 0);

  // The optional/null store is part of the public contract, so a caller can omit it.
  const source = fs.readFileSync(restorePath, "utf8");
  assert.match(source, /store\?: ArtifactBlobStore \| null;/);
});

test("dry run reports planned, conflict, and not-ready rows with zero Blob and zero RPC", async () => {
  const encoded = encodeArticleRawText(RAW_TEXT);
  const partial = candidate({ rawTextStorageRef: articleRawBlobStorageRef(SOURCE_KEY, encoded.sha256) });
  const { repository, restoreCalls } = fakeRepository([coherentCandidate(), partial, candidate()]);
  const deps = dependencies(repository);
  const result = await runArticleRawRestoreBatch(
    { articleTable: "articles", batchSize: 10, actorId: "operator", execute: false },
    deps,
  );
  assert.deepEqual(
    result.outcomes.map((outcome) => outcome.status),
    ["planned", "conflict", "not_ready"],
  );
  assert.equal(result.conflicts, 1);
  assert.equal(result.notReady, 1);
  assert.deepEqual(result.failed.map((entry) => entry.errorCode), [
    "article_raw_restore.conflict",
    "article_raw_restore.not_ready",
  ]);
  assert.equal(deps.transport.puts.length, 0);
  assert.equal(deps.transport.heads.length, 0);
  assert.equal(deps.transport.gets.length, 0);
  assert.equal(restoreCalls.length, 0);
});

// --- execute gating ---------------------------------------------------------

test("execute requires the Blob read flag ready and fails closed before listing or mutating", async () => {
  const { repository, restoreCalls, listCalls } = fakeRepository([coherentCandidate()]);
  const deps = dependencies(repository, new FakeTransport(), {});
  await assert.rejects(
    () => runArticleRawRestoreBatch(
      { articleTable: "articles", batchSize: 10, actorId: "operator", execute: true },
      deps,
    ),
    /article_raw_restore\.read_disabled/,
  );
  assert.equal(listCalls.length, 0);
  assert.equal(deps.transport.heads.length, 0);
  assert.equal(deps.transport.gets.length, 0);
  assert.equal(restoreCalls.length, 0);
});

test("execute with no Blob store fails closed before listing or mutating", async () => {
  const { repository, restoreCalls, listCalls } = fakeRepository([coherentCandidate()]);
  await assert.rejects(
    () => runArticleRawRestoreBatch(
      { articleTable: "articles", batchSize: 10, actorId: "operator", execute: true },
      { repository, environment: enabledEnvironment },
    ),
    /article_raw_restore\.store_unavailable/,
  );
  assert.equal(listCalls.length, 0);
  assert.equal(restoreCalls.length, 0);
});

// --- success path -----------------------------------------------------------

test("execute heads then gets, verifies size/SHA-256/decoded text, and only then restores with no put", async () => {
  const entry = coherentCandidate();
  const { repository, restoreCalls } = fakeRepository([entry]);
  const deps = dependencies(repository);
  const seed = seedBlob(deps.transport, RAW_TEXT);
  const result = await runArticleRawRestoreBatch(
    { articleTable: "articles", batchSize: 10, actorId: "operator", execute: true },
    deps,
  );
  assert.equal(result.restored, 1);
  assert.equal(result.failed.length, 0);
  assert.equal(result.outcomes[0].status, "restored");
  assert.equal(deps.transport.puts.length, 0);
  assert.deepEqual(deps.transport.heads, [seed.storageRef]);
  assert.deepEqual(deps.transport.gets, [seed.storageRef]);
  assert.deepEqual(restoreCalls, [{
    articleTable: "articles",
    articleRowId: ARTICLE_ROW_ID,
    rawText: RAW_TEXT,
    storageRef: seed.storageRef,
    contentHash: seed.sha256,
    contentSize: seed.size,
    externalizationContractVersion: ARTICLE_RAW_BLOB_CONTRACT_VERSION,
    actorId: "operator",
  }]);
  const restoreInput = restoreCalls[0] as unknown as Record<string, unknown>;
  assert.equal("p_dry_run" in restoreInput, false);
});

test("version rows restore against article_content_versions_p3 with their own ref", async () => {
  const entry = coherentCandidate({ articleTable: "article_content_versions_p3", articleRowId: VERSION_ROW_ID });
  const { repository, restoreCalls } = fakeRepository([entry]);
  const deps = dependencies(repository);
  seedBlob(deps.transport, RAW_TEXT);
  const result = await runArticleRawRestoreBatch(
    { articleTable: "article_content_versions_p3", batchSize: 10, actorId: "operator", execute: true },
    deps,
  );
  assert.equal(result.restored, 1);
  assert.equal(restoreCalls[0].articleTable, "article_content_versions_p3");
  assert.equal(restoreCalls[0].articleRowId, VERSION_ROW_ID);
  assert.match(restoreCalls[0].storageRef, /^artifacts\/article_raw\//);
});

test("an identical rerun reported by the RPC is idempotent", async () => {
  const { repository, restoreCalls } = fakeRepository([coherentCandidate()], {
    restore: async (input) => ({ articleRowId: input.articleRowId, idempotent: true }),
  });
  const deps = dependencies(repository);
  seedBlob(deps.transport, RAW_TEXT);
  const result = await runArticleRawRestoreBatch(
    { articleTable: "articles", batchSize: 10, actorId: "operator", execute: true },
    deps,
  );
  assert.equal(result.idempotent, 1);
  assert.equal(result.restored, 0);
  assert.equal(result.outcomes[0].status, "idempotent");
  assert.equal(restoreCalls.length, 1);
});

// --- fail-closed verification ----------------------------------------------

test("a head size mismatch blocks the RPC after the size check", async () => {
  const { repository, restoreCalls } = fakeRepository([coherentCandidate()]);
  const deps = dependencies(repository);
  seedBlob(deps.transport, RAW_TEXT);
  deps.transport.headSizeAdjust = 1;
  const result = await runArticleRawRestoreBatch(
    { articleTable: "articles", batchSize: 10, actorId: "operator", execute: true },
    deps,
  );
  assert.equal(result.restored, 0);
  assert.deepEqual(result.failed, [
    { articleRowId: ARTICLE_ROW_ID, errorCode: "article_raw_restore.head_verification_failed" },
  ]);
  assert.equal(deps.transport.gets.length, 0);
  assert.equal(restoreCalls.length, 0);
});

test("a get SHA-256 mismatch blocks the RPC", async () => {
  const { repository, restoreCalls } = fakeRepository([coherentCandidate()]);
  const deps = dependencies(repository);
  seedBlob(deps.transport, RAW_TEXT);
  deps.transport.getBytesOverride = () => Buffer.from(encodeArticleRawText("tampered").bytes);
  const result = await runArticleRawRestoreBatch(
    { articleTable: "articles", batchSize: 10, actorId: "operator", execute: true },
    deps,
  );
  assert.equal(result.failed[0].errorCode, "article_raw_restore.get_verification_failed");
  assert.equal(restoreCalls.length, 0);
});

test("a get byte-length mismatch blocks the RPC", async () => {
  const { repository, restoreCalls } = fakeRepository([coherentCandidate()]);
  const deps = dependencies(repository);
  seedBlob(deps.transport, RAW_TEXT);
  deps.transport.getBytesOverride = () => Buffer.from(encodeArticleRawText(RAW_TEXT).bytes.subarray(0, 4));
  const result = await runArticleRawRestoreBatch(
    { articleTable: "articles", batchSize: 10, actorId: "operator", execute: true },
    deps,
  );
  assert.equal(result.failed[0].errorCode, "article_raw_restore.get_verification_failed");
  assert.equal(restoreCalls.length, 0);
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
  const { repository, restoreCalls } = fakeRepository([entry]);
  const deps = dependencies(repository);
  deps.transport.objects.set(entry.rawTextStorageRef as string, bytes);
  const result = await runArticleRawRestoreBatch(
    { articleTable: "articles", batchSize: 10, actorId: "operator", execute: true },
    deps,
  );
  assert.equal(result.failed[0].errorCode, "article_raw_restore.invalid_document");
  assert.equal(deps.transport.heads.length, 1);
  assert.equal(deps.transport.gets.length, 1);
  assert.equal(restoreCalls.length, 0);
});

test("partial metadata is blocked with zero Blob read and zero RPC", async () => {
  const encoded = encodeArticleRawText(RAW_TEXT);
  const entry = candidate({ rawTextStorageRef: articleRawBlobStorageRef(SOURCE_KEY, encoded.sha256) });
  const { repository, restoreCalls } = fakeRepository([entry]);
  const deps = dependencies(repository);
  const result = await runArticleRawRestoreBatch(
    { articleTable: "articles", batchSize: 10, actorId: "operator", execute: true },
    deps,
  );
  assert.equal(result.restored, 0);
  assert.equal(result.conflicts, 1);
  assert.deepEqual(result.failed, [
    { articleRowId: ARTICLE_ROW_ID, errorCode: "article_raw_restore.conflict" },
  ]);
  assert.equal(deps.transport.puts.length, 0);
  assert.equal(deps.transport.heads.length, 0);
  assert.equal(deps.transport.gets.length, 0);
  assert.equal(restoreCalls.length, 0);
});

test("conflicting full metadata is blocked with zero Blob read and zero RPC", async () => {
  const entry = coherentCandidate({ rawTextStorageRef: articleRawBlobStorageRef(SOURCE_KEY, "b".repeat(64)) });
  const { repository, restoreCalls } = fakeRepository([entry]);
  const deps = dependencies(repository);
  const result = await runArticleRawRestoreBatch(
    { articleTable: "articles", batchSize: 10, actorId: "operator", execute: true },
    deps,
  );
  assert.equal(result.restored, 0);
  assert.equal(result.conflicts, 1);
  assert.equal(result.failed[0].errorCode, "article_raw_restore.conflict");
  assert.equal(deps.transport.heads.length, 0);
  assert.equal(deps.transport.gets.length, 0);
  assert.equal(restoreCalls.length, 0);
});

// --- pagination & redaction -------------------------------------------------

test("batches stay bounded and advance with a UUID keyset cursor", async () => {
  const entries = Array.from({ length: 3 }, (_, index) => ({
    ...coherentCandidate(),
    articleRowId: `0000000${index}-0000-4000-8000-00000000000${index}`,
  }));
  const { repository, listCalls } = fakeRepository(entries);
  const deps = dependencies(repository);
  const first = await runArticleRawRestoreBatch(
    { articleTable: "articles", batchSize: 2, actorId: "operator", execute: false },
    deps,
  );
  assert.equal(first.scanned, 2);
  assert.equal(first.lastArticleRowId, entries[1].articleRowId);
  const second = await runArticleRawRestoreBatch(
    { articleTable: "articles", batchSize: 2, actorId: "operator", execute: false, afterArticleRowId: first.lastArticleRowId },
    deps,
  );
  assert.equal(second.scanned, 1);
  assert.equal(second.lastArticleRowId, entries[2].articleRowId);
  assert.deepEqual(listCalls.map((call) => call.limit), [2, 2]);
  assert.equal(listCalls[0].afterArticleRowId, null);
  assert.equal(listCalls[1].afterArticleRowId, entries[1].articleRowId);
});

test("the CLI-safe outcome projection drops the ref, hash, and decoded text", () => {
  const encoded = encodeArticleRawText(RAW_TEXT);
  const outcome: ArticleRawRestoreOutcome = {
    articleTable: "articles",
    articleRowId: ARTICLE_ROW_ID,
    sourceKey: SOURCE_KEY,
    status: "restored",
    storageRef: articleRawBlobStorageRef(SOURCE_KEY, encoded.sha256),
    contentHash: encoded.sha256,
    contentSize: encoded.size,
  };
  const safe = toSafeArticleRawRestoreOutcome(outcome);
  assert.deepEqual(Object.keys(safe).sort(), ["articleRowId", "contentSize", "status"]);
  const serialized = JSON.stringify(safe);
  assert.equal(serialized.includes(RAW_TEXT), false);
  assert.equal(serialized.includes("artifacts/article_raw/"), false);
  assert.equal(serialized.includes(encoded.sha256), false);
  assert.equal(serialized.includes(SOURCE_KEY), false);
});

// --- repository -------------------------------------------------------------

test("repository lists candidates through the restore candidate RPC and never queries raw tables directly", () => {
  const source = fs.readFileSync(repositoryPath, "utf8");
  assert.match(source, /article_raw_restore_candidates_v1/);
  assert.match(source, /article_raw_restore_inline_v1/);
  assert.match(source, /p_dry_run: false/);
  assert.equal(source.includes(".from("), false);
  assert.equal(source.includes(".select("), false);
  assert.equal(source.includes("store.put("), false);
  assert.equal(source.includes("store.delete("), false);
  assert.equal(source.includes("article_raw_operator_candidates_v1"), false);
  assert.match(source, /p_article_table: input\.articleTable/);
  assert.match(source, /p_source_key: input\.sourceKey \?\? null/);
  assert.match(source, /p_after_row_id: input\.afterArticleRowId \?\? null/);
  assert.match(source, /p_limit: input\.limit/);
});

test("repository maps restore candidate rows and drops rows without a row id or source key", async () => {
  const encoded = encodeArticleRawText(RAW_TEXT);
  const client = new FakeListRpcClient();
  client.rows = [
    {
      article_table: "article_content_versions_p3",
      article_row_id: VERSION_ROW_ID,
      article_id: ARTICLE_ROW_ID,
      source_key: SOURCE_KEY,
      raw_text_storage_ref: articleRawBlobStorageRef(SOURCE_KEY, encoded.sha256),
      raw_text_blob_hash: encoded.sha256,
      raw_text_blob_size: encoded.size,
      raw_text_externalized_at: EXTERNALIZED_AT,
      raw_text_blob_contract_version: ARTICLE_RAW_BLOB_CONTRACT_VERSION,
    },
    { article_table: "article_content_versions_p3", article_row_id: null, source_key: SOURCE_KEY },
    { article_table: "article_content_versions_p3", article_row_id: ARTICLE_ROW_ID, source_key: null },
  ];
  const repository = createPostgresArticleRawRestoreRepository({
    client: () => client as unknown as SupabaseClient,
  });
  const result = await repository.listArticleRawRestoreCandidates({
    articleTable: "article_content_versions_p3",
    sourceKey: SOURCE_KEY,
    limit: 5,
    afterArticleRowId: CURSOR_ROW_ID,
  });
  assert.deepEqual(client.rpcCalls, [{
    name: "article_raw_restore_candidates_v1",
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
    rawTextStorageRef: articleRawBlobStorageRef(SOURCE_KEY, encoded.sha256),
    rawTextBlobHash: encoded.sha256,
    rawTextBlobSize: encoded.size,
    rawTextExternalizedAt: EXTERNALIZED_AT,
    rawTextBlobContractVersion: ARTICLE_RAW_BLOB_CONTRACT_VERSION,
  });
});

test("repository restore calls the RPC with the decoded text and exact ref/hash/size/contract/actor and p_dry_run=false", async () => {
  const encoded = encodeArticleRawText(RAW_TEXT);
  const storageRef = articleRawBlobStorageRef(SOURCE_KEY, encoded.sha256);
  const client = new FakeRpcClient();
  const repository = createPostgresArticleRawRestoreRepository({
    client: () => client as unknown as SupabaseClient,
  });
  const result = await repository.restoreArticleRawInline({
    articleTable: "articles",
    articleRowId: ARTICLE_ROW_ID,
    rawText: RAW_TEXT,
    storageRef,
    contentHash: encoded.sha256,
    contentSize: encoded.size,
    externalizationContractVersion: ARTICLE_RAW_BLOB_CONTRACT_VERSION,
    actorId: "operator",
  });
  assert.deepEqual(result, { articleRowId: ARTICLE_ROW_ID, idempotent: false });
  assert.deepEqual(client.rpcCalls, [{
    name: "article_raw_restore_inline_v1",
    args: {
      p_article_table: "articles",
      p_article_row_id: ARTICLE_ROW_ID,
      p_raw_text: RAW_TEXT,
      p_storage_ref: storageRef,
      p_content_hash: encoded.sha256,
      p_content_size: encoded.size,
      p_externalization_contract_version: ARTICLE_RAW_BLOB_CONTRACT_VERSION,
      p_actor_id: "operator",
      p_dry_run: false,
    },
  }]);
});

test("repository reports an idempotent RPC result", async () => {
  const client = new FakeRpcClient();
  client.rpcRow = { articleTable: "articles", articleRowId: ARTICLE_ROW_ID, dryRun: false, idempotent: true };
  const repository = createPostgresArticleRawRestoreRepository({
    client: () => client as unknown as SupabaseClient,
  });
  const result = await repository.restoreArticleRawInline({
    articleTable: "articles",
    articleRowId: ARTICLE_ROW_ID,
    rawText: RAW_TEXT,
    storageRef: articleRawBlobStorageRef(SOURCE_KEY, "a".repeat(64)),
    contentHash: "a".repeat(64),
    contentSize: 1,
    externalizationContractVersion: ARTICLE_RAW_BLOB_CONTRACT_VERSION,
    actorId: "operator",
  });
  assert.equal(result.idempotent, true);
});

// --- static ordering & CLI gates -------------------------------------------

test("lib verifies head and get and decodes before calling the repository, and never puts or deletes", () => {
  const source = fs.readFileSync(restorePath, "utf8");
  const headIndex = source.indexOf("await dependencies.store.head(");
  const getIndex = source.indexOf("await dependencies.store.get(");
  const decodeIndex = source.indexOf("decodeArticleRawText(bytes)");
  const restoreIndex = source.indexOf("await dependencies.repository.restoreArticleRawInline(");
  assert.ok(headIndex >= 0 && getIndex > headIndex && decodeIndex > getIndex && restoreIndex > decodeIndex);
  const dryRunIndex = source.indexOf("if (!input.execute)");
  const executeIndex = source.indexOf("await restoreArticleRawInlinePlan(");
  assert.ok(dryRunIndex >= 0 && executeIndex > dryRunIndex);
  assert.doesNotMatch(source, /store\.put\(/);
  assert.doesNotMatch(source, /store\.delete\(/);
  assert.match(source, /articleRawBlobReadReady/);
});

test("metadata classification happens before any Blob read in the batch loop", () => {
  const source = fs.readFileSync(restorePath, "utf8");
  const planIndex = source.indexOf("const plan = planArticleRawRestore(candidate)");
  const dryRunIndex = source.indexOf("if (!input.execute)", planIndex);
  const executeIndex = source.indexOf("await restoreArticleRawInlinePlan(", planIndex);
  assert.ok(planIndex >= 0, "planning must exist");
  assert.ok(dryRunIndex > planIndex, "planning must precede the dry-run branch");
  assert.ok(executeIndex > planIndex, "planning must precede the execute path");
  const planDefinitionIndex = source.indexOf("export function planArticleRawRestore(");
  const classifyIndex = source.indexOf("const classification = classifyArticleRawRestore(candidate)");
  assert.ok(planDefinitionIndex >= 0 && planDefinitionIndex < planIndex);
  assert.ok(classifyIndex > planDefinitionIndex, "classification runs inside planning, before Blob access");
});

test("CLI execute gates on --acknowledge-inline-restore and the read flag before the store or a batch", () => {
  const source = fs.readFileSync(scriptPath, "utf8");
  const executeIndex = source.indexOf('const execute = flag("execute")');
  const gateIndex = source.indexOf("if (execute)");
  const ackIndex = source.indexOf('flag("acknowledge-inline-restore")');
  const readIndex = source.indexOf("articleRawBlobReadEnabled()");
  const storeIndex = source.indexOf("createOperatorArtifactBlobStore()");
  const batchIndex = source.indexOf("runArticleRawRestoreBatch(");
  assert.ok(executeIndex >= 0 && gateIndex > executeIndex, "the execute flag is read before the gate");
  assert.ok(ackIndex > gateIndex && readIndex > gateIndex, "the gates live inside the execute branch");
  assert.ok(storeIndex > ackIndex && storeIndex > readIndex, "the Blob store is created only after the gates");
  assert.ok(batchIndex > ackIndex && batchIndex > readIndex, "no batch runs before the gates");
  assert.match(source, /article_raw_restore\.acknowledge_required/);
  assert.match(source, /article_raw_restore\.read_disabled/);
  assert.equal(source.includes("ARTICLE_RAW_BLOB_WRITE_ENABLED"), false);
  assert.equal(source.includes("articleRawBlobWriteEnabled"), false);
  assert.equal(source.includes("articleRawBlobWriteReady"), false);
});

test("CLI creates the Blob store only under --execute after the gates; dry run passes null", () => {
  const source = fs.readFileSync(scriptPath, "utf8");
  assert.match(source, /const store = execute \? createOperatorArtifactBlobStore\(\) : null;/);
  assert.equal(
    source.includes("const store = createOperatorArtifactBlobStore();"),
    false,
    "the store must never be created unconditionally",
  );
  const gateIndex = source.indexOf("if (execute)");
  const ackIndex = source.indexOf('flag("acknowledge-inline-restore")');
  const readIndex = source.indexOf("articleRawBlobReadEnabled()");
  const storeIndex = source.indexOf("createOperatorArtifactBlobStore()");
  const batchIndex = source.indexOf("runArticleRawRestoreBatch(");
  assert.ok(gateIndex >= 0 && ackIndex > gateIndex && readIndex > gateIndex);
  assert.ok(storeIndex > ackIndex && storeIndex > readIndex, "the store call follows the execute gates");
  assert.ok(batchIndex > storeIndex, "the store is ready before the first batch");
});

test("CLI output is redacted through the safe outcome projection", () => {
  const source = fs.readFileSync(scriptPath, "utf8");
  assert.match(source, /toSafeArticleRawRestoreOutcome/);
  assert.match(source, /result\.outcomes\.map\(toSafeArticleRawRestoreOutcome\)/);
  assert.equal(source.includes("outcomes: result.outcomes,"), false);
  assert.equal(source.includes("storageRef"), false);
  assert.equal(source.includes("contentHash"), false);
  assert.equal(source.includes("rawText"), false);
});

test("script defaults to dry run with a bounded batch, cursor, and explicit table", () => {
  const source = fs.readFileSync(scriptPath, "utf8");
  assert.match(source, /const execute = flag\("execute"\)/);
  assert.match(source, /const articleTable = tableArgument\(\)/);
  assert.match(source, /integerArgument\("batch-size", 25, 1, 100\)/);
  assert.match(source, /integerArgument\("max-batches", 20, 1, 1000\)/);
  assert.match(source, /optionalUuid\("after"\)/);
  assert.match(source, /ARTICLE_RAW_RESTORE_TABLES/);
  assert.match(source, /createOperatorArtifactBlobStore\(\)/);
  assert.match(source, /runArticleRawRestoreBatch\(/);
  assert.equal(source.includes("store.put("), false);
  assert.equal(source.includes("store.delete("), false);
});

// --- migration contract -----------------------------------------------------

test("the M6E migration is additive and restores only the redundant inline raw_text", () => {
  const sql = fs.readFileSync(migrationPath, "utf8");
  assert.doesNotMatch(sql, /\bdrop\s+(table|column)\b/i);
  assert.doesNotMatch(sql, /\btruncate\b/i);
  assert.doesNotMatch(sql, /\bvacuum\b/i);
  assert.doesNotMatch(sql, /\bdelete\s+from\s+(articles|article_content_versions_p3)\b/i);
  assert.doesNotMatch(sql, /cleaned_text\s*=/i);
  assert.doesNotMatch(sql, /search_vector\s*=/i);

  assert.match(sql, /create table if not exists article_raw_inline_restore_permits/);
  assert.match(sql, /alter table article_raw_inline_restore_permits enable row level security/);
  assert.match(sql, /create or replace function article_raw_restore_inline_v1\(/);
  assert.match(sql, /p_dry_run boolean default true/);
  assert.match(sql, /security definer/);
  assert.match(sql, /update articles set raw_text = p_raw_text where id = p_article_row_id;/);
  assert.match(sql, /update article_content_versions_p3 set raw_text = p_raw_text where id = p_article_row_id;/);
  assert.doesNotMatch(sql, /grant\s+(insert|update|delete)/i);
});

test("the restore RPC and guard verify the JSON-string document size and SHA-256 database-side", () => {
  const sql = fs.readFileSync(migrationPath, "utf8");
  // The RPC recomputes the document from the caller's raw_text and compares it to the
  // recorded Blob size/hash before any row is locked or written.
  assert.match(sql, /v_document := to_json\(p_raw_text\)::text;/);
  assert.match(sql, /v_document_size := octet_length\(v_document\);/);
  assert.match(
    sql,
    /v_document_hash := encode\(extensions\.digest\(convert_to\(v_document, 'UTF8'\), 'sha256'\), 'hex'\);/,
  );
  assert.match(sql, /if v_document_size <> p_content_size or v_document_hash <> p_content_hash then/);
  assert.match(sql, /ARTICLE_RAW_RESTORE_CONTENT_MISMATCH/);
  // The guard independently re-checks the restored value against the recorded Blob.
  assert.match(sql, /v_new_size is distinct from octet_length\(to_json\(v_new_raw\)::text\)/);
  assert.match(
    sql,
    /v_new_hash is distinct from\s*encode\(extensions\.digest\(convert_to\(to_json\(v_new_raw\)::text, 'UTF8'\), 'sha256'\), 'hex'\)/,
  );
});

test("both the guard and the RPC ledger checks bind content_kind='raw_text' and the exact article_id", () => {
  const sql = fs.readFileSync(migrationPath, "utf8");
  const blocks = [...sql.matchAll(/if not exists \(\s*select 1\s*from article_raw_externalization_ledger l[\s\S]*?\) then/g)].map(
    (match) => match[0],
  );
  assert.equal(blocks.length, 3, "there must be exactly three ledger EXISTS checks (clear, restore, RPC)");

  const guardBlocks = blocks.filter((block) => block.includes("new.article_id"));
  const rpcBlocks = blocks.filter((block) => block.includes("v_article_id"));
  assert.equal(guardBlocks.length, 2, "the clear and restore guard branches must bind NEW.article_id");
  assert.equal(rpcBlocks.length, 1, "the RPC ledger check must bind v_article_id");

  for (const guard of guardBlocks) {
    assert.match(guard, /l\.content_kind = 'raw_text'/);
    assert.match(guard, /l\.article_id = new\.article_id/);
    assert.doesNotMatch(guard, /v_article_id/);
  }

  const rpc = rpcBlocks[0];
  assert.match(rpc, /l\.content_kind = 'raw_text'/);
  assert.match(rpc, /l\.article_id = v_article_id/);
  assert.doesNotMatch(rpc, /new\.article_id/);
});

test("the combined guard preserves the attach, clear, and restore transitions and adds no articles trigger", () => {
  const sql = fs.readFileSync(migrationPath, "utf8");
  // The single guard function keeps all three permitted transitions.
  assert.match(sql, /v_old_raw is not null and v_new_raw is null then/);
  assert.match(sql, /v_old_raw is null and v_new_raw is not null then/);
  assert.match(sql, /if v_old_raw is null or v_old_raw is distinct from v_new_raw then/);
  assert.match(sql, /if \(to_jsonb\(old\) - v_meta_columns\) is distinct from \(to_jsonb\(new\) - v_meta_columns\) then/);
  // public.articles is deliberately trigger-free: its raw_text is restored only
  // through the security-definer RPC.
  assert.doesNotMatch(sql, /create\s+trigger/i);
  assert.doesNotMatch(sql, /trigger[\s\S]*?on\s+articles\b/i);
  assert.match(sql, /if tg_table_name <> 'article_content_versions_p3' then/);
});

test("restore preserves every other column byte-identical and never repoints metadata", () => {
  const sql = fs.readFileSync(migrationPath, "utf8");
  const restoreIndex = sql.indexOf("if v_old_raw is null and v_new_raw is not null then");
  assert.ok(restoreIndex >= 0, "the restore branch must exist");
  const restoreBlock = sql.slice(restoreIndex, sql.indexOf("Operation A (M6B attach)", restoreIndex));
  assert.match(restoreBlock, /if v_old_meta is distinct from v_new_meta then/);
  assert.match(
    restoreBlock,
    /if \(to_jsonb\(old\) - 'raw_text'\) is distinct from \(to_jsonb\(new\) - 'raw_text'\) then/,
  );
  // Only the inline raw_text is updated; no externalization metadata column is set.
  assert.doesNotMatch(sql, /set raw_text_storage_ref\s*=/i);
  assert.doesNotMatch(sql, /set raw_text_blob_hash\s*=/i);
});

test("the M6E migration exposes the restore RPCs to service_role only", () => {
  const sql = fs.readFileSync(migrationPath, "utf8");
  assert.match(sql, /revoke all on table article_raw_inline_restore_permits from public;/);
  assert.match(sql, /revoke all on table article_raw_inline_restore_permits from service_role;/);
  assert.match(sql, /revoke all on function article_raw_restore_inline_v1\([\s\S]*?\) from public;/);
  assert.match(sql, /revoke all on function article_raw_restore_candidates_v1\([\s\S]*?\) from public;/);
  assert.match(sql, /grant execute on function article_raw_restore_inline_v1\([\s\S]*?\) to service_role;/);
  assert.match(sql, /grant execute on function article_raw_restore_candidates_v1\([\s\S]*?\) to service_role;/);
  assert.doesNotMatch(sql, /to anon\b/i);
  assert.doesNotMatch(sql, /to authenticated\b/i);
});

// --- fakes ------------------------------------------------------------------

class FakeRpcClient {
  readonly rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  rpcRow: Record<string, unknown> = {
    articleTable: "articles",
    articleRowId: ARTICLE_ROW_ID,
    dryRun: false,
    idempotent: false,
    restored: true,
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
