import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { canonicalJson } from "../lib/backfill/canonical-json";
import {
  ARTIFACT_READINESS_INLINE_RESTORE,
  classifyArtifactReadinessRow,
  runArtifactReadiness,
  type CaseBackfillArtifactReadinessDependencies,
} from "../lib/backfill/artifact-readiness";
import {
  CASE_BACKFILL_ARTIFACT_BLOB_READ_FLAG,
  CASE_BACKFILL_ARTIFACT_BLOB_WRITE_FLAG,
} from "../lib/backfill/flags";
import type {
  CaseBackfillArtifactExternalizationKind,
  CaseBackfillArtifactReadinessRow,
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

const modulePath = path.join(process.cwd(), "lib/backfill/artifact-readiness.ts");
const scriptPath = path.join(process.cwd(), "scripts/artifact-readiness.ts");
const repositoryPath = path.join(process.cwd(), "lib/backfill/repository.ts");
const migrationPath = path.join(
  process.cwd(),
  "supabase/migrations/20260919120000_artifact_blob_readiness_observability.sql",
);

const SOURCE_KEY = "es-tribunal-constitucional";
const OTHER_SOURCE_KEY = "fr-conseil-constitutionnel";
const SUPPORTED = ARTIFACT_BLOB_CONTRACT_VERSION;
const SENSITIVE_MARKER = "SENSITIVE-MARKER-9f3a";

const READ_ON = { [CASE_BACKFILL_ARTIFACT_BLOB_READ_FLAG]: "true" };
const BOTH_ON = {
  [CASE_BACKFILL_ARTIFACT_BLOB_READ_FLAG]: "true",
  [CASE_BACKFILL_ARTIFACT_BLOB_WRITE_FLAG]: "true",
};

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

interface ListCall {
  kind: CaseBackfillArtifactExternalizationKind;
  sourceKey: string | null;
  limit: number;
  afterArtifactId: string | null;
}

class FakeReadinessRepository {
  readonly calls: ListCall[] = [];

  constructor(private readonly rows: CaseBackfillArtifactReadinessRow[]) {}

  async listArtifactReadinessRows(input: {
    kind: CaseBackfillArtifactExternalizationKind;
    sourceKey?: string | null;
    limit: number;
    afterArtifactId?: string | null;
  }): Promise<CaseBackfillArtifactReadinessRow[]> {
    this.calls.push({
      kind: input.kind,
      sourceKey: input.sourceKey ?? null,
      limit: input.limit,
      afterArtifactId: input.afterArtifactId ?? null,
    });
    return this.rows
      .filter((row) => row.kind === input.kind)
      .filter((row) => (input.sourceKey ? row.sourceKey === input.sourceKey : true))
      .filter((row) => (input.afterArtifactId ? row.artifactId > input.afterArtifactId : true))
      .sort((left, right) => (left.artifactId < right.artifactId ? -1 : left.artifactId > right.artifactId ? 1 : 0))
      .slice(0, input.limit);
  }
}

function fetchDocument() {
  return {
    sourceKey: SOURCE_KEY,
    url: "https://example.test/resolucion/1",
    canonicalUrl: "https://example.test/resolucion/1",
    contentType: "decision",
    text: SENSITIVE_MARKER,
  };
}

function normalizedDocument() {
  return {
    sourceKey: SOURCE_KEY,
    jurisdiction: "Spain",
    contentType: "decision",
    originalUrl: "https://example.test/resolucion/1",
    canonicalUrl: "https://example.test/resolucion/1",
    metadata: { resolutionType: "SENTENCIA", note: SENSITIVE_MARKER },
  };
}

function inlineFetchRow(overrides: Partial<CaseBackfillArtifactReadinessRow> = {}): CaseBackfillArtifactReadinessRow {
  const document = canonicalJson(fetchDocument());
  return {
    artifactTable: "source_fetch_artifacts",
    artifactId: "00000001-0000-4000-8000-000000000001",
    itemId: "44444444-4444-4444-8444-444444444444",
    sourceKey: SOURCE_KEY,
    kind: "fetch",
    replayability: "bounded_evidence",
    inlinePresent: true,
    storageRef: null,
    storedHash: sha256Hex(document),
    storedSize: Buffer.byteLength(document, "utf8"),
    externalizationContractVersion: null,
    externalizedAtPresent: false,
    ledgerCovered: false,
    ...overrides,
  };
}

function inlineNormalizationRow(
  overrides: Partial<CaseBackfillArtifactReadinessRow> = {},
): CaseBackfillArtifactReadinessRow {
  const document = canonicalJson(normalizedDocument());
  return {
    artifactTable: "source_normalization_artifacts",
    artifactId: "00000002-0000-4000-8000-000000000002",
    itemId: "44444444-4444-4444-8444-444444444444",
    sourceKey: SOURCE_KEY,
    kind: "normalization",
    replayability: null,
    inlinePresent: true,
    storageRef: null,
    storedHash: sha256Hex(document),
    storedSize: null,
    externalizationContractVersion: null,
    externalizedAtPresent: false,
    ledgerCovered: false,
    ...overrides,
  };
}

function externalizedFetchRow(
  overrides: Partial<CaseBackfillArtifactReadinessRow> = {},
): CaseBackfillArtifactReadinessRow {
  const document = canonicalJson(fetchDocument());
  const hash = sha256Hex(document);
  return inlineFetchRow({
    artifactId: "10000000-0000-4000-8000-000000000001",
    inlinePresent: false,
    storageRef: buildArtifactStorageRef("fetch", SOURCE_KEY, hash),
    storedHash: hash,
    storedSize: Buffer.byteLength(document, "utf8"),
    externalizationContractVersion: SUPPORTED,
    externalizedAtPresent: true,
    ledgerCovered: true,
    ...overrides,
  });
}

function seedFetchDocument(transport: FakeTransport, storageRef: string) {
  transport.objects.set(storageRef, Buffer.from(canonicalJson(fetchDocument()), "utf8"));
}

function externalizedNormalizationRow(
  overrides: Partial<CaseBackfillArtifactReadinessRow> = {},
): CaseBackfillArtifactReadinessRow {
  const document = canonicalJson(normalizedDocument());
  const hash = sha256Hex(document);
  return inlineNormalizationRow({
    artifactId: "10000000-0000-4000-8000-000000000101",
    inlinePresent: false,
    storageRef: buildArtifactStorageRef("normalization", SOURCE_KEY, hash),
    storedHash: hash,
    storedSize: Buffer.byteLength(document, "utf8"),
    externalizationContractVersion: SUPPORTED,
    externalizedAtPresent: true,
    ledgerCovered: true,
    ...overrides,
  });
}

function seedNormalizedDocument(transport: FakeTransport, storageRef: string) {
  transport.objects.set(storageRef, Buffer.from(canonicalJson(normalizedDocument()), "utf8"));
}

function dependencies(
  repository: FakeReadinessRepository,
  transport = new FakeTransport(),
  environment: Record<string, string | undefined> = {},
): CaseBackfillArtifactReadinessDependencies & { transport: FakeTransport } {
  return { repository, store: new ArtifactBlobStore(transport), transport, environment };
}

test("classify distinguishes dual-copy, blob-only, inline-only, contract, and metadata states", () => {
  const dual = classifyArtifactReadinessRow(inlineFetchRow({
    inlinePresent: true,
    storageRef: "artifacts/fetch/es-tribunal-constitucional/" + "a".repeat(64) + ".json",
    externalizationContractVersion: SUPPORTED,
    externalizedAtPresent: true,
    ledgerCovered: true,
  }));
  assert.equal(dual.dualCopy, true);
  assert.equal(dual.blobOnly, false);
  assert.equal(dual.inlineOnly, false);
  assert.equal(dual.clearable, true);
  assert.equal(dual.ledgerCovered, true);
  assert.equal(dual.metadataInconsistent, false);
  assert.equal(dual.contractMismatch, false);

  const blobOnly = classifyArtifactReadinessRow(externalizedFetchRow());
  assert.equal(blobOnly.blobOnly, true);
  assert.equal(blobOnly.clearable, false);

  const inlineOnly = classifyArtifactReadinessRow(inlineFetchRow());
  assert.equal(inlineOnly.inlineOnly, true);
  assert.equal(inlineOnly.externalized, false);

  const missingContract = classifyArtifactReadinessRow(externalizedFetchRow({
    externalizationContractVersion: null,
  }));
  assert.equal(missingContract.metadataInconsistent, true);

  const contractMismatch = classifyArtifactReadinessRow(externalizedFetchRow({
    externalizationContractVersion: "worldcons-artifact-blob-v2",
  }));
  assert.equal(contractMismatch.contractMismatch, true);
  assert.equal(contractMismatch.clearable, false);

  const missingContent = classifyArtifactReadinessRow(inlineFetchRow({
    inlinePresent: false,
    storageRef: null,
  }));
  assert.equal(missingContent.metadataInconsistent, true);
});

test("default scan reports aggregate-only status and never touches Blob storage", async () => {
  const repository = new FakeReadinessRepository([
    inlineFetchRow(),
    externalizedFetchRow({ artifactId: "10000000-0000-4000-8000-000000000002" }),
    externalizedFetchRow({
      artifactId: "10000000-0000-4000-8000-000000000003",
      inlinePresent: true,
      ledgerCovered: true,
    }),
    inlineNormalizationRow(),
  ]);
  const deps = dependencies(repository);
  const report = await runArtifactReadiness({ batchSize: 25, maxBatches: 10 }, deps);

  assert.equal(report.event, "artifact_blob_readiness");
  assert.equal(report.readOnly, true);
  assert.equal(report.fetch.totalRows, 3);
  assert.equal(report.fetch.inlinePresentRows, 2);
  assert.equal(report.fetch.externalizedRows, 2);
  assert.equal(report.fetch.dualCopyRows, 1);
  assert.equal(report.fetch.blobOnlyRows, 1);
  assert.equal(report.fetch.inlineOnlyRows, 1);
  assert.equal(report.fetch.clearableRows, 1);
  assert.equal(report.fetch.inlineBytesEstimated, Buffer.byteLength(canonicalJson(fetchDocument()), "utf8") * 2);
  assert.equal(report.fetch.inlineSizeUnavailableRows, 0);
  assert.equal(report.normalization.totalRows, 1);
  assert.equal(report.normalization.inlinePresentRows, 1);
  assert.equal(report.normalization.inlineSizeUnavailableRows, 1);
  assert.equal(report.combined.totalRows, 4);

  assert.equal(report.verification.requested, false);
  assert.equal(report.verification.sampled, 0);
  assert.equal(deps.transport.heads.length, 0);
  assert.equal(deps.transport.gets.length, 0);

  assert.equal(report.gates.readEnabled, false);
  assert.equal(report.gates.writeEnabled, false);
  assert.equal(report.gates.newWriteReady, false);
  assert.equal(report.gates.inlineClearReady, false);
  assert.equal(report.decisions.newWriteReady, false);
  assert.equal(report.decisions.inlineClearReady, false);
  assert.equal(report.writeFlagsDefaultOff, true);
  assert.equal(report.inlineRestore, ARTIFACT_READINESS_INLINE_RESTORE);
  assert.equal(report.storageRefsEmitted, 0);
  assert.equal(report.perRowPayloadsEmitted, 0);
});

test("NEW_WRITE_READY needs both flags and no metadata criticals", async () => {
  const clean = new FakeReadinessRepository([externalizedFetchRow()]);

  const flagsOff = await runArtifactReadiness({ batchSize: 10, maxBatches: 10 }, dependencies(clean));
  assert.equal(flagsOff.gates.newWriteReady, false);
  assert.ok(flagsOff.gates.blocking.includes("read_flag_disabled"));
  assert.ok(flagsOff.gates.blocking.includes("write_flag_disabled"));

  const readOnly = await runArtifactReadiness(
    { batchSize: 10, maxBatches: 10 },
    dependencies(clean, new FakeTransport(), READ_ON),
  );
  assert.equal(readOnly.gates.readEnabled, true);
  assert.equal(readOnly.gates.writeEnabled, false);
  assert.equal(readOnly.gates.newWriteReady, false);
  assert.ok(readOnly.gates.blocking.includes("write_flag_disabled"));

  const writeWithoutRead = await runArtifactReadiness(
    { batchSize: 10, maxBatches: 10 },
    dependencies(clean, new FakeTransport(), { [CASE_BACKFILL_ARTIFACT_BLOB_WRITE_FLAG]: "true" }),
  );
  assert.equal(writeWithoutRead.gates.writeWithoutRead, true);
  assert.equal(writeWithoutRead.gates.newWriteReady, false);
  assert.equal(writeWithoutRead.gates.flagErrors.length, 1);

  const bothOn = await runArtifactReadiness(
    { batchSize: 10, maxBatches: 10 },
    dependencies(clean, new FakeTransport(), BOTH_ON),
  );
  assert.equal(bothOn.gates.newWriteReady, true);
  assert.equal(bothOn.gates.metadataCritical, false);
  assert.equal(bothOn.gates.critical, false);
  // Inline clear also needs a requested, clean verified sample and full ledger coverage.
  assert.equal(bothOn.gates.inlineClearReady, false);
  assert.ok(bothOn.gates.blocking.includes("verification_not_requested"));

  const inconsistent = new FakeReadinessRepository([
    externalizedFetchRow({ artifactId: "20000000-0000-4000-8000-000000000001", externalizationContractVersion: null }),
  ]);
  const metadataCritical = await runArtifactReadiness(
    { batchSize: 10, maxBatches: 10 },
    dependencies(inconsistent, new FakeTransport(), BOTH_ON),
  );
  assert.equal(metadataCritical.gates.metadataCritical, true);
  assert.equal(metadataCritical.gates.critical, true);
  assert.equal(metadataCritical.gates.newWriteReady, false);
  assert.ok(metadataCritical.gates.blocking.includes("metadata_inconsistent_rows"));

  const mismatch = new FakeReadinessRepository([
    externalizedFetchRow({
      artifactId: "30000000-0000-4000-8000-000000000001",
      externalizationContractVersion: "worldcons-artifact-blob-v2",
    }),
  ]);
  const contractCritical = await runArtifactReadiness(
    { batchSize: 10, maxBatches: 10 },
    dependencies(mismatch, new FakeTransport(), BOTH_ON),
  );
  assert.equal(contractCritical.combined.contractMismatchRows, 1);
  assert.equal(contractCritical.gates.newWriteReady, false);
  assert.equal(contractCritical.gates.critical, true);
});

test("INLINE_CLEAR_READY requires a clean verified sample and full ledger coverage", async () => {
  const clearable = externalizedFetchRow({ inlinePresent: true, ledgerCovered: true });

  const cleanRepository = new FakeReadinessRepository([clearable]);
  const cleanDeps = dependencies(cleanRepository, new FakeTransport(), BOTH_ON);
  seedFetchDocument(cleanDeps.transport, clearable.storageRef as string);
  const clean = await runArtifactReadiness(
    { batchSize: 10, maxBatches: 10, verificationSampleSize: 5 },
    cleanDeps,
  );
  assert.equal(clean.combined.clearableRows, 1);
  assert.equal(clean.combined.clearableLedgerCoveredRows, 1);
  assert.equal(clean.verification.requested, true);
  assert.equal(clean.verification.sampled, 1);
  assert.equal(clean.verification.verifiedOk, 1);
  assert.equal(clean.gates.verificationReady, true);
  assert.equal(clean.gates.ledgerCoverageReady, true);
  assert.equal(clean.gates.inlineClearReady, true);
  assert.equal(clean.gates.critical, false);
  assert.equal(cleanDeps.transport.heads.length, 1);
  assert.equal(cleanDeps.transport.gets.length, 1);

  const ledgerRow = externalizedFetchRow({
    artifactId: "40000000-0000-4000-8000-000000000001",
    inlinePresent: true,
    ledgerCovered: false,
  });
  const ledgerMissingRepository = new FakeReadinessRepository([ledgerRow]);
  const ledgerMissingDeps = dependencies(ledgerMissingRepository, new FakeTransport(), BOTH_ON);
  seedFetchDocument(ledgerMissingDeps.transport, ledgerRow.storageRef as string);
  const ledgerMissing = await runArtifactReadiness(
    { batchSize: 10, maxBatches: 10, verificationSampleSize: 5 },
    ledgerMissingDeps,
  );
  assert.equal(ledgerMissing.gates.ledgerCoverageReady, false);
  assert.equal(ledgerMissing.gates.inlineClearReady, false);
  assert.ok(ledgerMissing.gates.blocking.includes("ledger_coverage_incomplete"));
  assert.equal(ledgerMissing.gates.critical, false);
});

test("INLINE_CLEAR_READY blocks when the verified sample misses a clearable kind", async () => {
  const fetchRow = externalizedFetchRow({ inlinePresent: true, ledgerCovered: true });
  const normalizationRow = externalizedNormalizationRow({ inlinePresent: true, ledgerCovered: true });
  const repository = new FakeReadinessRepository([fetchRow, normalizationRow]);
  const deps = dependencies(repository, new FakeTransport(), BOTH_ON);
  seedFetchDocument(deps.transport, fetchRow.storageRef as string);
  seedNormalizedDocument(deps.transport, normalizationRow.storageRef as string);

  // Sample size 1 fills from kind iteration order (fetch first), so the
  // normalization kind is never sampled even though it has a clearable row.
  const report = await runArtifactReadiness(
    { batchSize: 10, maxBatches: 10, verificationSampleSize: 1 },
    deps,
  );

  assert.equal(report.combined.clearableRows, 2);
  assert.equal(report.combined.clearableLedgerCoveredRows, 2);
  assert.equal(report.verification.requested, true);
  assert.equal(report.verification.sampled, 1);
  assert.equal(report.verification.sampledByKind.fetch, 1);
  assert.equal(report.verification.sampledByKind.normalization, 0);
  assert.equal(report.verification.verifiedOk, 1);
  assert.equal(report.gates.verificationReady, false);
  assert.equal(report.gates.verificationKindCoverageReady, false);
  assert.equal(report.gates.inlineClearReady, false);
  assert.equal(report.gates.critical, false);
  assert.ok(report.gates.blocking.includes("verification_clearable_kind_unsampled_normalization"));
  assert.equal(report.gates.blocking.includes("verification_clearable_kind_unsampled_fetch"), false);
  assert.equal(deps.transport.gets.length, 1);
});

test("INLINE_CLEAR_READY allows both clearable kinds when the sample covers both cleanly", async () => {
  const fetchRow = externalizedFetchRow({ inlinePresent: true, ledgerCovered: true });
  const normalizationRow = externalizedNormalizationRow({ inlinePresent: true, ledgerCovered: true });
  const repository = new FakeReadinessRepository([fetchRow, normalizationRow]);
  const deps = dependencies(repository, new FakeTransport(), BOTH_ON);
  seedFetchDocument(deps.transport, fetchRow.storageRef as string);
  seedNormalizedDocument(deps.transport, normalizationRow.storageRef as string);

  const report = await runArtifactReadiness(
    { batchSize: 10, maxBatches: 10, verificationSampleSize: 2 },
    deps,
  );

  assert.equal(report.verification.candidatesConsidered, 2);
  assert.equal(report.verification.sampled, 2);
  assert.equal(report.verification.sampledByKind.fetch, 1);
  assert.equal(report.verification.sampledByKind.normalization, 1);
  assert.equal(report.verification.verifiedOk, 2);
  assert.equal(report.verification.readErrors, 0);
  assert.equal(report.gates.verificationKindCoverageReady, true);
  assert.equal(report.gates.verificationReady, true);
  assert.equal(report.gates.ledgerCoverageReady, true);
  assert.equal(report.gates.inlineClearReady, true);
  assert.equal(report.gates.critical, false);
  assert.equal(deps.transport.heads.length, 2);
  assert.equal(deps.transport.gets.length, 2);
});

test("a single selected kind only requires its own verified sample", async () => {
  const normalizationRow = externalizedNormalizationRow({ inlinePresent: true, ledgerCovered: true });
  const repository = new FakeReadinessRepository([
    normalizationRow,
    externalizedFetchRow({ inlinePresent: true, ledgerCovered: true }),
  ]);
  const deps = dependencies(repository, new FakeTransport(), BOTH_ON);
  seedNormalizedDocument(deps.transport, normalizationRow.storageRef as string);

  const report = await runArtifactReadiness(
    { kinds: ["normalization"], batchSize: 10, maxBatches: 10, verificationSampleSize: 5 },
    deps,
  );

  assert.equal(report.kinds.length, 1);
  assert.equal(report.fetch.totalRows, 0);
  assert.equal(report.normalization.clearableRows, 1);
  assert.equal(report.verification.sampledByKind.fetch, 0);
  assert.equal(report.verification.sampledByKind.normalization, 1);
  assert.equal(report.gates.verificationKindCoverageReady, true);
  assert.equal(report.gates.inlineClearReady, true);
  assert.equal(report.gates.critical, false);
});

test("a sampled hash mismatch is critical and blocks inline clear", async () => {
  const row = externalizedFetchRow({ inlinePresent: true, ledgerCovered: true });
  const repository = new FakeReadinessRepository([row]);
  const deps = dependencies(repository, new FakeTransport(), BOTH_ON);
  seedFetchDocument(deps.transport, row.storageRef as string);
  // Same length as the recorded size, different bytes: the hash check must fire.
  deps.transport.getBytesOverride = () => Buffer.alloc(row.storedSize as number, 0x61);

  const report = await runArtifactReadiness(
    { batchSize: 10, maxBatches: 10, verificationSampleSize: 5 },
    deps,
  );
  assert.equal(report.verification.sizeMismatches, 0);
  assert.equal(report.verification.hashMismatches, 1);
  assert.equal(report.verification.verifiedOk, 0);
  assert.equal(report.gates.critical, true);
  assert.equal(report.gates.inlineClearReady, false);
  assert.ok(report.gates.blocking.includes("blob_hash_mismatches"));
});

test("a sampled size mismatch is critical", async () => {
  const row = externalizedFetchRow({ inlinePresent: true });
  const repository = new FakeReadinessRepository([row]);
  const deps = dependencies(repository, new FakeTransport(), BOTH_ON);
  seedFetchDocument(deps.transport, row.storageRef as string);
  deps.transport.headSizeAdjust = 1;

  const report = await runArtifactReadiness(
    { batchSize: 10, maxBatches: 10, verificationSampleSize: 5 },
    deps,
  );
  assert.equal(report.verification.sizeMismatches, 1);
  assert.equal(report.verification.sampled, 1);
  assert.equal(report.gates.critical, true);
  assert.equal(report.gates.inlineClearReady, false);
  assert.ok(report.gates.blocking.includes("blob_size_mismatches"));
});

test("an invalid sampled document is critical", async () => {
  const bytes = Buffer.from("not-json{", "utf8");
  const hash = sha256Hex(bytes);
  const row = inlineFetchRow({
    artifactId: "50000000-0000-4000-8000-000000000001",
    inlinePresent: true,
    storageRef: buildArtifactStorageRef("fetch", SOURCE_KEY, hash),
    storedHash: hash,
    storedSize: bytes.byteLength,
    externalizationContractVersion: SUPPORTED,
    externalizedAtPresent: true,
    ledgerCovered: true,
  });
  const repository = new FakeReadinessRepository([row]);
  const deps = dependencies(repository, new FakeTransport(), BOTH_ON);
  deps.transport.objects.set(row.storageRef as string, bytes);

  const report = await runArtifactReadiness(
    { batchSize: 10, maxBatches: 10, verificationSampleSize: 5 },
    deps,
  );
  assert.equal(report.verification.hashMismatches, 0);
  assert.equal(report.verification.invalidDocuments, 1);
  assert.equal(report.gates.critical, true);
  assert.ok(report.gates.blocking.includes("blob_invalid_documents"));
});

test("a Blob read error makes the verification gate not-ready but is not critical", async () => {
  const row = externalizedFetchRow({ inlinePresent: true });
  const repository = new FakeReadinessRepository([row]);
  const deps = dependencies(repository, new FakeTransport(), BOTH_ON);

  const report = await runArtifactReadiness(
    { batchSize: 10, maxBatches: 10, verificationSampleSize: 5 },
    deps,
  );
  assert.equal(report.verification.readErrors, 1);
  assert.equal(report.verification.sampled, 1);
  assert.equal(report.gates.verificationReady, false);
  assert.equal(report.gates.inlineClearReady, false);
  assert.equal(report.gates.critical, false);
  assert.ok(report.gates.blocking.includes("blob_read_errors"));
});

test("bounded keyset pagination and optional source filter are applied", async () => {
  const rows = Array.from({ length: 5 }, (_, index) => inlineFetchRow({
    artifactId: `0000000${index}-0000-4000-8000-00000000000${index}`,
  }));
  const repository = new FakeReadinessRepository(rows);
  const deps = dependencies(repository, new FakeTransport(), BOTH_ON);

  const truncated = await runArtifactReadiness(
    { kinds: ["fetch"], batchSize: 2, maxBatches: 2 },
    deps,
  );
  assert.equal(truncated.fetch.totalRows, 4);
  assert.equal(truncated.fetch.batches, 2);
  assert.equal(truncated.fetch.truncated, true);
  assert.equal(truncated.gates.scanComplete, false);
  assert.equal(truncated.gates.newWriteReady, false);
  assert.ok(truncated.gates.blocking.includes("scan_truncated"));
  assert.deepEqual(repository.calls.map((call) => call.limit), [2, 2]);
  assert.equal(repository.calls[0].afterArtifactId, null);
  assert.equal(repository.calls[1].afterArtifactId, rows[1].artifactId);

  const filteredRepository = new FakeReadinessRepository([
    inlineFetchRow({ artifactId: "60000000-0000-4000-8000-000000000001" }),
    inlineFetchRow({ artifactId: "60000000-0000-4000-8000-000000000002", sourceKey: OTHER_SOURCE_KEY }),
  ]);
  const filteredDeps = dependencies(filteredRepository);
  await runArtifactReadiness(
    {
      kinds: ["fetch"],
      sourceKey: OTHER_SOURCE_KEY,
      batchSize: 10,
      maxBatches: 10,
      afterArtifactId: "50000000-0000-4000-8000-000000000000",
    },
    filteredDeps,
  );
  assert.equal(filteredRepository.calls.length, 1);
  assert.equal(filteredRepository.calls[0].sourceKey, OTHER_SOURCE_KEY);
  assert.equal(filteredRepository.calls[0].afterArtifactId, "50000000-0000-4000-8000-000000000000");
});

test("the readiness report never emits refs, hashes, raw content, or per-row payloads", async () => {
  const row = externalizedFetchRow({ inlinePresent: true, ledgerCovered: true });
  const repository = new FakeReadinessRepository([row]);
  const deps = dependencies(repository, new FakeTransport(), BOTH_ON);
  seedFetchDocument(deps.transport, row.storageRef as string);

  const report = await runArtifactReadiness(
    { batchSize: 10, maxBatches: 10, verificationSampleSize: 5 },
    deps,
  );
  const serialized = JSON.stringify(report);

  assert.equal(serialized.includes(row.storageRef as string), false);
  assert.equal(serialized.includes("artifacts/"), false);
  assert.equal(serialized.includes(row.storedHash), false);
  assert.equal(serialized.includes(SENSITIVE_MARKER), false);
  assert.equal(serialized.includes("bounded_replay_payload"), false);
  assert.equal(serialized.includes("normalized_output"), false);
  assert.equal(/https?:\/\//.test(serialized), false);
  assert.equal(/(token|secret|signature|credential)/i.test(serialized), false);
  assert.equal("storageRef" in report, false);
  assert.equal("storageRefs" in report, false);
  assert.equal("outcomes" in report, false);
});

test("invalid bounds and a missing verification store fail closed", async () => {
  const repository = new FakeReadinessRepository([inlineFetchRow()]);
  const deps = dependencies(repository);

  await assert.rejects(
    () => runArtifactReadiness({ batchSize: 0, maxBatches: 10 }, deps),
    /artifact_readiness\.invalid_batch_size/,
  );
  await assert.rejects(
    () => runArtifactReadiness({ batchSize: 101, maxBatches: 10 }, deps),
    /artifact_readiness\.invalid_batch_size/,
  );
  await assert.rejects(
    () => runArtifactReadiness({ batchSize: 10, maxBatches: 0 }, deps),
    /artifact_readiness\.invalid_max_batches/,
  );
  await assert.rejects(
    () => runArtifactReadiness({ batchSize: 10, maxBatches: 10, verificationSampleSize: 101 }, deps),
    /artifact_readiness\.invalid_verification_sample_size/,
  );
  await assert.rejects(
    () => runArtifactReadiness({ kinds: ["bogus" as never], batchSize: 10, maxBatches: 10 }, deps),
    /artifact_readiness\.invalid_kind/,
  );
  await assert.rejects(
    () => runArtifactReadiness(
      { batchSize: 10, maxBatches: 10, verificationSampleSize: 1 },
      { repository, store: null },
    ),
    /artifact_readiness\.store_required/,
  );
});

test("the CLI is read-only and takes no write flags", () => {
  const source = fs.readFileSync(scriptPath, "utf8");
  assert.match(source, /runArtifactReadiness\(/);
  assert.match(source, /integerArgument\("verify-sample", 0, 0, 100\)/);
  assert.match(source, /verificationSampleSize > 0 \? createArtifactBlobStore\(\) : null/);
  assert.match(source, /artifact_blob_read_not_ready/);
  assert.match(source, /after_requires_kind/);
  assert.match(source, /require-new-write-ready/);
  assert.match(source, /require-inline-clear-ready/);
  assert.doesNotMatch(source, /flag\("execute"\)/);
  assert.doesNotMatch(source, /acknowledge-irreversible/);
  assert.doesNotMatch(source, /store\.put\(/);
  assert.doesNotMatch(source, /store\.delete\(/);
  assert.doesNotMatch(source, /attachArtifactExternalization|clearArtifactInline|recordFetchArtifact/);
  assert.doesNotMatch(source, /console\.log/);
});

test("the module keeps verification default off, deletes nothing, and derives the rollout gates", () => {
  const source = fs.readFileSync(modulePath, "utf8");
  assert.match(source, /verificationSampleSize \?\? 0/);
  assert.match(source, /sha256Hex\(bytes\)/);
  assert.match(source, /await store\.head\(/);
  assert.match(source, /await store\.get\(/);
  assert.match(source, /newWriteReady = readFlagReady && writeFlagReady && !metadataCritical/);
  assert.match(source, /inlineClearReady = newWriteReady && ledgerCoverageReady && verificationReady/);
  assert.match(source, /verificationKindCoverageReady = uncoveredClearableKinds\.length === 0/);
  assert.match(source, /verification\.sampledByKind\[candidate\.kind\] \+= 1/);
  assert.match(source, /verification_clearable_kind_unsampled_\$\{kind\}/);
  assert.match(source, /ARTIFACT_READINESS_INLINE_RESTORE = "requires_separate_restore_design"/);
  assert.match(source, /storageRefsEmitted: 0/);
  assert.doesNotMatch(source, /store\.delete\(/);
  assert.doesNotMatch(source, /console\.log/);
});

test("the repository read path uses the read-only readiness function", () => {
  const source = fs.readFileSync(repositoryPath, "utf8");
  assert.match(source, /source_backfill_artifact_readiness_rows_v1/);
  assert.match(source, /listArtifactReadinessRows/);
  assert.match(source, /p_kind: input\.kind/);
  assert.match(source, /p_source_key: input\.sourceKey \?\? null/);
  assert.match(source, /p_after_artifact_id: input\.afterArtifactId \?\? null/);
});

test("the readiness migration is read-only and service_role only", () => {
  const sql = fs.readFileSync(migrationPath, "utf8");
  assert.match(sql, /create or replace function source_backfill_artifact_readiness_rows_v1\(/);
  assert.match(sql, /returns table/);
  assert.match(sql, /\bstable\b/);
  assert.match(sql, /security definer/);
  assert.match(sql, /set search_path = public, extensions, pg_temp/);
  assert.match(sql, /bounded_replay_payload is not null/);
  assert.match(sql, /normalized_output is not null/);
  assert.match(sql, /from source_artifact_externalization_ledger l/);
  assert.match(sql, /p_after_artifact_id is null or f\.id > p_after_artifact_id/);
  assert.match(sql, /v_source_key is null or s\.source_key = v_source_key/);
  assert.match(
    sql,
    /revoke all on function source_backfill_artifact_readiness_rows_v1\(text, text, integer, uuid\) from public/,
  );
  assert.match(
    sql,
    /grant execute on function source_backfill_artifact_readiness_rows_v1\(text, text, integer, uuid\) to service_role/,
  );
  assert.doesNotMatch(sql, /\b(insert|update|delete|truncate|alter\s+table|drop\s+table|create\s+table)\b/i);
  assert.doesNotMatch(sql, /\bvacuum\b/i);
});
