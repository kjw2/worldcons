import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { runCaseBackfillPass } from "../lib/backfill/service";
import type {
  CaseBackfillRepository,
  RecordFetchArtifactInput,
  RecordNormalizationArtifactInput,
} from "../lib/backfill/repository";
import type {
  CaseBackfillAttemptAuthority,
  CaseBackfillClaimedItem,
  CaseBackfillFetchArtifact,
  CaseBackfillNormalizationArtifact,
  CaseBackfillPassInput,
  CaseBackfillSnapshot,
} from "../lib/backfill/types";
import {
  CASE_BACKFILL_ARTIFACT_BLOB_READ_FLAG,
  CASE_BACKFILL_ARTIFACT_BLOB_WRITE_FLAG,
} from "../lib/backfill/flags";
import {
  ARTIFACT_BLOB_CONTRACT_VERSION,
  ArtifactBlobStore,
  buildArtifactStorageRef,
  sha256Hex,
  type ArtifactBlobGetResult,
  type ArtifactBlobHeadResult,
  type ArtifactBlobPutOptions,
  type ArtifactBlobTransport,
} from "../lib/storage/blob";
import type { SourceAdapter } from "../lib/sources/types";

const repositoryPath = path.join(process.cwd(), "lib/backfill/repository.ts");

const authority: CaseBackfillAttemptAuthority = {
  attemptId: "11111111-1111-4111-8111-111111111111",
  runId: "22222222-2222-4222-8222-222222222222",
  fencingToken: "17",
  leaseExpiresAt: "2026-09-03T12:00:00.000Z",
};

const snapshot: CaseBackfillSnapshot = {
  id: "33333333-3333-4333-8333-333333333333",
  sourceKey: "es-tribunal-constitucional",
  scopeFrom: "2024-01-01",
  scopeTo: "2024-12-31",
  documentType: "SENTENCIA",
  parserVersion: "spain-hj-normalize-v1",
  sourcePolicyVersion: "spain-hj-2026-09-v1",
  status: "closed",
};

const fetchArtifactId = "66666666-6666-4666-8666-666666666667";
const normalizationArtifactId = "77777777-7777-4777-8777-777777777778";

const claimedItem: CaseBackfillClaimedItem = {
  itemId: "44444444-4444-4444-8444-444444444444",
  stableItemKey: "hj:12345",
  sourceRecordId: "12345",
  discoveredUrl: "https://hj.tribunalconstitucional.es/HJ/es/Resolucion/Show/12345",
  authorityUrl: null,
  documentType: "SENTENCIA",
  decisionDateHint: "2024-05-08",
  inventoryMetadata: { inventoryRecord: "hj:12345" },
  resolutionStatus: "fetching",
  currentFetchArtifactId: null,
  currentNormalizationArtifactId: null,
  verifiedNormalizationArtifactId: null,
  publishedNormalizationArtifactId: null,
  itemLeaseExpiresAt: "2026-09-03T12:00:00.000Z",
};

const normalizeItem: CaseBackfillClaimedItem = {
  ...claimedItem,
  resolutionStatus: "fetched",
  currentFetchArtifactId: fetchArtifactId,
};

const verifyItem: CaseBackfillClaimedItem = {
  ...normalizeItem,
  resolutionStatus: "normalized",
  currentNormalizationArtifactId: normalizationArtifactId,
};

const readOnlyEnvironment = { [CASE_BACKFILL_ARTIFACT_BLOB_READ_FLAG]: "true" };
const enabledEnvironment = {
  [CASE_BACKFILL_ARTIFACT_BLOB_WRITE_FLAG]: "true",
  [CASE_BACKFILL_ARTIFACT_BLOB_READ_FLAG]: "true",
};

function streamOf(buffer: Buffer): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(buffer));
      controller.close();
    },
  });
}

class MemoryTransport implements ArtifactBlobTransport {
  readonly objects = new Map<string, Buffer>();
  readonly puts: { pathname: string; body: Buffer; options: ArtifactBlobPutOptions }[] = [];
  readonly gets: string[] = [];

  async put(pathname: string, body: Buffer, options: ArtifactBlobPutOptions) {
    this.puts.push({ pathname, body: Buffer.from(body), options });
    this.objects.set(pathname, Buffer.from(body));
    return { pathname };
  }

  async get(pathname: string): Promise<ArtifactBlobGetResult | null> {
    this.gets.push(pathname);
    const stored = this.objects.get(pathname);
    if (!stored) return null;
    return { statusCode: 200, stream: streamOf(stored), size: stored.byteLength };
  }

