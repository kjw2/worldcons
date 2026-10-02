import { createHash } from "node:crypto";
import { d1AdminCommandRepository } from "../../../lib/admin/command-control-plane/d1-repository";
import { canonicalJson } from "../../../lib/backfill/canonical-json";
import { d1CaseBackfillRepository } from "../../../lib/backfill/d1-repository";
import type { CaseBackfillAttemptAuthority, CaseBackfillClaimedItem, CaseBackfillFetchArtifact } from "../../../lib/backfill/types";
import { setRuntimeD1Bindings, type D1RuntimeDatabase } from "../../../lib/cloudflare/d1/runtime-binding";
import {
  ARTIFACT_BLOB_CONTRACT_VERSION,
  ArtifactBlobStore,
  createR2BindingArtifactBlobTransport,
  sha256Hex,
  type ArtifactBlobR2Bucket,
} from "../../../lib/storage/blob";
import type { NormalizedArticle } from "../../../lib/sources/types";
import { germanyBackfillSourcePolicyVersion, isApprovedGermanyBackfillSnapshotId } from "./backfill-fetch";

const SOURCE_KEY = "de-bverfg";
const PARSER_VERSION = "bverfg-official-normalize-v2";
const NORMALIZATION_CONTRACT_VERSION = "case-normalized-v1";

export interface GermanyBackfillNormalizePayload {
  snapshotId: string;
  phase: "normalize";
  passNumber: number;
  batchLimit?: number;
  maxPasses?: number;
  parserVersion?: string;
  normalizationContractVersion?: string;
  requestedBy?: string;
}

export interface GermanyBackfillNormalizeEnv {
  WORLDCONS_OPS: D1RuntimeDatabase;
  WORLDCONS_CORE: D1RuntimeDatabase;
  WORLDCONS_INGEST: D1RuntimeDatabase;
  WORLDCONS_SEARCH?: D1RuntimeDatabase;
  WORLDCONS_RAW: ArtifactBlobR2Bucket;
  CASE_CATALOG_GERMANY_HISTORY_ENABLED?: string;
}

type Row = Record<string, unknown>;

