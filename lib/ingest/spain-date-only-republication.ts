import { canonicalJson } from "@/lib/backfill/canonical-json";
import {
  APPROVAL_HASH_SCHEMA,
  OFFICIAL_DATE_ONLY_POLICY,
  approvalIdentity,
  sha256Canonical,
  type E2EApprovalContext,
} from "@/lib/cloudflare/e2e/contracts";
import { hasE2ETable } from "@/lib/cloudflare/e2e/generation-state";
import type { D1RuntimeDatabase } from "@/lib/cloudflare/d1/runtime-binding";
import type { SpainDateOnlyCorrectionInput } from "@/lib/article-publication/types";
import {
  normalizeSpainDateOnly,
  normalizeSpainResolutionType,
  type SpainResolutionType,
} from "@/lib/ingest/spain-decision-date";
import {
  extractSpainHjId,
  spainOfficialUrl,
  type SpainOfficialDateEvidence,
} from "@/lib/ingest/spain-decision-date-recovery";

export { OFFICIAL_DATE_ONLY_POLICY };
export const SPAIN_DATE_ONLY_REASON =
  "Republish the verified official HJ FECHA_REGISTRO decision date as a new immutable P3 version.";
export const SPAIN_DATE_ONLY_ACTOR = "spain-official-date-only-correction";

type Row = Record<string, unknown>;

export interface SpainDateOnlyCandidate {
  article: Row;
  publication: Row | null;
  version: Row | null;
  p3Head: Row | null;
  v4Head: Row | null;
  managed: Row | null;
  sourcePolicyRequired: boolean;
}

export type SpainDateOnlyEvidenceFailure =
  | "official_fetch_failed"
  | "official_heading_unavailable"
  | "official_identity_mismatch"
  | "official_date_mismatch"
  | "official_ecli_mismatch"
  | "boe_date_not_distinct"
  | "article_identity_missing"
  | "hj_id_mismatch"
  | "corrected_date_mismatch";

export type SpainDateOnlyAuthorizationFailure =
  | "managed_owner_missing"
  | "managed_owner_stale"
  | "managed_approval_evidence_mismatch"
  | "operator_authorization_required"
  | "operator_authorization_mismatch"
  | "not_date_only_change";

export interface SpainDateOnlyApprovalEvidence {
  identity: {
    sourceContentHash: string;
    approvalSnapshotHash: string;
    approvalKey: string;
  };
  evidenceDocument: string;
  evidenceRef: string;
  sourceArtifactRef: string;
  sourceArtifactHash: string;
  approvalContext: E2EApprovalContext;
}

export interface SpainDateOnlyOperatorAuthorization {
  actorId: string;
  approvedAt: string;
  articleId: string;
  currentVersionId: string;
  correctedOriginalPublishedAt: string;
  evidenceSha256: string;
  correlationId?: string | null;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown) {
  const n = typeof value === "number" ? value : Number(value ?? NaN);
  return Number.isSafeInteger(n) ? n : null;
}

function jsonObject(value: unknown) {
  if (typeof value !== "string") return value && typeof value === "object" ? value as Row : {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Row : {};
  } catch {
    return {};
  }
}

async function readOne(core: D1RuntimeDatabase, sql: string, ...values: unknown[]): Promise<Row | null> {
  const result = await core.prepare(sql).bind(...values).all<Row>();
  if (result.success === false || result.error) throw new Error("e2e.read_failed");
  return result.results?.[0] ?? null;
}

