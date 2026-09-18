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
  sha256Hex,
  type ArtifactBlobGetOptions,
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

const enabledEnvironment = {
  [CASE_BACKFILL_ARTIFACT_BLOB_WRITE_FLAG]: "true",
  [CASE_BACKFILL_ARTIFACT_BLOB_READ_FLAG]: "true",
};

class RecordingTransport implements ArtifactBlobTransport {
  readonly puts: { pathname: string; body: Buffer; options: ArtifactBlobPutOptions }[] = [];

  async put(pathname: string, body: Buffer, options: ArtifactBlobPutOptions) {
    this.puts.push({ pathname, body: Buffer.from(body), options });
    return { pathname };
  }

  async get(_pathname: string, _options: ArtifactBlobGetOptions): Promise<ArtifactBlobGetResult | null> {
    return null;
  }

  async head(pathname: string): Promise<ArtifactBlobHeadResult> {
    return { pathname, size: 0 };
  }
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

function fakeRepository(overrides: Partial<CaseBackfillRepository> = {}): CaseBackfillRepository {
  const unavailable = async () => { throw new Error("unused"); };
  let itemClaimed = false;
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
    claimItems: async () => {
      if (itemClaimed) return [];
      itemClaimed = true;
      return [claimedItem];
    },
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

function normalizeAdapter(): SourceAdapter {
  return {
    sourceKey: snapshot.sourceKey,
    displayName: "Spain",
    jurisdiction: "Spain",
    baseUrl: "https://hj.tribunalconstitucional.es",
    defaultLanguage: "es",
    discover: async () => [],
    fetchItem: async () => { throw new Error("unused"); },
    normalize: async (raw) => ({
      sourceKey: raw.sourceKey,
      jurisdiction: "Spain",
      institutionName: "Tribunal Constitucional de España",
      contentType: "decision",
      originalUrl: raw.url,
      canonicalUrl: raw.canonicalUrl,
      originalLanguage: "es",
      originalTitle: "SENTENCIA 53/2024",
      metadata: { adapterField: "kept" },
    }),
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
) {
  return runCaseBackfillPass(pass("normalize"), {
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

test("fetch keeps the inline bounded replay payload when the write flag is off", async () => {
  const transport = new RecordingTransport();
  const store = new ArtifactBlobStore(transport);
  let recorded: RecordFetchArtifactInput | null = null;
  const repository = fakeRepository({
    recordFetchArtifact: async (input) => { recorded = input; return "artifact-id"; },
  });

  const result = await runFetch(repository, store, {});
  assert.equal(result.succeeded, 1);
  assert(recorded);
  const input = recorded as RecordFetchArtifactInput;
  assert.notEqual(input.boundedReplayPayload, null);
  assert.equal(input.boundedReplayStorageRef ?? null, null);
  assert.equal(input.externalizationContractVersion ?? null, null);
  assert.equal(transport.puts.length, 0);
});

test("fetch externalizes the bounded replay payload to a private content-addressed blob", async () => {
  const transport = new RecordingTransport();
  const store = new ArtifactBlobStore(transport);
  let recorded: RecordFetchArtifactInput | null = null;
  const repository = fakeRepository({
    recordFetchArtifact: async (input) => { recorded = input; return "artifact-id"; },
  });

  const result = await runFetch(repository, store, enabledEnvironment);
  assert.equal(result.succeeded, 1);
  assert(recorded);
  const input = recorded as RecordFetchArtifactInput;
  assert.equal(input.boundedReplayPayload, null);
  assert.equal(
    input.boundedReplayStorageRef,
    `artifacts/fetch/${snapshot.sourceKey}/${input.payloadHash}.json`,
  );
  assert.match(input.boundedReplayStorageRef as string, /^artifacts\/fetch\/es-tribunal-constitucional\/[0-9a-f]{64}\.json$/);
  assert.equal(input.externalizationContractVersion, ARTIFACT_BLOB_CONTRACT_VERSION);

  assert.equal(transport.puts.length, 1);
  assert.equal(transport.puts[0].options.access, "private");
  assert.equal(transport.puts[0].options.addRandomSuffix, false);
  assert.equal(transport.puts[0].options.allowOverwrite, true);
  assert.equal(sha256Hex(transport.puts[0].body), input.payloadHash);
  assert.equal(input.payloadSize, transport.puts[0].body.byteLength);
  assert.doesNotMatch(transport.puts[0].pathname, /https?:|blob\.vercel-storage\.com/);
});

test("fetch stays inline when write is enabled without the read gate", async () => {
  const transport = new RecordingTransport();
  const store = new ArtifactBlobStore(transport);
  let recorded: RecordFetchArtifactInput | null = null;
  const repository = fakeRepository({
    recordFetchArtifact: async (input) => { recorded = input; return "artifact-id"; },
  });

  const result = await runFetch(repository, store, { [CASE_BACKFILL_ARTIFACT_BLOB_WRITE_FLAG]: "true" });
  assert.equal(result.succeeded, 1);
  assert(recorded);
  assert.notEqual((recorded as RecordFetchArtifactInput).boundedReplayPayload, null);
  assert.equal(transport.puts.length, 0);
});

test("normalize keeps the inline normalized output when the write flag is off", async () => {
  const transport = new RecordingTransport();
  const store = new ArtifactBlobStore(transport);
  const item = { ...claimedItem, resolutionStatus: "fetched", currentFetchArtifactId: "66666666-6666-4666-8666-666666666667" };
  let recorded: RecordNormalizationArtifactInput | null = null;
  let served = false;
  const repository = fakeRepository({
    claimItems: async () => {
      if (served) return [];
      served = true;
      return [item];
    },
    getFetchArtifact: async () => ({
      id: item.currentFetchArtifactId as string,
      itemId: item.itemId,
      sourcePolicyVersion: snapshot.sourcePolicyVersion,
      authorityUrl: item.discoveredUrl,
      payloadHash: "a".repeat(64),
      replayability: "bounded_evidence",
      immutableStorageRef: null,
      boundedReplayPayload: {
        sourceKey: snapshot.sourceKey,
        url: item.discoveredUrl,
        canonicalUrl: item.discoveredUrl,
        contentType: "decision",
        text: "official text",
      },
      fetchContractVersion: "spain-hj-fetch-v1",
    }),
    recordNormalizationArtifact: async (input) => { recorded = input; return "normalization-id"; },
  });

  const result = await runNormalize(repository, store, {});
  assert.equal(result.succeeded, 1);
  assert(recorded);
  const input = recorded as RecordNormalizationArtifactInput;
  assert.notEqual(input.normalizedOutput, null);
  assert.equal(input.normalizedOutputStorageRef ?? null, null);
  assert.equal(transport.puts.length, 0);
});

test("normalize externalizes the normalized output with hash and size", async () => {
  const transport = new RecordingTransport();
  const store = new ArtifactBlobStore(transport);
  const item = { ...claimedItem, resolutionStatus: "fetched", currentFetchArtifactId: "66666666-6666-4666-8666-666666666667" };
  let recorded: RecordNormalizationArtifactInput | null = null;
  let served = false;
  const repository = fakeRepository({
    claimItems: async () => {
      if (served) return [];
      served = true;
      return [item];
    },
    getFetchArtifact: async () => ({
      id: item.currentFetchArtifactId as string,
      itemId: item.itemId,
      sourcePolicyVersion: snapshot.sourcePolicyVersion,
      authorityUrl: item.discoveredUrl,
      payloadHash: "a".repeat(64),
      replayability: "bounded_evidence",
      immutableStorageRef: null,
      boundedReplayPayload: {
        sourceKey: snapshot.sourceKey,
        url: item.discoveredUrl,
        canonicalUrl: item.discoveredUrl,
        contentType: "decision",
        text: "official text",
      },
      fetchContractVersion: "spain-hj-fetch-v1",
    }),
    recordNormalizationArtifact: async (input) => { recorded = input; return "normalization-id"; },
  });

  const result = await runNormalize(repository, store, enabledEnvironment);
  assert.equal(result.succeeded, 1);
  assert(recorded);
  const input = recorded as RecordNormalizationArtifactInput;
  assert.equal(input.normalizedOutput, null);
  assert.equal(
    input.normalizedOutputStorageRef,
    `artifacts/normalization/${snapshot.sourceKey}/${input.normalizedOutputHash}.json`,
  );
  assert.match(input.normalizedOutputStorageRef as string, /^artifacts\/normalization\/es-tribunal-constitucional\/[0-9a-f]{64}\.json$/);
  assert.equal(input.externalizationContractVersion, ARTIFACT_BLOB_CONTRACT_VERSION);
  assert.equal(input.normalizedOutputSize, transport.puts[0].body.byteLength);
  assert.equal(sha256Hex(transport.puts[0].body), input.normalizedOutputHash);

  assert.equal(transport.puts.length, 1);
  assert.equal(transport.puts[0].options.access, "private");
  assert.match(transport.puts[0].pathname, /^artifacts\/normalization\//);
});

test("repository routes to v2 record RPCs only when a storage ref is present", () => {
  const source = fs.readFileSync(repositoryPath, "utf8");
  assert.match(source, /source_backfill_fetch_artifact_record_v2/);
  assert.match(source, /source_backfill_normalization_artifact_record_v2/);
  assert.match(source, /source_backfill_fetch_artifact_record_v1/);
  assert.match(source, /source_backfill_normalization_artifact_record_v1/);
  assert.match(source, /input\.boundedReplayStorageRef\?\.trim\(\) \|\| null/);
  assert.match(source, /input\.normalizedOutputStorageRef\?\.trim\(\) \|\| null/);
});
