import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { canonicalJson } from "../lib/backfill/canonical-json";
import {
  planArtifactInlineClear,
  runArtifactInlineClearBatch,
  type CaseBackfillInlineClearDependencies,
} from "../lib/backfill/inline-clear";
import type { CaseBackfillRepository } from "../lib/backfill/repository";
import type {
  CaseBackfillInlineClearCandidate,
  ClearArtifactInlineInput,
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
import { CASE_BACKFILL_ARTIFACT_BLOB_READ_FLAG } from "../lib/backfill/flags";

const repositoryPath = path.join(process.cwd(), "lib/backfill/repository.ts");
const inlineClearPath = path.join(process.cwd(), "lib/backfill/inline-clear.ts");
const scriptPath = path.join(process.cwd(), "scripts/clear-inline-artifacts.ts");
const migrationRoot = path.join(process.cwd(), "supabase/migrations");
const migrationPath = path.join(migrationRoot, "20260919110000_artifact_blob_inline_clear.sql");
const externalizeMigrationPath = path.join(migrationRoot, "20260919100000_artifact_blob_externalization_backfill.sql");

const SOURCE_KEY = "es-tribunal-constitucional";
const FETCH_ARTIFACT_ID = "66666666-6666-4666-8666-666666666667";
const NORMALIZATION_ARTIFACT_ID = "77777777-7777-4777-8777-777777777778";

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
  readonly gets: string[] = [];
  readonly heads: string[] = [];
  headSizeAdjust = 0;
  headMissing = false;
  getBytesOverride: ((pathname: string) => Buffer | null) | null = null;

  async put(pathname: string, body: Buffer, _options: ArtifactBlobPutOptions) {
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
    if (this.headMissing) return { pathname: `${pathname}.missing`, size: 0 };
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

function fetchCandidate(overrides: Partial<CaseBackfillInlineClearCandidate> = {}): CaseBackfillInlineClearCandidate {
  const document = canonicalJson(fetchDocument());
  const hash = sha256Hex(document);
  return {
    artifactTable: "source_fetch_artifacts",
    artifactId: FETCH_ARTIFACT_ID,
    itemId: "44444444-4444-4444-8444-444444444444",
    sourceKey: SOURCE_KEY,
    kind: "fetch",
    storageRef: buildArtifactStorageRef("fetch", SOURCE_KEY, hash),
    storedHash: hash,
    storedSize: Buffer.byteLength(document, "utf8"),
    externalizationContractVersion: ARTIFACT_BLOB_CONTRACT_VERSION,
    ...overrides,
  };
}

function normalizationCandidate(overrides: Partial<CaseBackfillInlineClearCandidate> = {}): CaseBackfillInlineClearCandidate {
  const document = canonicalJson(normalizedDocument());
  const hash = sha256Hex(document);
  return {
    artifactTable: "source_normalization_artifacts",
    artifactId: NORMALIZATION_ARTIFACT_ID,
    itemId: "44444444-4444-4444-8444-444444444444",
    sourceKey: SOURCE_KEY,
    kind: "normalization",
    storageRef: buildArtifactStorageRef("normalization", SOURCE_KEY, hash),
    storedHash: hash,
    storedSize: Buffer.byteLength(document, "utf8"),
    externalizationContractVersion: ARTIFACT_BLOB_CONTRACT_VERSION,
    ...overrides,
  };
}

function seed(transport: FakeTransport, candidate: CaseBackfillInlineClearCandidate) {
  transport.objects.set(candidate.storageRef, Buffer.from(canonicalJson(candidate.kind === "fetch" ? fetchDocument() : normalizedDocument()), "utf8"));
}

function fakeRepository(
  candidates: CaseBackfillInlineClearCandidate[],
  overrides: {
    clear?: (input: ClearArtifactInlineInput) => Promise<{ artifactId: string; idempotent: boolean }>;
  } = {},
) {
  const clearCalls: ClearArtifactInlineInput[] = [];
  const listCalls: { kind: string; sourceKey: string | null; limit: number; afterArtifactId: string | null }[] = [];
  const repository: Pick<
    CaseBackfillRepository,
    "listArtifactInlineClearCandidates" | "clearArtifactInline"
  > = {
    listArtifactInlineClearCandidates: async (input) => {
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
    clearArtifactInline: async (input) => {
      clearCalls.push(input);
      if (overrides.clear) return overrides.clear(input);
      return { artifactId: input.artifactId, idempotent: false };
    },
  };
  return { repository, clearCalls, listCalls };
}

function dependencies(
  repository: ReturnType<typeof fakeRepository>["repository"],
  transport = new FakeTransport(),
  environment: Record<string, string | undefined> = enabledEnvironment,
): CaseBackfillInlineClearDependencies & { transport: FakeTransport } {
  return { repository, store: new ArtifactBlobStore(transport), transport, environment };
}

test("plan revalidates the contract, content-addressed ref, and recorded size", () => {
  const candidate = fetchCandidate();
  const plan = planArtifactInlineClear(candidate);
  assert.equal(plan.storageRef, candidate.storageRef);
  assert.equal(plan.contentHash, candidate.storedHash);
  assert.equal(plan.contentSize, candidate.storedSize);
});

test("plan refuses an unsupported externalization contract", () => {
  assert.throws(
    () => planArtifactInlineClear(fetchCandidate({ externalizationContractVersion: "worldcons-artifact-blob-v2" })),
    /artifact_inline_clear\.contract_unsupported/,
  );
});

test("plan refuses a storage ref that is not content addressed to this artifact", () => {
  const candidate = fetchCandidate();
  assert.throws(
    () => planArtifactInlineClear({ ...candidate, storageRef: buildArtifactStorageRef("fetch", SOURCE_KEY, sha256Hex("other")) }),
    /artifact_inline_clear\.storage_ref_mismatch/,
  );
});

test("plan refuses a candidate without a recorded size", () => {
  const candidate = fetchCandidate();
  assert.throws(
    () => planArtifactInlineClear({ ...candidate, storedSize: Number.NaN }),
    /artifact_inline_clear\.size_missing/,
  );
});

test("dry run plans inline clears without reading Blob storage or mutating", async () => {
  const candidate = fetchCandidate();
  const { repository, clearCalls } = fakeRepository([candidate]);
  const deps = dependencies(repository);
  const result = await runArtifactInlineClearBatch(
    { kind: "fetch", batchSize: 10, actorId: "operator", execute: false },
    deps,
  );
  assert.equal(result.scanned, 1);
  assert.equal(result.cleared, 0);
  assert.equal(result.failed.length, 0);
  assert.equal(result.outcomes[0].status, "planned");
  assert.equal(deps.transport.heads.length, 0);
  assert.equal(deps.transport.gets.length, 0);
  assert.equal(clearCalls.length, 0);
});

test("execute requires the Blob read flag ready and fails closed before listing or mutating", async () => {
  const candidate = fetchCandidate();
  const { repository, clearCalls, listCalls } = fakeRepository([candidate]);
  const deps = dependencies(repository, new FakeTransport(), {});
  await assert.rejects(
    () => runArtifactInlineClearBatch(
      { kind: "fetch", batchSize: 10, actorId: "operator", execute: true },
      deps,
    ),
    /artifact_inline_clear\.read_disabled/,
  );
  assert.equal(listCalls.length, 0);
  assert.equal(deps.transport.heads.length, 0);
  assert.equal(deps.transport.gets.length, 0);
  assert.equal(clearCalls.length, 0);
});

test("execute heads then gets, verifies size and SHA-256, and only then clears", async () => {
  const candidate = fetchCandidate();
  const { repository, clearCalls } = fakeRepository([candidate]);
  const deps = dependencies(repository);
  seed(deps.transport, candidate);
  const result = await runArtifactInlineClearBatch(
    { kind: "fetch", batchSize: 10, actorId: "operator", execute: true },
    deps,
  );
  assert.equal(result.cleared, 1);
  assert.equal(result.failed.length, 0);
  assert.equal(result.outcomes[0].status, "cleared");
  assert.deepEqual(deps.transport.heads, [candidate.storageRef]);
  assert.deepEqual(deps.transport.gets, [candidate.storageRef]);
  assert.deepEqual(clearCalls, [{
    artifactTable: "source_fetch_artifacts",
    artifactId: candidate.artifactId,
    expectedStorageRef: candidate.storageRef,
    expectedContentHash: candidate.storedHash,
    expectedContentSize: candidate.storedSize,
    externalizationContractVersion: ARTIFACT_BLOB_CONTRACT_VERSION,
    actorId: "operator",
  }]);
  const clearInput = clearCalls[0] as unknown as Record<string, unknown>;
  assert.equal("boundedReplayPayload" in clearInput, false);
  assert.equal("inlinePayload" in clearInput, false);
  assert.equal("normalizedOutput" in clearInput, false);
});

test("normalization clears with the normalization ref and size", async () => {
  const candidate = normalizationCandidate();
  const { repository, clearCalls } = fakeRepository([candidate]);
  const deps = dependencies(repository);
  seed(deps.transport, candidate);
  const result = await runArtifactInlineClearBatch(
    { kind: "normalization", batchSize: 10, actorId: "operator", execute: true },
    deps,
  );
  assert.equal(result.cleared, 1);
  assert.equal(clearCalls[0].artifactTable, "source_normalization_artifacts");
  assert.match(clearCalls[0].expectedStorageRef, /^artifacts\/normalization\//);
  assert.equal(clearCalls[0].expectedContentSize, candidate.storedSize);
});

test("a head size mismatch fails closed before get and before the clear RPC", async () => {
  const candidate = fetchCandidate();
  const { repository, clearCalls } = fakeRepository([candidate]);
  const deps = dependencies(repository);
  seed(deps.transport, candidate);
  deps.transport.headSizeAdjust = 1;
  const result = await runArtifactInlineClearBatch(
    { kind: "fetch", batchSize: 10, actorId: "operator", execute: true },
    deps,
  );
  assert.equal(result.cleared, 0);
  assert.deepEqual(result.failed, [{ artifactId: candidate.artifactId, errorCode: "artifact_inline_clear.head_verification_failed" }]);
  assert.equal(deps.transport.gets.length, 0);
  assert.equal(clearCalls.length, 0);
});

test("a missing Blob object fails closed before the clear RPC", async () => {
  const candidate = fetchCandidate();
  const { repository, clearCalls } = fakeRepository([candidate]);
  const deps = dependencies(repository);
  const result = await runArtifactInlineClearBatch(
    { kind: "fetch", batchSize: 10, actorId: "operator", execute: true },
    deps,
  );
  assert.equal(result.cleared, 0);
  assert.equal(result.failed[0].errorCode, "artifact_blob.not_found");
  assert.equal(clearCalls.length, 0);
});

test("tampered stored bytes fail closed before the clear RPC", async () => {
  const candidate = fetchCandidate();
  const { repository, clearCalls } = fakeRepository([candidate]);
  const deps = dependencies(repository);
  seed(deps.transport, candidate);
  const original = deps.transport.getBytesOverride;
  deps.transport.getBytesOverride = (pathname) => (pathname === candidate.storageRef ? Buffer.from("tampered") : original?.(pathname) ?? null);
  const result = await runArtifactInlineClearBatch(
    { kind: "fetch", batchSize: 10, actorId: "operator", execute: true },
    deps,
  );
  assert.equal(result.cleared, 0);
  assert.equal(result.failed[0].errorCode, "artifact_inline_clear.get_verification_failed");
  assert.equal(clearCalls.length, 0);
});

test("malformed Blob JSON fails closed before the clear RPC", async () => {
  const candidate = fetchCandidate();
  const bytes = Buffer.from("not-json{", "utf8");
  const hash = sha256Hex(bytes);
  const listCandidate = { ...candidate, storageRef: buildArtifactStorageRef("fetch", SOURCE_KEY, hash), storedHash: hash, storedSize: bytes.byteLength };
  const { repository, clearCalls } = fakeRepository([listCandidate]);
  const deps = dependencies(repository);
  deps.transport.objects.set(listCandidate.storageRef, bytes);
  const result = await runArtifactInlineClearBatch(
    { kind: "fetch", batchSize: 10, actorId: "operator", execute: true },
    deps,
  );
  assert.equal(result.cleared, 0);
  assert.equal(result.failed[0].errorCode, "artifact_inline_clear.invalid_document");
  assert.equal(clearCalls.length, 0);
});

test("non-object Blob JSON fails closed before the clear RPC", async () => {
  const candidate = fetchCandidate();
  const bytes = Buffer.from("[1,2,3]", "utf8");
  const hash = sha256Hex(bytes);
  const listCandidate = { ...candidate, storageRef: buildArtifactStorageRef("fetch", SOURCE_KEY, hash), storedHash: hash, storedSize: bytes.byteLength };
  const { repository, clearCalls } = fakeRepository([listCandidate]);
  const deps = dependencies(repository);
  deps.transport.objects.set(listCandidate.storageRef, bytes);
  const result = await runArtifactInlineClearBatch(
    { kind: "fetch", batchSize: 10, actorId: "operator", execute: true },
    deps,
  );
  assert.equal(result.cleared, 0);
  assert.equal(result.failed[0].errorCode, "artifact_inline_clear.invalid_document");
  assert.equal(clearCalls.length, 0);
});

test("an identical rerun is reported as idempotent", async () => {
  const candidate = fetchCandidate();
  const { repository, clearCalls } = fakeRepository([candidate], {
    clear: async (input) => ({ artifactId: input.artifactId, idempotent: true }),
  });
  const deps = dependencies(repository);
  seed(deps.transport, candidate);
  const result = await runArtifactInlineClearBatch(
    { kind: "fetch", batchSize: 10, actorId: "operator", execute: true },
    deps,
  );
  assert.equal(result.idempotent, 1);
  assert.equal(result.cleared, 0);
  assert.equal(result.outcomes[0].status, "idempotent");
  assert.equal(clearCalls.length, 1);
});

test("batches stay bounded and advance with a keyset cursor", async () => {
  const candidates = Array.from({ length: 3 }, (_, index) => fetchCandidate({
    artifactId: `0000000${index}-0000-4000-8000-00000000000${index}`,
  }));
  const { repository, listCalls } = fakeRepository(candidates);
  const deps = dependencies(repository);
  const first = await runArtifactInlineClearBatch(
    { kind: "fetch", batchSize: 2, actorId: "operator", execute: false },
    deps,
  );
  assert.equal(first.scanned, 2);
  assert.equal(first.lastArtifactId, candidates[1].artifactId);
  const second = await runArtifactInlineClearBatch(
    { kind: "fetch", batchSize: 2, actorId: "operator", execute: false, afterArtifactId: first.lastArtifactId },
    deps,
  );
  assert.equal(second.scanned, 1);
  assert.equal(second.lastArtifactId, candidates[2].artifactId);
  assert.deepEqual(listCalls.map((call) => call.limit), [2, 2]);
  assert.equal(listCalls[1].afterArtifactId, candidates[1].artifactId);
});

test("inline-clear lib verifies head and get before calling the repository", () => {
  const source = fs.readFileSync(inlineClearPath, "utf8");
  const headIndex = source.indexOf("await dependencies.store.head(");
  const getIndex = source.indexOf("await dependencies.store.get(");
  const clearIndex = source.indexOf("await dependencies.repository.clearArtifactInline(");
  assert.ok(headIndex >= 0 && getIndex > headIndex && clearIndex > getIndex);
  const dryRunIndex = source.indexOf("if (!input.execute)");
  const executeIndex = source.indexOf("await clearArtifactInlinePlan(");
  assert.ok(dryRunIndex >= 0 && executeIndex > dryRunIndex);
  assert.doesNotMatch(source, /store\.delete\(/);
  assert.doesNotMatch(source, /inlinePayload/);
});

test("repository selects externalized inline candidates and routes to the clear RPC", () => {
  const source = fs.readFileSync(repositoryPath, "utf8");
  assert.match(source, /source_backfill_artifact_inline_clear_v1/);
  assert.match(source, /listArtifactInlineClearCandidates/);
  assert.match(source, /clearArtifactInline/);
  assert.match(source, /\.not\("bounded_replay_storage_ref", "is", null\)/);
  assert.match(source, /\.not\("bounded_replay_payload", "is", null\)/);
  assert.match(source, /\.not\("normalized_output_storage_ref", "is", null\)/);
  assert.match(source, /\.not\("normalized_output", "is", null\)/);
  assert.match(source, /\.eq\("externalization_contract_version", ARTIFACT_BLOB_CONTRACT_VERSION\)/);
  assert.match(source, /\.order\("id", \{ ascending: true \}\)/);
  assert.match(source, /\.gt\("id", input\.afterArtifactId\)/);
  assert.match(source, /\.eq\("source_backfill_items\.source_inventory_snapshots\.source_key", input\.sourceKey\)/);
});

test("script defaults to dry run and requires execute plus an irreversible acknowledgement", () => {
  const source = fs.readFileSync(scriptPath, "utf8");
  assert.match(source, /const execute = flag\("execute"\)/);
  assert.match(source, /const acknowledgedIrreversible = flag\("acknowledge-irreversible"\)/);
  assert.match(source, /execute_requires_acknowledge_irreversible/);
  assert.match(source, /artifact_blob_read_not_ready/);
  assert.match(source, /caseBackfillArtifactBlobReadReady\(process\.env\)/);
  assert.match(source, /const KINDS: readonly CaseBackfillArtifactExternalizationKind\[\] = \["fetch", "normalization"\]/);
  assert.match(source, /integerArgument\("batch-size", 25, 1, 100\)/);
  assert.match(source, /integerArgument\("max-batches", 20, 1, 1000\)/);
  assert.match(source, /optionalSourceKey\(\)/);
  assert.match(source, /createArtifactBlobStore\(\)/);
  assert.match(source, /runArtifactInlineClearBatch\(/);
  assert.doesNotMatch(source, /store\.put\(/);
  assert.doesNotMatch(source, /store\.delete\(/);
});

test("migration is additive, extends the guard narrowly, and leaves no generic bypass", () => {
  const sql = fs.readFileSync(migrationPath, "utf8");

  assert.doesNotMatch(sql, /\bdrop\s+(table|column)\b/i);
  assert.doesNotMatch(sql, /\btruncate\b/i);
  assert.doesNotMatch(sql, /\bvacuum\b/i);
  assert.doesNotMatch(sql, /pg_repack/i);
  assert.doesNotMatch(sql, /\bdelete\s+from\s+source_(fetch|normalization)_artifacts\b/i);

  // A second one-time, operation-specific permit, invisible to every API role.
  assert.match(sql, /create table if not exists source_artifact_inline_clear_permits/);
  assert.match(sql, /primary key \(artifact_table, artifact_id\)/);
  assert.match(sql, /externalization_contract_version = 'worldcons-artifact-blob-v1'/);
  assert.match(sql, /alter table source_artifact_inline_clear_permits enable row level security/);

  // The guard is extended in place and still supports the M4A attach transition.
  assert.match(sql, /create or replace function case_backfill_artifact_externalization_guard_v1/);
  assert.match(sql, /security definer/);
  assert.match(sql, /set search_path = public, extensions, pg_temp/);
  assert.match(sql, /CASE_BACKFILL_IMMUTABLE/);
  assert.match(sql, /from source_artifact_externalization_permits p/);
  assert.match(sql, /delete from source_artifact_externalization_permits/);

  // The only newly permitted inline transition is present -> null with every other
  // column byte-identical.
  assert.match(sql, /v_old_inline_present and not v_new_inline_present/);
  assert.match(sql, /\(to_jsonb\(old\) - v_inline_column\) is distinct from \(to_jsonb\(new\) - v_inline_column\)/);
  assert.match(sql, /from source_artifact_inline_clear_permits c/);
  assert.match(sql, /delete from source_artifact_inline_clear_permits/);
  assert.match(sql, /from source_artifact_externalization_ledger l/);
  assert.match(sql, /l\.storage_ref = v_new_ref/);
  assert.match(sql, /l\.content_hash = v_new_hash/);
  assert.match(sql, /l\.content_size = v_new_size/);

  // The clear RPC is service_role-only.
  assert.match(sql, /create or replace function source_backfill_artifact_inline_clear_v1/);
  assert.match(sql, /revoke all on table source_artifact_inline_clear_permits from service_role/);
  assert.match(sql, /grant execute on function source_backfill_artifact_inline_clear_v1/);
  assert.doesNotMatch(sql, /grant\s+(insert|update|delete)/i);
  assert.doesNotMatch(sql, /grant\s+all/i);
});

test("clear RPC clears only the inline column after all externalization gates pass", () => {
  const sql = fs.readFileSync(migrationPath, "utf8");
  const rpcStart = sql.indexOf("create or replace function source_backfill_artifact_inline_clear_v1(");
  assert.ok(rpcStart >= 0, "clear RPC must be defined");
  const rpcEnd = sql.indexOf("$function$;", rpcStart);
  assert.ok(rpcEnd > rpcStart, "clear RPC body must terminate");
  const rpc = sql.slice(rpcStart, rpcEnd);

  assert.match(rpc, /for update;/);
  assert.match(rpc, new RegExp(`p_externalization_contract_version is distinct from '${ARTIFACT_BLOB_CONTRACT_VERSION}'`));
  assert.match(rpc, /CASE_BACKFILL_INLINE_CLEAR_CONTRACT_VERSION_INVALID/);
  assert.match(rpc, /CASE_BACKFILL_INLINE_CLEAR_ARTIFACT_NOT_FOUND/);
  assert.match(rpc, /CASE_BACKFILL_INLINE_CLEAR_NOT_EXTERNALIZED/);
  assert.match(rpc, /CASE_BACKFILL_INLINE_CLEAR_CONFLICT/);
  assert.match(rpc, /CASE_BACKFILL_INLINE_CLEAR_LEDGER_MISSING/);
  assert.match(rpc, /from source_artifact_externalization_ledger l/);
  assert.match(rpc, /v_stored_ref is null or v_stored_version is null or v_stored_externalized_at is null/);

  // Only the inline content is cleared; no externalization metadata is repointed.
  assert.match(rpc, /update source_fetch_artifacts set bounded_replay_payload = null where id = p_artifact_id;/);
  assert.match(rpc, /update source_normalization_artifacts set normalized_output = null where id = p_artifact_id;/);
  assert.equal((rpc.match(/update source_fetch_artifacts/g) ?? []).length, 1);
  assert.equal((rpc.match(/update source_normalization_artifacts/g) ?? []).length, 1);
  assert.doesNotMatch(rpc, /bounded_replay_storage_ref\s*=/);
  assert.doesNotMatch(rpc, /normalized_output_storage_ref\s*=/);
  assert.doesNotMatch(rpc, /normalized_output_size\s*=/);
  assert.doesNotMatch(rpc, /externalized_at\s*=/);

  // The contract gate must run before the permit write and before either update.
  const versionGateIndex = rpc.search(/p_externalization_contract_version is distinct from/);
  assert.ok(versionGateIndex >= 0, "contract gate must exist");
  assert.ok(rpc.indexOf("insert into source_artifact_inline_clear_permits") > versionGateIndex);
  assert.ok(rpc.indexOf("update source_fetch_artifacts") > versionGateIndex);
  assert.ok(rpc.indexOf("update source_normalization_artifacts") > versionGateIndex);
});

test("migration preserves the M4A externalization backfill contract", () => {
  const m4a = fs.readFileSync(externalizeMigrationPath, "utf8");
  assert.match(m4a, /create or replace function source_backfill_artifact_externalize_v1/);
  assert.match(m4a, /insert into source_artifact_externalization_ledger/);
});