export async function readSpainDateOnlyCandidate(
  core: D1RuntimeDatabase,
  articleId: string,
): Promise<SpainDateOnlyCandidate | null> {
  if (!articleId.trim()) return null;
  const article = await readOne(
    core,
    "SELECT * FROM articles WHERE id=? AND source_key=?",
    articleId,
    "es-tribunal-constitucional",
  );
  if (!article) return null;
  const publication = await readOne(core, "SELECT * FROM article_publications_p3 WHERE article_id=?", articleId);
  const version = publication?.version_id
    ? await readOne(
      core,
      "SELECT * FROM article_content_versions_p3 WHERE id=? AND article_id=?",
      String(publication.version_id),
      articleId,
    )
    : null;
  const p3Head = await readOne(core, "SELECT * FROM article_version_heads_p3 WHERE article_id=?", articleId);
  const v4Head = await readOne(core, "SELECT * FROM article_revision_heads_v4 WHERE article_id=?", articleId);
  const managed = await hasE2ETable(core, "e2e_generation_heads_v1")
    ? await readOne(
      core,
      "SELECT g.* FROM e2e_generation_heads_v1 h JOIN e2e_generations_v1 g ON g.generation_id=h.generation_id WHERE h.article_id=?",
      articleId,
    )
    : null;
  const sourceRule = await hasE2ETable(core, "e2e_source_policies_v1")
    ? await readOne(core, "SELECT required FROM e2e_source_policies_v1 WHERE source_key=?", String(article.source_key))
    : null;
  return {
    article,
    publication,
    version,
    p3Head,
    v4Head,
    managed,
    sourcePolicyRequired: Number(sourceRule?.required ?? 0) === 1,
  };
}

export function parseSpainArticleResolutionIdentity(title: unknown) {
  const text = stringValue(title);
  if (!text) return null;
  const match = /\b(SENTENCIA|AUTO|DECLARACI[OÓ]N|DECLARACION)\s+(\d{1,5})\s*\/\s*(\d{4})\b/i.exec(text);
  if (!match) return null;
  const resolutionType = normalizeSpainResolutionType(match[1]);
  const resolutionNumber = numberValue(match[2]);
  const resolutionYear = numberValue(match[3]);
  if (!resolutionType || !resolutionNumber || !resolutionYear) return null;
  return { resolutionType, resolutionNumber, resolutionYear };
}

function parsedEcli(value: string | undefined) {
  if (!value) return null;
  const match = /^ECLI:ES:TC:(\d{4}):(\d{1,5})([A-Z]?)$/u.exec(value.trim().toUpperCase());
  if (!match) return null;
  return { year: Number(match[1]), number: Number(match[2]), suffix: match[3] };
}

/**
 * Fail-closed official evidence check. The detail heading is authoritative; HJ
 * JSON is only a cross-check. Listing/title/createdAt dates are never accepted.
 */
export function validateSpainDateOnlyEvidence(input: {
  article: Row;
  version: Row;
  evidence: SpainOfficialDateEvidence;
  correctedOriginalPublishedAt: string;
}): { ok: true } | { ok: false; code: SpainDateOnlyEvidenceFailure; reason: string } {
  const { evidence, article, version } = input;
  if (!evidence.fetched) {
    return { ok: false, code: "official_fetch_failed", reason: evidence.reason ?? "Official HJ evidence is unavailable." };
  }
  if (!evidence.ok || !evidence.decisionDate) {
    return { ok: false, code: "official_date_mismatch", reason: evidence.reason ?? "Official decision date is unavailable." };
  }
  if (evidence.evidenceBasis !== "detail_heading" || !evidence.heading?.decisionDate) {
    return { ok: false, code: "official_heading_unavailable", reason: "The authoritative official HJ detail heading is required." };
  }
  if (evidence.heading.decisionDate !== evidence.decisionDate) {
    return { ok: false, code: "official_date_mismatch", reason: "Official heading and evidence decision dates disagree." };
  }
  const identity = parseSpainArticleResolutionIdentity(article.original_title);
  if (!identity) {
    return { ok: false, code: "article_identity_missing", reason: "The stored article title has no official resolution identity." };
  }
  const heading = evidence.heading;
  if (heading.resolutionType !== identity.resolutionType
    || heading.resolutionNumber !== identity.resolutionNumber
    || heading.resolutionYear !== identity.resolutionYear) {
    return { ok: false, code: "official_identity_mismatch", reason: "Official heading type/number/year does not match the stored article." };
  }
  const expectedHjId = extractSpainHjId({
    canonical_url: stringValue(version.canonical_url) ?? stringValue(article.canonical_url),
    original_url: stringValue(version.original_url) ?? stringValue(article.original_url),
  });
  if (!expectedHjId || expectedHjId !== evidence.hjId) {
    return { ok: false, code: "hj_id_mismatch", reason: "Official HJ id does not match the immutable version canonical URL." };
  }
  if (evidence.ecli) {
    const ecli = parsedEcli(evidence.ecli);
    if (!ecli || ecli.year !== identity.resolutionYear || ecli.number !== identity.resolutionNumber) {
      return { ok: false, code: "official_ecli_mismatch", reason: "Official ECLI does not match the resolution type/number/year." };
    }
    if (heading.ecli && heading.ecli.toUpperCase() !== evidence.ecli.toUpperCase()) {
      return { ok: false, code: "official_ecli_mismatch", reason: "Official heading ECLI disagrees with the cross-check payload." };
    }
  }
  if (evidence.boeDate && evidence.boeDate === evidence.decisionDate) {
    return { ok: false, code: "boe_date_not_distinct", reason: "The BOE publication date must be distinct from the decision date." };
  }
  if (input.correctedOriginalPublishedAt !== `${evidence.decisionDate}T00:00:00.000Z`) {
    return { ok: false, code: "corrected_date_mismatch", reason: "The corrected timestamp must be the exact official decision date." };
  }
  return { ok: true };
}

