import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { canonicalJson } from "../lib/backfill/canonical-json";
import {
  planArtifactInlineRestore,
  runArtifactInlineRestoreBatch,
  toSafeArtifactInlineRestoreOutcome,
  type CaseBackfillInlineRestoreDependencies,
  type CaseBackfillInlineRestoreOutcome,
} from "../lib/backfill/inline-restore";
import { CASE_BACKFILL_ARTIFACT_BLOB_READ_FLAG } from "../lib/backfill/flags";
import type { CaseBackfillRepository } from "../lib/backfill/repository";
import type {
  CaseBackfillInlineRestoreCandidate,
  RestoreArtifactInlineInput,
} from "../lib/backfill/types";
import {
  ARTIFACT_BLOB_CONTRACT_VERSION,
  ArtifactBlobStore,
  buildArtifactStorageRef,
  sha256Hex,
  type ArtifactBlobGetOptions,
  type ArtifactBlobGetResult,
  type ArtifactBlobHeadResult,
  type ArtifactBlobPutOptions,
  type ArtifactBlobTransport,
} from "../lib/storage/blob";

const repositoryPath = path.join(process.cwd(), "lib/backfill/repository.ts");
const inlineRestorePath = path.join(process.cwd(), "lib/backfill/inline-restore.ts");
const scriptPath = path.join(process.cwd(), "scripts/restore-inline-artifacts.ts");
const migrationRoot = path.join(process.cwd(), "supabase/migrations");
const migrationPath = path.join(migrationRoot, "20260919210000_artifact_blob_inline_restore.sql");
const inlineClearMigrationPath = path.join(migrationRoot, "20260919110000_artifact_blob_inline_clear.sql");

const SOURCE_KEY = "es-tribunal-constitucional";
const FETCH_ARTIFACT_ID = "66666666-6666-4666-8666-666666666667";
const NORMALIZATION_ARTIFACT_ID = "77777777-7777-4777-8777-777777777778";
const ITEM_ID = "44444444-4444-4444-8444-444444444444";
const EXTERNALIZED_AT = "2026-09-19T00:00:00.000Z";

