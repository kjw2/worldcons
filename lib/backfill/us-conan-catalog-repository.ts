import { getSupabaseServiceRoleAdmin } from "@/lib/db/client";

export interface UsConanCatalogPublicationContext {
  candidateId: string;
  citation: string;
  reviewId: string | null;
  reviewRevision: number;
  reviewStatus: string;
  reviewAuthorityArtifactId: string | null;
  currentAuthorityArtifactId: string | null;
  currentAuthorityStatus: string | null;
  candidateSourceKey: string;
  candidatePolicyVersion: string;
  candidatePolicyReviewDueAt: string;
  candidateSnapshotStatus: string;
  candidateManifestHash: string | null;
  articleId: string | null;
  catalogRevision: number;
  catalogState: string | null;
}

export interface UsConanCatalogSourcePolicy {
  sourceKey: string;
  policyVersion: string;
  reviewDueAt: string;
  textAccessPolicy: string;
  authorityHosts: string[];
}

export interface PublishUsConanCatalogInput {
  candidateId: string;
  expectedReviewRevision: number;
  sourcePolicyVersion: string;
  expectedCatalogRevision: number;
  idempotencyKey: string;
  actorId: string;
}

export interface PublishedUsConanCatalog {
  eventId: string;
  articleId: string;
  versionId: string;
  versionRevision: number;
  publicationRevision: number;
  articleSlug: string;
  applied: boolean;
  idempotent: boolean;
}

export interface UsConanCatalogRepository {
  getPublicationContext(candidateId: string): Promise<UsConanCatalogPublicationContext>;
  getSourcePolicy(policyVersion: string): Promise<UsConanCatalogSourcePolicy>;
  publish(input: PublishUsConanCatalogInput): Promise<PublishedUsConanCatalog>;
}

function requiredClient() {
  const client = getSupabaseServiceRoleAdmin();
  if (!client) throw new Error("us_catalog.database_unavailable");
  return client;
}