function redactedVersion(version: Row) {
  return { ...version, original_published_at: "__official_date_only__" };
}

async function dateOnlyHashesMatch(
  articleId: string,
  previousVersion: Row,
  correctedVersion: Row,
  policyVersion: string,
  hashSchema: string,
) {
  const previous = await approvalIdentity(articleId, redactedVersion(previousVersion), policyVersion, hashSchema);
  const corrected = await approvalIdentity(articleId, redactedVersion(correctedVersion), policyVersion, hashSchema);
  return previous.approvalSnapshotHash === corrected.approvalSnapshotHash
    && previous.sourceContentHash === corrected.sourceContentHash;
}

export async function assertSpainDateOnlyAuthorization(input: {
  articleId: string;
  previousVersion: Row;
  correctedVersion: Row;
  publication: Row;
  managed: Row | null;
  correction: SpainDateOnlyCorrectionInput;
}): Promise<{ ok: true; authorizationBasis: "managed_generation" | "operator_authorization" } | { ok: false; code: SpainDateOnlyAuthorizationFailure; reason: string }> {
  const { articleId, previousVersion, correctedVersion, publication, managed, correction } = input;
  if (previousVersion.original_published_at !== null && previousVersion.original_published_at !== undefined) {
    return { ok: false, code: "managed_owner_stale", reason: "The previous immutable version already has an official date." };
  }
  if (correction.authorizationBasis === "managed_generation") {
    if (!managed) return { ok: false, code: "managed_owner_missing", reason: "No recorded E2E generation owns this article." };
    if (String(managed.expected_publication_state) !== "published"
      || String(managed.expected_version_id) !== String(previousVersion.id)
      || String(managed.expected_publication_id) !== String(publication.id)
      || Number(managed.expected_version_revision) !== Number(previousVersion.revision)) {
      return { ok: false, code: "managed_owner_stale", reason: "The recorded generation no longer owns the current published version." };
    }
    const policyVersion = stringValue(managed.policy_version);
    const hashSchema = stringValue(managed.approval_hash_schema) ?? APPROVAL_HASH_SCHEMA;
    if (!policyVersion || ![APPROVAL_HASH_SCHEMA, "worldcons.approval.v1"].includes(hashSchema)) {
      return { ok: false, code: "managed_approval_evidence_mismatch", reason: "The recorded generation approval schema is invalid." };
    }
    const previousIdentity = await approvalIdentity(articleId, previousVersion, policyVersion, hashSchema);
    if (previousIdentity.approvalSnapshotHash !== managed.approval_snapshot_hash
      || previousIdentity.approvalKey !== managed.approval_key) {
      return { ok: false, code: "managed_approval_evidence_mismatch", reason: "The recorded generation approval is not bound to the published version." };
    }
    if (!await dateOnlyHashesMatch(articleId, previousVersion, correctedVersion, policyVersion, hashSchema)) {
      return { ok: false, code: "not_date_only_change", reason: "The correction changes fields other than the official date." };
    }
    return { ok: true, authorizationBasis: "managed_generation" };
  }
  if (!stringValue(correction.operatorActorId) || !Number.isFinite(Date.parse(String(correction.operatorApprovedAt)))) {
    return { ok: false, code: "operator_authorization_required", reason: "An authenticated operator receipt is required for legacy rows." };
  }
  if (!correction.correlationId.trim()) {
    return { ok: false, code: "operator_authorization_mismatch", reason: "A correlation id is required for operator authorization." };
  }
  if (!await dateOnlyHashesMatch(articleId, previousVersion, correctedVersion, OFFICIAL_DATE_ONLY_POLICY, APPROVAL_HASH_SCHEMA)) {
    return { ok: false, code: "not_date_only_change", reason: "The correction changes fields other than the official date." };
  }
  return { ok: true, authorizationBasis: "operator_authorization" };
}

