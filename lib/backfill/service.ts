import { createHash } from "node:crypto";
import {
  postgresCaseBackfillRepository,
  type CaseBackfillRepository,
} from "@/lib/backfill/repository";
import type {
  CaseBackfillAttemptAuthority,
  CaseBackfillClaimedItem,
  CaseBackfillItemPhase,
  CaseBackfillPassInput,
  CaseBackfillPassResult,
  CaseBackfillSnapshot,
  CaseBackfillSourcePolicy,
} from "@/lib/backfill/types";
import { loadSourceAdapter } from "@/lib/sources/lazy";
import type { DiscoveredItem, NormalizedArticle, RawArticle, SourceAdapter } from "@/lib/sources/types";
import { discoverSpainTcInventory } from "@/lib/crawlee/spain-tribunal-constitucional-spider";
import { discoverFranceConseilInventory } from "@/lib/crawlee/france-conseil-inventory";
import { discoverFranceDilaConstitInventory } from "@/lib/crawlee/france-dila-constit";
import { discoverBverfgInventory } from "@/lib/crawlee/bverfg-inventory";
import { caseCatalogWriteEnabled } from "@/lib/case-catalog/flags";
import { createCaseBackfillRequestGovernor } from "@/lib/backfill/source-request-governor";
import type { CrawlerRequestGovernor } from "@/lib/crawler/types";
import {
  loadCaseBackfillSourceStrategy,
  type CaseBackfillSourceStrategy,
  validateCaseWithSourceStrategy,
} from "@/lib/backfill/source-strategies";

export interface CaseBackfillExecutionContext {
  authority: CaseBackfillAttemptAuthority;
  checkpoint: () => Promise<void>;
  signal: AbortSignal;
  requestGovernor?: CrawlerRequestGovernor;
}

interface CaseBackfillDependencies {
  repository: CaseBackfillRepository;
  loadAdapter: typeof loadSourceAdapter;
  now: () => Date;
  discoverSpainTcInventory?: typeof discoverSpainTcInventory;
  discoverFranceConseilInventory?: typeof discoverFranceConseilInventory;
  discoverFranceDilaConstitInventory?: typeof discoverFranceDilaConstitInventory;
  discoverBverfgInventory?: typeof discoverBverfgInventory;
  environment?: Record<string, string | undefined>;
}

const defaultDependencies: CaseBackfillDependencies = {
  repository: postgresCaseBackfillRepository,
  loadAdapter: loadSourceAdapter,
  now: () => new Date(),
  discoverSpainTcInventory,
  discoverFranceDilaConstitInventory,
  environment: process.env,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function jsonSafe<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (_key, child) => Buffer.isBuffer(child) ? undefined : child)) as T;
}

function pathValue(source: Record<string, unknown>, path: string) {
  let value: unknown = source;
  for (const segment of path.split(".")) {
    if (!isRecord(value) || !(segment in value)) return undefined;
    value = value[segment];
  }
  return value;
}

function assignPath(target: Record<string, unknown>, path: string, value: unknown) {
  const segments = path.split(".");
  let current = target;
  for (const segment of segments.slice(0, -1)) {
    const next = current[segment];
    if (!isRecord(next)) current[segment] = {};
    current = current[segment] as Record<string, unknown>;
  }
  current[segments[segments.length - 1]] = value;
}

export function buildBoundedReplayPayload(raw: RawArticle, allowedFields: string[]) {
  const source = jsonSafe(raw) as unknown as Record<string, unknown>;
  const payload: Record<string, unknown> = {};
  for (const field of allowedFields) {
    if (!/^[a-zA-Z][a-zA-Z0-9_.]{0,119}$/.test(field)) continue;
    const value = pathValue(source, field);
    if (value !== undefined) assignPath(payload, field, value);
  }
  return payload;
}

function replayRawArticle(payload: Record<string, unknown>): RawArticle {
  if (
    typeof payload.sourceKey !== "string"
    || typeof payload.url !== "string"
    || typeof payload.canonicalUrl !== "string"
    || typeof payload.contentType !== "string"
  ) {
    throw new Error("case_backfill.replay_payload_incomplete");
  }
  return payload as unknown as RawArticle;
}