function databaseError(error: { message?: string } | null) {
  if (error) throw new Error(error.message || "us_catalog.database_error");
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function firstRow(value: unknown) {
  if (Array.isArray(value)) return record(value[0]);
  return record(value);
}

function requiredString(row: Record<string, unknown>, key: string) {
  const value = row[key];
  if (typeof value !== "string" || !value) throw new Error("us_catalog.context_invalid");
  return value;
}

function nullableString(row: Record<string, unknown> | null, key: string) {
  return row && typeof row[key] === "string" ? row[key] as string : null;
}

function integer(value: unknown, errorCode = "us_catalog.context_invalid") {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(errorCode);
  return parsed;
}

function normalizedCitation(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export const postgresUsConanCatalogRepository: UsConanCatalogRepository = {
  async getPublicationContext(candidateId) {
    const client = requiredClient();
    const candidateResult = await client
      .from("us_conan_candidate_current_v1")
      .select("id,snapshot_id,citation,review_revision,constitutional_relevance_status")
      .eq("id", candidateId)
      .single();
    databaseError(candidateResult.error);
    const candidate = record(candidateResult.data);
    if (!candidate) throw new Error("us_catalog.candidate_not_found");
    const snapshotResult = await client
      .from("us_conan_candidate_snapshots_v1")
      .select("status,source_key,source_policy_version,manifest_hash")
      .eq("id", requiredString(candidate, "snapshot_id"))
      .single();
    databaseError(snapshotResult.error);
    const snapshot = record(snapshotResult.data);
    if (!snapshot) throw new Error("us_catalog.context_invalid");
    const candidatePolicyResult = await client
      .from("source_corpus_policies")
      .select("review_due_at")
      .eq("source_key", requiredString(snapshot, "source_key"))
      .eq("policy_version", requiredString(snapshot, "source_policy_version"))
      .single();
    databaseError(candidatePolicyResult.error);
    const candidatePolicy = record(candidatePolicyResult.data);
    if (!candidatePolicy) throw new Error("us_catalog.context_invalid");
    const reviewResult = await client
      .from("us_conan_candidate_reviews_v1")
      .select("id,revision,status,authority_artifact_id")
      .eq("candidate_id", candidateId)
      .order("revision", { ascending: false })
      .limit(1)
      .maybeSingle();
    databaseError(reviewResult.error);
    const review = record(reviewResult.data);
    const authorityResult = await client
      .from("us_conan_candidate_authority_current_v1")
      .select("id,status,details_url")
      .eq("candidate_id", candidateId)
      .maybeSingle();
    databaseError(authorityResult.error);
    const authority = record(authorityResult.data);

    const citation = requiredString(candidate, "citation");
    const identifierResult = await client
      .from("case_identifiers_v1")
      .select("article_id")
      .eq("source_key", "us-scotus")
      .eq("identifier_type", "reporter_citation")
      .eq("normalized_value", normalizedCitation(citation))
      .maybeSingle();
    databaseError(identifierResult.error);
    const identifier = record(identifierResult.data);
    const identifierArticleId = nullableString(identifier, "article_id");
    let canonicalArticleId: string | null = null;
    const authorityUrl = nullableString(authority, "details_url");
    if (authorityUrl) {
      const articleResult = await client.from("articles").select("id").eq("canonical_url", authorityUrl).maybeSingle();
      databaseError(articleResult.error);
      canonicalArticleId = nullableString(record(articleResult.data), "id");
    }
    if (identifierArticleId && canonicalArticleId && identifierArticleId !== canonicalArticleId) {
      throw new Error("us_catalog.identity_conflict");
    }
    const articleId = identifierArticleId ?? canonicalArticleId;
    let publication: Record<string, unknown> | null = null;
    if (articleId) {
      const publicationResult = await client
        .from("case_catalog_publications_v1")
        .select("revision,state")
        .eq("article_id", articleId)
        .maybeSingle();
      databaseError(publicationResult.error);
      publication = record(publicationResult.data);
    }
    return {
      candidateId: requiredString(candidate, "id"),
      citation,
      reviewId: nullableString(review, "id"),
      reviewRevision: integer(candidate.review_revision),
      reviewStatus: requiredString(candidate, "constitutional_relevance_status"),
      reviewAuthorityArtifactId: nullableString(review, "authority_artifact_id"),
      currentAuthorityArtifactId: nullableString(authority, "id"),
      currentAuthorityStatus: nullableString(authority, "status"),
      candidateSourceKey: requiredString(snapshot, "source_key"),
      candidatePolicyVersion: requiredString(snapshot, "source_policy_version"),
      candidatePolicyReviewDueAt: requiredString(candidatePolicy, "review_due_at"),
      candidateSnapshotStatus: requiredString(snapshot, "status"),
      candidateManifestHash: nullableString(snapshot, "manifest_hash"),
      articleId,
      catalogRevision: publication ? integer(publication.revision) : 0,
      catalogState: nullableString(publication, "state"),
    };
  },

  async getSourcePolicy(policyVersion) {
    const { data, error } = await requiredClient()
      .from("source_corpus_policies")
      .select("source_key,policy_version,review_due_at,default_text_access_policy,authority_hosts")
      .eq("source_key", "us-scotus")
      .eq("policy_version", policyVersion)
      .single();
    databaseError(error);
    const policy = record(data);
    if (!policy) throw new Error("us_catalog.source_policy_not_found");
    return {
      sourceKey: requiredString(policy, "source_key"),
      policyVersion: requiredString(policy, "policy_version"),
      reviewDueAt: requiredString(policy, "review_due_at"),
      textAccessPolicy: requiredString(policy, "default_text_access_policy"),
      authorityHosts: Array.isArray(policy.authority_hosts)
        ? policy.authority_hosts.filter((value): value is string => typeof value === "string")
        : [],
    };
  },

  async publish(input) {
    const { data, error } = await requiredClient().rpc("us_conan_candidate_publish_catalog_v1", {
      p_candidate_id: input.candidateId,
      p_expected_review_revision: input.expectedReviewRevision,
      p_source_policy_version: input.sourcePolicyVersion,
      p_expected_catalog_revision: input.expectedCatalogRevision,
      p_idempotency_key: input.idempotencyKey,
      p_actor_id: input.actorId,
    });
    databaseError(error);
    const row = firstRow(data);
    if (!row) throw new Error("us_catalog.publish_failed");
    return {
      eventId: requiredString(row, "event_id"),
      articleId: requiredString(row, "article_id"),
      versionId: requiredString(row, "version_id"),
      versionRevision: integer(row.version_revision, "us_catalog.publish_confirmation_invalid"),
      publicationRevision: integer(row.publication_revision, "us_catalog.publish_confirmation_invalid"),
      articleSlug: requiredString(row, "article_slug"),
      applied: row.applied === true,
      idempotent: row.idempotent === true,
    };
  },
};
