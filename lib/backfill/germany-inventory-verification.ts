import { germanyBverfgYearScope } from "@/lib/backfill/germany-scope";
import {
  discoverBverfgInventory,
  type BverfgInventoryResult,
} from "@/lib/crawlee/bverfg-inventory";
import { isBverfgOfficialDecisionUrl } from "@/lib/crawlee/bverfg-spider";
import { createHash } from "@/lib/utils/hash";

const SAFE_DETAIL_KEYS = new Set([
  "page",
  "scopedRecordCount",
  "resolvedOfficialUrlCount",
  "storesExternalText",
]);

function verificationError(code: string): never {
  throw new Error(`case_backfill.bverfg_inventory_verification.${code}`);
}

function numberEvidence(evidence: Record<string, unknown>, key: string) {
  const value = evidence[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function artifactDigest(result: BverfgInventoryResult) {
  const input = result.enumerationArtifacts.map((artifact) => [
    artifact.providerKey,
    artifact.artifactKind,
    artifact.sequenceNumber,
    artifact.requestUrl,
    artifact.responseHash,
    artifact.recordManifestHash,
    artifact.recordCount,
    artifact.newestDecisionDate ?? "",
    artifact.oldestDecisionDate ?? "",
    artifact.observedLastPage ?? "",
  ].join("|")).join("\n");
  return createHash(input, 64);
}

export function validateBverfgInventoryResult(result: BverfgInventoryResult) {
  const scope = germanyBverfgYearScope(result.year);
  if (result.sourceKey !== "de-bverfg" || result.documentType !== "DECISION") {
    verificationError("scope_mismatch");
  }
  if (result.items.length === 0) verificationError("empty_scope");
  if (new Set(result.items.map((item) => item.stableItemKey)).size !== result.items.length) {
    verificationError("duplicate_stable_item_key");
  }
  if (result.items.some((item) => (
    item.decisionDateHint < scope.scopeFrom
    || item.decisionDateHint > scope.scopeTo
    || item.inventoryMetadata.sourceUrlVerified !== false
  ))) {
    verificationError("item_scope_or_authority_state_invalid");
  }
  for (const item of result.items) {
    const candidates = item.inventoryMetadata.officialUrlCandidates;
    if (!Array.isArray(candidates) || candidates.some((value) => (
      typeof value !== "string" || !isBverfgOfficialDecisionUrl(value)
    ))) {
      verificationError("official_url_candidate_invalid");
    }
  }

  const pageArtifacts = result.enumerationArtifacts.filter((artifact) => artifact.artifactKind === "page");
  const boundaryArtifacts = result.enumerationArtifacts.filter((artifact) => artifact.artifactKind === "boundary_probe");
  if (
    pageArtifacts.length !== result.pageCount
    || result.requestCount !== result.enumerationArtifacts.length
    || boundaryArtifacts.length !== 1
    || boundaryArtifacts[0].sequenceNumber !== 1
  ) {
    verificationError("artifact_cardinality_invalid");
  }
  if (pageArtifacts.some((artifact, index) => artifact.sequenceNumber !== index + 1)) {
    verificationError("page_sequence_invalid");
  }
  for (const artifact of result.enumerationArtifacts) {
    let requestHost = "";
    try {
      requestHost = new URL(artifact.requestUrl).hostname.toLowerCase();
    } catch {
      verificationError("artifact_url_invalid");
    }
    if (
      artifact.providerKey !== "dejure.org"
      || requestHost !== "dejure.org"
      || !/^[0-9a-f]{64}$/.test(artifact.responseHash)
      || !/^[0-9a-f]{64}$/.test(artifact.recordManifestHash)
      || artifact.safeDetails.storesExternalText !== false
      || Object.keys(artifact.safeDetails).some((key) => !SAFE_DETAIL_KEYS.has(key))
    ) {
      verificationError("artifact_contract_invalid");
    }
  }

  const evidence = result.coverageEvidence;
  const unresolvedOfficialUrlCount = result.items.filter((item) => (
    (item.inventoryMetadata.officialUrlCandidates as unknown[]).length === 0
  )).length;
  if (
    evidence.method !== "external_index_dejure_paged_listing"
    || evidence.coverageAssurance !== "external_index_assisted"
    || evidence.officialCorpusCoverageClaimed !== false
    || evidence.crossedOlderBoundary !== true
    || evidence.firstPageProbeStable !== true
    || numberEvidence(evidence, "discoveredCount") !== result.items.length
    || numberEvidence(evidence, "unresolvedOfficialUrlCount") !== unresolvedOfficialUrlCount
  ) {
    verificationError("coverage_evidence_invalid");
  }

  return {
    event: "bverfg_inventory_read_only_verified" as const,
    sourceKey: result.sourceKey,
    year: result.year,
    documentType: result.documentType,
    scopeFrom: scope.scopeFrom,
    scopeTo: scope.scopeTo,
    discoveredCount: result.items.length,
    unresolvedOfficialUrlCount,
    pageCount: result.pageCount,
    requestCount: result.requestCount,
    observedLastPageMinimum: numberEvidence(evidence, "observedLastPageMinimum"),
    observedLastPageMaximum: numberEvidence(evidence, "observedLastPageMaximum"),
    coverageAssurance: "external_index_assisted" as const,
    officialCorpusCoverageClaimed: false as const,
    firstPageProbeStable: true as const,
    enumerationArtifactCount: result.enumerationArtifacts.length,
    enumerationArtifactManifestHash: artifactDigest(result),
    inventoryContractVerified: true as const,
    productionWriteAuthorized: false as const,
    geminiCalls: 0 as const,
  };
}

export async function verifyBverfgInventoryReadOnly(input: {
  year: number;
  maxPages?: number;
}, dependencies: {
  discover?: typeof discoverBverfgInventory;
} = {}) {
  const discover = dependencies.discover ?? discoverBverfgInventory;
  const result = await discover({
    year: input.year,
    maxPages: input.maxPages,
  });
  return validateBverfgInventoryResult(result);
}