export async function buildSpainDateOnlyApprovalEvidence(input: {
  articleId: string;
  previousVersion: Row;
  correctedVersion: Row;
  managed: Row | null;
  correction: SpainDateOnlyCorrectionInput;
  evidence: SpainOfficialDateEvidence;
  observedAt: string;
}): Promise<SpainDateOnlyApprovalEvidence> {
  const { articleId, previousVersion, correctedVersion, managed, correction, observedAt } = input;
  const identity = await approvalIdentity(articleId, correctedVersion, OFFICIAL_DATE_ONLY_POLICY, APPROVAL_HASH_SCHEMA);
  const previousIdentity = await approvalIdentity(articleId, previousVersion, OFFICIAL_DATE_ONLY_POLICY, APPROVAL_HASH_SCHEMA);
  const evidenceRef = `core:e2e-date-only:${identity.approvalKey}`;
  const sourceArtifactRef = `official:hj:${correction.hjId}:${correction.evidenceSha256}`;
  const sourceArtifactHash = correction.evidenceSha256;
  const candidateId = ((managed ? stringValue(managed.discovery_candidate_id) : null)
    ?? `date-only:${managed ? String(managed.generation_id) : correction.operatorActorId ?? "legacy"}`).slice(0, 160);
  const pipelineRunId = ((managed ? stringValue(managed.pipeline_run_id) : null)
    ?? `date-only-run:${identity.approvalKey}`).slice(0, 160);
  const document = {
    schema: "worldcons.official-date-only-approval.v1",
    policyVersion: OFFICIAL_DATE_ONLY_POLICY,
    articleId,
    ...identity,
    previousVersionId: String(previousVersion.id),
    previousVersionRevision: String(previousVersion.revision),
    previousOriginalPublishedAt: previousVersion.original_published_at ?? null,
    previousGenerationId: managed ? String(managed.generation_id) : null,
    previousApprovalKey: managed ? String(managed.approval_key) : null,
    previousPolicyVersion: managed ? String(managed.policy_version) : null,
    correctedOriginalPublishedAt: correction.correctedOriginalPublishedAt,
    decisionDate: correction.decisionDate,
    hjId: correction.hjId,
    officialSourceUrl: correction.officialSourceUrl,
    rawFechaRegistro: correction.rawFechaRegistro ?? null,
    headingIdentifier: correction.headingIdentifier,
    resolutionType: correction.resolutionType,
    resolutionNumber: correction.resolutionNumber,
    resolutionYear: correction.resolutionYear,
    ecli: correction.ecli ?? null,
    boeDate: correction.boeDate ?? null,
    evidenceBasis: correction.evidenceBasis,
    evidenceSha256: correction.evidenceSha256,
    sourceArtifactRef,
    sourceArtifactHash,
    candidateId,
    pipelineRunId,
    authorizationBasis: correction.authorizationBasis,
    operatorActorId: correction.operatorActorId ?? null,
    operatorApprovedAt: correction.operatorApprovedAt ?? null,
    correlationId: correction.correlationId,
    checks: {
      dateOnlyChange: true,
      officialHeadingIdentity: true,
      officialDateMatches: true,
      boeDistinct: true,
      sourceContentUnchanged: identity.sourceContentHash === previousIdentity.sourceContentHash,
      previousApprovalBound: correction.authorizationBasis === "managed_generation",
      operatorAuthorized: correction.authorizationBasis === "operator_authorization",
    },
    observedAt,
  };
  const evidenceDocument = canonicalJson(document);
  return {
    identity,
    evidenceDocument,
    evidenceRef,
    sourceArtifactRef,
    sourceArtifactHash,
    approvalContext: {
      mode: "automatic",
      hashSchema: APPROVAL_HASH_SCHEMA,
      policyVersion: OFFICIAL_DATE_ONLY_POLICY,
      evidenceRef,
      sourceEvidenceRef: sourceArtifactRef,
      pipelineRunId,
      discoveryCandidateId: candidateId,
    },
  };
}

