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

export interface CaseBackfillExecutionContext {
  authority: CaseBackfillAttemptAuthority;
  checkpoint: () => Promise<void>;
  signal: AbortSignal;
}

interface CaseBackfillDependencies {
  repository: CaseBackfillRepository;
  loadAdapter: typeof loadSourceAdapter;
  now: () => Date;
}

const defaultDependencies: CaseBackfillDependencies = {
  repository: postgresCaseBackfillRepository,
  loadAdapter: loadSourceAdapter,
  now: () => new Date(),
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
    metadata: item.sourceRecordId ? { sourceRecordId: item.sourceRecordId } : undefined,
  };
}

function officialSpainUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname === "tribunalconstitucional.es" || url.hostname.endsWith(".tribunalconstitucional.es"));
  } catch {
    return false;
  }
}

export function validateNormalizedCase(
  normalized: NormalizedArticle,
  item: CaseBackfillClaimedItem,
  snapshot: CaseBackfillSnapshot,
) {
  const errors: string[] = [];
  if (normalized.sourceKey !== snapshot.sourceKey) errors.push("source_key_mismatch");
  if (snapshot.sourceKey !== "es-tribunal-constitucional") errors.push("source_not_enabled_for_gate1");
  if (!officialSpainUrl(normalized.canonicalUrl) || !officialSpainUrl(normalized.originalUrl)) errors.push("authority_url_invalid");
  if (normalized.contentType !== "decision") errors.push("document_type_mismatch");
  const resolutionType = stringAt(normalized.metadata, "resolutionType")?.toUpperCase();
  if (snapshot.documentType.toUpperCase() === "SENTENCIA" && resolutionType !== "SENTENCIA") {
    errors.push("resolution_type_mismatch");
  }
  const decisionDate = stringAt(normalized.metadata, "decisionDate") ?? normalized.originalPublishedAt?.slice(0, 10) ?? null;
  if (!decisionDate || !/^\d{4}-\d{2}-\d{2}$/.test(decisionDate)) errors.push("decision_date_missing");
  if (decisionDate && snapshot.scopeFrom && decisionDate < snapshot.scopeFrom) errors.push("decision_date_before_scope");
  if (decisionDate && snapshot.scopeTo && decisionDate > snapshot.scopeTo) errors.push("decision_date_after_scope");
  const hjId = item.sourceRecordId;
  if (hjId && !normalized.canonicalUrl.match(new RegExp(`/Show/${hjId}(?:$|[/?#])`, "i"))) errors.push("source_record_id_mismatch");
  if (!normalized.originalTitle?.trim()) errors.push("official_title_missing");
  return errors;
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
) {
  if (policy.normalizeReplayPolicy !== "bounded_evidence") {
    throw new Error(`case_backfill.${policy.normalizeReplayPolicy}_storage_not_configured`);
  }
  const raw = await adapter.fetchItem(discoveredItem(item, snapshot.sourceKey), {
    signal: context.signal,
    checkpoint: context.checkpoint,
  });
  const replayPayload = buildBoundedReplayPayload(raw, policy.boundedReplayFields);
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
    fetchContractVersion: input.fetchContractVersion ?? "spain-hj-fetch-v1",
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
) {
  if (!item.currentFetchArtifactId) throw new Error("case_backfill.fetch_artifact_missing");
  const fetchArtifact = await repository.getFetchArtifact(item.currentFetchArtifactId);
  if (fetchArtifact.replayability !== "bounded_evidence" || !fetchArtifact.boundedReplayPayload) {
    throw new Error("case_backfill.fetch_artifact_not_replayable");
  }
  const normalized = await adapter.normalize(replayRawArticle(fetchArtifact.boundedReplayPayload));
  const normalizedOutput = jsonSafe(normalized) as unknown as Record<string, unknown>;
  const validationErrors = typeof normalized.canonicalUrl === "string" && typeof normalized.sourceKey === "string"
    ? []
    : ["normalized_shape_invalid"];
  const artifactId = await repository.recordNormalizationArtifact({
    itemId: item.itemId,
    authority: context.authority,
    fetchArtifactId: fetchArtifact.id,
    parserVersion: input.parserVersion ?? "spain-hj-normalize-v1",
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
) {
  if (!item.currentNormalizationArtifactId) throw new Error("case_backfill.normalization_artifact_missing");
  const normalizedArtifact = await repository.getNormalizationArtifact(item.currentNormalizationArtifactId, item.itemId);
  const normalized = normalizedArtifact.normalizedOutput;
  const errors = validateNormalizedCase(normalized, item, snapshot);
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
) {
  const phase = input.phase as CaseBackfillItemPhase;
  await context.checkpoint();
  if (phase === "fetch") await processFetch(item, snapshot, policy, adapter, input, context, repository);
  else if (phase === "normalize") await processNormalize(item, adapter, input, context, repository);
  else if (phase === "verify") await processVerify(item, snapshot, context, repository);
  else throw new Error("case_backfill.publish_gate_closed");
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
    if (
      snapshot.sourceKey !== "es-tribunal-constitucional"
      || snapshot.documentType.toUpperCase() !== "SENTENCIA"
      || !snapshot.scopeFrom
      || !snapshot.scopeTo
      || snapshot.scopeFrom.slice(0, 4) !== snapshot.scopeTo.slice(0, 4)
    ) {
      throw new Error("case_backfill.discovery_scope_not_enabled");
    }
    const runId = await repository.beginRun(input, context.authority);
    const year = Number(snapshot.scopeFrom.slice(0, 4));
    let written = 0;
    try {
      const inventory = await discoverSpainTcInventory({
        year,
        documentType: "SENTENCIA",
        signal: context.signal,
        checkpoint: context.checkpoint,
      });
      for (const item of inventory.items) {
        await context.checkpoint();
        await repository.upsertInventoryItem({
          snapshotId: snapshot.id,
          stableItemKey: item.stableItemKey,
          sourceRecordId: item.sourceRecordId,
          discoveredUrl: item.discoveredUrl,
          documentType: item.documentType,
          decisionDateHint: item.decisionDateHint,
        });
        written += 1;
      }
      await repository.updateSnapshotEvidence(snapshot.id, inventory.coverageEvidence);
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
  if (input.phase === "publish") throw new Error("case_backfill.publish_gate_closed");

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
      ...context,
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
      await processItem(item, snapshot, policy, adapter, input, itemContext, repository);
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
