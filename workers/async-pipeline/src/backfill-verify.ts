import { d1AdminCommandRepository } from "../../../lib/admin/command-control-plane/d1-repository";
import { d1CaseBackfillRepository } from "../../../lib/backfill/d1-repository";
import type { CaseBackfillAttemptAuthority, CaseBackfillClaimedItem, CaseBackfillNormalizationArtifact, CaseBackfillSnapshot } from "../../../lib/backfill/types";
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

export interface GermanyBackfillVerifyPayload {
  snapshotId: string;
  phase: "verify";
  passNumber: number;
  batchLimit?: number;
  maxPasses?: number;
  requestedBy?: string;
}

export interface GermanyBackfillVerifyEnv {
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

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0) : [];
}

function canonicalUrl(value: string) {
  try {
    const url = new URL(value);
    url.hash = "";
    if (/\/SharedDocs\/Entscheidungen\//i.test(url.pathname)) url.search = "";
    return url.toString();
  } catch {
    return value;
  }
}

function officialDecisionUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && ["www.bundesverfassungsgericht.de", "www.bverfg.de"].includes(url.hostname.toLowerCase())
      && /\/SharedDocs\/Entscheidungen\/(?:DE|EN)\/20\d{2}\/\d{2}\/[a-z]{2}\d{8}_[a-z0-9]+\.html$/i.test(url.pathname);
  } catch {
    return false;
  }
}

function docketKey(value: string) {
  return value.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function validationErrors(normalized: NormalizedArticle, item: CaseBackfillClaimedItem, snapshot: CaseBackfillSnapshot) {
  const errors: string[] = [];
  if (normalized.sourceKey !== snapshot.sourceKey) errors.push("source_key_mismatch");
  if (!officialDecisionUrl(normalized.canonicalUrl) || !officialDecisionUrl(normalized.originalUrl)) errors.push("authority_url_invalid");
  const candidates = stringArray(item.inventoryMetadata.officialUrlCandidates).map(canonicalUrl);
  if (candidates.length === 0 || !candidates.includes(canonicalUrl(normalized.canonicalUrl))) errors.push("official_url_candidate_mismatch");
  if (normalized.contentType !== "decision") errors.push("document_type_mismatch");
  const metadata = record(normalized.metadata);
  const decisionDate = text(metadata.decisionDate) || normalized.originalPublishedAt?.slice(0, 10) || "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(decisionDate)) errors.push("decision_date_missing");
  if (decisionDate && snapshot.scopeFrom && decisionDate < snapshot.scopeFrom.slice(0, 10)) errors.push("decision_date_before_scope");
  if (decisionDate && snapshot.scopeTo && decisionDate > snapshot.scopeTo.slice(0, 10)) errors.push("decision_date_after_scope");
  const inventoryDocket = text(item.inventoryMetadata.docket);
  const normalizedDocket = text(metadata.caseNumber);
  if (!inventoryDocket || !normalizedDocket || !docketKey(normalizedDocket).includes(docketKey(inventoryDocket))) errors.push("docket_mismatch");
  const collection = record(metadata.collection);
  if (collection.sourceUrlVerified !== true) errors.push("official_source_not_verified");
  if (collection.sourceTextAvailable !== true || collection.publishable !== true || !normalized.cleanedText?.trim()) errors.push("official_source_text_missing");
  if (!normalized.originalTitle?.trim()) errors.push("official_title_missing");
  return errors;
}

function retryable(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /r2_get_failed|artifact_blob\.not_found|timeout|network|temporar/i.test(message);
}

function boundedErrorCode(error: unknown) {
  const value = error instanceof Error ? error.message : String(error);
  return /^[a-z][a-z0-9._-]{0,159}$/.test(value) ? value : "case_backfill.verify_failed";
}

function boundedErrorSummary(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 500);
}

async function queryRows<T extends Row>(db: D1RuntimeDatabase, sql: string, values: unknown[] = []) {
  const result = await db.prepare(sql).bind(...values).all<T>();
  if (!result || result.success === false || result.error || !Array.isArray(result.results)) throw new Error(result?.error || "case_backfill.workflow_d1_read_failed");
  return result.results;
}

async function heartbeat(authority: CaseBackfillAttemptAuthority) {
  const result = await d1AdminCommandRepository.heartbeat(authority.attemptId, authority.fencingToken, 900);
  if (!result.ok) throw new Error(`case_backfill.${result.error.code}`);
  authority.leaseExpiresAt = result.data.leaseExpiresAt;
}