  async head(pathname: string): Promise<ArtifactBlobHeadResult> {
    const stored = this.objects.get(pathname);
    return stored ? { pathname, size: stored.byteLength } : { pathname: `${pathname}.missing`, size: 0 };
  }
}

function fetchReplayDocument() {
  return {
    sourceKey: snapshot.sourceKey,
    url: claimedItem.discoveredUrl,
    canonicalUrl: claimedItem.discoveredUrl,
    contentType: "decision",
    text: "official text",
  };
}

function normalizedDocument() {
  return {
    sourceKey: snapshot.sourceKey,
    jurisdiction: "Spain",
    institutionName: "Tribunal Constitucional de España",
    contentType: "decision",
    originalUrl: claimedItem.discoveredUrl,
    canonicalUrl: claimedItem.discoveredUrl,
    originalLanguage: "es",
    originalTitle: "SENTENCIA 53/2024",
    originalPublishedAt: "2024-05-08T00:00:00.000Z",
    metadata: { resolutionType: "SENTENCIA" },
  };
}

function seedBlob(transport: MemoryTransport, kind: "fetch" | "normalization", document: string | Buffer) {
  const bytes = Buffer.isBuffer(document) ? document : Buffer.from(document, "utf8");
  const hash = sha256Hex(bytes);
  const storageRef = buildArtifactStorageRef(kind, snapshot.sourceKey, hash);
  transport.objects.set(storageRef, bytes);
  return { storageRef, hash, size: bytes.byteLength };
}

function blobBackedFetchArtifact(
  seed: { storageRef: string; hash: string; size: number },
  overrides: Partial<CaseBackfillFetchArtifact> = {},
): CaseBackfillFetchArtifact {
  return {
    id: fetchArtifactId,
    itemId: claimedItem.itemId,
    sourcePolicyVersion: snapshot.sourcePolicyVersion,
    authorityUrl: claimedItem.discoveredUrl,
    payloadHash: seed.hash,
    payloadSize: seed.size,
    replayability: "bounded_evidence",
    immutableStorageRef: null,
    boundedReplayPayload: null,
    boundedReplayStorageRef: seed.storageRef,
    externalizationContractVersion: ARTIFACT_BLOB_CONTRACT_VERSION,
    fetchContractVersion: "spain-hj-fetch-v1",
    ...overrides,
  };
}

function blobBackedNormalizationArtifact(
  seed: { storageRef: string; hash: string; size: number },
  overrides: Partial<CaseBackfillNormalizationArtifact> = {},
): CaseBackfillNormalizationArtifact {
  return {
    id: normalizationArtifactId,
    itemId: claimedItem.itemId,
    fetchArtifactId,
    parserVersion: "spain-hj-normalize-v1",
    normalizationContractVersion: "case-normalized-v1",
    normalizedOutput: null,
    normalizedOutputHash: seed.hash,
    normalizedOutputStorageRef: seed.storageRef,
    normalizedOutputSize: seed.size,
    externalizationContractVersion: ARTIFACT_BLOB_CONTRACT_VERSION,
    validationStatus: "valid",
    ...overrides,
  };
}

function pass(phase: CaseBackfillPassInput["phase"]): CaseBackfillPassInput {
  return {
    cohort: "catalog-backfill",
    snapshotId: snapshot.id,
    phase,
    passNumber: 1,
    batchLimit: 50,
    parserVersion: "spain-hj-normalize-v1",
    normalizationContractVersion: "case-normalized-v1",
    fetchContractVersion: "spain-hj-fetch-v1",
  };
}

function claimOnce(items: CaseBackfillClaimedItem[]) {
  let served = false;
  return async () => {
    if (served) return [];
    served = true;
    return items;
  };
}