function stringAt(value: unknown, path: string) {
  const found = isRecord(value) ? pathValue(value, path) : undefined;
  return typeof found === "string" && found.trim() ? found.trim() : null;
}

function discoveredItem(item: CaseBackfillClaimedItem, sourceKey: string): DiscoveredItem {
  return {
    sourceKey,
    url: item.discoveredUrl,
    canonicalUrl: item.discoveredUrl,
    publishedAt: item.decisionDateHint ? `${item.decisionDateHint}T00:00:00.000Z` : undefined,
    contentType: "decision",
    metadata: {
      ...(item.sourceRecordId ? { sourceRecordId: item.sourceRecordId } : {}),
      sourceInventory: item.inventoryMetadata,
    },
  };
}

export function validateNormalizedCase(
  normalized: NormalizedArticle,
  item: CaseBackfillClaimedItem,
  snapshot: CaseBackfillSnapshot,
) {
  return validateCaseWithSourceStrategy(normalized, item, snapshot);
}

function retryableError(error: unknown) {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return /timeout|timed out|network|fetch failed|econn|enotfound|429|502|503|504|rate.limit/.test(message);
}

function errorCode(error: unknown, phase: CaseBackfillItemPhase) {
  const value = error instanceof Error ? error.message : String(error);
  if (/^[a-z][a-z0-9._-]{0,159}$/.test(value)) return value;
  return `case_backfill.${phase}_failed`;
}

function errorSummary(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 500);
}

function retryAt(now: Date) {
  return new Date(now.getTime() + 5 * 60_000).toISOString();
}

async function processFetch(
  item: CaseBackfillClaimedItem,
  snapshot: CaseBackfillSnapshot,
  policy: CaseBackfillSourcePolicy,
  adapter: SourceAdapter,
  input: CaseBackfillPassInput,
  context: CaseBackfillExecutionContext,
  repository: CaseBackfillRepository,
  strategy: CaseBackfillSourceStrategy,
) {
  if (policy.normalizeReplayPolicy !== "bounded_evidence") {
    throw new Error(`case_backfill.${policy.normalizeReplayPolicy}_storage_not_configured`);
  }
  const raw = await adapter.fetchItem(discoveredItem(item, snapshot.sourceKey), {
    signal: context.signal,
    checkpoint: context.checkpoint,
    requestGovernor: context.requestGovernor,
  });
  const replayPayload = buildBoundedReplayPayload(raw, policy.boundedReplayFields);
  // Inventory provenance is already size/secret validated and sealed into the
  // snapshot manifest. Preserve it even when a source policy projects a narrow
  // subset of network response metadata.
  assignPath(replayPayload, "metadata.sourceInventory", item.inventoryMetadata);
  replayRawArticle(replayPayload);
  const payloadDocument = canonicalJson(replayPayload);
  const artifactId = await repository.recordFetchArtifact({
    itemId: item.itemId,
    authority: context.authority,
    sourcePolicyVersion: snapshot.sourcePolicyVersion,
    authorityUrl: raw.canonicalUrl,
    httpStatus: 200,
    responseHeaders: {},
    sourceEtag: stringAt(raw.metadata, "sourceEtag"),
    sourceLastModifiedAt: stringAt(raw.metadata, "sourceLastModifiedAt"),
    payloadHash: sha256(payloadDocument),
    payloadSize: Buffer.byteLength(payloadDocument),
    replayability: "bounded_evidence",
    immutableStorageRef: null,
    boundedReplayPayload: replayPayload,
    fetchContractVersion: input.fetchContractVersion ?? strategy.defaultFetchContractVersion,
  });
  await repository.completeItem({
    itemId: item.itemId,
    phase: "fetch",
    authority: context.authority,
    nextStatus: item.resolutionStatus === "published" ? "published" : "fetched",
    resultMetadata: { artifactId },
  });
}