function text(value: unknown) {
  return typeof value === "string" ? value : "";
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function cleanText(value: unknown) {
  return typeof value === "string"
    ? value.replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim()
    : "";
}

function isoDate(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function inferredCaseNumber(item: CaseBackfillClaimedItem, raw: Record<string, unknown>) {
  const docket = text(item.inventoryMetadata.docket);
  if (docket) return docket;
  const haystack = `${text(raw.title)} ${text(raw.canonicalUrl)} ${text(raw.url)}`;
  const displayed = haystack.match(/\b(?:1|2)\s+Bv[A-Za-zÄÖÜäöü]+\s+\d+\/\d{2,4}\b/u)?.[0];
  if (displayed) return displayed;
  const compact = haystack.match(/[_./]([12])bv([a-z]+)(\d{4})(\d{2})(?:\.html)?\b/i);
  if (!compact) return undefined;
  const suffix = `${compact[2].slice(0, 1).toUpperCase()}${compact[2].slice(1).toLowerCase()}`;
  return `${compact[1]} Bv${suffix} ${Number(compact[3])}/${compact[4]}`;
}

function normalizedArticle(item: CaseBackfillClaimedItem, raw: Record<string, unknown>): NormalizedArticle {
  const metadata = record(raw.metadata);
  const caseNumber = inferredCaseNumber(item, raw);
  return {
    sourceKey: SOURCE_KEY,
    jurisdiction: "Germany",
    institutionName: "Federal Constitutional Court of Germany",
    contentType: "decision",
    originalUrl: text(raw.url),
    canonicalUrl: text(raw.canonicalUrl),
    originalLanguage: "de",
    ...(text(raw.title) ? { originalTitle: text(raw.title) } : {}),
    ...(isoDate(raw.publishedAt) ? { originalPublishedAt: isoDate(raw.publishedAt) } : {}),
    ...(text(raw.text) ? { rawText: text(raw.text), cleanedText: cleanText(raw.text) } : {}),
    metadata: {
      ...metadata,
      ...(caseNumber ? { caseNumber } : {}),
      sourceInventory: item.inventoryMetadata,
    },
  };
}

function exclusionCode(raw: Record<string, unknown>) {
  const collection = record(record(raw.metadata).collection);
  if (collection.sourceUrlVerified !== true) return "official_source_unavailable";
  if (collection.publishable !== true) return "official_source_not_publishable";
  return null;
}

function retryable(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /r2_get_failed|r2_put_failed|artifact_blob\.not_found|timeout|network|temporar/i.test(message);
}

function boundedErrorCode(error: unknown) {
  const value = error instanceof Error ? error.message : String(error);
  return /^[a-z][a-z0-9._-]{0,159}$/.test(value) ? value : "case_backfill.normalize_failed";
}

function boundedErrorSummary(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 500);
}

async function queryRows<T extends Row>(db: D1RuntimeDatabase, sql: string, values: unknown[] = []) {
  const result = await db.prepare(sql).bind(...values).all<T>();
  if (!result || result.success === false || result.error || !Array.isArray(result.results)) {
    throw new Error(result?.error || "case_backfill.workflow_d1_read_failed");
  }
  return result.results;
}

async function heartbeat(authority: CaseBackfillAttemptAuthority) {
  const result = await d1AdminCommandRepository.heartbeat(authority.attemptId, authority.fencingToken, 900);
  if (!result.ok) throw new Error(`case_backfill.${result.error.code}`);
  authority.leaseExpiresAt = result.data.leaseExpiresAt;
}

async function replayPayload(fetchArtifact: CaseBackfillFetchArtifact, store: ArtifactBlobStore) {
  if (fetchArtifact.replayability !== "bounded_evidence") throw new Error("case_backfill.fetch_artifact_not_replayable");
  if (fetchArtifact.boundedReplayPayload) return fetchArtifact.boundedReplayPayload;
  if (!fetchArtifact.boundedReplayStorageRef) throw new Error("case_backfill.fetch_artifact_not_replayable");
  if (fetchArtifact.externalizationContractVersion !== ARTIFACT_BLOB_CONTRACT_VERSION) {
    throw new Error("case_backfill.artifact_blob_contract_unsupported");
  }
  const bytes = await store.get(fetchArtifact.boundedReplayStorageRef);
  if (fetchArtifact.payloadSize !== null && fetchArtifact.payloadSize !== undefined && bytes.byteLength !== fetchArtifact.payloadSize) {
    throw new Error("case_backfill.artifact_blob_integrity_mismatch");
  }
  if (sha256Hex(bytes) !== fetchArtifact.payloadHash) throw new Error("case_backfill.artifact_blob_integrity_mismatch");
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("case_backfill.artifact_blob_invalid_document"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("case_backfill.artifact_blob_invalid_document");
  return parsed as Record<string, unknown>;
}

export function parseGermanyBackfillNormalizePayload(value: unknown): GermanyBackfillNormalizePayload | null {
  let candidate = value;
  if (typeof candidate === "string") {
    try { candidate = JSON.parse(candidate); } catch { return null; }
  }
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
  const payload = candidate as Record<string, unknown>;
  const keys = Object.keys(payload);
  if (keys.some((key) => !["snapshotId","phase","passNumber","batchLimit","maxPasses","parserVersion","normalizationContractVersion","requestedBy"].includes(key))) return null;
  if (
    !isApprovedGermanyBackfillSnapshotId(payload.snapshotId)
    || payload.phase !== "normalize"
    || !Number.isInteger(payload.passNumber) || Number(payload.passNumber) < 1 || Number(payload.passNumber) > 2_147_483_647
    || (payload.batchLimit !== undefined && (!Number.isInteger(payload.batchLimit) || Number(payload.batchLimit) < 1 || Number(payload.batchLimit) > 50))
    || (payload.maxPasses !== undefined && (!Number.isInteger(payload.maxPasses) || Number(payload.maxPasses) < 1 || Number(payload.maxPasses) > 10))
    || (payload.parserVersion !== undefined && payload.parserVersion !== PARSER_VERSION)
    || (payload.normalizationContractVersion !== undefined && payload.normalizationContractVersion !== NORMALIZATION_CONTRACT_VERSION)
    || (payload.requestedBy !== undefined && (typeof payload.requestedBy !== "string" || payload.requestedBy.trim().length < 1 || payload.requestedBy.length > 160))
  ) return null;
  return payload as unknown as GermanyBackfillNormalizePayload;
}

export async function runGermanyBackfillNormalizePass(env: GermanyBackfillNormalizeEnv, input: GermanyBackfillNormalizePayload) {
  if (env.CASE_CATALOG_GERMANY_HISTORY_ENABLED !== "true") throw new Error("case_backfill.germany_history_disabled");
  const expectedSourcePolicyVersion = germanyBackfillSourcePolicyVersion(input.snapshotId);
  if (!expectedSourcePolicyVersion) throw new Error("case_backfill.germany_snapshot_not_approved");
  if (input.phase !== "normalize") throw new Error("case_backfill.d1_phase_unsupported");
  const parserVersion = input.parserVersion ?? PARSER_VERSION;
  const normalizationContractVersion = input.normalizationContractVersion ?? NORMALIZATION_CONTRACT_VERSION;
  if (parserVersion !== PARSER_VERSION || normalizationContractVersion !== NORMALIZATION_CONTRACT_VERSION) {
    throw new Error("case_backfill.normalize_contract_not_approved");
  }
  const batchLimit = Math.max(1, Math.min(input.batchLimit ?? 25, 50));
  const requestedBy = input.requestedBy?.trim() || "worldcons-backfill-normalize-workflow";
  setRuntimeD1Bindings({ worldcons_ops: env.WORLDCONS_OPS, worldcons_core: env.WORLDCONS_CORE, worldcons_ingest: env.WORLDCONS_INGEST, worldcons_search: env.WORLDCONS_SEARCH });
  const store = new ArtifactBlobStore(createR2BindingArtifactBlobTransport({ bucket: env.WORLDCONS_RAW }));

  const snapshot = await d1CaseBackfillRepository.getSnapshot(input.snapshotId);
  if (snapshot.sourceKey !== SOURCE_KEY || snapshot.status !== "closed" || snapshot.sourcePolicyVersion !== expectedSourcePolicyVersion) {
    throw new Error("case_backfill.germany_snapshot_contract_mismatch");
  }
  const activeCommands = await queryRows(env.WORLDCONS_OPS, `
    SELECT r.id FROM admin_command_runs r JOIN admin_commands c ON c.id=r.command_id
    WHERE c.command_type='p1.case-backfill.normalize' AND r.status IN ('queued','running','retry_wait') LIMIT 1
  `);
  if (activeCommands.length > 0) throw new Error("case_backfill.normalize_command_already_active");
  if ((await d1CaseBackfillRepository.listNonTerminalRuns(input.snapshotId, "normalize")).length > 0) throw new Error("case_backfill.normalize_run_already_active");
  if (await d1CaseBackfillRepository.countResidualClaims(input.snapshotId) > 0) throw new Error("case_backfill.residual_claims_present");
  const passRow = (await queryRows(env.WORLDCONS_INGEST, `SELECT COALESCE(MAX(pass_number),0)+1 AS next_pass FROM source_backfill_runs WHERE snapshot_id=? AND phase='normalize'`, [input.snapshotId]))[0];
  const nextPass = Number(passRow?.next_pass ?? 1);
  if (input.passNumber !== nextPass) throw new Error(`case_backfill.expected_pass_${nextPass}`);

  const payloadRef = { cohort: "catalog-backfill", snapshotId: input.snapshotId, passNumber: input.passNumber, batchLimit, parserVersion, normalizationContractVersion };
  const submitted = await d1AdminCommandRepository.submit({
    commandType: "p1.case-backfill.normalize", payloadRef,
    idempotencyKey: `backfill-pass:${input.snapshotId}:normalize:${input.passNumber}`,
    dedupeKey: `backfill-active:${input.snapshotId}:normalize`, requestedBy, priority: 90,
    maxAttempts: 1, retryBackoffBaseSeconds: 60, retryBackoffCapSeconds: 60, shadowOnly: false,
  });
  if (!submitted.ok) throw new Error(`case_backfill.command_submit_failed.${submitted.error.code}`);
  const claimedCommand = await d1AdminCommandRepository.claim({
    workerId: `cloudflare-backfill-normalize:${input.snapshotId}:${input.passNumber}`,
    commandTypes: ["p1.case-backfill.normalize"], cohorts: ["catalog-backfill"], leaseSeconds: 900,
  });
  if (!claimedCommand.ok) throw new Error(`case_backfill.command_claim_failed.${claimedCommand.error.code}`);
  if (!claimedCommand.data || claimedCommand.data.runId !== submitted.data.runId) {
    await d1AdminCommandRepository.abort({ runId: submitted.data.runId, requestedBy, reason: "exact normalize pass claim failed" });
    throw new Error("case_backfill.command_claim_mismatch");
  }
  const attempt = claimedCommand.data;
  const authority: CaseBackfillAttemptAuthority = { attemptId: attempt.attemptId, runId: attempt.runId, fencingToken: attempt.fencingToken, leaseExpiresAt: attempt.leaseExpiresAt };
  const passInput = { cohort: "catalog-backfill" as const, snapshotId: input.snapshotId, phase: "normalize" as const, passNumber: input.passNumber, batchLimit, parserVersion, normalizationContractVersion };
  const runId = await d1CaseBackfillRepository.beginRun(passInput, authority);
  let claimed = 0, succeeded = 0, retryableFailed = 0, terminalFailed = 0;
  try {
    while (claimed < batchLimit) {
      await heartbeat(authority);
      const [item] = await d1CaseBackfillRepository.claimItems({ ...passInput, batchLimit: 1 }, authority);
      if (!item) break;
      claimed += 1;
      try {
        if (!item.currentFetchArtifactId) throw new Error("case_backfill.fetch_artifact_missing");
        const fetchArtifact = await d1CaseBackfillRepository.getFetchArtifact(item.currentFetchArtifactId);
        const raw = await replayPayload(fetchArtifact, store);
        const exclusion = exclusionCode(raw);
        if (exclusion) {
          await d1CaseBackfillRepository.excludeItem({ itemId: item.itemId, phase: "normalize", authority, exclusionCode: exclusion });
          succeeded += 1;
          continue;
        }
        const normalized = normalizedArticle(item, raw);
        if (!normalized.canonicalUrl || !normalized.sourceKey) throw new Error("case_backfill.normalized_shape_invalid");
        const document = canonicalJson(normalized as unknown as Record<string, unknown>);
        const hash = createHash("sha256").update(document).digest("hex");
        const uploaded = await store.put({ kind: "normalization", sourceKey: SOURCE_KEY, bytes: Buffer.from(document, "utf8") });
        if (uploaded.sha256 !== hash || uploaded.size !== Buffer.byteLength(document)) throw new Error("case_backfill.artifact_blob_integrity_mismatch");
        const artifactId = await d1CaseBackfillRepository.recordNormalizationArtifact({
          itemId: item.itemId, authority, fetchArtifactId: fetchArtifact.id, parserVersion, normalizationContractVersion,
          normalizedOutput: null, normalizedOutputHash: hash, normalizedOutputStorageRef: uploaded.storageRef,
          normalizedOutputSize: uploaded.size, externalizationContractVersion: uploaded.contractVersion,
          validationStatus: "valid", validationErrors: [],
        });
        await d1CaseBackfillRepository.completeItem({ itemId: item.itemId, phase: "normalize", authority, nextStatus: item.resolutionStatus === "published" ? "published" : "normalized", resultMetadata: { artifactId } });
        succeeded += 1;
      } catch (error) {
        const isRetryable = retryable(error);
        await d1CaseBackfillRepository.failItem({
          itemId: item.itemId, phase: "normalize", authority, disposition: isRetryable ? "retryable" : "terminal",
          errorCode: boundedErrorCode(error), errorSummary: boundedErrorSummary(error),
          retryAt: isRetryable ? new Date(Date.now() + 5 * 60_000).toISOString() : null,
        });
        if (isRetryable) retryableFailed += 1; else terminalFailed += 1;
      }
    }
    const backlogRemaining = await d1CaseBackfillRepository.countBacklog(passInput) > 0;
    await d1CaseBackfillRepository.finishRun({ runId, authority, status: retryableFailed > 0 || terminalFailed > 0 ? "degraded" : "succeeded", claimed, succeeded, retryableFailed, terminalFailed });
    const transition = await d1AdminCommandRepository.complete(authority.attemptId, authority.fencingToken, { snapshotId: input.snapshotId, passNumber: input.passNumber, claimed, succeeded, retryableFailed, terminalFailed, backlogRemaining });
    if (!transition.ok) throw new Error(`case_backfill.command_complete_failed.${transition.error.code}`);
    return { schemaVersion: 1, snapshotId: input.snapshotId, passNumber: input.passNumber, claimed, succeeded, retryableFailed, terminalFailed, backlogRemaining };
  } catch (error) {
    try {
      if (await d1CaseBackfillRepository.countResidualClaims(input.snapshotId) === 0) {
        await d1CaseBackfillRepository.finishRun({ runId, authority, status: "failed", claimed, succeeded, retryableFailed, terminalFailed, lastErrorCode: boundedErrorCode(error), lastErrorSummary: boundedErrorSummary(error) });
      }
    } catch { /* preserve original error */ }
    await d1AdminCommandRepository.fail({ attemptId: authority.attemptId, fencingToken: authority.fencingToken, disposition: "terminal", errorCode: boundedErrorCode(error), errorMessage: boundedErrorSummary(error), resultSummary: { snapshotId: input.snapshotId, passNumber: input.passNumber, claimed, succeeded, retryableFailed, terminalFailed } }).catch(() => undefined);
    throw error;
  }
}

