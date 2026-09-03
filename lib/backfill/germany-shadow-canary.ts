import { z } from "zod";
import {
  postgresBverfgShadowCanaryRepository,
  type BverfgShadowCanaryRepository,
} from "@/lib/backfill/germany-shadow-canary-repository";

const hash = z.string().regex(/^[0-9a-f]{64}$/u).nullable();
const count = z.number().int().nonnegative();
const evidenceSchema = z.object({
  snapshotFound: z.literal(true),
  snapshotId: z.string().uuid(),
  sourceKey: z.string(),
  scopeFrom: z.string(),
  scopeTo: z.string(),
  documentType: z.string(),
  snapshotStatus: z.string(),
  coverageAssurance: z.string(),
  coverageEvidence: z.record(z.unknown()),
  discoveredCount: count,
  manifestHash: hash,
  enumerationManifestHash: hash,
  recomputedEnumerationManifestHash: hash,
  sourcePolicyFound: z.boolean(),
  sourcePolicyVersion: z.string(),
  sourcePolicyReviewDueAt: z.string().nullable(),
  enumerationArtifactCount: count,
  pageArtifactCount: count,
  boundaryProbeCount: count,
  pageSequenceContiguous: z.boolean(),
  externalTextEvidenceCount: count,
  itemCount: count,
  resolvedOfficialUrlCount: count,
  unresolvedActionableCount: count,
  invalidInventoryCount: count,
  verifiedCount: count,
  invalidVerifiedAuthorityCount: count,
  excludedCount: count,
  terminalFailureCount: count,
  retryWaitCount: count,
  activeClaimCount: count,
  publishedItemCount: count,
  articleLinkedCount: count,
  catalogPublicationCount: count,
  aiPayloadCount: count,
}).strict();

export async function verifyBverfgPrivateShadowCanary(
  snapshotId: string,
  dependencies: {
    repository?: BverfgShadowCanaryRepository;
    now?: () => Date;
  } = {},
) {
  if (!z.string().uuid().safeParse(snapshotId).success) {
    throw new Error("bverfg_shadow_canary.invalid_snapshot_id");
  }
  const raw = await (dependencies.repository ?? postgresBverfgShadowCanaryRepository).getEvidence(snapshotId);
  if (typeof raw === "object" && raw !== null && "snapshotFound" in raw && raw.snapshotFound === false) {
    throw new Error("bverfg_shadow_canary.snapshot_not_found");
  }
  const parsed = evidenceSchema.safeParse(raw);
  if (!parsed.success) throw new Error("bverfg_shadow_canary.evidence_invalid");
  const evidence = parsed.data;
  if (evidence.snapshotId !== snapshotId) throw new Error("bverfg_shadow_canary.snapshot_mismatch");
  const blocking: string[] = [];
  const now = (dependencies.now ?? (() => new Date()))().getTime();
  const resolvedOutcomeCount = evidence.verifiedCount + evidence.excludedCount;

  if (evidence.sourceKey !== "de-bverfg" || evidence.documentType !== "DECISION") blocking.push("snapshot_scope_invalid");
  if (evidence.snapshotStatus !== "closed" || !evidence.manifestHash) blocking.push("closed_manifest_missing");
  if (evidence.coverageAssurance !== "external_index_assisted"
    || evidence.coverageEvidence.officialCorpusCoverageClaimed !== false
    || evidence.coverageEvidence.crossedOlderBoundary !== true
    || evidence.coverageEvidence.firstPageProbeStable !== true) {
    blocking.push("coverage_evidence_invalid");
  }
  if (!evidence.enumerationManifestHash
    || evidence.enumerationManifestHash !== evidence.recomputedEnumerationManifestHash) {
    blocking.push("enumeration_manifest_mismatch");
  }
  if (evidence.enumerationArtifactCount < 2 || evidence.pageArtifactCount < 1
    || evidence.boundaryProbeCount !== 1 || !evidence.pageSequenceContiguous) {
    blocking.push("enumeration_evidence_incomplete");
  }
  if (evidence.externalTextEvidenceCount > 0) blocking.push("external_text_evidence_present");
  if (evidence.itemCount !== evidence.discoveredCount || evidence.itemCount < 1) blocking.push("item_count_mismatch");
  if (resolvedOutcomeCount !== evidence.itemCount) blocking.push("private_shadow_items_incomplete");
  if (evidence.unresolvedActionableCount > 0) blocking.push("official_url_unresolved");
  if (evidence.invalidInventoryCount > 0) blocking.push("inventory_provenance_invalid");
  if (evidence.invalidVerifiedAuthorityCount > 0) blocking.push("verified_authority_invalid");
  if (evidence.terminalFailureCount > 0) blocking.push("terminal_failures_present");
  if (evidence.retryWaitCount > 0) blocking.push("retries_pending");
  if (evidence.activeClaimCount > 0) blocking.push("active_claims_present");
  if (evidence.publishedItemCount > 0 || evidence.articleLinkedCount > 0 || evidence.catalogPublicationCount > 0) {
    blocking.push("public_catalog_leakage");
  }
  if (evidence.aiPayloadCount > 0) blocking.push("ai_payload_leakage");
  if (!evidence.sourcePolicyFound || evidence.sourcePolicyReviewDueAt === null
    || !Number.isFinite(Date.parse(evidence.sourcePolicyReviewDueAt))
    || Date.parse(evidence.sourcePolicyReviewDueAt) <= now) {
    blocking.push("source_policy_missing_or_overdue");
  }

  return {
    snapshotId,
    status: blocking.length === 0 ? "pass" as const : "blocked" as const,
    blocking,
    evidence,
    readOnly: true as const,
    publicCatalogEnabledByThisCheck: false as const,
    productionWriteAuthorizedByThisCheck: false as const,
    sourcePolicyApprovedByThisCheck: false as const,
    geminiCalls: 0 as const,
  };
}