async function normalizedOutput(artifact: CaseBackfillNormalizationArtifact, store: ArtifactBlobStore): Promise<NormalizedArticle> {
  if (artifact.normalizedOutput) return artifact.normalizedOutput;
  if (!artifact.normalizedOutputStorageRef) throw new Error("case_backfill.normalization_artifact_not_found");
  if (artifact.externalizationContractVersion !== ARTIFACT_BLOB_CONTRACT_VERSION) throw new Error("case_backfill.artifact_blob_contract_unsupported");
  const bytes = await store.get(artifact.normalizedOutputStorageRef);
  if (artifact.normalizedOutputSize !== null && artifact.normalizedOutputSize !== undefined && bytes.byteLength !== artifact.normalizedOutputSize) {
    throw new Error("case_backfill.artifact_blob_integrity_mismatch");
  }
  if (sha256Hex(bytes) !== artifact.normalizedOutputHash) throw new Error("case_backfill.artifact_blob_integrity_mismatch");
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("case_backfill.artifact_blob_invalid_document"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("case_backfill.artifact_blob_invalid_document");
  return parsed as NormalizedArticle;
}

export function parseGermanyBackfillVerifyPayload(value: unknown): GermanyBackfillVerifyPayload | null {
  let candidate = value;
  if (typeof candidate === "string") { try { candidate = JSON.parse(candidate); } catch { return null; } }
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
  const payload = candidate as Record<string, unknown>;
  const keys = Object.keys(payload);
  if (keys.some((key) => !["snapshotId","phase","passNumber","batchLimit","maxPasses","requestedBy"].includes(key))) return null;
  if (
    !isApprovedGermanyBackfillSnapshotId(payload.snapshotId) || payload.phase !== "verify"
    || !Number.isInteger(payload.passNumber) || Number(payload.passNumber) < 1 || Number(payload.passNumber) > 2_147_483_647
    || (payload.batchLimit !== undefined && (!Number.isInteger(payload.batchLimit) || Number(payload.batchLimit) < 1 || Number(payload.batchLimit) > 50))
    || (payload.maxPasses !== undefined && (!Number.isInteger(payload.maxPasses) || Number(payload.maxPasses) < 1 || Number(payload.maxPasses) > 10))
    || (payload.requestedBy !== undefined && (typeof payload.requestedBy !== "string" || payload.requestedBy.trim().length < 1 || payload.requestedBy.length > 160))
  ) return null;
  return payload as unknown as GermanyBackfillVerifyPayload;
}

export async function runGermanyBackfillVerifyPass(env: GermanyBackfillVerifyEnv, input: GermanyBackfillVerifyPayload) {
  if (env.CASE_CATALOG_GERMANY_HISTORY_ENABLED !== "true") throw new Error("case_backfill.germany_history_disabled");
  const expectedSourcePolicyVersion = germanyBackfillSourcePolicyVersion(input.snapshotId);
  if (!expectedSourcePolicyVersion) throw new Error("case_backfill.germany_snapshot_not_approved");
  const batchLimit = Math.max(1, Math.min(input.batchLimit ?? 25, 50));
  const requestedBy = input.requestedBy?.trim() || "worldcons-backfill-verify-workflow";
  setRuntimeD1Bindings({ worldcons_ops: env.WORLDCONS_OPS, worldcons_core: env.WORLDCONS_CORE, worldcons_ingest: env.WORLDCONS_INGEST, worldcons_search: env.WORLDCONS_SEARCH });
  const store = new ArtifactBlobStore(createR2BindingArtifactBlobTransport({ bucket: env.WORLDCONS_RAW }));
  const snapshot = await d1CaseBackfillRepository.getSnapshot(input.snapshotId);
  if (snapshot.sourceKey !== SOURCE_KEY || snapshot.status !== "closed" || snapshot.sourcePolicyVersion !== expectedSourcePolicyVersion) throw new Error("case_backfill.germany_snapshot_contract_mismatch");
  const active = await queryRows(env.WORLDCONS_OPS, `SELECT r.id FROM admin_command_runs r JOIN admin_commands c ON c.id=r.command_id WHERE c.command_type='p1.case-backfill.verify' AND r.status IN ('queued','running','retry_wait') LIMIT 1`);
  if (active.length > 0) throw new Error("case_backfill.verify_command_already_active");
  if ((await d1CaseBackfillRepository.listNonTerminalRuns(input.snapshotId, "verify")).length > 0) throw new Error("case_backfill.verify_run_already_active");
  if (await d1CaseBackfillRepository.countResidualClaims(input.snapshotId) > 0) throw new Error("case_backfill.residual_claims_present");
  const passRow = (await queryRows(env.WORLDCONS_INGEST, `SELECT COALESCE(MAX(pass_number),0)+1 AS next_pass FROM source_backfill_runs WHERE snapshot_id=? AND phase='verify'`, [input.snapshotId]))[0];
  const nextPass = Number(passRow?.next_pass ?? 1);
  if (input.passNumber !== nextPass) throw new Error(`case_backfill.expected_pass_${nextPass}`);
  const payloadRef = { cohort: "catalog-backfill", snapshotId: input.snapshotId, passNumber: input.passNumber, batchLimit };
  const submitted = await d1AdminCommandRepository.submit({ commandType: "p1.case-backfill.verify", payloadRef,
    idempotencyKey: `backfill-pass:${input.snapshotId}:verify:${input.passNumber}`, dedupeKey: `backfill-active:${input.snapshotId}:verify`,
    requestedBy, priority: 80, maxAttempts: 1, retryBackoffBaseSeconds: 60, retryBackoffCapSeconds: 60, shadowOnly: false });
  if (!submitted.ok) throw new Error(`case_backfill.command_submit_failed.${submitted.error.code}`);
  const claimedCommand = await d1AdminCommandRepository.claim({ workerId: `cloudflare-backfill-verify:${input.snapshotId}:${input.passNumber}`, commandTypes: ["p1.case-backfill.verify"], cohorts: ["catalog-backfill"], leaseSeconds: 900 });
  if (!claimedCommand.ok) throw new Error(`case_backfill.command_claim_failed.${claimedCommand.error.code}`);
  if (!claimedCommand.data || claimedCommand.data.runId !== submitted.data.runId) {
    await d1AdminCommandRepository.abort({ runId: submitted.data.runId, requestedBy, reason: "exact verify pass claim failed" });
    throw new Error("case_backfill.command_claim_mismatch");
  }
  const attempt = claimedCommand.data;
  const authority: CaseBackfillAttemptAuthority = { attemptId: attempt.attemptId, runId: attempt.runId, fencingToken: attempt.fencingToken, leaseExpiresAt: attempt.leaseExpiresAt };
  const passInput = { cohort: "catalog-backfill" as const, snapshotId: input.snapshotId, phase: "verify" as const, passNumber: input.passNumber, batchLimit };
  const runId = await d1CaseBackfillRepository.beginRun(passInput, authority);
  let claimed = 0, succeeded = 0, retryableFailed = 0, terminalFailed = 0;
  try {
    while (claimed < batchLimit) {
      await heartbeat(authority);
      const [item] = await d1CaseBackfillRepository.claimItems({ ...passInput, batchLimit: 1 }, authority);
      if (!item) break;
      claimed += 1;
      try {
        if (!item.currentNormalizationArtifactId) throw new Error("case_backfill.normalization_artifact_missing");
        const artifact = await d1CaseBackfillRepository.getNormalizationArtifact(item.currentNormalizationArtifactId, item.itemId);
        const normalized = await normalizedOutput(artifact, store);
        const errors = validationErrors(normalized, item, snapshot);
        if (errors.length > 0) throw new Error(`case_backfill.verification_${errors[0]}`);
        await d1CaseBackfillRepository.completeItem({ itemId: item.itemId, phase: "verify", authority,
          nextStatus: item.resolutionStatus === "published" ? "published" : "verified",
          resultMetadata: { artifactId: item.currentNormalizationArtifactId, noop: false } });
        succeeded += 1;
      } catch (error) {
        const isRetryable = retryable(error);
        await d1CaseBackfillRepository.failItem({ itemId: item.itemId, phase: "verify", authority,
          disposition: isRetryable ? "retryable" : "terminal", errorCode: boundedErrorCode(error), errorSummary: boundedErrorSummary(error),
          retryAt: isRetryable ? new Date(Date.now() + 5 * 60_000).toISOString() : null });
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
      if (await d1CaseBackfillRepository.countResidualClaims(input.snapshotId) === 0) await d1CaseBackfillRepository.finishRun({ runId, authority, status: "failed", claimed, succeeded, retryableFailed, terminalFailed, lastErrorCode: boundedErrorCode(error), lastErrorSummary: boundedErrorSummary(error) });
    } catch { /* preserve original */ }
    await d1AdminCommandRepository.fail({ attemptId: authority.attemptId, fencingToken: authority.fencingToken, disposition: "terminal", errorCode: boundedErrorCode(error), errorMessage: boundedErrorSummary(error), resultSummary: { snapshotId: input.snapshotId, passNumber: input.passNumber, claimed, succeeded, retryableFailed, terminalFailed } }).catch(() => undefined);
    throw error;
  }
}

