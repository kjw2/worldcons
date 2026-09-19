import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  ARTICLE_RAW_BLOB_CONTRACT_VERSION,
  articleRawBlobStorageRef,
  encodeArticleRawText,
} from "../lib/article-raw/codec";
import {
  classifyArticleRawExternalization,
  externalizeArticleRawPlan,
  planArticleRawExternalization,
  runArticleRawExternalizationBatch,
  toSafeArticleRawExternalizationOutcome,
  type ArticleRawExternalizationCandidate,
  type ArticleRawExternalizationDependencies,
  type ArticleRawExternalizationOutcome,
  type ArticleRawExternalizationRepository,
  type AttachArticleRawExternalizationInput,
} from "../lib/article-raw/externalization";
import {
  ARTIFACT_BLOB_CONTRACT_VERSION,
  ArtifactBlobStore,
  sha256Hex,
  type ArtifactBlobGetResult,
  type ArtifactBlobHeadResult,
  type ArtifactBlobPutOptions,
  type ArtifactBlobTransport,
} from "../lib/storage/blob";

const repositoryPath = path.join(process.cwd(), "lib/article-raw/externalization-repository.ts");
const externalizationPath = path.join(process.cwd(), "lib/article-raw/externalization.ts");
const scriptPath = path.join(process.cwd(), "scripts/externalize-article-raw.ts");
const migrationPath = path.join(
  process.cwd(),
  "supabase/migrations/20260919140000_article_raw_blob_externalization_backfill.sql",
);
const contractMigrationPath = path.join(
  process.cwd(),
  "supabase/migrations/20260919130000_article_raw_blob_contract.sql",
);