function fakeRepository(overrides: Partial<CaseBackfillRepository> = {}): CaseBackfillRepository {
  const unavailable = async () => { throw new Error("unused"); };
  return {
    openSnapshot: unavailable,
    upsertInventoryItem: unavailable,
    updateSnapshotEvidence: unavailable,
    closeSnapshot: unavailable,
    getSnapshot: async () => snapshot,
    getSourcePolicy: async () => ({
      sourceKey: snapshot.sourceKey,
      policyVersion: snapshot.sourcePolicyVersion,
      normalizeReplayPolicy: "bounded_evidence",
      boundedReplayFields: ["sourceKey", "url", "canonicalUrl", "title", "publishedAt", "contentType", "text", "metadata"],
      minRequestDelayMs: 1000,
      maxConcurrency: 1,
      reviewDueAt: "2027-09-03T00:00:00.000Z",
    }),
    getSnapshotStatus: unavailable,
    acquireSourceRequestPermit: unavailable,
    releaseSourceRequestPermit: unavailable,
    allocatePass: unavailable,
    beginRun: async () => "55555555-5555-4555-8555-555555555555",
    finishRun: async () => undefined,
    countBacklog: async () => 0,
    claimItems: claimOnce([]),
    extendItems: async (ids) => ids.length,
    recordFetchArtifact: unavailable,
    getFetchArtifact: unavailable,
    getNormalizationArtifact: unavailable,
    recordNormalizationArtifact: unavailable,
    publishItem: unavailable,
    completeItem: async () => undefined,
    excludeItem: async () => undefined,
    failItem: async () => undefined,
    ...overrides,
  } as CaseBackfillRepository;
}

function fetchAdapter(): SourceAdapter {
  return {
    sourceKey: snapshot.sourceKey,
    displayName: "Spain",
    jurisdiction: "Spain",
    baseUrl: "https://hj.tribunalconstitucional.es",
    defaultLanguage: "es",
    discover: async () => [],
    fetchItem: async () => ({
      sourceKey: snapshot.sourceKey,
      url: claimedItem.discoveredUrl,
      canonicalUrl: claimedItem.discoveredUrl,
      title: "SENTENCIA 53/2024",
      publishedAt: "2024-05-08T00:00:00.000Z",
      contentType: "decision",
      text: "official text",
      metadata: { resolutionType: "SENTENCIA" },
    }),
    normalize: async () => { throw new Error("unused"); },
  };
}

function normalizeAdapter(received: string[] = []): SourceAdapter {
  return {
    sourceKey: snapshot.sourceKey,
    displayName: "Spain",
    jurisdiction: "Spain",
    baseUrl: "https://hj.tribunalconstitucional.es",
    defaultLanguage: "es",
    discover: async () => [],
    fetchItem: async () => { throw new Error("unused"); },
    normalize: async (raw) => {
      received.push(raw.url);
      return {
        sourceKey: raw.sourceKey,
        jurisdiction: "Spain",
        institutionName: "Tribunal Constitucional de España",
        contentType: "decision",
        originalUrl: raw.url,
        canonicalUrl: raw.canonicalUrl,
        originalLanguage: "es",
        originalTitle: "SENTENCIA 53/2024",
        metadata: { adapterField: "kept" },
      };
    },
  };
}

async function runFetch(
  repository: CaseBackfillRepository,
  store: ArtifactBlobStore,
  environment: Record<string, string | undefined>,
) {
  return runCaseBackfillPass(pass("fetch"), {
    authority,
    checkpoint: async () => undefined,
    signal: new AbortController().signal,
  }, {
    repository,
    loadAdapter: async () => fetchAdapter(),
    now: () => new Date("2026-09-03T00:00:00.000Z"),
    spainHistorySourcePolicyApproved: true,
    environment,
    artifactBlobStore: store,
  });
}

async function runNormalize(
  repository: CaseBackfillRepository,
  store: ArtifactBlobStore,
  environment: Record<string, string | undefined>,
  received: string[] = [],
) {
  return runCaseBackfillPass(pass("normalize"), {
    authority,
    checkpoint: async () => undefined,
    signal: new AbortController().signal,
  }, {
    repository,
    loadAdapter: async () => normalizeAdapter(received),
    now: () => new Date("2026-09-03T00:00:00.000Z"),
    spainHistorySourcePolicyApproved: true,
    environment,
    artifactBlobStore: store,
  });
}

async function runVerify(
  repository: CaseBackfillRepository,
  store: ArtifactBlobStore,
  environment: Record<string, string | undefined>,
) {
  return runCaseBackfillPass(pass("verify"), {
    authority,
    checkpoint: async () => undefined,
    signal: new AbortController().signal,
  }, {
    repository,
    loadAdapter: async () => normalizeAdapter(),
    now: () => new Date("2026-09-03T00:00:00.000Z"),
    spainHistorySourcePolicyApproved: true,
    environment,
    artifactBlobStore: store,
  });
}

