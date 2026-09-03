import { getSupabaseServiceRoleAdmin } from "@/lib/db/client";
import type {
  CaseBackfillAttemptAuthority,
  CaseBackfillClaimedItem,
  CaseBackfillFetchArtifact,
  CaseBackfillItemPhase,
  CaseBackfillNormalizationArtifact,
  CaseBackfillPassInput,
  CaseBackfillPublicationResult,
  CaseBackfillSnapshot,
  CaseBackfillSnapshotStatus,
  CaseBackfillSourcePolicy,
} from "@/lib/backfill/types";

type Row = Record<string, unknown>;

function isRecord(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstRow(value: unknown) {
  if (Array.isArray(value)) return isRecord(value[0]) ? value[0] : null;
  return isRecord(value) ? value : null;
}

function text(row: Row, key: string) {
  return typeof row[key] === "string" ? row[key] as string : "";
}

function nullableText(row: Row, key: string) {
  return typeof row[key] === "string" ? row[key] as string : null;
}

function numberValue(row: Row, key: string) {
  const value = row[key];
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : 0;
  return Number.isFinite(number) ? number : 0;
}

function nullableNumber(row: Row, key: string) {
  return row[key] === null || row[key] === undefined ? null : numberValue(row, key);
}

function recordValue(row: Row, key: string) {
  return isRecord(row[key]) ? row[key] as Record<string, unknown> : null;
}

function requiredClient() {
  const client = getSupabaseServiceRoleAdmin();
  if (!client) throw new Error("case_backfill.database_unavailable");
  return client;
}

function databaseError(error: { message?: string } | null) {
  if (error) throw new Error(error.message || "case_backfill.database_error");
}

function mapClaim(row: Row): CaseBackfillClaimedItem {
  return {
    itemId: text(row, "item_id"),
    stableItemKey: text(row, "stable_item_key"),
    sourceRecordId: nullableText(row, "source_record_id"),
    discoveredUrl: text(row, "discovered_url"),
    authorityUrl: nullableText(row, "authority_url"),
    documentType: nullableText(row, "document_type"),
    decisionDateHint: nullableText(row, "decision_date_hint"),
    resolutionStatus: text(row, "resolution_status"),
    currentFetchArtifactId: nullableText(row, "current_fetch_artifact_id"),
    currentNormalizationArtifactId: nullableText(row, "current_normalization_artifact_id"),
    verifiedNormalizationArtifactId: nullableText(row, "verified_normalization_artifact_id"),
    publishedNormalizationArtifactId: nullableText(row, "published_normalization_artifact_id"),
    itemLeaseExpiresAt: text(row, "item_lease_expires_at"),
  };
}

export interface OpenCaseBackfillSnapshotInput {
  sourceKey: string;
  scopeFrom: string | null;
  scopeTo: string | null;
  documentType: string;
  discoveryMethod: string;
  parserVersion: string;
  sourcePolicyVersion: string;
  coverageAssurance: string;
  expectedCount: number | null;
  expectedCountBasis: string | null;
  coverageEvidence: Record<string, unknown>;
  exclusions: unknown[];
  createdBy: string;
}

export interface InventoryItemInput {
  snapshotId: string;
  stableItemKey: string;
  sourceRecordId: string | null;
  discoveredUrl: string;
  documentType: string;
  decisionDateHint: string | null;
}

export interface RecordFetchArtifactInput {
  itemId: string;
  authority: CaseBackfillAttemptAuthority;
  sourcePolicyVersion: string;
  authorityUrl: string;
  httpStatus: number;
  responseHeaders: Record<string, unknown>;
  sourceEtag: string | null;
  sourceLastModifiedAt: string | null;
  payloadHash: string;
  payloadSize: number;
  replayability: "full_snapshot" | "bounded_evidence" | "non_replayable";
  immutableStorageRef: string | null;
  boundedReplayPayload: Record<string, unknown> | null;
  fetchContractVersion: string;
}

export interface RecordNormalizationArtifactInput {
  itemId: string;
  authority: CaseBackfillAttemptAuthority;
  fetchArtifactId: string;
  parserVersion: string;
  normalizationContractVersion: string;
  normalizedOutput: Record<string, unknown>;
  normalizedOutputHash: string;
  validationStatus: "valid" | "invalid";
  validationErrors: unknown[];
}

export interface AcquireSourceRequestPermitInput {
  snapshotId: string;
  phase: "discover" | "fetch";
  authority: CaseBackfillAttemptAuthority;
  requestOrigin: string;
  requestedLeaseSeconds: number;
}

export interface SourceRequestPermitResult {
  granted: boolean;
  permitId: string | null;
  retryAfterMs: number;
  permitLeaseExpiresAt: string | null;
}

export interface CaseBackfillRepository {
  openSnapshot(input: OpenCaseBackfillSnapshotInput): Promise<string>;
  upsertInventoryItem(input: InventoryItemInput): Promise<string>;
  updateSnapshotEvidence(
    snapshotId: string,
    coverageEvidence: Record<string, unknown>,
    expectedCount?: number | null,
    expectedCountBasis?: string | null,
  ): Promise<void>;
  closeSnapshot(snapshotId: string): Promise<CaseBackfillSnapshotStatus>;
  getSnapshot(snapshotId: string): Promise<CaseBackfillSnapshot>;
  getSourcePolicy(sourceKey: string, policyVersion: string): Promise<CaseBackfillSourcePolicy>;
  getSnapshotStatus(snapshotId: string): Promise<CaseBackfillSnapshotStatus>;
  acquireSourceRequestPermit(input: AcquireSourceRequestPermitInput): Promise<SourceRequestPermitResult>;
  releaseSourceRequestPermit(input: {
    permitId: string;
    authority: CaseBackfillAttemptAuthority;
  }): Promise<void>;
  beginRun(input: CaseBackfillPassInput, authority: CaseBackfillAttemptAuthority): Promise<string>;
  allocatePass(snapshotId: string, phase: CaseBackfillPassInput["phase"]): Promise<number>;
  finishRun(input: {
    runId: string;
    authority: CaseBackfillAttemptAuthority;
    status: "succeeded" | "degraded" | "failed" | "aborted";
    claimed: number;
    succeeded: number;
    retryableFailed: number;
    terminalFailed: number;
    lastErrorCode?: string | null;
    lastErrorSummary?: string | null;
  }): Promise<void>;
  countBacklog(input: CaseBackfillPassInput): Promise<number>;
  claimItems(input: CaseBackfillPassInput, authority: CaseBackfillAttemptAuthority): Promise<CaseBackfillClaimedItem[]>;
  extendItems(itemIds: string[], phase: CaseBackfillItemPhase, authority: CaseBackfillAttemptAuthority): Promise<number>;
  recordFetchArtifact(input: RecordFetchArtifactInput): Promise<string>;
  getFetchArtifact(artifactId: string): Promise<CaseBackfillFetchArtifact>;
  getNormalizationArtifact(artifactId: string, itemId?: string): Promise<CaseBackfillNormalizationArtifact>;
  recordNormalizationArtifact(input: RecordNormalizationArtifactInput): Promise<string>;
  publishItem(input: {
    itemId: string;
    authority: CaseBackfillAttemptAuthority;
    actorId?: string;
  }): Promise<CaseBackfillPublicationResult>;
  completeItem(input: {
    itemId: string;
    phase: CaseBackfillItemPhase;
    authority: CaseBackfillAttemptAuthority;
    nextStatus: string;
    resultMetadata: Record<string, unknown>;
  }): Promise<void>;
  failItem(input: {
    itemId: string;
    phase: CaseBackfillItemPhase;
    authority: CaseBackfillAttemptAuthority;
    disposition: "retryable" | "terminal";
    errorCode: string;
    errorSummary: string;
    retryAt: string | null;
  }): Promise<void>;
}

export const postgresCaseBackfillRepository: CaseBackfillRepository = {
  async openSnapshot(input) {
    const { data, error } = await requiredClient().rpc("source_inventory_snapshot_open_v1", {
      p_source_key: input.sourceKey,
      p_scope_from: input.scopeFrom,
      p_scope_to: input.scopeTo,
      p_document_type: input.documentType,
      p_discovery_method: input.discoveryMethod,
      p_parser_version: input.parserVersion,
      p_source_policy_version: input.sourcePolicyVersion,
      p_coverage_assurance: input.coverageAssurance,
      p_expected_count: input.expectedCount,
      p_expected_count_basis: input.expectedCountBasis,
      p_coverage_evidence: input.coverageEvidence,
      p_exclusions: input.exclusions,
      p_created_by: input.createdBy,
    });
    databaseError(error);
    if (typeof data !== "string") throw new Error("case_backfill.snapshot_open_failed");
    return data;
  },

  async upsertInventoryItem(input) {
    const { data, error } = await requiredClient().rpc("source_inventory_item_upsert_v1", {
      p_snapshot_id: input.snapshotId,
      p_stable_item_key: input.stableItemKey,
      p_source_record_id: input.sourceRecordId,
      p_discovered_url: input.discoveredUrl,
      p_document_type: input.documentType,
      p_decision_date_hint: input.decisionDateHint,
    });
    databaseError(error);
    if (typeof data !== "string") throw new Error("case_backfill.inventory_write_failed");
    return data;
  },

  async updateSnapshotEvidence(snapshotId, coverageEvidence, expectedCount = null, expectedCountBasis = null) {
    const { data, error } = await requiredClient().rpc("source_inventory_snapshot_evidence_v2", {
      p_snapshot_id: snapshotId,
      p_coverage_evidence: coverageEvidence,
      p_expected_count: expectedCount,
      p_expected_count_basis: expectedCountBasis,
    });
    databaseError(error);
    if (data !== true) throw new Error("case_backfill.snapshot_evidence_write_failed");
  },

  async closeSnapshot(snapshotId) {
    const { data, error } = await requiredClient().rpc("source_inventory_snapshot_close_v1", { p_snapshot_id: snapshotId });
    databaseError(error);
    const status = firstRow(data);
    if (!status) throw new Error("case_backfill.snapshot_close_failed");
    return this.getSnapshotStatus(snapshotId);
  },

  async getSnapshot(snapshotId) {
    const { data, error } = await requiredClient()
      .from("source_inventory_snapshots")
      .select("id, source_key, scope_from, scope_to, document_type, parser_version, source_policy_version, status")
      .eq("id", snapshotId)
      .single();
    databaseError(error);
    if (!isRecord(data)) throw new Error("case_backfill.snapshot_not_found");
    return {
      id: text(data, "id"),
      sourceKey: text(data, "source_key"),
      scopeFrom: nullableText(data, "scope_from"),
      scopeTo: nullableText(data, "scope_to"),
      documentType: text(data, "document_type"),
      parserVersion: text(data, "parser_version"),
      sourcePolicyVersion: text(data, "source_policy_version"),
      status: text(data, "status"),
    };
  },

  async getSourcePolicy(sourceKey, policyVersion) {
    const { data, error } = await requiredClient()
      .from("source_corpus_policies")
      .select("source_key, policy_version, normalize_replay_policy, bounded_replay_fields, min_request_delay_ms, max_concurrency, review_due_at")
      .eq("source_key", sourceKey)
      .eq("policy_version", policyVersion)
      .single();
    databaseError(error);
    if (!isRecord(data)) throw new Error("case_backfill.policy_not_found");
    const replayPolicy = text(data, "normalize_replay_policy");
    if (!["full_snapshot", "bounded_evidence", "non_replayable"].includes(replayPolicy)) {
      throw new Error("case_backfill.policy_invalid");
    }
    return {
      sourceKey: text(data, "source_key"),
      policyVersion: text(data, "policy_version"),
      normalizeReplayPolicy: replayPolicy as CaseBackfillSourcePolicy["normalizeReplayPolicy"],
      boundedReplayFields: Array.isArray(data.bounded_replay_fields)
        ? data.bounded_replay_fields.filter((entry): entry is string => typeof entry === "string")
        : [],
      minRequestDelayMs: numberValue(data, "min_request_delay_ms"),
      maxConcurrency: numberValue(data, "max_concurrency"),
      reviewDueAt: text(data, "review_due_at"),
    };
  },

  async acquireSourceRequestPermit(input) {
    const { data, error } = await requiredClient().rpc("source_backfill_request_permit_acquire_v1", {
      p_snapshot_id: input.snapshotId,
      p_phase: input.phase,
      p_p1_attempt_id: input.authority.attemptId,
      p_p1_fencing_token: input.authority.fencingToken,
      p_request_origin: input.requestOrigin,
      p_requested_lease_seconds: input.requestedLeaseSeconds,
    });
    databaseError(error);
    const row = firstRow(data);
    if (!row || typeof row.granted !== "boolean") {
      throw new Error("case_backfill.request_permit_invalid");
    }
    return {
      granted: row.granted,
      permitId: nullableText(row, "permit_id"),
      retryAfterMs: numberValue(row, "retry_after_ms"),
      permitLeaseExpiresAt: nullableText(row, "permit_lease_expires_at"),
    };
  },

  async releaseSourceRequestPermit(input) {
    const { data, error } = await requiredClient().rpc("source_backfill_request_permit_release_v1", {
      p_permit_id: input.permitId,
      p_p1_attempt_id: input.authority.attemptId,
      p_p1_fencing_token: input.authority.fencingToken,
    });
    databaseError(error);
    if (data !== true) throw new Error("case_backfill.request_permit_release_failed");
  },

  async getSnapshotStatus(snapshotId) {
    const { data, error } = await requiredClient().rpc("source_backfill_snapshot_status_v1", { p_snapshot_id: snapshotId });
    databaseError(error);
    const row = firstRow(data);
    if (!row) throw new Error("case_backfill.snapshot_not_found");
    return {
      snapshotId: text(row, "snapshot_id"),
      sourceKey: text(row, "source_key"),
      snapshotStatus: text(row, "snapshot_status"),
      discoveredTotal: numberValue(row, "discovered_total"),
      terminalTotal: numberValue(row, "terminal_total"),
      processingCompletion: numberValue(row, "processing_completion"),
      expectedCount: nullableNumber(row, "expected_count"),
      coverageAssurance: text(row, "coverage_assurance") as CaseBackfillSnapshotStatus["coverageAssurance"],
      corpusCoverage: nullableNumber(row, "corpus_coverage"),
      claimed: numberValue(row, "claimed"),
      retryWait: numberValue(row, "retry_wait"),
      needsNormalize: numberValue(row, "needs_normalize"),
      needsReverify: numberValue(row, "needs_reverify"),
      needsRepublish: numberValue(row, "needs_republish"),
      failed: numberValue(row, "failed"),
      currentConformant: numberValue(row, "current_conformant"),
      currentConformance: numberValue(row, "current_conformance"),
      manifestHash: nullableText(row, "manifest_hash"),
    };
  },

  async beginRun(input, authority) {
    const { data, error } = await requiredClient().rpc("source_backfill_run_begin_v1", {
      p_snapshot_id: input.snapshotId,
      p_phase: input.phase,
      p_pass_number: input.passNumber,
      p_attempt_id: authority.attemptId,
      p_fencing_token: authority.fencingToken,
    });
    databaseError(error);
    if (typeof data !== "string") throw new Error("case_backfill.run_begin_failed");
    return data;
  },

  async allocatePass(snapshotId, phase) {
    const { data, error } = await requiredClient().rpc("source_backfill_pass_allocate_v1", {
      p_snapshot_id: snapshotId,
      p_phase: phase,
    });
    databaseError(error);
    const pass = typeof data === "number" ? data : Number(data);
    if (!Number.isInteger(pass) || pass < 1) throw new Error("case_backfill.pass_allocate_failed");
    return pass;
  },

  async finishRun(input) {
    const { data, error } = await requiredClient().rpc("source_backfill_run_finish_v1", {
      p_run_id: input.runId,
      p_p1_attempt_id: input.authority.attemptId,
      p_p1_fencing_token: input.authority.fencingToken,
      p_status: input.status,
      p_claimed_count: input.claimed,
      p_succeeded_count: input.succeeded,
      p_retryable_failed_count: input.retryableFailed,
      p_terminal_failed_count: input.terminalFailed,
      p_last_error_code: input.lastErrorCode ?? null,
      p_last_error_summary: input.lastErrorSummary ?? null,
    });
    databaseError(error);
    if (data !== true) throw new Error("case_backfill.run_finish_failed");
  },

  async countBacklog(input) {
    const targetVersion = input.phase === "fetch"
      ? input.fetchContractVersion ?? "spain-hj-fetch-v1"
      : input.phase === "normalize"
        ? `${input.parserVersion ?? "spain-hj-normalize-v1"}:${input.normalizationContractVersion ?? "case-normalized-v1"}`
        : null;
    const { data, error } = await requiredClient().rpc("source_backfill_phase_backlog_count_v1", {
      p_snapshot_id: input.snapshotId,
      p_phase: input.phase,
      p_target_version: targetVersion,
    });
    databaseError(error);
    const count = typeof data === "number" ? data : Number(data ?? 0);
    if (!Number.isFinite(count) || count < 0) throw new Error("case_backfill.backlog_count_invalid");
    return count;
  },

  async claimItems(input, authority) {
    const targetVersion = input.phase === "fetch"
      ? input.fetchContractVersion ?? "spain-hj-fetch-v1"
      : input.phase === "normalize"
        ? `${input.parserVersion ?? "spain-hj-normalize-v1"}:${input.normalizationContractVersion ?? "case-normalized-v1"}`
        : null;
    const { data, error } = await requiredClient().rpc("source_backfill_items_claim_v1", {
      p_snapshot_id: input.snapshotId,
      p_phase: input.phase,
      p_batch_limit: input.batchLimit,
      p_p1_attempt_id: authority.attemptId,
      p_p1_fencing_token: authority.fencingToken,
      p_requested_lease_seconds: 180,
      p_target_version: targetVersion,
    });
    databaseError(error);
    return Array.isArray(data) ? data.filter(isRecord).map(mapClaim) : [];
  },

  async extendItems(itemIds, phase, authority) {
    const { data, error } = await requiredClient().rpc("source_backfill_items_extend_v1", {
      p_item_ids: itemIds,
      p_phase: phase,
      p_p1_attempt_id: authority.attemptId,
      p_p1_fencing_token: authority.fencingToken,
      p_requested_lease_seconds: 180,
    });
    databaseError(error);
    return typeof data === "number" ? data : Number(data ?? 0);
  },

  async recordFetchArtifact(input) {
    const { data, error } = await requiredClient().rpc("source_backfill_fetch_artifact_record_v1", {
      p_item_id: input.itemId,
      p_p1_attempt_id: input.authority.attemptId,
      p_p1_fencing_token: input.authority.fencingToken,
      p_source_policy_version: input.sourcePolicyVersion,
      p_authority_url: input.authorityUrl,
      p_http_status: input.httpStatus,
      p_response_headers: input.responseHeaders,
      p_source_etag: input.sourceEtag,
      p_source_last_modified_at: input.sourceLastModifiedAt,
      p_payload_hash: input.payloadHash,
      p_payload_size: input.payloadSize,
      p_replayability: input.replayability,
      p_immutable_storage_ref: input.immutableStorageRef,
      p_bounded_replay_payload: input.boundedReplayPayload,
      p_fetch_contract_version: input.fetchContractVersion,
    });
    databaseError(error);
    if (typeof data !== "string") throw new Error("case_backfill.fetch_artifact_failed");
    return data;
  },

  async getFetchArtifact(artifactId) {
    const { data, error } = await requiredClient()
      .from("source_fetch_artifacts")
      .select("id, item_id, source_policy_version, authority_url, payload_hash, replayability, immutable_storage_ref, bounded_replay_payload, fetch_contract_version")
      .eq("id", artifactId)
      .single();
    databaseError(error);
    if (!isRecord(data)) throw new Error("case_backfill.fetch_artifact_not_found");
    const replayability = text(data, "replayability");
    if (!["full_snapshot", "bounded_evidence", "non_replayable"].includes(replayability)) {
      throw new Error("case_backfill.fetch_artifact_invalid");
    }
    return {
      id: text(data, "id"),
      itemId: text(data, "item_id"),
      sourcePolicyVersion: text(data, "source_policy_version"),
      authorityUrl: text(data, "authority_url"),
      payloadHash: text(data, "payload_hash"),
      replayability: replayability as CaseBackfillFetchArtifact["replayability"],
      immutableStorageRef: nullableText(data, "immutable_storage_ref"),
      boundedReplayPayload: recordValue(data, "bounded_replay_payload"),
      fetchContractVersion: text(data, "fetch_contract_version"),
    };
  },

  async getNormalizationArtifact(artifactId, itemId) {
    let query = requiredClient()
      .from("source_normalization_artifacts")
      .select("id, item_id, fetch_artifact_id, parser_version, normalization_contract_version, normalized_output, normalized_output_hash, validation_status")
      .eq("id", artifactId);
    if (itemId) query = query.eq("item_id", itemId);
    const { data, error } = await query.single();
    databaseError(error);
    if (!isRecord(data) || !isRecord(data.normalized_output)) throw new Error("case_backfill.normalization_artifact_not_found");
    const validationStatus = text(data, "validation_status");
    if (!["valid", "invalid"].includes(validationStatus)) throw new Error("case_backfill.normalization_artifact_invalid");
    return {
      id: text(data, "id"),
      itemId: text(data, "item_id"),
      fetchArtifactId: text(data, "fetch_artifact_id"),
      parserVersion: text(data, "parser_version"),
      normalizationContractVersion: text(data, "normalization_contract_version"),
      normalizedOutput: data.normalized_output as unknown as CaseBackfillNormalizationArtifact["normalizedOutput"],
      normalizedOutputHash: text(data, "normalized_output_hash"),
      validationStatus: validationStatus as CaseBackfillNormalizationArtifact["validationStatus"],
    };
  },

  async recordNormalizationArtifact(input) {
    const { data, error } = await requiredClient().rpc("source_backfill_normalization_artifact_record_v1", {
      p_item_id: input.itemId,
      p_p1_attempt_id: input.authority.attemptId,
      p_p1_fencing_token: input.authority.fencingToken,
      p_fetch_artifact_id: input.fetchArtifactId,
      p_parser_version: input.parserVersion,
      p_normalization_contract_version: input.normalizationContractVersion,
      p_normalized_output: input.normalizedOutput,
      p_normalized_output_hash: input.normalizedOutputHash,
      p_validation_status: input.validationStatus,
      p_validation_errors: input.validationErrors,
    });
    databaseError(error);
    if (typeof data !== "string") throw new Error("case_backfill.normalization_artifact_failed");
    return data;
  },

  async publishItem(input) {
    const { data, error } = await requiredClient().rpc("case_catalog_publish_backfill_item_v1", {
      p_item_id: input.itemId,
      p_p1_attempt_id: input.authority.attemptId,
      p_p1_fencing_token: input.authority.fencingToken,
      p_actor_id: input.actorId ?? "case-backfill-worker",
    });
    databaseError(error);
    const row = firstRow(data);
    if (!row) throw new Error("case_backfill.catalog_publish_failed");
    return {
      articleId: text(row, "article_id"),
      versionId: text(row, "version_id"),
      versionRevision: numberValue(row, "version_revision"),
      publicationRevision: numberValue(row, "publication_revision"),
      articleSlug: text(row, "article_slug"),
    };
  },

  async completeItem(input) {
    const { error } = await requiredClient().rpc("source_backfill_item_complete_v1", {
      p_item_id: input.itemId,
      p_phase: input.phase,
      p_p1_attempt_id: input.authority.attemptId,
      p_p1_fencing_token: input.authority.fencingToken,
      p_next_status: input.nextStatus,
      p_result_metadata: input.resultMetadata,
    });
    databaseError(error);
  },

  async failItem(input) {
    const { error } = await requiredClient().rpc("source_backfill_item_fail_v1", {
      p_item_id: input.itemId,
      p_phase: input.phase,
      p_p1_attempt_id: input.authority.attemptId,
      p_p1_fencing_token: input.authority.fencingToken,
      p_disposition: input.disposition,
      p_error_code: input.errorCode,
      p_error_summary: input.errorSummary,
      p_retry_at: input.retryAt,
    });
    databaseError(error);
  },
};
