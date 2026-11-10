import { transitionArticlePublicationInD1 } from "@/lib/cloudflare/core-write/authority";
import type { D1RuntimeDatabase } from "@/lib/cloudflare/d1/runtime-binding";
import type { SpainDateOnlyCorrectionInput } from "@/lib/article-publication/types";
import {
  fetchSpainOfficialDateEvidence,
  extractSpainHjId,
  type SpainOfficialDateEvidence,
} from "@/lib/ingest/spain-decision-date-recovery";
import { spainDateCorrectionEvidenceSha256 } from "@/lib/ingest/spain-decision-date-correction";
import {
  OFFICIAL_DATE_ONLY_POLICY,
  SPAIN_DATE_ONLY_ACTOR,
  SPAIN_DATE_ONLY_REASON,
  spainDateOnlyDateOnly,
  spainDateOnlyOfficialUrl,
  spainDateOnlyPlanHash,
  validateSpainDateOnlyEvidence,
  readSpainDateOnlyCandidate,
  type SpainDateOnlyOperatorAuthorization,
} from "@/lib/ingest/spain-date-only-republication";

export interface ApplySpainDateOnlyInput {
  core: D1RuntimeDatabase;
  articleId: string;
  actorId: string;
  correlationId: string;
  now?: string;
  apply?: boolean;
  /** Required for apply; the exact dry-run plan hash binds the one-item canary. */
  confirmPlanHash?: string;
  evidence?: SpainOfficialDateEvidence;
  fetchEvidence?: (hjId: string, canonicalUrl: string) => Promise<SpainOfficialDateEvidence>;
  operatorAuthorization?: SpainDateOnlyOperatorAuthorization;
}

export type SpainDateOnlyApplicationResult =
  | { status: "not_found"; articleId: string }
  | { status: "not_published"; articleId: string; reason: string }
  | { status: "already_corrected"; articleId: string; versionOriginalPublishedAt: string }
  | { status: "approval_required"; articleId: string; reason: string }
  | { status: "rejected"; articleId: string; code: string; reason: string }
  | {
    status: "planned";
    articleId: string;
    previousVersionId: string;
    correctedOriginalPublishedAt: string;
    decisionDate: string;
    evidenceSha256: string;
    authorizationBasis: "managed_generation" | "operator_authorization";
    planHash: string;
    evidence: SpainOfficialDateEvidence;
    authorizationRequired?: boolean;
    operatorAuthorization?: SpainDateOnlyOperatorAuthorization;
  }
  | {
    status: "applied";
    articleId: string;
    previousVersionId: string;
    versionId: string;
    versionRevision: number;
    publicationId: string;
    publicationRevision: number;
    generationId?: string;
    searchRepairOutboxId?: string;
    evidenceSha256: string;
    authorizationBasis: "managed_generation" | "operator_authorization";
    planHash: string;
  }
  | { status: "failed"; articleId: string; error: string; planHash: string };

function validActor(value: string) {
  return Boolean(value.trim()) && value.length <= 160;
}

/**
 * One bounded item at a time. Managed rows must still be owned by their recorded
 * E2E generation; legacy rows require an exact operator receipt. Every apply
 * produces a new immutable P3 version through the normal publication transition.
 */