test("fetch stays inline when only the read flag is enabled", async () => {
  const transport = new MemoryTransport();
  const store = new ArtifactBlobStore(transport);
  let recorded: RecordFetchArtifactInput | null = null;
  const repository = fakeRepository({
    claimItems: claimOnce([claimedItem]),
    recordFetchArtifact: async (input) => { recorded = input; return "artifact-id"; },
  });

  const result = await runFetch(repository, store, readOnlyEnvironment);
  assert.equal(result.succeeded, 1);
  assert(recorded);
  assert.notEqual((recorded as RecordFetchArtifactInput).boundedReplayPayload, null);
  assert.equal((recorded as RecordFetchArtifactInput).boundedReplayStorageRef ?? null, null);
  assert.equal(transport.puts.length, 0);
  assert.equal(transport.gets.length, 0);
});

test("normalize reads a Blob-backed fetch artifact when the read flag is enabled", async () => {
  const transport = new MemoryTransport();
  const seed = seedBlob(transport, "fetch", JSON.stringify(fetchReplayDocument()));
  const artifact = blobBackedFetchArtifact(seed);
  const received: string[] = [];
  let recorded: RecordNormalizationArtifactInput | null = null;
  const repository = fakeRepository({
    claimItems: claimOnce([normalizeItem]),
    getFetchArtifact: async () => artifact,
    recordNormalizationArtifact: async (input) => { recorded = input; return normalizationArtifactId; },
  });

  const result = await runNormalize(repository, new ArtifactBlobStore(transport), readOnlyEnvironment, received);
  assert.equal(result.succeeded, 1);
  assert.deepEqual(received, [claimedItem.discoveredUrl]);
  assert.deepEqual(transport.gets, [seed.storageRef]);
  assert(recorded);
  assert.notEqual((recorded as RecordNormalizationArtifactInput).normalizedOutput, null);
  assert.equal(transport.puts.length, 0);
});

test("normalize prefers the inline fetch payload over a Blob ref", async () => {
  const transport = new MemoryTransport();
  const seed = seedBlob(transport, "fetch", JSON.stringify(fetchReplayDocument()));
  const inlineArtifact = blobBackedFetchArtifact(seed, {
    boundedReplayPayload: fetchReplayDocument(),
  });
  let recorded: RecordNormalizationArtifactInput | null = null;
  const repository = fakeRepository({
    claimItems: claimOnce([normalizeItem]),
    getFetchArtifact: async () => inlineArtifact,
    recordNormalizationArtifact: async (input) => { recorded = input; return normalizationArtifactId; },
  });

  const result = await runNormalize(repository, new ArtifactBlobStore(transport), enabledEnvironment);
  assert.equal(result.succeeded, 1);
  assert(recorded);
  assert.equal(transport.gets.length, 0);
});

test("normalize fails closed when a Blob-backed fetch artifact is read with the read flag off", async () => {
  const transport = new MemoryTransport();
  const seed = seedBlob(transport, "fetch", JSON.stringify(fetchReplayDocument()));
  const failures: { errorCode: string; disposition: string }[] = [];
  const repository = fakeRepository({
    claimItems: claimOnce([normalizeItem]),
    getFetchArtifact: async () => blobBackedFetchArtifact(seed),
    failItem: async (input) => { failures.push({ errorCode: input.errorCode, disposition: input.disposition }); },
  });

  const result = await runNormalize(repository, new ArtifactBlobStore(transport), {});
  assert.equal(result.succeeded, 0);
  assert.equal(result.terminalFailed, 1);
  assert.deepEqual(failures, [{ errorCode: "case_backfill.artifact_blob_read_disabled", disposition: "terminal" }]);
  assert.equal(transport.gets.length, 0);
});

test("normalize rejects a Blob-backed fetch artifact with a size mismatch", async () => {
  const transport = new MemoryTransport();
  const seed = seedBlob(transport, "fetch", JSON.stringify(fetchReplayDocument()));
  const failures: string[] = [];
  const repository = fakeRepository({
    claimItems: claimOnce([normalizeItem]),
    getFetchArtifact: async () => blobBackedFetchArtifact(seed, { payloadSize: seed.size + 1 }),
    failItem: async (input) => { failures.push(input.errorCode); },
  });

  const result = await runNormalize(repository, new ArtifactBlobStore(transport), enabledEnvironment);
  assert.equal(result.succeeded, 0);
  assert.equal(result.terminalFailed, 1);
  assert.deepEqual(failures, ["case_backfill.artifact_blob_integrity_mismatch"]);
});

