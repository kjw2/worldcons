import { z } from "zod";
import {
  postgresUsConanCatalogRepository,
  type UsConanCatalogRepository,
} from "@/lib/backfill/us-conan-catalog-repository";
import {
  caseCatalogPublicReadsEnabled,
  caseCatalogWriteEnabled,
} from "@/lib/case-catalog/flags";

export const US_CONAN_CATALOG_PUBLISH_FLAG = "CASE_CATALOG_US_CONAN_PUBLISH_ENABLED";

const policyVersionSchema = z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const publicationInputSchema = z.object({
  candidateId: z.string().uuid(),
  sourcePolicyVersion: policyVersionSchema,
  expectedReviewRevision: z.number().int().min(1),
  expectedCatalogRevision: z.number().int().min(0),
  idempotencyKey: z.string().min(8).max(240).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  actorId: z.string().trim().min(1).max(160),
}).strict();

export type UsConanCatalogPublicationInput = z.infer<typeof publicationInputSchema>;

interface UsConanCatalogServiceDependencies {
  repository?: UsConanCatalogRepository;
  environment?: Record<string, string | undefined>;
  now?: () => Date;
}

function explicitTrue(value?: string) {
  return value?.trim().toLowerCase() === "true";
}

function publicationIdempotencyKey(candidateId: string, reviewRevision: number, policyVersion: string) {
  return `us-conan:${candidateId}:review-${reviewRevision}:policy-${policyVersion}`;
}

function assertWriteAuthority(environment: Record<string, string | undefined>) {
  if (!caseCatalogWriteEnabled(environment)) throw new Error("case_backfill.catalog_write_disabled");
  if (!explicitTrue(environment[US_CONAN_CATALOG_PUBLISH_FLAG])) {
    throw new Error("case_backfill.us_conan_publish_disabled");
  }
}

export async function planUsConanCatalogPublication(
  candidateId: string,
  sourcePolicyVersion: string,
  dependencies: UsConanCatalogServiceDependencies = {},
) {
  const parsedCandidate = z.string().uuid().safeParse(candidateId);
  if (!parsedCandidate.success) throw new Error("us_catalog.invalid_candidate_id");
  const parsedPolicy = policyVersionSchema.safeParse(sourcePolicyVersion);
  if (!parsedPolicy.success) throw new Error("us_catalog.invalid_source_policy_version");
  const repository = dependencies.repository ?? postgresUsConanCatalogRepository;
  const [context, policy] = await Promise.all([
    repository.getPublicationContext(parsedCandidate.data),
    repository.getSourcePolicy(parsedPolicy.data),
  ]);
  const now = (dependencies.now ?? (() => new Date()))().getTime();
  const blocking: string[] = [];
  if (context.candidateId !== parsedCandidate.data) blocking.push("candidate_context_mismatch");
  if (context.candidateSourceKey !== "us-constitution-annotated") blocking.push("candidate_discovery_source_mismatch");
  if (context.candidateSnapshotStatus !== "closed" || !context.candidateManifestHash) blocking.push("closed_candidate_manifest_required");
  if (context.reviewStatus !== "verified" || context.reviewRevision < 1 || !context.reviewId) blocking.push("verified_review_required");
  if (context.currentAuthorityStatus !== "verified"
    || !context.currentAuthorityArtifactId
    || context.currentAuthorityArtifactId !== context.reviewAuthorityArtifactId) {
    blocking.push("current_reviewed_authority_required");
  }
  if (!Number.isFinite(Date.parse(context.candidatePolicyReviewDueAt)) || Date.parse(context.candidatePolicyReviewDueAt) <= now) {
    blocking.push("candidate_policy_review_overdue");
  }
  if (policy.sourceKey !== "us-scotus" || policy.policyVersion !== parsedPolicy.data) blocking.push("publication_policy_mismatch");
  if (!Number.isFinite(Date.parse(policy.reviewDueAt)) || Date.parse(policy.reviewDueAt) <= now) {
    blocking.push("publication_policy_review_overdue");
  }
  if (!policy.authorityHosts.includes("www.govinfo.gov")) blocking.push("govinfo_authority_host_required");
  if (!["metadata_only", "index_only"].includes(policy.textAccessPolicy)) blocking.push("metadata_only_policy_required");
  const idempotencyKey = publicationIdempotencyKey(context.candidateId, context.reviewRevision, policy.policyVersion);
  return {
    candidateId: context.candidateId,
    citation: context.citation,
    candidatePolicyVersion: context.candidatePolicyVersion,
    sourcePolicyVersion: policy.policyVersion,
    expectedReviewRevision: context.reviewRevision,
    expectedCatalogRevision: context.catalogRevision,
    catalogState: context.catalogState,
    articleId: context.articleId,
    idempotencyKey,
    eligible: blocking.length === 0,
    blocking,
    mode: "plan" as const,
    writeEnabled: caseCatalogWriteEnabled(dependencies.environment ?? process.env),
    publicCatalogEnabled: caseCatalogPublicReadsEnabled(dependencies.environment ?? process.env),
    geminiCalls: 0,
  };
}

export async function publishUsConanCatalogCandidate(
  inputValue: unknown,
  dependencies: UsConanCatalogServiceDependencies = {},
) {
  const parsed = publicationInputSchema.safeParse(inputValue);
  if (!parsed.success) throw new Error(`us_catalog.invalid_input:${parsed.error.issues.map((issue) => issue.path.join(".")).join(",")}`);
  const input = parsed.data;
  const environment = dependencies.environment ?? process.env;
  assertWriteAuthority(environment);
  const repository = dependencies.repository ?? postgresUsConanCatalogRepository;
  const plan = await planUsConanCatalogPublication(input.candidateId, input.sourcePolicyVersion, {
    ...dependencies,
    repository,
    environment,
  });
  if (!plan.eligible) throw new Error(`us_catalog.not_eligible:${plan.blocking.join(",")}`);
  if (input.expectedReviewRevision !== plan.expectedReviewRevision
    || input.expectedCatalogRevision !== plan.expectedCatalogRevision) {
    throw new Error("us_catalog.stale_plan");
  }
  if (input.idempotencyKey !== plan.idempotencyKey) throw new Error("us_catalog.idempotency_key_mismatch");
  const publication = await repository.publish(input);
  return {
    ...plan,
    mode: "published" as const,
    publication,
    publicCatalogEnabled: caseCatalogPublicReadsEnabled(environment),
    reviewWritten: false,
    p3PublicationWritten: false,
    geminiCalls: 0,
  };
}