async function processNormalize(
  item: CaseBackfillClaimedItem,
  adapter: SourceAdapter,
  input: CaseBackfillPassInput,
  context: CaseBackfillExecutionContext,
  repository: CaseBackfillRepository,
  strategy: CaseBackfillSourceStrategy,
) {
  if (!item.currentFetchArtifactId) throw new Error("case_backfill.fetch_artifact_missing");
  const fetchArtifact = await repository.getFetchArtifact(item.currentFetchArtifactId);
  if (fetchArtifact.replayability !== "bounded_evidence" || !fetchArtifact.boundedReplayPayload) {
    throw new Error("case_backfill.fetch_artifact_not_replayable");
  }
  const normalized = await adapter.normalize(replayRawArticle(fetchArtifact.boundedReplayPayload));
  const normalizedWithProvenance: NormalizedArticle = {
    ...normalized,
    metadata: {
      ...normalized.metadata,
      sourceInventory: item.inventoryMetadata,
    },
  };
  const normalizedOutput = jsonSafe(normalizedWithProvenance) as unknown as Record<string, unknown>;
  const validationErrors = typeof normalizedWithProvenance.canonicalUrl === "string" && typeof normalizedWithProvenance.sourceKey === "string"
    ? []
    : ["normalized_shape_invalid"];
  const artifactId = await repository.recordNormalizationArtifact({
    itemId: item.itemId,
    authority: context.authority,
    fetchArtifactId: fetchArtifact.id,
    parserVersion: input.parserVersion ?? strategy.defaultParserVersion,
    normalizationContractVersion: input.normalizationContractVersion ?? "case-normalized-v1",
    normalizedOutput,
    normalizedOutputHash: sha256(canonicalJson(normalizedOutput)),
    validationStatus: validationErrors.length === 0 ? "valid" : "invalid",
    validationErrors,
  });
  if (validationErrors.length > 0) throw new Error("case_backfill.normalized_shape_invalid");
  await repository.completeItem({
    itemId: item.itemId,
    phase: "normalize",
    authority: context.authority,
    nextStatus: item.resolutionStatus === "published" ? "published" : "normalized",
    resultMetadata: { artifactId },
  });
}

async function processVerify(
  item: CaseBackfillClaimedItem,
  snapshot: CaseBackfillSnapshot,
  context: CaseBackfillExecutionContext,
  repository: CaseBackfillRepository,
  strategy: CaseBackfillSourceStrategy,
) {
  if (!item.currentNormalizationArtifactId) throw new Error("case_backfill.normalization_artifact_missing");
  const normalizedArtifact = await repository.getNormalizationArtifact(item.currentNormalizationArtifactId, item.itemId);
  const normalized = normalizedArtifact.normalizedOutput;
  const errors = strategy.validate(normalized, item, snapshot);
  if (errors.length > 0) throw new Error(`case_backfill.verification_${errors[0]}`);
  const noop = item.resolutionStatus === "published"
    && item.publishedNormalizationArtifactId !== null
    && normalizedArtifact.normalizedOutputHash === (await repository.getNormalizationArtifact(item.publishedNormalizationArtifactId, item.itemId)).normalizedOutputHash;
  await repository.completeItem({
    itemId: item.itemId,
    phase: "verify",
    authority: context.authority,
    nextStatus: item.resolutionStatus === "published" ? "published" : "verified",
    resultMetadata: { artifactId: item.currentNormalizationArtifactId, noop },
  });
}

async function processItem(
  item: CaseBackfillClaimedItem,
  snapshot: CaseBackfillSnapshot,
  policy: CaseBackfillSourcePolicy,
  adapter: SourceAdapter,
  input: CaseBackfillPassInput,
  context: CaseBackfillExecutionContext,
  repository: CaseBackfillRepository,
  strategy: CaseBackfillSourceStrategy,
) {
  const phase = input.phase as CaseBackfillItemPhase;
  await context.checkpoint();
  if (phase === "fetch") await processFetch(item, snapshot, policy, adapter, input, context, repository, strategy);
  else if (phase === "normalize") await processNormalize(item, adapter, input, context, repository, strategy);
  else if (phase === "verify") await processVerify(item, snapshot, context, repository, strategy);
  else if (phase === "publish") await repository.publishItem({ itemId: item.itemId, authority: context.authority });
  else throw new Error("case_backfill.invalid_item_phase");
}

