import { z } from "zod";
import {
  postgresUsConanReviewRepository,
  type AppendUsConanReviewInput,
  type StoredUsConanReviewContext,
  type UsConanReviewRepository,
} from "@/lib/backfill/us-conan-review-repository";
import { verifyConstitutionAnnotatedCandidate } from "@/lib/backfill/us-constitution-annotated";

export const US_CONAN_REVIEW_FLAG = "CASE_CATALOG_US_CONAN_REVIEW_ENABLED";

const uuid = z.string().uuid();
const httpsUrl = z.string().url().max(2_000).refine((value) => value.startsWith("https://"), "HTTPS URL required");
const holdingEvidenceSchema = z.object({
  sourceUrl: httpsUrl,
  locator: z.string().trim().min(1).max(300),
  constitutionalQuestion: z.string().trim().min(1).max(1_000),
}).strict();

const reviewInputSchema = z.object({
  candidateId: uuid,
  expectedRevision: z.number().int().min(0),
  status: z.enum(["verified", "uncertain", "rejected"]),
  officialScotusIdentityVerified: z.boolean(),
  constitutionalEssayContextVerified: z.boolean(),
  officialAuthorityVerified: z.boolean(),
  constitutionalHoldingVerified: z.boolean(),
  identityRejected: z.boolean().default(false),
  authorityArtifactId: uuid.nullable(),
  officialAuthorityUrl: httpsUrl.nullable(),
  essayEvidenceIds: z.array(uuid).max(50),
  holdingEvidence: z.array(holdingEvidenceSchema).max(50),
  safeEvidence: z.record(z.string(), z.unknown()),
  reviewedBy: z.string().trim().min(1).max(160),
  reviewReason: z.string().trim().min(5).max(1_000),
}).strict();

export type UsConanHumanReviewInput = z.infer<typeof reviewInputSchema>;

export interface ReviewUsConanCandidateDependencies {
  repository?: UsConanReviewRepository;
  environment?: Record<string, string | undefined>;
}

export async function inspectUsConanCandidateReview(
  candidateId: string,
  dependencies: ReviewUsConanCandidateDependencies = {},
) {
  const parsedId = uuid.safeParse(candidateId);
  if (!parsedId.success) throw new Error("us_review.invalid_candidate_id");
  const context = await (dependencies.repository ?? postgresUsConanReviewRepository).getReviewContext(parsedId.data);
  if (context.id !== parsedId.data) throw new Error("us_review.candidate_mismatch");
  return {
    candidateId: context.id,
    citation: context.citation,
    caseName: context.caseName,
    courtClassification: context.courtClassification,
    currentStatus: context.currentStatus,
    expectedRevision: context.reviewRevision,
    currentAuthority: context.currentAuthority,
    essayEvidence: context.essays.map((essay) => ({
      id: essay.id,
      essayId: essay.essayId,
      title: essay.title,
      url: essay.url,
    })),
    readOnly: true,
    publicCatalogEnabled: false,
    geminiCalls: 0,
  };
}

export function parseUsConanHumanReviewInput(value: unknown) {
  const result = reviewInputSchema.safeParse(value);
  return result.success
    ? { ok: true as const, data: result.data }
    : {
      ok: false as const,
      error: result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "),
    };
}

function assertReviewEnabled(environment: Record<string, string | undefined>) {
  if (environment[US_CONAN_REVIEW_FLAG]?.trim().toLowerCase() !== "true") {
    throw new Error("case_backfill.us_conan_review_disabled");
  }
}

function assertBoundEvidence(input: UsConanHumanReviewInput, context: StoredUsConanReviewContext) {
  if (new Set(input.essayEvidenceIds).size !== input.essayEvidenceIds.length) {
    throw new Error("us_review.duplicate_essay_evidence");
  }
  const availableEssayIds = new Set(context.essays.map((essay) => essay.id));
  if (input.essayEvidenceIds.some((id) => !availableEssayIds.has(id))) {
    throw new Error("us_review.essay_evidence_mismatch");
  }

  const authority = context.currentAuthority;
  const authorityFieldsPresent = Boolean(input.authorityArtifactId || input.officialAuthorityUrl || input.holdingEvidence.length);
  if (authorityFieldsPresent) {
    if (!authority || input.authorityArtifactId !== authority.id) throw new Error("us_review.current_authority_required");
    if (input.officialAuthorityUrl !== authority.detailsUrl) throw new Error("us_review.authority_url_mismatch");
    const officialUrls = new Set([authority.detailsUrl, authority.pdfUrl].filter((value): value is string => Boolean(value)));
    if (input.holdingEvidence.some((evidence) => !officialUrls.has(evidence.sourceUrl))) {
      throw new Error("us_review.holding_authority_mismatch");
    }
  }

  if (input.status === "verified") {
    if (!authority || authority.status !== "verified") throw new Error("us_review.verified_authority_required");
    if (input.essayEvidenceIds.length === 0) throw new Error("us_review.verified_essay_evidence_required");
    if (input.holdingEvidence.length === 0) throw new Error("us_review.verified_holding_evidence_required");
  }
}