export async function applySpainDateOnlyRepublication(
  input: ApplySpainDateOnlyInput,
): Promise<SpainDateOnlyApplicationResult> {
  const articleId = input.articleId.trim();
  if (!articleId) return { status: "not_found", articleId };
  if (!validActor(input.actorId)) return { status: "rejected", articleId, code: "actor_required", reason: "An authenticated actor id is required." };
  if (!input.correlationId.trim() || input.correlationId.length > 200) {
    return { status: "rejected", articleId, code: "correlation_required", reason: "A bounded correlation id is required." };
  }
  const candidate = await readSpainDateOnlyCandidate(input.core, articleId);
  if (!candidate) return { status: "not_found", articleId };
  const { article, publication, version, p3Head, v4Head, managed } = candidate;
  if (!publication || publication.state !== "published") {
    return { status: "not_published", articleId, reason: "The article has no currently published P3 version." };
  }
  if (!version || String(publication.version_id) !== String(version.id)) {
    return { status: "not_published", articleId, reason: "The published version identity is incomplete." };
  }
  const existingVersionDate = typeof version.original_published_at === "string" && version.original_published_at.trim()
    ? version.original_published_at
    : null;
  if (existingVersionDate) {
    return { status: "already_corrected", articleId, versionOriginalPublishedAt: existingVersionDate };
  }
  const canonicalUrl = String(version.canonical_url ?? article.canonical_url ?? "");
  const hjId = extractSpainHjId({ canonical_url: canonicalUrl, original_url: String(version.original_url ?? article.original_url ?? "") });
  if (!hjId) return { status: "rejected", articleId, code: "hj_id_missing", reason: "The immutable version canonical URL is not an official HJ resolution URL." };

  const evidence = input.evidence ?? await (input.fetchEvidence ?? ((id, url) => fetchSpainOfficialDateEvidence(id, url)))(
    hjId,
    canonicalUrl || spainDateOnlyOfficialUrl(hjId),
  );
  const correctedOriginalPublishedAt = evidence.decisionDate ? `${evidence.decisionDate}T00:00:00.000Z` : "";
  const validation = validateSpainDateOnlyEvidence({ article, version, evidence, correctedOriginalPublishedAt });
  if (!validation.ok) return { status: "rejected", articleId, code: validation.code, reason: validation.reason };
  const decisionDate = evidence.decisionDate!;
  const correctedDateOnly = spainDateOnlyDateOnly(correctedOriginalPublishedAt);
  const articleDateOnly = spainDateOnlyDateOnly(article.original_published_at);
  if (articleDateOnly && articleDateOnly !== correctedDateOnly) {
    return { status: "rejected", articleId, code: "core_date_conflict", reason: "The current Core date conflicts with the verified official decision date." };
  }
  const evidenceSha256 = await spainDateCorrectionEvidenceSha256(evidence);

  const authorizationBasis = managed ? "managed_generation" as const : "operator_authorization" as const;
  const operatorTemplate: SpainDateOnlyOperatorAuthorization | undefined = authorizationBasis === "operator_authorization"
    ? {
      actorId: input.actorId,
      approvedAt: input.now ?? new Date().toISOString(),
      articleId,
      currentVersionId: String(version.id),
      correctedOriginalPublishedAt,
      evidenceSha256,
      correlationId: input.correlationId,
    }
    : undefined;
  let authorizationRequired = false;
  if (authorizationBasis === "operator_authorization") {
    const receipt = input.operatorAuthorization;
    const receiptValid = Boolean(receipt)
      && receipt!.articleId === articleId && receipt!.currentVersionId === String(version.id)
      && receipt!.correctedOriginalPublishedAt === correctedOriginalPublishedAt
      && receipt!.evidenceSha256 === evidenceSha256 && receipt!.actorId === input.actorId
      && Number.isFinite(Date.parse(receipt!.approvedAt))
      && (!receipt!.correlationId || receipt!.correlationId === input.correlationId);
    if (!receiptValid) {
      if (input.apply === true) {
        if (!receipt) {
          return { status: "approval_required", articleId, reason: "Legacy published rows require an exact operator authorization receipt." };
        }
        return { status: "rejected", articleId, code: "operator_authorization_mismatch", reason: "The operator receipt does not bind this article, version, date and evidence." };
      }
      authorizationRequired = true;
    }
  }

  const planHash = await spainDateOnlyPlanHash({
    articleId,
    previousVersionId: String(version.id),
    correctedOriginalPublishedAt,
    evidenceSha256,
    authorizationBasis,
  });
  const correction: SpainDateOnlyCorrectionInput = {
    previousVersionId: String(version.id),
    correctedOriginalPublishedAt,
    decisionDate,
    evidenceSha256,
    hjId: String(evidence.hjId),
    officialSourceUrl: evidence.canonicalUrl || spainDateOnlyOfficialUrl(hjId),
    rawFechaRegistro: evidence.rawFechaRegistro ?? null,
    headingIdentifier: evidence.heading!.identifierText,
    resolutionType: evidence.heading!.resolutionType!,
    resolutionNumber: evidence.heading!.resolutionNumber!,
    resolutionYear: evidence.heading!.resolutionYear!,
    ecli: evidence.ecli ?? evidence.heading!.ecli ?? null,
    boeDate: evidence.boeDate ?? evidence.heading!.boeDate ?? null,
    evidenceBasis: "detail_heading",
    authorizationBasis,
    operatorActorId: authorizationBasis === "operator_authorization" ? input.actorId : null,
    operatorApprovedAt: authorizationBasis === "operator_authorization"
      ? input.operatorAuthorization?.approvedAt ?? input.now ?? new Date().toISOString()
      : null,
    correlationId: input.correlationId,
  };
  if (input.apply !== true) {
    return {
      status: "planned",
      articleId,
      previousVersionId: String(version.id),
      correctedOriginalPublishedAt,
      decisionDate,
      evidenceSha256,
      authorizationBasis,
      planHash,
      evidence,
      ...(authorizationRequired ? {
        authorizationRequired: true,
        ...(operatorTemplate ? { operatorAuthorization: operatorTemplate } : {}),
      } : {}),
    };
  }
  if (!input.confirmPlanHash || input.confirmPlanHash !== planHash) {
    return { status: "rejected", articleId, code: "plan_hash_mismatch", reason: "The confirm plan hash does not match the current dry-run plan." };
  }
  const expectedVersionRevision = Math.max(
    Number(p3Head?.current_revision ?? 0),
    Number(v4Head?.current_revision ?? 0),
    Number(version.revision ?? 0),
  );
  const result = await transitionArticlePublicationInD1(input.core, {
    articleId,
    expectedVersionRevision,
    expectedPublicationRevision: Number(publication.revision ?? 0),
    idempotencyKey: `${OFFICIAL_DATE_ONLY_POLICY}:${articleId}:${version.id}:${decisionDate}`,
    targetState: "published",
    versionId: String(version.id),
    captureLegacy: false,
    actorType: "compatibility",
    actorId: input.actorId,
    reason: SPAIN_DATE_ONLY_REASON,
    requestId: input.correlationId,
    correlationId: input.correlationId,
    safeMetadata: {
      correctionPolicy: OFFICIAL_DATE_ONLY_POLICY,
      authorizationBasis,
      evidenceSha256,
      decisionDate,
      previousVersionId: String(version.id),
    },
    officialDateOnlyCorrection: correction,
  });
  if (!result.ok) {
    return { status: "failed", articleId, error: result.error.code, planHash };
  }
  return {
    status: "applied",
    articleId,
    previousVersionId: String(version.id),
    versionId: result.data.versionId,
    versionRevision: result.data.versionRevision,
    publicationId: result.data.publicationId,
    publicationRevision: result.data.publicationRevision,
    ...(result.data.generation ? {
      generationId: result.data.generation.generationId,
      searchRepairOutboxId: result.data.generation.searchRepairOutboxId,
    } : {}),
    evidenceSha256,
    authorizationBasis,
    planHash,
  };
}

export { SPAIN_DATE_ONLY_ACTOR };