export async function runCaseBackfillPass(
  input: CaseBackfillPassInput,
  context: CaseBackfillExecutionContext,
  dependencies: CaseBackfillDependencies = defaultDependencies,
): Promise<CaseBackfillPassResult> {
  const { repository } = dependencies;
  const snapshot = await repository.getSnapshot(input.snapshotId);

  if (input.phase === "discover") {
    if (snapshot.status !== "open") throw new Error("case_backfill.snapshot_not_open");
    const strategy = loadCaseBackfillSourceStrategy(snapshot.sourceKey, {
      discoverSpainTcInventory: dependencies.discoverSpainTcInventory,
      discoverFranceConseilInventory: dependencies.discoverFranceConseilInventory,
      discoverFranceDilaConstitInventory: dependencies.discoverFranceDilaConstitInventory,
      discoverBverfgInventory: dependencies.discoverBverfgInventory,
      currentYear: dependencies.now().getUTCFullYear(),
    });
    strategy.assertDiscoveryScope(snapshot, dependencies.environment ?? process.env);
    if (!strategy.governedNetworkPhases.includes("discover")) {
      throw new Error("case_backfill.source_request_governor_not_supported");
    }
    await repository.getSourcePolicy(snapshot.sourceKey, snapshot.sourcePolicyVersion);
    const requestGovernor = createCaseBackfillRequestGovernor({
      repository,
      snapshotId: snapshot.id,
      phase: "discover",
      authority: context.authority,
      checkpoint: context.checkpoint,
      signal: context.signal,
    });
    const runId = await repository.beginRun(input, context.authority);
    let written = 0;
    try {
      const inventory = await strategy.discover(snapshot, {
        environment: dependencies.environment ?? process.env,
        signal: context.signal,
        checkpoint: context.checkpoint,
        requestGovernor,
      });
      for (const artifact of inventory.enumerationArtifacts ?? []) {
        await context.checkpoint();
        await repository.recordEnumerationArtifact({
          snapshotId: snapshot.id,
          authority: context.authority,
          artifact,
        });
      }
      for (const item of inventory.items) {
        await context.checkpoint();
        await repository.upsertInventoryItem({
          snapshotId: snapshot.id,
          stableItemKey: item.stableItemKey,
          sourceRecordId: item.sourceRecordId,
          discoveredUrl: item.discoveredUrl,
          documentType: item.documentType,
          decisionDateHint: item.decisionDateHint,
          inventoryMetadata: item.inventoryMetadata ?? {},
        });
        written += 1;
      }
      await repository.updateSnapshotEvidence(
        snapshot.id,
        inventory.coverageEvidence,
        inventory.expectedCount ?? null,
        inventory.expectedCountBasis ?? null,
      );
      await repository.closeSnapshot(snapshot.id);
      await repository.finishRun({
        runId,
        authority: context.authority,
        status: "succeeded",
        claimed: written,
        succeeded: written,
        retryableFailed: 0,
        terminalFailed: 0,
      });
      return {
        phase: input.phase,
        snapshotId: input.snapshotId,
        passNumber: input.passNumber,
        claimed: written,
        succeeded: written,
        retryableFailed: 0,
        terminalFailed: 0,
        backlogRemaining: false,
      };
    } catch (error) {
      if (!context.signal.aborted) {
        await repository.finishRun({
          runId,
          authority: context.authority,
          status: "failed",
          claimed: written,
          succeeded: written,
          retryableFailed: 0,
          terminalFailed: 0,
          lastErrorCode: errorCode(error, "fetch"),
          lastErrorSummary: errorSummary(error),
        });
      }
      throw error;
    }
  }

  if (snapshot.status !== "closed") throw new Error("case_backfill.snapshot_not_closed");
  if (input.phase === "publish" && !caseCatalogWriteEnabled(dependencies.environment ?? process.env)) {
    throw new Error("case_backfill.catalog_write_disabled");
  }
  const strategy = loadCaseBackfillSourceStrategy(snapshot.sourceKey, {
    discoverSpainTcInventory: dependencies.discoverSpainTcInventory,
    discoverFranceConseilInventory: dependencies.discoverFranceConseilInventory,
    discoverFranceDilaConstitInventory: dependencies.discoverFranceDilaConstitInventory,
    discoverBverfgInventory: dependencies.discoverBverfgInventory,
    currentYear: dependencies.now().getUTCFullYear(),
  });
  if (input.phase === "fetch" && !strategy.governedNetworkPhases.includes("fetch")) {
    throw new Error("case_backfill.source_request_governor_not_supported");
  }

  const runId = await repository.beginRun(input, context.authority);

  if (input.phase === "reconcile") {
    const status = await repository.getSnapshotStatus(input.snapshotId);
    await repository.finishRun({
      runId,
      authority: context.authority,
      status: status.failed > 0 || status.retryWait > 0 ? "degraded" : "succeeded",
      claimed: 0,
      succeeded: 0,
      retryableFailed: 0,
      terminalFailed: 0,
    });
    return {
      phase: input.phase,
      snapshotId: input.snapshotId,
      passNumber: input.passNumber,
      claimed: 0,
      succeeded: 0,
      retryableFailed: 0,
      terminalFailed: 0,
      backlogRemaining: status.retryWait + status.needsNormalize + status.needsReverify + status.needsRepublish > 0,
    };
  }

  const itemPhase = input.phase as CaseBackfillItemPhase;
  const [policy, adapter] = await Promise.all([
    repository.getSourcePolicy(snapshot.sourceKey, snapshot.sourcePolicyVersion),
    dependencies.loadAdapter(snapshot.sourceKey),
  ]);
  if (!adapter) throw new Error("case_backfill.source_adapter_unavailable");
  const passContext: CaseBackfillExecutionContext = input.phase === "fetch"
    ? {
      ...context,
      requestGovernor: createCaseBackfillRequestGovernor({
        repository,
        snapshotId: snapshot.id,
        phase: "fetch",
        authority: context.authority,
        checkpoint: context.checkpoint,
        signal: context.signal,
      }),
    }
    : context;
  let claimed = 0;
  let succeeded = 0;
  let retryableFailed = 0;
  let terminalFailed = 0;

  while (claimed < input.batchLimit) {
    await context.checkpoint();
    const [item] = await repository.claimItems({ ...input, batchLimit: 1 }, context.authority);
    if (!item) break;
    claimed += 1;
    let itemLeaseExtendedAt = 0;
    const itemContext: CaseBackfillExecutionContext = {
      ...passContext,
      checkpoint: async () => {
        await context.checkpoint();
        const now = dependencies.now().getTime();
        if (now - itemLeaseExtendedAt >= 20_000) {
          await repository.extendItems([item.itemId], itemPhase, context.authority);
          itemLeaseExtendedAt = now;
        }
      },
    };
    try {
      await processItem(item, snapshot, policy, adapter, input, itemContext, repository, strategy);
      succeeded += 1;
    } catch (error) {
      if (context.signal.aborted) throw error;
      const retryable = retryableError(error);
      await repository.failItem({
        itemId: item.itemId,
        phase: itemPhase,
        authority: context.authority,
        disposition: retryable ? "retryable" : "terminal",
        errorCode: errorCode(error, itemPhase),
        errorSummary: errorSummary(error),
        retryAt: retryable ? retryAt(dependencies.now()) : null,
      });
      if (retryable) retryableFailed += 1;
      else terminalFailed += 1;
    }
  }

  const backlogRemaining = await repository.countBacklog(input) > 0;
  await repository.finishRun({
    runId,
    authority: context.authority,
    status: terminalFailed > 0 || retryableFailed > 0 ? "degraded" : "succeeded",
    claimed,
    succeeded,
    retryableFailed,
    terminalFailed,
  });
  return {
    phase: input.phase,
    snapshotId: input.snapshotId,
    passNumber: input.passNumber,
    claimed,
    succeeded,
    retryableFailed,
    terminalFailed,
    backlogRemaining,
  };
}

export type { CaseBackfillDependencies };