test("normalize rejects a Blob-backed fetch artifact with a SHA-256 mismatch", async () => {
  const transport = new MemoryTransport();
  const seed = seedBlob(transport, "fetch", JSON.stringify(fetchReplayDocument()));
  const failures: string[] = [];
  const repository = fakeRepository({
    claimItems: claimOnce([normalizeItem]),
    getFetchArtifact: async () => blobBackedFetchArtifact(seed, { payloadHash: sha256Hex("tampered") }),
    failItem: async (input) => { failures.push(input.errorCode); },
  });

  const result = await runNormalize(repository, new ArtifactBlobStore(transport), enabledEnvironment);
  assert.equal(result.succeeded, 0);
  assert.equal(result.terminalFailed, 1);
  assert.deepEqual(failures, ["case_backfill.artifact_blob_integrity_mismatch"]);
});

test("normalize rejects malformed Blob JSON", async () => {
  const transport = new MemoryTransport();
  const seed = seedBlob(transport, "fetch", Buffer.from("not-json{"));
  const failures: string[] = [];
  const repository = fakeRepository({
    claimItems: claimOnce([normalizeItem]),
    getFetchArtifact: async () => blobBackedFetchArtifact(seed),
    failItem: async (input) => { failures.push(input.errorCode); },
  });

  const result = await runNormalize(repository, new ArtifactBlobStore(transport), enabledEnvironment);
  assert.equal(result.succeeded, 0);
  assert.equal(result.terminalFailed, 1);
  assert.deepEqual(failures, ["case_backfill.artifact_blob_invalid_document"]);
});

test("normalize rejects an unsupported externalization contract version", async () => {
  const transport = new MemoryTransport();
  const seed = seedBlob(transport, "fetch", JSON.stringify(fetchReplayDocument()));
  const failures: string[] = [];
  const repository = fakeRepository({
    claimItems: claimOnce([normalizeItem]),
    getFetchArtifact: async () => blobBackedFetchArtifact(seed, {
      externalizationContractVersion: "worldcons-artifact-blob-v2",
    }),
    failItem: async (input) => { failures.push(input.errorCode); },
  });

  const result = await runNormalize(repository, new ArtifactBlobStore(transport), enabledEnvironment);
  assert.equal(result.succeeded, 0);
  assert.equal(result.terminalFailed, 1);
  assert.deepEqual(failures, ["case_backfill.artifact_blob_contract_unsupported"]);
});

test("verify reads a Blob-backed normalization artifact when the read flag is enabled", async () => {
  const transport = new MemoryTransport();
  const seed = seedBlob(transport, "normalization", JSON.stringify(normalizedDocument()));
  const artifact = blobBackedNormalizationArtifact(seed);
  let completed: { artifactId: unknown } | null = null;
  const repository = fakeRepository({
    claimItems: claimOnce([verifyItem]),
    getNormalizationArtifact: async () => artifact,
    completeItem: async (input) => { completed = { artifactId: input.resultMetadata.artifactId }; },
  });

  const result = await runVerify(repository, new ArtifactBlobStore(transport), readOnlyEnvironment);
  assert.equal(result.succeeded, 1);
  assert.deepEqual(transport.gets, [seed.storageRef]);
  assert.deepEqual(completed, { artifactId: normalizationArtifactId });
});

test("verify prefers an inline normalization artifact over a Blob ref", async () => {
  const transport = new MemoryTransport();
  const seed = seedBlob(transport, "normalization", JSON.stringify(normalizedDocument()));
  const inlineArtifact = blobBackedNormalizationArtifact(seed, {
    normalizedOutput: normalizedDocument() as unknown as CaseBackfillNormalizationArtifact["normalizedOutput"],
  });
  const repository = fakeRepository({
    claimItems: claimOnce([verifyItem]),
    getNormalizationArtifact: async () => inlineArtifact,
  });

  const result = await runVerify(repository, new ArtifactBlobStore(transport), enabledEnvironment);
  assert.equal(result.succeeded, 1);
  assert.equal(transport.gets.length, 0);
});

test("repository supports Blob-backed reads without weakening inline rows", () => {
  const source = fs.readFileSync(repositoryPath, "utf8");
  assert.match(source, /payload_size/);
  assert.match(source, /payloadSize: nullableNumber\(data, "payload_size"\)/);
  assert.match(source, /const normalizedOutput = recordValue\(data, "normalized_output"\)/);
  assert.match(source, /const normalizedOutputStorageRef = nullableText\(data, "normalized_output_storage_ref"\)/);
  assert.match(source, /!normalizedOutput && !normalizedOutputStorageRef/);
});
