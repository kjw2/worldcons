import { z } from "zod";
import {
  postgresUsConanCatalogCanaryRepository,
  type UsConanCatalogCanaryRepository,
} from "@/lib/backfill/us-conan-canary-repository";

const uuid = z.string().uuid();
const nullableUuid = uuid.nullable();
const nullableString = z.string().nullable();
const nullableInteger = z.number().int().nonnegative().nullable();

const evidenceSchema = z.object({
  candidateFound: z.literal(true),
  candidateId: uuid,
  citation: z.string().min(1),
  candidateSnapshotStatus: nullableString,
  candidateManifestHash: nullableString,
  candidatePolicyVersion: nullableString,
  candidatePolicyReviewDueAt: nullableString,
  currentReviewId: nullableUuid,
  currentReviewRevision: z.number().int().nonnegative(),
  currentReviewStatus: z.string(),
  currentReviewAuthorityArtifactId: nullableUuid,
  currentAuthorityArtifactId: nullableUuid,
  currentAuthorityStatus: nullableString,
  currentAuthorityPayloadHash: nullableString,
  eventId: nullableUuid,
  eventReviewId: nullableUuid,
  eventReviewRevision: nullableInteger,
  eventAuthorityArtifactId: nullableUuid,
  eventCandidateManifestHash: nullableString,
  eventSourcePolicyVersion: nullableString,
  eventCreatedAt: nullableString,
  articleId: nullableUuid,
  articleSlug: nullableString,
  articleSourceKey: nullableString,
  catalogPublicationId: nullableUuid,
  catalogPublicationState: nullableString,
  catalogPublicationRevision: nullableInteger,
  catalogSourceAnchorVersionId: nullableUuid,
  catalogSourcePolicyVersion: nullableString,
  publicationPolicyReviewDueAt: nullableString,
  sourceAnchorVersionId: nullableUuid,
  sourceAnchorRevision: nullableInteger,
  sourceAnchorRole: nullableString,
  sourceAnchorSelfId: nullableUuid,
  sourceAnchorContentHash: nullableString,
  sourceAnchorSnapshotHash: nullableString,
  sourceAnchorSummaryPresent: z.boolean(),
  sourceAnchorEmbeddingPresent: z.boolean(),
  caseAuthorityStatus: nullableString,
  caseConstitutionalStatus: nullableString,
  caseEnrichmentStatus: nullableString,
  caseTextAccessPolicy: nullableString,
  caseSourcePolicyVersion: nullableString,
  publicDetailArticleId: nullableUuid,
  publicDetailVersionId: nullableUuid,
  publicDetailVersionRole: nullableString,
  publicDetailEnrichmentStatus: nullableString,
  publicDetailSummaryAvailable: z.boolean().nullable(),
  publicDetailSummaryPresent: z.boolean(),
  p3PublicationState: nullableString,
  p3PublicationVersionId: nullableUuid,
}).strict();

function isFuture(value: string | null, now: number) {
  return value !== null && Number.isFinite(Date.parse(value)) && Date.parse(value) > now;
}