export function spainDateOnlyEvidenceInsert(
  binding: D1RuntimeDatabase,
  articleId: string,
  approval: SpainDateOnlyApprovalEvidence,
  now: string,
) {
  return binding.prepare(
    `INSERT INTO e2e_approval_evidence_v1 (approval_key,article_id,approval_snapshot_hash,source_content_hash,
      policy_version,evidence_ref,source_artifact_ref,source_artifact_hash,discovery_candidate_id,pipeline_run_id,evidence_document,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(approval_key) DO NOTHING`,
  ).bind(
    approval.identity.approvalKey,
    articleId,
    approval.identity.approvalSnapshotHash,
    approval.identity.sourceContentHash,
    OFFICIAL_DATE_ONLY_POLICY,
    approval.evidenceRef,
    approval.sourceArtifactRef,
    approval.sourceArtifactHash,
    approval.approvalContext.discoveryCandidateId ?? null,
    approval.approvalContext.pipelineRunId ?? null,
    approval.evidenceDocument,
    now,
  );
}

/** Exact immutable snapshot consumed by the correction content hash. */
export function spainDateOnlyVersionDocument(version: Row, correctedOriginalPublishedAt: string) {
  return {
    slug: version.slug ?? null,
    sourceKey: version.source_key ?? null,
    jurisdiction: version.jurisdiction ?? null,
    institutionName: version.institution_name ?? null,
    contentType: version.content_type ?? null,
    originalUrl: version.original_url ?? null,
    canonicalUrl: version.canonical_url ?? null,
    originalLanguage: version.original_language ?? null,
    originalTitle: version.original_title ?? null,
    koreanTitle: version.korean_title ?? null,
    originalPublishedAt: correctedOriginalPublishedAt,
    discoveredAt: version.discovered_at ?? null,
    fetchedAt: version.fetched_at ?? null,
    summarizedAt: version.summarized_at ?? null,
    cleanedText: version.cleaned_text ?? null,
    summaryJson: jsonObject(version.summary_json),
    sourceMetadata: jsonObject(version.source_metadata),
    errorMetadata: jsonObject(version.error_metadata),
  };
}

async function sha256Hex(value: string) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function spainDateOnlyContentHash(version: Row, correctedOriginalPublishedAt: string) {
  return sha256Hex(JSON.stringify(spainDateOnlyVersionDocument(version, correctedOriginalPublishedAt)));
}

export async function spainDateOnlyVersionId(articleId: string, contentHash: string) {
  const hash = await sha256Hex(`${articleId}:${contentHash}`);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

export async function spainDateOnlyPlanHash(input: {
  articleId: string;
  previousVersionId: string;
  correctedOriginalPublishedAt: string;
  evidenceSha256: string;
  authorizationBasis: "managed_generation" | "operator_authorization";
}) {
  return sha256Canonical({ schema: OFFICIAL_DATE_ONLY_POLICY, ...input });
}

export function spainDateOnlyOfficialUrl(hjId: string) {
  return spainOfficialUrl(hjId);
}

export function spainDateOnlyDateOnly(value: unknown) {
  return normalizeSpainDateOnly(value);
}

export type { SpainOfficialDateEvidence, SpainResolutionType };