const enabledEnvironment = { [CASE_BACKFILL_ARTIFACT_BLOB_READ_FLAG]: "true" };

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
  headSizeAdjust = 0;
  getBytesOverride: ((pathname: string) => Buffer | null) | null = null;

  async put(pathname: string, body: Buffer, options: ArtifactBlobPutOptions) {
    this.puts.push({ pathname, body: Buffer.from(body), options });
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

function fetchDocument() {
  return {
    sourceKey: SOURCE_KEY,
    url: "https://hj.tribunalconstitucional.es/HJ/es/Resolucion/Show/12345",
    canonicalUrl: "https://hj.tribunalconstitucional.es/HJ/es/Resolucion/Show/12345",
    contentType: "decision",
    text: "official text",
  };
}

function normalizedDocument() {
  return {
    sourceKey: SOURCE_KEY,
    jurisdiction: "Spain",
    contentType: "decision",
    originalUrl: "https://hj.tribunalconstitucional.es/HJ/es/Resolucion/Show/12345",
    canonicalUrl: "https://hj.tribunalconstitucional.es/HJ/es/Resolucion/Show/12345",
    metadata: { resolutionType: "SENTENCIA" },
  };
}

function fetchCandidate(overrides: Partial<CaseBackfillInlineRestoreCandidate> = {}): CaseBackfillInlineRestoreCandidate {
  const document = canonicalJson(fetchDocument());
  const hash = sha256Hex(document);
  return {
    artifactTable: "source_fetch_artifacts",
    artifactId: FETCH_ARTIFACT_ID,
    itemId: ITEM_ID,
    sourceKey: SOURCE_KEY,
    kind: "fetch",
    storageRef: buildArtifactStorageRef("fetch", SOURCE_KEY, hash),
    storedHash: hash,
    storedSize: Buffer.byteLength(document, "utf8"),
    externalizedAt: EXTERNALIZED_AT,
    externalizationContractVersion: ARTIFACT_BLOB_CONTRACT_VERSION,
    ...overrides,
  };
}

function normalizationCandidate(overrides: Partial<CaseBackfillInlineRestoreCandidate> = {}): CaseBackfillInlineRestoreCandidate {
  const document = canonicalJson(normalizedDocument());
  const hash = sha256Hex(document);
  return {
    artifactTable: "source_normalization_artifacts",
    artifactId: NORMALIZATION_ARTIFACT_ID,
    itemId: ITEM_ID,
    sourceKey: SOURCE_KEY,
    kind: "normalization",
    storageRef: buildArtifactStorageRef("normalization", SOURCE_KEY, hash),
    storedHash: hash,
    storedSize: Buffer.byteLength(document, "utf8"),
    externalizedAt: EXTERNALIZED_AT,
    externalizationContractVersion: ARTIFACT_BLOB_CONTRACT_VERSION,
    ...overrides,
  };
}

function seedBlob(transport: FakeTransport, candidate: CaseBackfillInlineRestoreCandidate) {
  const document = candidate.kind === "fetch" ? canonicalJson(fetchDocument()) : canonicalJson(normalizedDocument());
  transport.objects.set(candidate.storageRef as string, Buffer.from(document, "utf8"));
}

function fakeRepository(
  candidates: CaseBackfillInlineRestoreCandidate[],
  overrides: {
    restore?: (input: RestoreArtifactInlineInput) => Promise<{ artifactId: string; idempotent: boolean }>;
  } = {},
) {
  const restoreCalls: RestoreArtifactInlineInput[] = [];
  const listCalls: { kind: string; sourceKey: string | null; limit: number; afterArtifactId: string | null }[] = [];
  const repository: Pick<
    CaseBackfillRepository,
    "listArtifactInlineRestoreCandidates" | "restoreArtifactInline"
  > = {
    listArtifactInlineRestoreCandidates: async (input) => {
      listCalls.push({
        kind: input.kind,
        sourceKey: input.sourceKey ?? null,
        limit: input.limit,
        afterArtifactId: input.afterArtifactId ?? null,
      });
      const after = input.afterArtifactId ?? null;
      return candidates
        .filter((candidate) => (after ? candidate.artifactId > after : true))
        .slice(0, input.limit);
    },
    restoreArtifactInline: async (input) => {
      restoreCalls.push(input);
      if (overrides.restore) return overrides.restore(input);
      return { artifactId: input.artifactId, idempotent: false };
    },
  };
  return { repository, restoreCalls, listCalls };
}

function dependencies(
  repository: ReturnType<typeof fakeRepository>["repository"],
  transport = new FakeTransport(),
  environment: Record<string, string | undefined> = enabledEnvironment,
): CaseBackfillInlineRestoreDependencies & { transport: FakeTransport } {
  return { repository, store: new ArtifactBlobStore(transport), transport, environment };
}

// --- planning ---------------------------------------------------------------

test("plan revalidates the contract, content-addressed ref, and recorded size", () => {
  const candidate = fetchCandidate();
  const plan = planArtifactInlineRestore(candidate);
  assert.equal(plan.storageRef, candidate.storageRef);
  assert.equal(plan.contentHash, candidate.storedHash);
  assert.equal(plan.contentSize, candidate.storedSize);
});

test("plan refuses an unsupported externalization contract", () => {
  assert.throws(
    () => planArtifactInlineRestore(fetchCandidate({ externalizationContractVersion: "worldcons-artifact-blob-v2" })),
    /artifact_inline_restore\.conflict/,
  );
});

test("plan refuses a storage ref that is not content addressed to this artifact", () => {
  const candidate = fetchCandidate();
  assert.throws(
    () => planArtifactInlineRestore({ ...candidate, storageRef: buildArtifactStorageRef("fetch", SOURCE_KEY, sha256Hex("other")) }),
    /artifact_inline_restore\.conflict/,
  );
});

test("plan refuses a candidate without a recorded size", () => {
  const candidate = fetchCandidate();
  assert.throws(
    () => planArtifactInlineRestore({ ...candidate, storedSize: Number.NaN }),
    /artifact_inline_restore\.conflict/,
  );
});

// --- dry run ----------------------------------------------------------------

test("dry run plans restores without any Blob read or restore RPC", async () => {
  const candidate = fetchCandidate();
  const { repository, restoreCalls } = fakeRepository([candidate]);
  const deps = dependencies(repository);
  const result = await runArtifactInlineRestoreBatch(
    { kind: "fetch", batchSize: 10, actorId: "operator", execute: false },
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
  const { repository, restoreCalls } = fakeRepository([fetchCandidate()]);
  const result = await runArtifactInlineRestoreBatch(
    { kind: "fetch", batchSize: 10, actorId: "operator", execute: false },
    { repository },
  );
  assert.equal(result.scanned, 1);
  assert.equal(result.restored, 0);
  assert.equal(result.failed.length, 0);
  assert.deepEqual(result.outcomes.map((outcome) => outcome.status), ["planned"]);
  assert.equal(restoreCalls.length, 0);

  const source = fs.readFileSync(inlineRestorePath, "utf8");
  assert.match(source, /store\?: ArtifactBlobStore \| null;/);
});

// --- execute gating ---------------------------------------------------------

test("execute requires the Blob read flag ready and fails closed before listing or mutating", async () => {
  const { repository, restoreCalls, listCalls } = fakeRepository([fetchCandidate()]);
  const deps = dependencies(repository, new FakeTransport(), {});
  await assert.rejects(
    () => runArtifactInlineRestoreBatch(
      { kind: "fetch", batchSize: 10, actorId: "operator", execute: true },
      deps,
    ),
    /artifact_inline_restore\.read_disabled/,
  );
  assert.equal(listCalls.length, 0);
  assert.equal(deps.transport.heads.length, 0);
  assert.equal(deps.transport.gets.length, 0);
  assert.equal(restoreCalls.length, 0);
});

test("execute with no Blob store fails closed before listing or mutating", async () => {
  const { repository, restoreCalls, listCalls } = fakeRepository([fetchCandidate()]);
  await assert.rejects(
    () => runArtifactInlineRestoreBatch(
      { kind: "fetch", batchSize: 10, actorId: "operator", execute: true },
      { repository, environment: enabledEnvironment },
    ),
    /artifact_inline_restore\.store_unavailable/,
  );
  assert.equal(listCalls.length, 0);
  assert.equal(restoreCalls.length, 0);
});

// --- success path -----------------------------------------------------------

test("execute heads then gets, verifies size/SHA-256/canonical object, and only then restores with the parsed payload and canonical document", async () => {
  const candidate = fetchCandidate();
  const { repository, restoreCalls } = fakeRepository([candidate]);
  const deps = dependencies(repository);
  seedBlob(deps.transport, candidate);
  const result = await runArtifactInlineRestoreBatch(
    { kind: "fetch", batchSize: 10, actorId: "operator", execute: true },
    deps,
  );
  assert.equal(result.restored, 1);
  assert.equal(result.failed.length, 0);
  assert.equal(result.outcomes[0].status, "restored");
  assert.equal(deps.transport.puts.length, 0);
  assert.deepEqual(deps.transport.heads, [candidate.storageRef]);
  assert.deepEqual(deps.transport.gets, [candidate.storageRef]);
  assert.deepEqual(restoreCalls, [{
    artifactTable: "source_fetch_artifacts",
    artifactId: candidate.artifactId,
    inlinePayload: fetchDocument(),
    document: canonicalJson(fetchDocument()),
    storageRef: candidate.storageRef,
    contentHash: candidate.storedHash,
    contentSize: candidate.storedSize,
    externalizationContractVersion: ARTIFACT_BLOB_CONTRACT_VERSION,
    actorId: "operator",
  }]);
  const restoreInput = restoreCalls[0] as unknown as Record<string, unknown>;
  assert.equal("p_dry_run" in restoreInput, false);
  assert.deepEqual(restoreCalls[0].inlinePayload, fetchDocument());
  assert.equal(restoreCalls[0].document, canonicalJson(fetchDocument()));
});

test("normalization restores with the normalization ref and size", async () => {
  const candidate = normalizationCandidate();
  const { repository, restoreCalls } = fakeRepository([candidate]);
  const deps = dependencies(repository);
  seedBlob(deps.transport, candidate);
  const result = await runArtifactInlineRestoreBatch(
    { kind: "normalization", batchSize: 10, actorId: "operator", execute: true },
    deps,
  );
  assert.equal(result.restored, 1);
  assert.equal(restoreCalls[0].artifactTable, "source_normalization_artifacts");
  assert.match(restoreCalls[0].storageRef, /^artifacts\/normalization\//);
  assert.equal(restoreCalls[0].contentSize, candidate.storedSize);
});

test("an identical rerun reported by the RPC is idempotent", async () => {
  const { repository, restoreCalls } = fakeRepository([fetchCandidate()], {
    restore: async (input) => ({ artifactId: input.artifactId, idempotent: true }),
  });
  const deps = dependencies(repository);
  seedBlob(deps.transport, fetchCandidate());
  const result = await runArtifactInlineRestoreBatch(
    { kind: "fetch", batchSize: 10, actorId: "operator", execute: true },
    deps,
  );
  assert.equal(result.idempotent, 1);
  assert.equal(result.restored, 0);
  assert.equal(result.outcomes[0].status, "idempotent");
  assert.equal(restoreCalls.length, 1);
});

// --- fail-closed verification ----------------------------------------------

test("a head size mismatch blocks the RPC after the size check", async () => {
  const candidate = fetchCandidate();
  const { repository, restoreCalls } = fakeRepository([candidate]);
  const deps = dependencies(repository);
  seedBlob(deps.transport, candidate);
  deps.transport.headSizeAdjust = 1;
  const result = await runArtifactInlineRestoreBatch(
    { kind: "fetch", batchSize: 10, actorId: "operator", execute: true },
    deps,
  );
  assert.equal(result.restored, 0);
  assert.deepEqual(result.failed, [
    { artifactId: candidate.artifactId, errorCode: "artifact_inline_restore.head_verification_failed" },
  ]);
  assert.equal(deps.transport.gets.length, 0);
  assert.equal(restoreCalls.length, 0);
});

test("a get SHA-256 mismatch blocks the RPC", async () => {
  const candidate = fetchCandidate();
  const { repository, restoreCalls } = fakeRepository([candidate]);
  const deps = dependencies(repository);
  seedBlob(deps.transport, candidate);
  deps.transport.getBytesOverride = () => Buffer.from(canonicalJson({ tampered: true }), "utf8");
  const result = await runArtifactInlineRestoreBatch(
    { kind: "fetch", batchSize: 10, actorId: "operator", execute: true },
    deps,
  );
  assert.equal(result.failed[0].errorCode, "artifact_inline_restore.get_verification_failed");
  assert.equal(restoreCalls.length, 0);
});

test("a get byte-length mismatch blocks the RPC", async () => {
  const candidate = fetchCandidate();
  const { repository, restoreCalls } = fakeRepository([candidate]);
  const deps = dependencies(repository);
  seedBlob(deps.transport, candidate);
  deps.transport.getBytesOverride = () => Buffer.from(canonicalJson(fetchDocument()).slice(0, 4), "utf8");
  const result = await runArtifactInlineRestoreBatch(
    { kind: "fetch", batchSize: 10, actorId: "operator", execute: true },
    deps,
  );
  assert.equal(result.failed[0].errorCode, "artifact_inline_restore.get_verification_failed");
  assert.equal(restoreCalls.length, 0);
});

test("a stored document that is not a JSON object blocks the RPC", async () => {
  const bytes = Buffer.from("[1,2,3]", "utf8");
  const hash = sha256Hex(bytes);
  const entry = fetchCandidate({
    storageRef: buildArtifactStorageRef("fetch", SOURCE_KEY, hash),
    storedHash: hash,
    storedSize: bytes.byteLength,
  });
  const { repository, restoreCalls } = fakeRepository([entry]);
  const deps = dependencies(repository);
  deps.transport.objects.set(entry.storageRef as string, bytes);
  const result = await runArtifactInlineRestoreBatch(
    { kind: "fetch", batchSize: 10, actorId: "operator", execute: true },
    deps,
  );
  assert.equal(result.failed[0].errorCode, "artifact_inline_restore.invalid_document");
  assert.equal(deps.transport.heads.length, 1);
  assert.equal(deps.transport.gets.length, 1);
  assert.equal(restoreCalls.length, 0);
});

test("a stored document that is not canonical JSON blocks the RPC", async () => {
  const bytes = Buffer.from('{"b": 2, "a": 1}', "utf8");
  const hash = sha256Hex(bytes);
  const entry = fetchCandidate({
    storageRef: buildArtifactStorageRef("fetch", SOURCE_KEY, hash),
    storedHash: hash,
    storedSize: bytes.byteLength,
  });
  const { repository, restoreCalls } = fakeRepository([entry]);
  const deps = dependencies(repository);
  deps.transport.objects.set(entry.storageRef as string, bytes);
  const result = await runArtifactInlineRestoreBatch(
    { kind: "fetch", batchSize: 10, actorId: "operator", execute: true },
    deps,
  );
  assert.equal(result.failed[0].errorCode, "artifact_inline_restore.non_canonical_document");
  assert.equal(restoreCalls.length, 0);
});

test("a candidate without a recorded size is blocked with zero Blob read and zero RPC", async () => {
  const candidate = fetchCandidate({ storedSize: Number.NaN });
  const { repository, restoreCalls } = fakeRepository([candidate]);
  const deps = dependencies(repository);
  const result = await runArtifactInlineRestoreBatch(
    { kind: "fetch", batchSize: 10, actorId: "operator", execute: true },
    deps,
  );
  assert.equal(result.restored, 0);
  assert.deepEqual(result.failed, [
    { artifactId: candidate.artifactId, errorCode: "artifact_inline_restore.conflict" },
  ]);
  assert.equal(deps.transport.heads.length, 0);
  assert.equal(deps.transport.gets.length, 0);
  assert.equal(restoreCalls.length, 0);
});

test("a conflicting storage ref is blocked with zero Blob read and zero RPC", async () => {
  const candidate = fetchCandidate({ storageRef: buildArtifactStorageRef("fetch", SOURCE_KEY, "b".repeat(64)) });
  const { repository, restoreCalls } = fakeRepository([candidate]);
  const deps = dependencies(repository);
  const result = await runArtifactInlineRestoreBatch(
    { kind: "fetch", batchSize: 10, actorId: "operator", execute: true },
    deps,
  );
  assert.equal(result.restored, 0);
  assert.equal(result.failed[0].errorCode, "artifact_inline_restore.conflict");
  assert.equal(deps.transport.heads.length, 0);
  assert.equal(restoreCalls.length, 0);
});

test("an unsupported contract is blocked with zero Blob read and zero RPC", async () => {
  const candidate = fetchCandidate({ externalizationContractVersion: "worldcons-artifact-blob-v2" });
  const { repository, restoreCalls } = fakeRepository([candidate]);
  const deps = dependencies(repository);
  const result = await runArtifactInlineRestoreBatch(
    { kind: "fetch", batchSize: 10, actorId: "operator", execute: true },
    deps,
  );
  assert.equal(result.restored, 0);
  assert.equal(result.failed[0].errorCode, "artifact_inline_restore.conflict");
  assert.equal(deps.transport.heads.length, 0);
  assert.equal(restoreCalls.length, 0);
});

// --- pagination -------------------------------------------------------------

test("batches stay bounded and advance with a keyset cursor", async () => {
  const candidates = Array.from({ length: 3 }, (_, index) => fetchCandidate({
    artifactId: `0000000${index}-0000-4000-8000-00000000000${index}`,
  }));
  const { repository, listCalls } = fakeRepository(candidates);
  const deps = dependencies(repository);
  const first = await runArtifactInlineRestoreBatch(
    { kind: "fetch", batchSize: 2, actorId: "operator", execute: false },
    deps,
  );
  assert.equal(first.scanned, 2);
  assert.equal(first.lastArtifactId, candidates[1].artifactId);
  const second = await runArtifactInlineRestoreBatch(
    { kind: "fetch", batchSize: 2, actorId: "operator", execute: false, afterArtifactId: first.lastArtifactId },
    deps,
  );
  assert.equal(second.scanned, 1);
  assert.equal(second.lastArtifactId, candidates[2].artifactId);
  assert.deepEqual(listCalls.map((call) => call.limit), [2, 2]);
  assert.equal(listCalls[0].afterArtifactId, null);
  assert.equal(listCalls[1].afterArtifactId, candidates[1].artifactId);
});

// --- static ordering --------------------------------------------------------

test("restore lib verifies head, get, and the canonical document before calling the repository, and never puts or deletes", () => {
  const source = fs.readFileSync(inlineRestorePath, "utf8");
  const headIndex = source.indexOf("await dependencies.store.head(");
  const getIndex = source.indexOf("await dependencies.store.get(");
  const canonicalIndex = source.indexOf("canonicalJson(parsed) !== document");
  const restoreIndex = source.indexOf("await dependencies.repository.restoreArtifactInline(");
  assert.ok(headIndex >= 0 && getIndex > headIndex && canonicalIndex > getIndex && restoreIndex > canonicalIndex);
  const dryRunIndex = source.indexOf("if (!input.execute)");
  const executeIndex = source.indexOf("await restoreArtifactInlinePlan(");
  assert.ok(dryRunIndex >= 0 && executeIndex > dryRunIndex);
  assert.doesNotMatch(source, /store\.put\(/);
  assert.doesNotMatch(source, /store\.delete\(/);
  assert.match(source, /caseBackfillArtifactBlobReadReady/);
  assert.match(source, /inlinePayload: parsed/);
  assert.match(source, /document,/);
  const payloadIndex = source.indexOf("inlinePayload: parsed");
  const documentIndex = source.indexOf("document,", payloadIndex);
  assert.ok(payloadIndex >= 0 && documentIndex > payloadIndex, "the parsed payload is passed before the document");
});

test("metadata planning happens before any Blob read in the batch loop", () => {
  const source = fs.readFileSync(inlineRestorePath, "utf8");
  const planIndex = source.indexOf("const plan = planArtifactInlineRestore(candidate)");
  const executeIndex = source.indexOf("await restoreArtifactInlinePlan(", planIndex);
  assert.ok(planIndex >= 0, "planning must exist");
  assert.ok(executeIndex > planIndex, "planning must precede the execute path");
  const planDefinitionIndex = source.indexOf("export function planArtifactInlineRestore(");
  assert.ok(planDefinitionIndex >= 0 && planDefinitionIndex < planIndex);
});

test("repository selects blob-only restore candidates and routes to the restore RPC", () => {
  const source = fs.readFileSync(repositoryPath, "utf8");
  assert.match(source, /source_backfill_artifact_inline_restore_v1/);
  assert.match(source, /listArtifactInlineRestoreCandidates/);
  assert.match(source, /restoreArtifactInline/);
  assert.match(source, /\.is\("bounded_replay_payload", null\)/);
  assert.match(source, /\.not\("bounded_replay_storage_ref", "is", null\)/);
  assert.match(source, /\.is\("normalized_output", null\)/);
  assert.match(source, /\.not\("normalized_output_storage_ref", "is", null\)/);
  assert.match(source, /\.eq\("externalization_contract_version", ARTIFACT_BLOB_CONTRACT_VERSION\)/);
  assert.match(source, /\.order\("id", \{ ascending: true \}\)/);
  assert.match(source, /\.gt\("id", input\.afterArtifactId\)/);
  assert.match(source, /\.eq\("source_backfill_items\.source_inventory_snapshots\.source_key", input\.sourceKey\)/);
  assert.match(source, /source_inventory_snapshots!inner\(source_key\)/);
  assert.match(source, /source_backfill_items!source_fetch_artifacts_item_id_fkey!inner\(snapshot_id, source_inventory_snapshots!inner\(source_key\)\)/);
  assert.match(source, /source_backfill_items!source_normalization_artifacts_item_id_fkey!inner\(snapshot_id, source_inventory_snapshots!inner\(source_key\)\)/);
  assert.match(source, /p_artifact_table: input\.artifactTable/);
  assert.match(source, /p_inline_payload: input\.inlinePayload/);
  assert.match(source, /p_document: input\.document/);
  assert.match(source, /p_dry_run: false/);
  assert.doesNotMatch(source, /source_backfill_items!inner\(/);

  const restoreListIndex = source.indexOf("async listArtifactInlineRestoreCandidates(input)");
  assert.ok(restoreListIndex >= 0, "the restore candidate listing must exist");
  const restoreListFetch = source.slice(
    restoreListIndex,
    source.indexOf('.from("source_normalization_artifacts")', restoreListIndex),
  );
  assert.match(restoreListFetch, /\.eq\("replayability", "bounded_evidence"\)/);
  assert.match(restoreListFetch, /\.is\("bounded_replay_payload", null\)/);
});

test("the restore RPC re-checks bounded-evidence replayability for fetch rows under the row lock", () => {
  const sql = fs.readFileSync(migrationPath, "utf8");
  const rpcStart = sql.indexOf("create or replace function source_backfill_artifact_inline_restore_v1(");
  assert.ok(rpcStart >= 0, "restore RPC must be defined");
  const rpcEnd = sql.indexOf("$function$;", rpcStart);
  assert.ok(rpcEnd > rpcStart, "restore RPC body must terminate");
  const rpc = sql.slice(rpcStart, rpcEnd);

  // The fetch row load selects replayability in the same FOR UPDATE statement.
  const fetchSelectIndex = rpc.indexOf("select f.item_id");
  assert.ok(fetchSelectIndex >= 0, "the fetch row load must exist");
  const fetchLockIndex = rpc.indexOf("for update;", fetchSelectIndex);
  assert.ok(fetchLockIndex > fetchSelectIndex, "the fetch row load must take the row lock");
  const fetchBranch = rpc.slice(fetchSelectIndex, fetchLockIndex);
  assert.match(fetchBranch, /f\.replayability\b/);
  assert.match(fetchBranch, /from source_fetch_artifacts f where f\.id = p_artifact_id/);
  assert.match(fetchBranch, /into[\s\S]*v_stored_replayability/);

  // Exactly bounded_evidence is required, scoped to the fetch branch only.
  assert.match(
    rpc,
    /if p_artifact_table = 'source_fetch_artifacts'\s*and v_stored_replayability is distinct from 'bounded_evidence'/,
  );
  assert.match(rpc, /CASE_BACKFILL_INLINE_RESTORE_REPLAYABILITY_INVALID/);

  // The normalization branch is unchanged: it neither selects nor gates replayability.
  const normalizationSelectIndex = rpc.indexOf("select n.item_id");
  assert.ok(normalizationSelectIndex >= 0, "the normalization row load must exist");
  const normalizationLockIndex = rpc.indexOf("for update;", normalizationSelectIndex);
  const normalizationBranch = rpc.slice(normalizationSelectIndex, normalizationLockIndex);
  assert.doesNotMatch(normalizationBranch, /replayability/);

  // The replayability gate fails closed before the idempotent, dry-run, permit,
  // and update paths.
  const replayabilityGateIndex = rpc.search(/v_stored_replayability is distinct from 'bounded_evidence'/);
  const idempotentIndex = rpc.indexOf("if v_inline_present then");
  const dryRunIndex = rpc.indexOf("if v_dry_run then");
  const permitIndex = rpc.indexOf("insert into source_artifact_inline_restore_permits");
  const updateIndex = rpc.indexOf("update source_fetch_artifacts set bounded_replay_payload");
  assert.ok(replayabilityGateIndex >= 0, "the replayability gate must exist");
  assert.ok(idempotentIndex >= 0 && replayabilityGateIndex < idempotentIndex, "the gate precedes the idempotent path");
  assert.ok(replayabilityGateIndex < dryRunIndex, "the gate precedes the dry-run path");
  assert.ok(replayabilityGateIndex < permitIndex, "the gate precedes permit minting");
  assert.ok(replayabilityGateIndex < updateIndex, "the gate precedes the inline update");

  // The repository candidate query keeps its own bounded-evidence gate too.
  const repository = fs.readFileSync(repositoryPath, "utf8");
  const restoreListIndex = repository.indexOf("async listArtifactInlineRestoreCandidates(input)");
  assert.ok(restoreListIndex >= 0, "the restore candidate listing must exist");
  const restoreListFetch = repository.slice(
    restoreListIndex,
    repository.indexOf('.from("source_normalization_artifacts")', restoreListIndex),
  );
  assert.match(restoreListFetch, /\.eq\("replayability", "bounded_evidence"\)/);
});

// --- CLI gates --------------------------------------------------------------

test("CLI defaults to dry run and requires execute plus an acknowledgement and the read flag", () => {
  const source = fs.readFileSync(scriptPath, "utf8");
  assert.match(source, /const execute = flag\("execute"\)/);
  assert.match(source, /const acknowledgedRestore = flag\("acknowledge-inline-restore"\)/);
  assert.match(source, /execute_requires_acknowledge_inline_restore/);
  assert.match(source, /artifact_blob_read_not_ready/);
  assert.match(source, /caseBackfillArtifactBlobReadReady\(process\.env\)/);
  assert.match(source, /const KINDS: readonly CaseBackfillArtifactExternalizationKind\[\] = \["fetch", "normalization"\]/);
  assert.match(source, /integerArgument\("batch-size", 25, 1, 100\)/);
  assert.match(source, /integerArgument\("max-batches", 20, 1, 1000\)/);
  assert.match(source, /optionalSourceKey\(\)/);
  assert.match(source, /const store = execute \? createOperatorArtifactBlobStore\(\) : null;/);
  assert.equal(source.includes("const store = createOperatorArtifactBlobStore();"), false);
  assert.match(source, /runArtifactInlineRestoreBatch\(/);
  assert.doesNotMatch(source, /store\.put\(/);
  assert.doesNotMatch(source, /store\.delete\(/);
  assert.equal(source.includes("ARTICLE_RAW_BLOB_WRITE_ENABLED"), false);
  assert.equal(source.includes("articleRawBlobWriteEnabled"), false);
});

test("CLI reads its flags and gates before creating the Blob store or running a batch", () => {
  const source = fs.readFileSync(scriptPath, "utf8");
  const executeIndex = source.indexOf('const execute = flag("execute")');
  const ackIndex = source.indexOf('const acknowledgedRestore = flag("acknowledge-inline-restore")');
  const readIndex = source.indexOf("const blobReadReady = caseBackfillArtifactBlobReadReady(process.env)");
  const gateIndex = source.indexOf("if (execute && !acknowledgedRestore)");
  const storeIndex = source.indexOf("const store = execute ? createOperatorArtifactBlobStore() : null;");
  const batchIndex = source.indexOf("runArtifactInlineRestoreBatch(");
  assert.ok(executeIndex >= 0 && ackIndex > executeIndex, "the execute flag is read before its acknowledgement");
  assert.ok(readIndex > ackIndex, "the read flag is evaluated after the flags are read");
  assert.ok(gateIndex > readIndex, "the execute gates run after the flags are evaluated");
  assert.ok(storeIndex > gateIndex, "the Blob store is created only after the gates");
  assert.ok(batchIndex > storeIndex, "the store is ready before the first batch");
});

// --- safe projection --------------------------------------------------------

test("the safe projection emits only status, artifactId, and contentSize and drops sourceKey, storageRef, and contentHash", () => {
  const raw: CaseBackfillInlineRestoreOutcome = {
    artifactId: FETCH_ARTIFACT_ID,
    artifactTable: "source_fetch_artifacts",
    kind: "fetch",
    sourceKey: SOURCE_KEY,
    status: "restored",
    storageRef: buildArtifactStorageRef("fetch", SOURCE_KEY, "a".repeat(64)),
    contentHash: "a".repeat(64),
    contentSize: 128,
  };
  const safe = toSafeArtifactInlineRestoreOutcome(raw);
  assert.deepEqual(Object.keys(safe).sort(), ["artifactId", "contentSize", "status"]);
  assert.deepEqual(safe, { status: "restored", artifactId: FETCH_ARTIFACT_ID, contentSize: 128 });
  assert.equal("sourceKey" in safe, false);
  assert.equal("storageRef" in safe, false);
  assert.equal("contentHash" in safe, false);

  const source = fs.readFileSync(scriptPath, "utf8");
  assert.match(source, /outcomes: result\.outcomes\.map\(toSafeArtifactInlineRestoreOutcome\)/);
  assert.equal(source.includes("outcomes: result.outcomes,"), false);
  assert.doesNotMatch(source, /outcomes:\s*result\.outcomes\s*[,\n}]/);
});

// --- migration contract -----------------------------------------------------

test("the restore migration is additive, extends the guard, and leaves no generic bypass", () => {
  const sql = fs.readFileSync(migrationPath, "utf8");

  assert.doesNotMatch(sql, /\bdrop\s+(table|column)\b/i);
  assert.doesNotMatch(sql, /\btruncate\b/i);
  assert.doesNotMatch(sql, /\bvacuum\b/i);
  assert.doesNotMatch(sql, /pg_repack/i);
  assert.doesNotMatch(sql, /\bdelete\s+from\s+source_(fetch|normalization)_artifacts\b/i);
  assert.doesNotMatch(sql, /create\s+trigger/i);
  assert.doesNotMatch(sql, /drop\s+trigger/i);

  assert.match(sql, /create table if not exists source_artifact_inline_restore_permits/);
  assert.match(sql, /primary key \(artifact_table, artifact_id\)/);
  assert.match(sql, /externalization_contract_version = 'worldcons-artifact-blob-v1'/);
  assert.match(sql, /alter table source_artifact_inline_restore_permits enable row level security/);

  assert.match(sql, /create or replace function case_backfill_artifact_externalization_guard_v1/);
  assert.match(sql, /security definer/);
  assert.match(sql, /set search_path = public, extensions, pg_temp/);
  assert.match(sql, /CASE_BACKFILL_IMMUTABLE/);

  assert.match(sql, /from source_artifact_externalization_permits p/);
  assert.match(sql, /from source_artifact_inline_clear_permits c/);
  assert.match(sql, /from source_artifact_inline_restore_permits r/);

  assert.match(sql, /if not \(v_old_inline_present and not v_new_inline_present\) then/);
  assert.match(sql, /if not v_old_inline_present and v_new_inline_present then/);
  assert.match(sql, /\(to_jsonb\(old\) - v_inline_column - v_generated_columns\)/);
  assert.match(sql, /from pg_attribute a/);
  assert.match(sql, /a\.attgenerated <> ''/);

  assert.match(sql, /delete from source_artifact_inline_restore_permits/);
  assert.match(sql, /from source_artifact_externalization_ledger l/);
  assert.match(sql, /l\.storage_ref = v_new_ref/);
  assert.match(sql, /l\.content_hash = v_new_hash/);
  assert.match(sql, /l\.content_size = v_new_size/);

  assert.equal((sql.match(/return new;/g) ?? []).length, 3);
});

test("the extended guard preserves the M4A attach and M4B clear transitions", () => {
  const sql = fs.readFileSync(migrationPath, "utf8");
  assert.match(sql, /v_old_ref is not null or v_old_version is not null or v_old_externalized_at is not null/);
  assert.match(sql, /v_new_ref is null or v_new_version is null or v_new_externalized_at is null/);
  assert.match(sql, /delete from source_artifact_externalization_permits/);
  assert.match(sql, /delete from source_artifact_inline_clear_permits/);

  const clearMigration = fs.readFileSync(inlineClearMigrationPath, "utf8");
  assert.match(clearMigration, /create table if not exists source_artifact_inline_clear_permits/);
  assert.match(clearMigration, /create or replace function source_backfill_artifact_inline_clear_v1/);
});

test("the restore RPC requires the parsed payload to equal the document and verifies the document byte length and SHA-256 database-side", () => {
  const sql = fs.readFileSync(migrationPath, "utf8");
  const rpcStart = sql.indexOf("create or replace function source_backfill_artifact_inline_restore_v1(");
  assert.ok(rpcStart >= 0, "restore RPC must be defined");
  const rpcEnd = sql.indexOf("$function$;", rpcStart);
  assert.ok(rpcEnd > rpcStart, "restore RPC body must terminate");
  const rpc = sql.slice(rpcStart, rpcEnd);

  // The exact signature: p_inline_payload jsonb is declared before p_document text.
  assert.match(rpc, /p_artifact_id uuid,\s*p_inline_payload jsonb,\s*p_document text,/);
  assert.match(rpc, /p_dry_run boolean default true/);
  assert.match(rpc, /security definer/);
  assert.match(rpc, /for update;/);
  assert.match(
    rpc,
    new RegExp(`p_externalization_contract_version is distinct from '${ARTIFACT_BLOB_CONTRACT_VERSION}'`),
  );
  assert.match(rpc, /CASE_BACKFILL_INLINE_RESTORE_CONTRACT_VERSION_INVALID/);
  assert.match(rpc, /CASE_BACKFILL_INLINE_RESTORE_ARTIFACT_NOT_FOUND/);
  assert.match(rpc, /CASE_BACKFILL_INLINE_RESTORE_NOT_EXTERNALIZED/);
  assert.match(rpc, /CASE_BACKFILL_INLINE_RESTORE_CONFLICT/);
  assert.match(rpc, /CASE_BACKFILL_INLINE_RESTORE_LEDGER_MISSING/);

  // The parsed payload is required to be a non-null object and must equal exactly
  // what the canonical document parses to.
  assert.match(rpc, /if p_inline_payload is null or jsonb_typeof\(p_inline_payload\) <> 'object' then/);
  assert.match(rpc, /CASE_BACKFILL_INLINE_RESTORE_PAYLOAD_REQUIRED/);
  assert.match(rpc, /if v_payload is distinct from p_inline_payload then/);
  assert.match(rpc, /CASE_BACKFILL_INLINE_RESTORE_PAYLOAD_MISMATCH/);

  // The byte length and SHA-256 are taken over the same UTF-8 bytes of the document.
  assert.match(rpc, /v_document_size := octet_length\(convert_to\(v_document, 'UTF8'\)\);/);
  assert.match(rpc, /encode\(extensions\.digest\(convert_to\(v_document, 'UTF8'\), 'sha256'\), 'hex'\)/);
  assert.match(rpc, /if v_document_size <> p_content_size or v_document_hash <> p_content_hash then/);
  assert.match(rpc, /CASE_BACKFILL_INLINE_RESTORE_CONTENT_MISMATCH/);
  assert.match(rpc, /CASE_BACKFILL_INLINE_RESTORE_DOCUMENT_INVALID/);
  assert.match(rpc, /jsonb_typeof\(v_payload\) <> 'object'/);

  assert.match(rpc, /if v_stored_payload is not distinct from p_inline_payload then/);
  assert.match(rpc, /update source_fetch_artifacts set bounded_replay_payload = p_inline_payload where id = p_artifact_id;/);
  assert.match(rpc, /update source_normalization_artifacts set normalized_output = p_inline_payload where id = p_artifact_id;/);
  assert.equal((rpc.match(/update source_fetch_artifacts/g) ?? []).length, 1);
  assert.equal((rpc.match(/update source_normalization_artifacts/g) ?? []).length, 1);
  assert.doesNotMatch(rpc, /bounded_replay_storage_ref\s*=/);
  assert.doesNotMatch(rpc, /normalized_output_storage_ref\s*=/);
  assert.doesNotMatch(rpc, /normalized_output_size\s*=/);
  assert.doesNotMatch(rpc, /externalized_at\s*=/);

  const versionGateIndex = rpc.search(/p_externalization_contract_version is distinct from/);
  assert.ok(versionGateIndex >= 0, "contract gate must exist");
  const dryRunIndex = rpc.indexOf("if v_dry_run then");
  assert.ok(dryRunIndex > versionGateIndex, "the dry-run branch follows the content gates");
  const permitIndex = rpc.indexOf("insert into source_artifact_inline_restore_permits");
  assert.ok(permitIndex > dryRunIndex, "the permit is minted only on the execute path");
  assert.ok(rpc.indexOf("update source_fetch_artifacts") > dryRunIndex);
  assert.ok(rpc.indexOf("update source_normalization_artifacts") > dryRunIndex);
});

test("the restore migration exposes only the RPC to service_role", () => {
  const sql = fs.readFileSync(migrationPath, "utf8");
  assert.match(sql, /revoke all on table source_artifact_inline_restore_permits from public;/);
  assert.match(sql, /revoke all on table source_artifact_inline_restore_permits from service_role;/);
  assert.match(sql, /revoke all on function case_backfill_artifact_externalization_guard_v1\(\) from service_role;/);
  assert.match(sql, /source_backfill_artifact_inline_restore_v1\(text, uuid, jsonb, text, text, text, bigint, text, text, boolean\)/);
  assert.match(sql, /revoke all on function source_backfill_artifact_inline_restore_v1\([\s\S]*?\) from public;/);
  assert.match(sql, /grant execute on function source_backfill_artifact_inline_restore_v1\([\s\S]*?\) to service_role;/);
  assert.doesNotMatch(sql, /grant\s+(insert|update|delete)/i);
  assert.doesNotMatch(sql, /grant\s+all/i);
  assert.doesNotMatch(sql, /to anon\b/i);
  assert.doesNotMatch(sql, /to authenticated\b/i);
});