function appendInput(input: UsConanHumanReviewInput): AppendUsConanReviewInput {
  return {
    candidateId: input.candidateId,
    expectedRevision: input.expectedRevision,
    status: input.status,
    officialScotusIdentityVerified: input.officialScotusIdentityVerified,
    constitutionalEssayContextVerified: input.constitutionalEssayContextVerified,
    officialAuthorityVerified: input.officialAuthorityVerified,
    constitutionalHoldingVerified: input.constitutionalHoldingVerified,
    authorityArtifactId: input.authorityArtifactId,
    officialAuthorityUrl: input.officialAuthorityUrl,
    essayEvidenceIds: input.essayEvidenceIds,
    holdingEvidence: input.holdingEvidence,
    safeEvidence: input.safeEvidence,
    reviewedBy: input.reviewedBy,
    reviewReason: input.reviewReason,
  };
}

export async function reviewUsConanCandidate(
  inputValue: unknown,
  execute: boolean,
  dependencies: ReviewUsConanCandidateDependencies = {},
) {
  const parsed = parseUsConanHumanReviewInput(inputValue);
  if (!parsed.ok) throw new Error(`us_review.invalid_input:${parsed.error}`);
  const input = parsed.data;
  if (JSON.stringify(input.safeEvidence).length > 16_000) throw new Error("us_review.safe_evidence_too_large");
  if (execute) assertReviewEnabled(dependencies.environment ?? process.env);

  const repository = dependencies.repository ?? postgresUsConanReviewRepository;
  const context = await repository.getReviewContext(input.candidateId);
  if (context.id !== input.candidateId) throw new Error("us_review.candidate_mismatch");
  if (context.reviewRevision !== input.expectedRevision) throw new Error("us_review.stale_revision");
  assertBoundEvidence(input, context);

  const verification = verifyConstitutionAnnotatedCandidate({
    stableCandidateKey: context.stableCandidateKey,
    caseName: context.caseName,
    citation: context.citation,
    normalizedCitation: context.normalizedCitation,
    courtClassification: context.courtClassification,
    constitutionalRelevanceStatus: "candidate",
    candidateBasis: "constitution_annotated_table_citation",
    essayReferences: context.essays.map((essay) => ({ essayId: essay.essayId, title: essay.title, url: essay.url })),
    priority: 0,
    priorityReasons: [],
  }, {
    officialScotusIdentityVerified: input.officialScotusIdentityVerified,
    constitutionalEssayContextVerified: input.constitutionalEssayContextVerified,
    officialAuthorityVerified: input.officialAuthorityVerified,
    constitutionalHoldingVerified: input.constitutionalHoldingVerified,
    identityRejected: input.identityRejected,
  });
  if (verification.status !== input.status) throw new Error("us_review.status_evidence_mismatch");

  const review = execute ? await repository.appendReview(appendInput(input)) : null;
  if (review && (review.revision !== input.expectedRevision + 1 || review.status !== input.status)) {
    throw new Error("us_review.write_confirmation_mismatch");
  }
  return {
    mode: execute ? "reviewed" as const : "plan" as const,
    candidateId: context.id,
    citation: context.citation,
    previousStatus: context.currentStatus,
    expectedRevision: input.expectedRevision,
    requestedStatus: input.status,
    verification,
    boundEvidence: {
      authorityArtifactId: input.authorityArtifactId,
      essayEvidenceCount: input.essayEvidenceIds.length,
      holdingEvidenceCount: input.holdingEvidence.length,
    },
    review,
    humanLegalReviewRequired: true,
    publicCatalogEnabled: false,
    geminiCalls: 0,
  };
}