const SOURCE_KEY = "us-scotus";
const ARTICLE_ROW_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ROW_ID = "22222222-2222-4222-8222-222222222222";
const RAW_TEXT = "헌법 §42 raw\n text";
const EXTERNALIZED_AT = "2026-09-19T00:00:00.000Z";
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
  readonly puts: { pathname: string; body: Buffer; options: ArtifactBlobPutOptions }[] = [];
  readonly gets: string[] = [];
  readonly heads: string[] = [];
  putPathnameSuffix: string | null = null;
  headSizeAdjust = 0;
  getBytesOverride: ((pathname: string) => Buffer | null) | null = null;

  async put(pathname: string, body: Buffer, options: ArtifactBlobPutOptions) {
    if (this.putPathnameSuffix) {
      const suffix = this.putPathnameSuffix;
      this.putPathnameSuffix = null;
      return { pathname: `${pathname}${suffix}` };
    }
    this.puts.push({ pathname, body: Buffer.from(body), options });
    this.objects.set(pathname, Buffer.from(body));
    return { pathname };
  }

  async get(pathname: string): Promise<ArtifactBlobGetResult | null> {
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
function candidate(overrides: Partial<ArticleRawExternalizationCandidate> = {}): ArticleRawExternalizationCandidate {
  return {
    articleTable: "articles",
    articleRowId: ARTICLE_ROW_ID,
    articleId: ARTICLE_ROW_ID,
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

function externalizedCandidate(overrides: Partial<ArticleRawExternalizationCandidate> = {}): ArticleRawExternalizationCandidate {
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
  candidates: ArticleRawExternalizationCandidate[],
  overrides: {
    attach?: (input: AttachArticleRawExternalizationInput) => Promise<{ articleRowId: string; idempotent: boolean }>;
  } = {},
) {
  const attachCalls: AttachArticleRawExternalizationInput[] = [];
  const listCalls: { articleTable: string; sourceKey: string | null; limit: number; afterArticleRowId: string | null }[] = [];
  const repository: Pick<
    ArticleRawExternalizationRepository,
    "listArticleRawExternalizationCandidates" | "attachArticleRawExternalization"
  > = {
    listArticleRawExternalizationCandidates: async (input) => {
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
    attachArticleRawExternalization: async (input) => {
      attachCalls.push(input);
      if (overrides.attach) return overrides.attach(input);
      return { articleRowId: input.articleRowId, idempotent: false };
    },
  };
  return { repository, attachCalls, listCalls };
}

function dependencies(
  repository: ReturnType<typeof fakeRepository>["repository"],
  transport = new FakeTransport(),
): ArticleRawExternalizationDependencies & { transport: FakeTransport } {
  return { repository, store: new ArtifactBlobStore(transport), transport };
}
test("plan recomputes the exact article-raw document, hash, and size", () => {
  const plan = planArticleRawExternalization(candidate());
  const encoded = encodeArticleRawText(RAW_TEXT);
  assert.equal(plan.document, encoded.document);
  assert.equal(plan.contentHash, encoded.sha256);
  assert.equal(plan.contentSize, encoded.size);
  assert.equal(plan.bytes.byteLength, encoded.size);
});

test("the article raw contract version is distinct from the generic artifact contract", () => {
  assert.notEqual(ARTICLE_RAW_BLOB_CONTRACT_VERSION, ARTIFACT_BLOB_CONTRACT_VERSION);
});

test("dry run plans the content-addressed ref without uploading or attaching", async () => {
  const { repository, attachCalls } = fakeRepository([candidate()]);
  const deps = dependencies(repository);
  const result = await runArticleRawExternalizationBatch(
    { articleTable: "articles", batchSize: 10, actorId: "operator", execute: false },
    deps,
  );
  assert.equal(result.scanned, 1);
  assert.equal(result.outcomes[0].status, "planned");
  assert.equal(
    result.outcomes[0].storageRef,
    articleRawBlobStorageRef(SOURCE_KEY, encodeArticleRawText(RAW_TEXT).sha256),
  );
  assert.equal(deps.transport.puts.length, 0);
  assert.equal(deps.transport.heads.length, 0);
  assert.equal(deps.transport.gets.length, 0);
  assert.equal(attachCalls.length, 0);
});
test("execute uploads, verifies size and SHA-256, then attaches while preserving inline text", async () => {
  const entry = candidate();
  const { repository, attachCalls } = fakeRepository([entry]);
  const deps = dependencies(repository);
  const result = await runArticleRawExternalizationBatch(
    { articleTable: "articles", batchSize: 10, actorId: "operator", execute: true },
    deps,
  );
  const encoded = encodeArticleRawText(RAW_TEXT);
  assert.equal(result.externalized, 1);
  assert.equal(result.failed.length, 0);
  const outcome = result.outcomes[0];
  assert.equal(outcome.status, "externalized");
  assert.equal(outcome.storageRef, articleRawBlobStorageRef(SOURCE_KEY, encoded.sha256));

  assert.equal(deps.transport.puts.length, 1);
  assert.equal(deps.transport.puts[0].options.access, "private");
  assert.equal(deps.transport.puts[0].options.addRandomSuffix, false);
  assert.equal(deps.transport.puts[0].options.allowOverwrite, true);
  assert.equal(sha256Hex(deps.transport.puts[0].body), encoded.sha256);
  assert.deepEqual(deps.transport.heads, [outcome.storageRef]);
  assert.deepEqual(deps.transport.gets, [outcome.storageRef]);

  assert.deepEqual(attachCalls, [{
    articleTable: "articles",
    articleRowId: ARTICLE_ROW_ID,
    storageRef: outcome.storageRef,
    contentHash: encoded.sha256,
    contentSize: encoded.size,
    externalizationContractVersion: ARTICLE_RAW_BLOB_CONTRACT_VERSION,
    actorId: "operator",
  }]);
  const attachInput = attachCalls[0] as unknown as Record<string, unknown>;
  assert.equal("rawText" in attachInput, false);
  assert.equal("inlinePayload" in attachInput, false);
  assert.equal("clearInline" in attachInput, false);
});
test("version rows attach to article_content_versions_p3 with their own ref", async () => {
  const entry = candidate({
    articleTable: "article_content_versions_p3",
    articleRowId: VERSION_ROW_ID,
    articleId: ARTICLE_ROW_ID,
  });
  const { repository, attachCalls } = fakeRepository([entry]);
  const deps = dependencies(repository);
  const result = await runArticleRawExternalizationBatch(
    { articleTable: "article_content_versions_p3", batchSize: 10, actorId: "operator", execute: true },
    deps,
  );
  assert.equal(result.externalized, 1);
  assert.equal(attachCalls[0].articleTable, "article_content_versions_p3");
  assert.equal(attachCalls[0].articleRowId, VERSION_ROW_ID);
  assert.match(attachCalls[0].storageRef, /^artifacts\/article_raw\//);
});

test("an invalid source key fails closed before upload and before any attach", async () => {
  const entry = candidate({ sourceKey: "Invalid Source" });
  const { repository, attachCalls } = fakeRepository([entry]);
  const deps = dependencies(repository);
  const result = await runArticleRawExternalizationBatch(
    { articleTable: "articles", batchSize: 10, actorId: "operator", execute: true },
    deps,
  );
  assert.equal(result.externalized, 0);
  assert.deepEqual(result.failed, [
    { articleRowId: ARTICLE_ROW_ID, errorCode: "article_raw_externalization.source_key_invalid" },
  ]);
  assert.equal(deps.transport.puts.length, 0);
  assert.equal(attachCalls.length, 0);
});
test("a put pathname mismatch fails closed before head, get, or attach", async () => {
  const { repository, attachCalls } = fakeRepository([candidate()]);
  const deps = dependencies(repository);
  deps.transport.putPathnameSuffix = ".mismatch";
  const result = await runArticleRawExternalizationBatch(
    { articleTable: "articles", batchSize: 10, actorId: "operator", execute: true },
    deps,
  );
  assert.equal(result.externalized, 0);
  assert.equal(result.failed[0].errorCode, "artifact_blob.pathname_mismatch");
  assert.equal(deps.transport.heads.length, 0);
  assert.equal(attachCalls.length, 0);
});

test("a head size mismatch fails closed before get and before attach", async () => {
  const { repository, attachCalls } = fakeRepository([candidate()]);
  const deps = dependencies(repository);
  deps.transport.headSizeAdjust = 1;
  const result = await runArticleRawExternalizationBatch(
    { articleTable: "articles", batchSize: 10, actorId: "operator", execute: true },
    deps,
  );
  assert.equal(result.failed[0].errorCode, "article_raw_externalization.head_verification_failed");
  assert.equal(deps.transport.gets.length, 0);
  assert.equal(attachCalls.length, 0);
});

test("tampered stored bytes fail closed before the attach RPC", async () => {
  const { repository, attachCalls } = fakeRepository([candidate()]);
  const deps = dependencies(repository);
  deps.transport.getBytesOverride = () => Buffer.from(encodeArticleRawText("tampered").bytes);
  const result = await runArticleRawExternalizationBatch(
    { articleTable: "articles", batchSize: 10, actorId: "operator", execute: true },
    deps,
  );
  assert.equal(result.failed[0].errorCode, "article_raw_externalization.get_verification_failed");
  assert.equal(attachCalls.length, 0);
});
test("an identical rerun is reported as idempotent", async () => {
  const { repository, attachCalls } = fakeRepository([candidate()], {
    attach: async (input) => ({ articleRowId: input.articleRowId, idempotent: true }),
  });
  const deps = dependencies(repository);
  const result = await runArticleRawExternalizationBatch(
    { articleTable: "articles", batchSize: 10, actorId: "operator", execute: true },
    deps,
  );
  assert.equal(result.idempotent, 1);
  assert.equal(result.externalized, 0);
  assert.equal(result.outcomes[0].status, "idempotent");
  assert.equal(attachCalls.length, 1);
});

test("classification reports pending, idempotent, and metadata_conflict before any upload", () => {
  const encoded = encodeArticleRawText(RAW_TEXT);
  const plan = planArticleRawExternalization(candidate());
  const exactRef = articleRawBlobStorageRef(SOURCE_KEY, encoded.sha256);

  assert.equal(classifyArticleRawExternalization(candidate(), plan), "pending");
  assert.equal(classifyArticleRawExternalization(externalizedCandidate(), plan), "idempotent");

  const conflicts: ArticleRawExternalizationCandidate[] = [
    candidate({ rawTextStorageRef: exactRef }),
    candidate({ rawTextBlobHash: encoded.sha256 }),
    externalizedCandidate({ rawTextStorageRef: null }),
    externalizedCandidate({ rawTextBlobHash: null }),
    externalizedCandidate({ rawTextBlobSize: null }),
    externalizedCandidate({ rawTextExternalizedAt: null }),
    externalizedCandidate({ rawTextBlobContractVersion: null }),
    externalizedCandidate({ rawTextExternalizedAt: "   " }),
    externalizedCandidate({ rawTextBlobContractVersion: "worldcons-article-raw-blob-v2" }),
    externalizedCandidate({ rawTextBlobSize: encoded.size + 1 }),
    externalizedCandidate({
      rawTextStorageRef: articleRawBlobStorageRef(SOURCE_KEY, "b".repeat(64)),
      rawTextBlobHash: "b".repeat(64),
    }),
  ];
  for (const conflict of conflicts) {
    assert.equal(classifyArticleRawExternalization(conflict, plan), "metadata_conflict");
  }
});

test("partial metadata is a metadata_conflict with zero put and zero attach", async () => {
  const encoded = encodeArticleRawText(RAW_TEXT);
  const entry = candidate({ rawTextStorageRef: articleRawBlobStorageRef(SOURCE_KEY, encoded.sha256) });
  const { repository, attachCalls } = fakeRepository([entry]);
  const deps = dependencies(repository);
  const result = await runArticleRawExternalizationBatch(
    { articleTable: "articles", batchSize: 10, actorId: "operator", execute: true },
    deps,
  );
  assert.equal(result.externalized, 0);
  assert.equal(result.idempotent, 0);
  assert.deepEqual(result.failed, [
    { articleRowId: ARTICLE_ROW_ID, errorCode: "article_raw_externalization.metadata_conflict" },
  ]);
  assert.equal(deps.transport.puts.length, 0);
  assert.equal(deps.transport.heads.length, 0);
  assert.equal(deps.transport.gets.length, 0);
  assert.equal(attachCalls.length, 0);
});

test("conflicting full metadata is a metadata_conflict with zero put and zero attach", async () => {
  const entry = externalizedCandidate({
    rawTextStorageRef: articleRawBlobStorageRef(SOURCE_KEY, "b".repeat(64)),
    rawTextBlobHash: "b".repeat(64),
  });
  const { repository, attachCalls } = fakeRepository([entry]);
  const deps = dependencies(repository);
  const result = await runArticleRawExternalizationBatch(
    { articleTable: "articles", batchSize: 10, actorId: "operator", execute: true },
    deps,
  );
  assert.equal(result.externalized, 0);
  assert.equal(result.idempotent, 0);
  assert.deepEqual(result.failed, [
    { articleRowId: ARTICLE_ROW_ID, errorCode: "article_raw_externalization.metadata_conflict" },
  ]);
  assert.equal(deps.transport.puts.length, 0);
  assert.equal(attachCalls.length, 0);
});

test("dry run reports exact-idempotent rows as idempotent and pending rows as planned", async () => {
  const pending = candidate({
    articleRowId: "0000000a-0000-4000-8000-00000000000a",
    articleId: "0000000a-0000-4000-8000-00000000000a",
  });
  const { repository, attachCalls } = fakeRepository([externalizedCandidate(), pending]);
  const deps = dependencies(repository);
  const result = await runArticleRawExternalizationBatch(
    { articleTable: "articles", batchSize: 10, actorId: "operator", execute: false },
    deps,
  );
  assert.equal(result.idempotent, 1);
  assert.equal(result.externalized, 0);
  assert.deepEqual(result.outcomes.map((outcome) => outcome.status), ["idempotent", "planned"]);
  assert.equal(deps.transport.puts.length, 0);
  assert.equal(deps.transport.heads.length, 0);
  assert.equal(deps.transport.gets.length, 0);
  assert.equal(attachCalls.length, 0);
});

test("execute leaves exact-idempotent rows untouched with zero put and zero attach", async () => {
  const { repository, attachCalls } = fakeRepository([externalizedCandidate()]);
  const deps = dependencies(repository);
  const result = await runArticleRawExternalizationBatch(
    { articleTable: "articles", batchSize: 10, actorId: "operator", execute: true },
    deps,
  );
  assert.equal(result.idempotent, 1);
  assert.equal(result.externalized, 0);
  assert.equal(result.outcomes[0].status, "idempotent");
  assert.equal(deps.transport.puts.length, 0);
  assert.equal(deps.transport.heads.length, 0);
  assert.equal(deps.transport.gets.length, 0);
  assert.equal(attachCalls.length, 0);
});

test("a stored document that decodes to different text fails closed before attach", async () => {
  const { repository, attachCalls } = fakeRepository([candidate()]);
  const deps = dependencies(repository);
  const stored = planArticleRawExternalization(candidate({ rawText: "stored text" }));
  const mismatched = { ...stored, candidate: { ...stored.candidate, rawText: RAW_TEXT } };
  await assert.rejects(
    externalizeArticleRawPlan(mismatched, deps, "operator"),
    /article_raw_externalization\.text_mismatch/,
  );
  assert.equal(deps.transport.puts.length, 1);
  assert.equal(deps.transport.gets.length, 1);
  assert.equal(attachCalls.length, 0);
});

test("the CLI-safe outcome projection drops the ref, hash, and inline text", () => {
  const encoded = encodeArticleRawText(RAW_TEXT);
  const outcome: ArticleRawExternalizationOutcome = {
    articleTable: "articles",
    articleRowId: ARTICLE_ROW_ID,
    sourceKey: SOURCE_KEY,
    status: "externalized",
    storageRef: articleRawBlobStorageRef(SOURCE_KEY, encoded.sha256),
    contentHash: encoded.sha256,
    contentSize: encoded.size,
  };
  const safe = toSafeArticleRawExternalizationOutcome(outcome);
  assert.deepEqual(Object.keys(safe).sort(), ["articleRowId", "contentSize", "status"]);
  const serialized = JSON.stringify(safe);
  assert.equal(serialized.includes(RAW_TEXT), false);
  assert.equal(serialized.includes("artifacts/article_raw/"), false);
  assert.equal(serialized.includes(encoded.sha256), false);
});

test("batches stay bounded and advance with a keyset cursor", async () => {
  const entries = Array.from({ length: 3 }, (_, index) => candidate({
    articleRowId: `0000000${index}-0000-4000-8000-00000000000${index}`,
    articleId: `0000000${index}-0000-4000-8000-00000000000${index}`,
  }));
  const { repository, listCalls } = fakeRepository(entries);
  const deps = dependencies(repository);
  const first = await runArticleRawExternalizationBatch(
    { articleTable: "articles", batchSize: 2, actorId: "operator", execute: false },
    deps,
  );
  assert.equal(first.scanned, 2);
  assert.equal(first.lastArticleRowId, entries[1].articleRowId);
  const second = await runArticleRawExternalizationBatch(
    { articleTable: "articles", batchSize: 2, actorId: "operator", execute: false, afterArticleRowId: first.lastArticleRowId },
    deps,
  );
  assert.equal(second.scanned, 1);
  assert.equal(second.lastArticleRowId, entries[2].articleRowId);
  assert.deepEqual(listCalls.map((call) => call.limit), [2, 2]);
  assert.equal(listCalls[1].afterArticleRowId, entries[1].articleRowId);
});
test("repository selects every raw blob metadata column plus raw_text and does not filter to ref-null", () => {
  const source = fs.readFileSync(repositoryPath, "utf8");
  assert.match(source, /article_raw_externalize_v1/);
  assert.equal(source.includes('.is("raw_text_storage_ref", null)'), false);
  assert.match(source, /\.not\("raw_text", "is", null\)/);
  assert.match(source, /\.eq\("source_key", input\.sourceKey\)/);
  assert.match(source, /\.order\("id", \{ ascending: true \}\)/);
  assert.match(source, /\.gt\("id", input\.afterArticleRowId\)/);
  assert.equal(
    source.includes(
      '"raw_text_storage_ref,raw_text_blob_hash,raw_text_blob_size,raw_text_externalized_at,raw_text_blob_contract_version"',
    ),
    true,
  );
  assert.match(source, /const ARTICLE_RAW_BLOB_ROW_SELECT = `id,source_key,raw_text,\$\{ARTICLE_RAW_BLOB_METADATA_SELECT\}`/);
  assert.match(
    source,
    /const ARTICLE_RAW_VERSION_ROW_SELECT = `id,article_id,source_key,raw_text,\$\{ARTICLE_RAW_BLOB_METADATA_SELECT\}`/,
  );
  assert.equal(source.includes(".select(ARTICLE_RAW_BLOB_ROW_SELECT)"), true);
  assert.equal(source.includes(".select(ARTICLE_RAW_VERSION_ROW_SELECT)"), true);
  assert.equal(source.includes("store.put("), false);
});

test("externalization lib verifies via head and get before calling the repository", () => {
  const source = fs.readFileSync(externalizationPath, "utf8");
  const putIndex = source.indexOf("await dependencies.store.put(");
  const headIndex = source.indexOf("await dependencies.store.head(");
  const getIndex = source.indexOf("await dependencies.store.get(");
  const attachIndex = source.indexOf("await dependencies.repository.attachArticleRawExternalization(");
  assert.ok(putIndex >= 0 && headIndex > putIndex && getIndex > headIndex && attachIndex > getIndex);
  assert.match(source, /encodeArticleRawText\(candidate\.rawText\)/);
  assert.match(source, /externalizationContractVersion: ARTICLE_RAW_BLOB_CONTRACT_VERSION,/);
  const decodeIndex = source.indexOf("decodeArticleRawText(stored)");
  assert.ok(decodeIndex > getIndex && attachIndex > decodeIndex, "decode must happen after get and before attach");
  assert.match(source, /decodeArticleRawText\(stored\) !== candidate\.rawText/);
  const dryRunIndex = source.indexOf("if (!input.execute)");
  const executeIndex = source.indexOf("await externalizeArticleRawPlan(");
  assert.ok(dryRunIndex >= 0 && executeIndex > dryRunIndex);
});

test("metadata classification happens before any put in the batch loop", () => {
  const source = fs.readFileSync(externalizationPath, "utf8");
  const classifyIndex = source.indexOf("const classification = classifyArticleRawExternalization(");
  const conflictIndex = source.indexOf('if (classification === "metadata_conflict")');
  const dryRunIndex = source.indexOf("if (!input.execute)", classifyIndex);
  const executeIndex = source.indexOf("await externalizeArticleRawPlan(", classifyIndex);
  assert.ok(classifyIndex >= 0, "classification call must exist");
  assert.ok(conflictIndex > classifyIndex, "metadata_conflict must be handled right after classification");
  assert.ok(dryRunIndex > classifyIndex, "classification must precede the dry-run branch");
  assert.ok(executeIndex > classifyIndex, "classification must precede the execute path");
});

test("CLI execute gates on --acknowledge-externalization and the read flag before the store or a batch", () => {
  const source = fs.readFileSync(scriptPath, "utf8");
  const executeIndex = source.indexOf('const execute = flag("execute")');
  const gateIndex = source.indexOf("if (execute)");
  const ackIndex = source.indexOf('flag("acknowledge-externalization")');
  const readIndex = source.indexOf("articleRawBlobReadEnabled()");
  const storeIndex = source.indexOf("createArtifactBlobStore()");
  const batchIndex = source.indexOf("runArticleRawExternalizationBatch(");
  assert.ok(executeIndex >= 0 && gateIndex > executeIndex, "the execute flag is read before the gate");
  assert.ok(ackIndex > gateIndex && readIndex > gateIndex, "the gates live inside the execute branch");
  assert.ok(storeIndex > ackIndex && storeIndex > readIndex, "the Blob store is created only after the gates");
  assert.ok(batchIndex > ackIndex && batchIndex > readIndex, "no batch runs before the gates");
  assert.match(source, /article_raw_externalization\.acknowledge_required/);
  assert.match(source, /article_raw_externalization\.read_disabled/);
  assert.equal(source.includes("ARTICLE_RAW_BLOB_WRITE_ENABLED"), false);
  assert.equal(source.includes("articleRawBlobWriteEnabled"), false);
  assert.equal(source.includes("articleRawBlobWriteReady"), false);
});

test("CLI output is redacted through the safe outcome projection", () => {
  const source = fs.readFileSync(scriptPath, "utf8");
  assert.match(source, /toSafeArticleRawExternalizationOutcome/);
  assert.match(source, /result\.outcomes\.map\(toSafeArticleRawExternalizationOutcome\)/);
  assert.equal(source.includes("outcomes: result.outcomes,"), false);
});
test("script defaults to dry run and requires an explicit --table and --execute", () => {
  const source = fs.readFileSync(scriptPath, "utf8");
  assert.match(source, /const execute = flag\("execute"\)/);
  assert.match(source, /const articleTable = tableArgument\(\)/);
  assert.match(source, /integerArgument\("batch-size", 25, 1, 100\)/);
  assert.match(source, /integerArgument\("max-batches", 20, 1, 1000\)/);
  assert.match(source, /createArtifactBlobStore\(\)/);
  assert.match(source, /runArticleRawExternalizationBatch\(/);
  assert.match(source, /ARTICLE_RAW_EXTERNALIZATION_TABLES/);
  assert.equal(source.includes("store.put("), false);
});

test("migration is additive, permit-guarded, and never clears inline raw_text", () => {
  const sql = fs.readFileSync(migrationPath, "utf8");
  assert.doesNotMatch(sql, /\bdrop\s+(table|column)\b/i);
  assert.doesNotMatch(sql, /\btruncate\b/i);
  assert.doesNotMatch(sql, /\bvacuum\b/i);
  assert.doesNotMatch(sql, /raw_text\s*=\s*null/i);
  assert.doesNotMatch(sql, /set\s+raw_text\s*=/i);
  assert.doesNotMatch(sql, /cleaned_text\s*=/i);
  assert.doesNotMatch(sql, /search_vector\s*=/i);
  assert.doesNotMatch(sql, /create table if not exists article_raw_externalization_ledger/i);
  assert.match(sql, /create table if not exists article_raw_externalization_permits/);
  assert.match(sql, /create or replace function article_raw_externalization_guard_v1\(/);
  assert.match(sql, /create or replace function article_raw_externalize_v1\(/);
  assert.match(sql, /security definer/);
  assert.match(sql, /set search_path = public, pg_temp/);
  assert.match(sql, /ARTICLE_RAW_EXTERNALIZATION_IMMUTABLE/);
  assert.match(sql, /worldcons-article-raw-blob-v1/);
  assert.match(sql, /insert into article_raw_externalization_ledger\(/);
  assert.match(sql, /on conflict \(article_table, article_row_id, externalization_contract_version\) do nothing/);
  assert.match(sql, /revoke all on table article_raw_externalization_permits from service_role/);
  assert.match(sql, /grant execute on function article_raw_externalize_v1/);
  assert.doesNotMatch(sql, /grant\s+(insert|update|delete)/i);
});
test("guard and permit table are versions-only with no articles trigger", () => {
  const sql = fs.readFileSync(migrationPath, "utf8");
  assert.doesNotMatch(sql, /articles_raw_text_externalization_guard_v1_trigger/);
  assert.doesNotMatch(sql, /create trigger[^;]*\bon articles\b/i);
  assert.doesNotMatch(sql, /before update of\s+raw_text_storage_ref/);
  assert.equal(sql.includes("article_table in ('articles', 'article_content_versions_p3')"), false);
  assert.match(
    sql,
    /constraint article_raw_externalization_permits_table_check check \(\s*article_table = 'article_content_versions_p3'/,
  );
  assert.match(sql, /drop trigger if exists article_content_versions_p3_immutable_trigger on article_content_versions_p3/);
  assert.match(sql, /create trigger article_content_versions_p3_immutable_trigger\s+before update or delete on article_content_versions_p3/);
  assert.match(sql, /from article_raw_externalization_permits p/);
  assert.match(sql, /delete from article_raw_externalization_permits/);
  assert.match(sql, /v_old_raw is null or v_old_raw is distinct from v_new_raw/);
  assert.match(sql, /is distinct from 'null'::jsonb/);
  assert.match(sql, /v_expected_ref/);
  assert.match(sql, /enable row level security/);
  assert.match(sql, /revoke all on table article_raw_externalization_permits from public/);
});

test("RPC accepts only the exact article raw contract version before any permit work", () => {
  const sql = fs.readFileSync(migrationPath, "utf8");
  const rpcStart = sql.indexOf("create or replace function article_raw_externalize_v1(");
  assert.ok(rpcStart >= 0, "externalization RPC must be defined");
  const rpcEnd = sql.indexOf("$function$;", rpcStart);
  assert.ok(rpcEnd > rpcStart, "externalization RPC body must terminate");
  const rpc = sql.slice(rpcStart, rpcEnd);
  assert.match(rpc, /p_externalization_contract_version is distinct from 'worldcons-article-raw-blob-v1'/);
  assert.match(rpc, /ARTICLE_RAW_EXTERNALIZATION_CONTRACT_VERSION_INVALID/);
  const versionGateIndex = rpc.search(/p_externalization_contract_version is distinct from/);
  const permitIndex = rpc.indexOf("insert into article_raw_externalization_permits");
  assert.ok(versionGateIndex >= 0, "contract version gate must exist");
  assert.ok(permitIndex > versionGateIndex, "version gate must precede the permit insert");
  assert.ok(rpc.indexOf("update articles") > versionGateIndex, "version gate must precede the articles update");
  assert.ok(rpc.indexOf("update article_content_versions_p3") > versionGateIndex, "version gate must precede the version update");
});

test("RPC mints the permit only for versions and updates articles through exactly five columns", () => {
  const sql = fs.readFileSync(migrationPath, "utf8");
  const rpcStart = sql.indexOf("create or replace function article_raw_externalize_v1(");
  const rpcEnd = sql.indexOf("$function$;", rpcStart);
  const rpc = sql.slice(rpcStart, rpcEnd);
  assert.match(
    rpc,
    /if p_article_table = 'article_content_versions_p3' then\s+insert into article_raw_externalization_permits\(/,
  );
  const permitInsertIndex = rpc.indexOf("insert into article_raw_externalization_permits");
  const articlesUpdateIndex = rpc.indexOf("update articles");
  assert.ok(permitInsertIndex > 0 && articlesUpdateIndex > permitInsertIndex, "permit is minted before the attach update");
  assert.match(
    rpc,
    /update articles\s+set raw_text_storage_ref = v_ref,\s+raw_text_blob_hash = p_content_hash,\s+raw_text_blob_size = p_content_size,\s+raw_text_externalized_at = now\(\),\s+raw_text_blob_contract_version = p_externalization_contract_version\s+where id = p_article_row_id;/,
  );
});

test("RPC requires a complete five-field current metadata set with exact size, otherwise a partial set fails", () => {
  const sql = fs.readFileSync(migrationPath, "utf8");
  const rpcStart = sql.indexOf("create or replace function article_raw_externalize_v1(");
  const rpcEnd = sql.indexOf("$function$;", rpcStart);
  const rpc = sql.slice(rpcStart, rpcEnd);
  assert.match(rpc, /a\.raw_text_blob_size, a\.raw_text_blob_contract_version,/);
  assert.match(rpc, /v\.raw_text_blob_size, v\.raw_text_blob_contract_version,/);
  assert.match(
    rpc,
    /if v_existing_ref is not null\s+or v_existing_hash is not null\s+or v_existing_size is not null\s+or v_existing_version is not null\s+or v_existing_externalized_at is not null\s+then/,
  );
  assert.match(rpc, /v_existing_size is not distinct from p_content_size/);
  assert.match(rpc, /v_existing_externalized_at is not null/);
});

test("RPC reconciles the ledger before any idempotent return and fails closed on a conflicting ledger", () => {
  const sql = fs.readFileSync(migrationPath, "utf8");
  const rpcStart = sql.indexOf("create or replace function article_raw_externalize_v1(");
  const rpcEnd = sql.indexOf("$function$;", rpcStart);
  const rpc = sql.slice(rpcStart, rpcEnd);
  const ledgerSelectIndex = rpc.indexOf("from article_raw_externalization_ledger l");
  const idempotentIndex = rpc.indexOf("'idempotent', true");
  assert.ok(ledgerSelectIndex >= 0, "the ledger must be consulted before returning idempotent");
  assert.ok(idempotentIndex > ledgerSelectIndex, "the ledger check must precede the idempotent return");
  assert.match(rpc, /l\.externalization_contract_version = p_externalization_contract_version/);
  assert.match(rpc, /ARTICLE_RAW_EXTERNALIZATION_LEDGER_CONFLICT/);
  assert.match(
    rpc,
    /insert into article_raw_externalization_ledger\(\s+article_table, article_row_id, article_id, content_kind, storage_ref, content_hash,\s+content_size, externalization_contract_version, actor_type, actor_id\s+\) values \(\s+p_article_table, p_article_row_id, v_article_id, 'raw_text', v_ref, p_content_hash,\s+p_content_size, p_externalization_contract_version, 'operator', v_actor\s+\)\s+on conflict \(article_table, article_row_id, externalization_contract_version\) do nothing;\s+end if;\s+return jsonb_build_object\('artifactId', p_article_row_id, 'idempotent', true\);/,
  );
});

test("M6A contract migration is unchanged and already owns the article raw ledger", () => {
  const contract = fs.readFileSync(contractMigrationPath, "utf8");
  assert.match(contract, /create table if not exists article_raw_externalization_ledger/);
  assert.match(contract, /worldcons-article-raw-blob-v1/);
  assert.equal(contract.includes("article_raw_externalization_permits"), false);
  const sql = fs.readFileSync(migrationPath, "utf8");
  assert.equal(sql.includes("add column if not exists raw_text_storage_ref"), false);
  assert.equal(sql.includes("drop trigger if exists article_raw_externalization_ledger_immutable_trigger"), false);
});