export async function verifyUsConanCatalogCanary(
  candidateId: string,
  dependencies: {
    repository?: UsConanCatalogCanaryRepository;
    now?: () => Date;
  } = {},
) {
  const parsedId = uuid.safeParse(candidateId);
  if (!parsedId.success) throw new Error("us_canary.invalid_candidate_id");
  const rawEvidence = await (dependencies.repository ?? postgresUsConanCatalogCanaryRepository)
    .getEvidence(parsedId.data);
  if (typeof rawEvidence === "object" && rawEvidence !== null
    && "candidateFound" in rawEvidence && rawEvidence.candidateFound === false) {
    throw new Error("us_canary.candidate_not_found");
  }
  const parsedEvidence = evidenceSchema.safeParse(rawEvidence);
  if (!parsedEvidence.success) throw new Error("us_canary.evidence_invalid");
  const evidence = parsedEvidence.data;
  if (evidence.candidateId !== parsedId.data) throw new Error("us_canary.candidate_mismatch");
  const now = (dependencies.now ?? (() => new Date()))().getTime();
  const blocking: string[] = [];

  if (evidence.candidateSnapshotStatus !== "closed" || !evidence.candidateManifestHash) {
    blocking.push("closed_candidate_manifest_missing");
  }
  if (!isFuture(evidence.candidatePolicyReviewDueAt, now)) blocking.push("candidate_policy_review_overdue");
  if (evidence.currentReviewStatus !== "verified" || !evidence.currentReviewId || evidence.currentReviewRevision < 1) {
    blocking.push("current_verified_review_missing");
  }
  if (evidence.currentAuthorityStatus !== "verified" || !evidence.currentAuthorityArtifactId
    || !evidence.currentAuthorityPayloadHash) {
    blocking.push("current_verified_authority_missing");
  }
  if (!evidence.eventId) blocking.push("catalog_bridge_event_missing");
  if (evidence.eventReviewId !== evidence.currentReviewId
    || evidence.eventReviewRevision !== evidence.currentReviewRevision) {
    blocking.push("catalog_bridge_review_stale");
  }
  if (evidence.eventAuthorityArtifactId !== evidence.currentAuthorityArtifactId
    || evidence.currentReviewAuthorityArtifactId !== evidence.currentAuthorityArtifactId) {
    blocking.push("catalog_bridge_authority_stale");
  }
  if (evidence.eventCandidateManifestHash !== evidence.candidateManifestHash
    || evidence.sourceAnchorSnapshotHash !== evidence.candidateManifestHash) {
    blocking.push("catalog_bridge_manifest_mismatch");
  }
  if (evidence.articleSourceKey !== "us-scotus" || !evidence.articleId || !evidence.articleSlug) {
    blocking.push("us_scotus_article_missing");
  }
  if (evidence.catalogPublicationState !== "published" || !evidence.catalogPublicationId
    || !evidence.catalogPublicationRevision || evidence.catalogPublicationRevision < 1) {
    blocking.push("catalog_publication_missing");
  }
  if (evidence.catalogSourceAnchorVersionId !== evidence.sourceAnchorVersionId
    || evidence.sourceAnchorVersionId !== evidence.sourceAnchorSelfId
    || evidence.sourceAnchorRole !== "authoritative_source") {
    blocking.push("authoritative_source_anchor_invalid");
  }
  if (!evidence.sourceAnchorContentHash
    || evidence.sourceAnchorContentHash !== evidence.currentAuthorityPayloadHash) {
    blocking.push("authority_content_hash_mismatch");
  }
  if (evidence.sourceAnchorSummaryPresent || evidence.sourceAnchorEmbeddingPresent) {
    blocking.push("source_anchor_ai_payload_present");
  }
  if (evidence.caseAuthorityStatus !== "verified"
    || evidence.caseConstitutionalStatus !== "verified"
    || evidence.caseEnrichmentStatus !== "source_only"
    || !["metadata_only", "index_only"].includes(evidence.caseTextAccessPolicy ?? "")) {
    blocking.push("case_metadata_not_source_only_verified");
  }
  if (evidence.eventSourcePolicyVersion !== evidence.catalogSourcePolicyVersion
    || evidence.eventSourcePolicyVersion !== evidence.caseSourcePolicyVersion
    || !isFuture(evidence.publicationPolicyReviewDueAt, now)) {
    blocking.push("publication_policy_invalid_or_overdue");
  }
  if (evidence.publicDetailArticleId !== evidence.articleId
    || evidence.publicDetailVersionId !== evidence.sourceAnchorVersionId
    || evidence.publicDetailVersionRole !== "authoritative_source"
    || evidence.publicDetailEnrichmentStatus !== "source_only"
    || evidence.publicDetailSummaryAvailable !== false
    || evidence.publicDetailSummaryPresent) {
    blocking.push("public_source_only_projection_invalid");
  }
  if (evidence.p3PublicationVersionId === evidence.sourceAnchorVersionId) {
    blocking.push("p3_points_to_authoritative_source");
  }

  return {
    candidateId: evidence.candidateId,
    citation: evidence.citation,
    status: blocking.length === 0 ? "pass" as const : "blocked" as const,
    blocking,
    evidence,
    readOnly: true,
    sourcePolicyApprovedByThisCheck: false,
    productionMigrationAppliedByThisCheck: false,
    geminiCalls: 0,
  };
}
