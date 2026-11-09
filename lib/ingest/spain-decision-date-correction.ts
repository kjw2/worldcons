import { canonicalJson } from "@/lib/backfill/canonical-json";
import { renderSqlLiteral } from "@/lib/cloudflare/d1/import/literal";
import { normalizeSpainDateOnly } from "@/lib/ingest/spain-decision-date";
import {
  extractSpainHjId,
  spainOfficialUrl,
  type SpainOfficialDateEvidence,
} from "@/lib/ingest/spain-decision-date-recovery";

export const SPAIN_DATE_CORRECTION_POLICY = "worldcons.spain-fecha-registro-correction.v1" as const;
export const SPAIN_DATE_CORRECTION_REASON =
  "Correct the court decision date from verified official HJ FECHA_REGISTRO as a new immutable version.";
export const SPAIN_DATE_CORRECTION_ACTOR = "spain-fecha-registro-correction";

export interface SpainDateCorrectionRow {
  article_id: string;
  article_source_key?: string | null;
  canonical_url?: string | null;
  article_original_published_at?: string | null;
  article_updated_at?: string | null;
  article_content_hash?: string | null;
  publication_id?: string | null;
  publication_state?: string | null;
  publication_revision?: number | string | null;
  publication_version_id?: string | null;
  version_id?: string | null;
  version_revision?: number | string | null;
  version_content_hash?: string | null;
  version_original_published_at?: string | null;
  version_created_at?: string | null;
  version_slug?: string | null;
  version_source_key?: string | null;
  version_jurisdiction?: string | null;
  version_institution_name?: string | null;
  version_content_type?: string | null;
  version_original_url?: string | null;
  version_canonical_url?: string | null;
  version_original_language?: string | null;
  version_original_title?: string | null;
  version_korean_title?: string | null;
  version_discovered_at?: string | null;
  version_fetched_at?: string | null;
  version_summarized_at?: string | null;
  version_cleaned_text?: string | null;
  version_summary_json?: string | null;
  version_source_metadata?: string | null;
  version_error_metadata?: string | null;
  version_case_key?: string | null;
  p3_head_version_id?: string | null;
  p3_head_revision?: number | string | null;
  v4_head_version_id?: string | null;
  v4_head_revision?: number | string | null;
  has_generation?: boolean | number | string | null;
  source_policy_required?: boolean | number | string | null;
  audit_ledger_revision?: number | string | null;
  audit_entry_hash?: string | null;
}

export interface SpainDateCorrectionAuthorizationEntry {
  articleId: string;
  currentVersionId: string;
  correctedOriginalPublishedAt: string;
  evidenceSha256: string;
}

export interface SpainDateCorrectionAuthorization {
  policyVersion: string;
  actorId: string;
  approvedAt: string;
  entries: readonly SpainDateCorrectionAuthorizationEntry[];
}

export type SpainDateCorrectionStatus =
  | "repairable"
  | "already_corrected"
  | "conflict"
  | "approval_required"
  | "source_date_missing"
  | "source_date_invalid"
  | "hj_id_missing"
  | "official_fetch_failed"
  | "not_published";

export interface SpainDateCorrectionVersion {
  versionId: string;
  revision: string;
  parentVersionId: string;
  contentHash: string;
  originalPublishedAt: string;
}

export interface SpainDateCorrectionRollback {
  policy: "republish_previous_immutable_version";
  previousVersionId: string;
  previousVersionRevision: string;
  previousCoreOriginalPublishedAt: string | null;
  previousPublicationRevision: string;
  neverDelete: true;
}

export interface SpainDateCorrectionProposal {
  articleId: string;
  status: SpainDateCorrectionStatus;
  action: "create_version_and_republish" | "none";
  canonicalUrl: string;
  hjId?: string;
  currentVersionOriginalPublishedAt: string | null;
  correctedOriginalPublishedAt: string | null;
  coreUpdateRequired: boolean;
  authorizationRequired: boolean;
  authorizationSatisfied: boolean;
  protectedSource: boolean;
  reason?: string;
  evidence?: SpainOfficialDateEvidence;
  evidenceSha256?: string;
  guard: {
    articleOriginalPublishedAt: string | null;
    articleUpdatedAt: string | null;
    articleContentHash: string | null;
    versionId: string;
    versionRevision: string;
    versionContentHash: string;
    versionOriginalPublishedAtIsNull: boolean;
    publicationId: string;
    publicationRevision: string;
    publicationState: string;
    p3HeadVersionId: string | null;
    p3HeadRevision: string | null;
  };
  newVersion?: SpainDateCorrectionVersion;
  idempotencyKey?: string;
  provenance?: {
    policyVersion: string;
    actorId: string;
    officialSourceUrl: string;
    rawFechaRegistro?: string;
    fechaRegistro: string;
    dateBasis?: "detail_heading" | "json_fecha_registro";
    headingIdentifier?: string;
    ecli?: string;
    boeDate?: string;
    evidenceSha256: string;
  };
  rollback?: SpainDateCorrectionRollback;
  audit: {
    previousRevision: string | null;
    previousHash: string | null;
  };
  sqlPreview?: string;
}

export interface SpainDateCorrectionPlan {
  schema: "worldcons.spain-decision-date-correction.v1";
  mode: "dry-run";
  generatedAt: string;
  writes: 0;
  applySupported: true;
  applyReady: boolean;
  policyVersion: typeof SPAIN_DATE_CORRECTION_POLICY;
  officialFetchCount: number;
  authorizationProvided: boolean;
  rollbackPolicy: "republish_previous_immutable_version";
  rows: SpainDateCorrectionProposal[];
  summary: {
    total: number;
    repairable: number;
    authorized: number;
    alreadyCorrected: number;
    conflicts: number;
    approvalRequired: number;
    unresolved: number;
  };
  planHash: string;
}

export interface SpainDateCorrectionStatement {
  id: string;
  sql: string;
  params: Array<string | number | null>;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function booleanValue(value: unknown) {
  return value === true || value === 1 || value === "1";
}

function revisionValue(value: unknown) {
  const raw = typeof value === "number" ? String(value) : stringValue(value);
  if (!raw || !/^\d+$/u.test(raw)) return "0";
  return String(Number(raw));
}

async function sha256Hex(value: string) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function jsonValue(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/** Official HJ evidence hash bound to the exact article/version/date authorization. */
export async function spainDateCorrectionEvidenceSha256(
  evidence: SpainOfficialDateEvidence,
  policyVersion = SPAIN_DATE_CORRECTION_POLICY,
) {
  return sha256Hex(canonicalJson({
    schema: policyVersion,
    hjId: evidence.hjId,
    canonicalUrl: evidence.canonicalUrl,
    rawFechaRegistro: evidence.rawFechaRegistro ?? null,
    decisionDate: evidence.decisionDate ?? null,
    boeDate: evidence.boeDate ?? null,
    ecli: evidence.ecli ?? null,
    evidenceBasis: evidence.evidenceBasis ?? null,
    heading: evidence.heading
      ? {
        identifierText: evidence.heading.identifierText,
        resolutionType: evidence.heading.resolutionType ?? null,
        resolutionNumber: evidence.heading.resolutionNumber ?? null,
        resolutionYear: evidence.heading.resolutionYear ?? null,
        decisionDate: evidence.heading.decisionDate ?? null,
        ecli: evidence.heading.ecli ?? null,
        boeNumber: evidence.heading.boeNumber ?? null,
        boeDate: evidence.heading.boeDate ?? null,
      }
      : null,
    checks: evidence.checks,
  }));
}

function authorizationEntry(
  authorization: SpainDateCorrectionAuthorization | undefined,
  articleId: string,
  versionId: string,
  correctedOriginalPublishedAt: string,
  evidenceSha256: string,
) {
  if (!authorization || authorization.policyVersion !== SPAIN_DATE_CORRECTION_POLICY
    || !authorization.actorId.trim() || !Number.isFinite(Date.parse(authorization.approvedAt))) return false;
  return authorization.entries.some((entry) => entry.articleId === articleId
    && entry.currentVersionId === versionId
    && entry.correctedOriginalPublishedAt === correctedOriginalPublishedAt
    && entry.evidenceSha256 === evidenceSha256);
}

/** The authoritative snapshot consumed by the version hash. No operational timestamps. */
export function spainDateCorrectionVersionDocument(
  row: SpainDateCorrectionRow,
  correctedOriginalPublishedAt: string,
) {
  return {
    slug: row.version_slug ?? null,
    sourceKey: row.version_source_key ?? row.article_source_key ?? null,
    jurisdiction: row.version_jurisdiction,
    institutionName: row.version_institution_name,
    contentType: row.version_content_type,
    originalUrl: row.version_original_url,
    canonicalUrl: row.version_canonical_url ?? row.canonical_url ?? null,
    originalLanguage: row.version_original_language,
    originalTitle: row.version_original_title ?? null,
    koreanTitle: row.version_korean_title ?? null,
    originalPublishedAt: correctedOriginalPublishedAt,
    discoveredAt: row.version_discovered_at ?? null,
    fetchedAt: row.version_fetched_at ?? null,
    summarizedAt: row.version_summarized_at ?? null,
    cleanedText: row.version_cleaned_text ?? null,
    summaryJson: jsonValue(row.version_summary_json),
    sourceMetadata: jsonValue(row.version_source_metadata),
    errorMetadata: jsonValue(row.version_error_metadata),
  };
}

export async function spainDateCorrectionContentHash(
  row: SpainDateCorrectionRow,
  correctedOriginalPublishedAt: string,
) {
  return sha256Hex(JSON.stringify(spainDateCorrectionVersionDocument(row, correctedOriginalPublishedAt)));
}

async function deterministicVersionId(articleId: string, contentHash: string) {
  const hash = await sha256Hex(`${articleId}:${contentHash}`);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

function nextRevision(row: SpainDateCorrectionRow) {
  return Math.max(
    Number(revisionValue(row.version_revision)),
    Number(revisionValue(row.p3_head_revision)),
    Number(revisionValue(row.v4_head_revision)),
  ) + 1;
}

function statusForEvidence(evidence: SpainOfficialDateEvidence): SpainDateCorrectionStatus {
  if (!evidence.fetched) return "official_fetch_failed";
  if (evidence.ok && evidence.decisionDate) return "repairable";
  return evidence.reason === "FECHA_REGISTRO is missing." ? "source_date_missing" : "source_date_invalid";
}

export interface BuildSpainDateCorrectionPlanInput {
  rows: readonly SpainDateCorrectionRow[];
  fetchEvidence: (hjId: string, canonicalUrl: string) => Promise<SpainOfficialDateEvidence>;
  authorization?: SpainDateCorrectionAuthorization;
  now?: string;
  maxOfficialFetches?: number;
}

/** Builds a safe, read-only correction plan. Every decision date is official evidence only. */
export async function buildSpainDateCorrectionPlan(
  input: BuildSpainDateCorrectionPlanInput,
): Promise<SpainDateCorrectionPlan> {
  const now = input.now ?? new Date().toISOString();
  const maxOfficialFetches = Math.max(0, Math.trunc(input.maxOfficialFetches ?? 200));
  const cache = new Map<string, SpainOfficialDateEvidence>();
  let officialFetchCount = 0;

  const evidenceFor = async (hjId: string, canonicalUrl: string) => {
    const cached = cache.get(hjId);
    if (cached) return cached;
    if (officialFetchCount >= maxOfficialFetches) return undefined;
    officialFetchCount += 1;
    const evidence = await input.fetchEvidence(hjId, canonicalUrl);
    cache.set(hjId, evidence);
    return evidence;
  };

  const rows: SpainDateCorrectionProposal[] = [];
  for (const row of input.rows) {
    const articleId = stringValue(row.article_id) ?? "";
    const canonicalUrl = stringValue(row.version_canonical_url) ?? stringValue(row.canonical_url) ?? "";
    const versionId = stringValue(row.version_id) ?? "";
    const versionRevision = revisionValue(row.version_revision);
    const versionContentHash = stringValue(row.version_content_hash) ?? "";
    const versionOriginalPublishedAt = stringValue(row.version_original_published_at);
    const publicationState = stringValue(row.publication_state) ?? "";
    const publicationVersionId = stringValue(row.publication_version_id) ?? "";
    const currentVersionOriginalPublishedAt = versionOriginalPublishedAt;
    const baseGuard = {
      articleOriginalPublishedAt: stringValue(row.article_original_published_at),
      articleUpdatedAt: stringValue(row.article_updated_at),
      articleContentHash: stringValue(row.article_content_hash),
      versionId,
      versionRevision,
      versionContentHash,
      versionOriginalPublishedAtIsNull: versionOriginalPublishedAt === null,
      publicationId: stringValue(row.publication_id) ?? "",
      publicationRevision: revisionValue(row.publication_revision),
      publicationState,
      p3HeadVersionId: stringValue(row.p3_head_version_id),
      p3HeadRevision: row.p3_head_revision === undefined || row.p3_head_revision === null
        ? null
        : revisionValue(row.p3_head_revision),
    };
    const audit = {
      previousRevision: stringValue(row.audit_ledger_revision),
      previousHash: stringValue(row.audit_entry_hash),
    };
    const protectedSource = booleanValue(row.has_generation) || booleanValue(row.source_policy_required);

    if (!articleId || !versionId || !versionContentHash) {
      rows.push({
        articleId, status: "conflict", action: "none", canonicalUrl, currentVersionOriginalPublishedAt,
        correctedOriginalPublishedAt: null, coreUpdateRequired: false, authorizationRequired: true,
        authorizationSatisfied: false, protectedSource, reason: "Required article/version identity is missing.",
        guard: baseGuard, audit,
      });
      continue;
    }
    if (publicationState !== "published" || publicationVersionId !== versionId) {
      rows.push({
        articleId, status: "not_published", action: "none", canonicalUrl, currentVersionOriginalPublishedAt,
        correctedOriginalPublishedAt: null, coreUpdateRequired: false, authorizationRequired: true,
        authorizationSatisfied: false, protectedSource, reason: "The selected version is not the current published version.",
        guard: baseGuard, audit,
      });
      continue;
    }
    if (currentVersionOriginalPublishedAt) {
      rows.push({
        articleId, status: "already_corrected", action: "none", canonicalUrl, currentVersionOriginalPublishedAt,
        correctedOriginalPublishedAt: null, coreUpdateRequired: false, authorizationRequired: false,
        authorizationSatisfied: true, protectedSource, guard: baseGuard, audit,
      });
      continue;
    }

    const versionCanonicalUrl = stringValue(row.version_canonical_url) ?? stringValue(row.canonical_url);
    const urlHjId = extractSpainHjId({ canonical_url: versionCanonicalUrl });
    const metadataHjId = stringValue(row.version_source_metadata)
      ? extractSpainHjId({ source_metadata: row.version_source_metadata })
      : undefined;
    if (!urlHjId) {
      rows.push({
        articleId, status: "hj_id_missing", action: "none", canonicalUrl,
        currentVersionOriginalPublishedAt, correctedOriginalPublishedAt: null, coreUpdateRequired: false,
        authorizationRequired: true, authorizationSatisfied: false, protectedSource,
        reason: "The immutable version canonical URL is not an official HJ resolution URL.",
        guard: baseGuard, audit,
      });
      continue;
    }
    if (metadataHjId && metadataHjId !== urlHjId) {
      rows.push({
        articleId, status: "conflict", action: "none", canonicalUrl,
        hjId: urlHjId, currentVersionOriginalPublishedAt, correctedOriginalPublishedAt: null, coreUpdateRequired: false,
        authorizationRequired: true, authorizationSatisfied: false, protectedSource,
        reason: "Immutable version metadata HJ id conflicts with the official canonical URL.",
        guard: baseGuard, audit,
      });
      continue;
    }
    const hjId = metadataHjId ?? urlHjId;

    const evidence = await evidenceFor(hjId, canonicalUrl || spainOfficialUrl(hjId));
    if (!evidence) {
      rows.push({
        articleId, status: "official_fetch_failed", action: "none", canonicalUrl: canonicalUrl || spainOfficialUrl(hjId),
        hjId, currentVersionOriginalPublishedAt, correctedOriginalPublishedAt: null, coreUpdateRequired: false,
        authorizationRequired: true, authorizationSatisfied: false, protectedSource,
        reason: "Official HJ evidence fetch budget exhausted.", guard: baseGuard, audit,
      });
      continue;
    }

    const status = statusForEvidence(evidence);
    if (status !== "repairable" || !evidence.decisionDate) {
      rows.push({
        articleId, status, action: "none", canonicalUrl: canonicalUrl || spainOfficialUrl(hjId), hjId,
        currentVersionOriginalPublishedAt, correctedOriginalPublishedAt: null, coreUpdateRequired: false,
        authorizationRequired: true, authorizationSatisfied: false, protectedSource,
        ...(evidence.reason ? { reason: evidence.reason } : {}), evidence, guard: baseGuard, audit,
      });
      continue;
    }

    if (protectedSource) {
      rows.push({
        articleId, status: "approval_required", action: "none", canonicalUrl: canonicalUrl || spainOfficialUrl(hjId), hjId,
        currentVersionOriginalPublishedAt, correctedOriginalPublishedAt: null, coreUpdateRequired: false,
        authorizationRequired: true, authorizationSatisfied: false, protectedSource,
        reason: "Protected generation/source ownership requires a separate manual publication authorization.",
        evidence, guard: baseGuard, audit,
      });
      continue;
    }

    const articleOriginalPublishedAt = stringValue(row.article_original_published_at);
    const articleDateOnly = normalizeSpainDateOnly(articleOriginalPublishedAt);
    if (articleOriginalPublishedAt && articleDateOnly !== evidence.decisionDate) {
      rows.push({
        articleId, status: "conflict", action: "none", canonicalUrl: canonicalUrl || spainOfficialUrl(hjId), hjId,
        currentVersionOriginalPublishedAt, correctedOriginalPublishedAt: null, coreUpdateRequired: false,
        authorizationRequired: true, authorizationSatisfied: false, protectedSource,
        reason: "Current Core decision date conflicts with the verified official FECHA_REGISTRO.",
        evidence, guard: baseGuard, audit,
      });
      continue;
    }

    const correctedOriginalPublishedAt = `${evidence.decisionDate}T00:00:00.000Z`;
    const contentHash = await spainDateCorrectionContentHash(row, correctedOriginalPublishedAt);
    const evidenceSha256 = await spainDateCorrectionEvidenceSha256(evidence);
    const authorizationSatisfied = authorizationEntry(
      input.authorization, articleId, versionId, correctedOriginalPublishedAt, evidenceSha256,
    );
    const proposal: SpainDateCorrectionProposal = {
      articleId,
      status: "repairable",
      action: "create_version_and_republish",
      canonicalUrl: canonicalUrl || spainOfficialUrl(hjId),
      hjId,
      currentVersionOriginalPublishedAt,
      correctedOriginalPublishedAt,
      coreUpdateRequired: articleOriginalPublishedAt === null,
      authorizationRequired: true,
      authorizationSatisfied,
      protectedSource,
      evidence,
      evidenceSha256,
      guard: baseGuard,
      newVersion: {
        versionId: await deterministicVersionId(articleId, contentHash),
        revision: String(nextRevision(row)),
        parentVersionId: versionId,
        contentHash,
        originalPublishedAt: correctedOriginalPublishedAt,
      },
      idempotencyKey: `${SPAIN_DATE_CORRECTION_POLICY}:${articleId}:${versionId}:${evidence.decisionDate}`,
      provenance: {
        policyVersion: SPAIN_DATE_CORRECTION_POLICY,
        actorId: input.authorization?.actorId ?? SPAIN_DATE_CORRECTION_ACTOR,
        officialSourceUrl: evidence.canonicalUrl || spainOfficialUrl(hjId),
        ...(evidence.rawFechaRegistro ? { rawFechaRegistro: evidence.rawFechaRegistro } : {}),
        fechaRegistro: evidence.decisionDate,
        ...(evidence.evidenceBasis ? { dateBasis: evidence.evidenceBasis } : {}),
        ...(evidence.heading?.identifierText ? { headingIdentifier: evidence.heading.identifierText } : {}),
        ...(evidence.ecli ? { ecli: evidence.ecli } : {}),
        ...(evidence.boeDate ? { boeDate: evidence.boeDate } : {}),
        evidenceSha256,
      },
      rollback: {
        policy: "republish_previous_immutable_version",
        previousVersionId: versionId,
        previousVersionRevision: versionRevision,
        previousCoreOriginalPublishedAt: articleOriginalPublishedAt,
        previousPublicationRevision: revisionValue(row.publication_revision),
        neverDelete: true,
      },
      audit,
    };
    proposal.sqlPreview = renderSpainDateCorrectionSql(await buildSpainDateCorrectionStatements(proposal, {
      actorId: input.authorization?.actorId ?? SPAIN_DATE_CORRECTION_ACTOR,
      now,
    }));
    rows.push(proposal);
  }

  const repairable = rows.filter((row) => row.status === "repairable").length;
  const authorized = rows.filter((row) => row.status === "repairable" && row.authorizationSatisfied).length;
  const summary = {
    total: rows.length,
    repairable,
    authorized,
    alreadyCorrected: rows.filter((row) => row.status === "already_corrected").length,
    conflicts: rows.filter((row) => row.status === "conflict").length,
    approvalRequired: rows.filter((row) => row.status === "approval_required").length,
    unresolved: rows.filter((row) => !["repairable", "already_corrected"].includes(row.status)).length,
  };
  const planHash = await sha256Hex(canonicalJson({
    schema: "worldcons.spain-decision-date-correction.v1",
    generatedAt: now,
    policyVersion: SPAIN_DATE_CORRECTION_POLICY,
    rows: rows.map((row) => ({
      articleId: row.articleId,
      status: row.status,
      versionId: row.newVersion?.parentVersionId ?? row.guard.versionId,
      correctedOriginalPublishedAt: row.correctedOriginalPublishedAt,
      evidenceSha256: row.evidenceSha256 ?? null,
    })),
  }));
  return {
    schema: "worldcons.spain-decision-date-correction.v1",
    mode: "dry-run",
    generatedAt: now,
    writes: 0,
    applySupported: true,
    applyReady: repairable > 0 && authorized === repairable && summary.conflicts === 0 && summary.approvalRequired === 0,
    policyVersion: SPAIN_DATE_CORRECTION_POLICY,
    officialFetchCount,
    authorizationProvided: Boolean(input.authorization),
    rollbackPolicy: "republish_previous_immutable_version",
    rows,
    summary,
    planHash,
  };
}

function sqlLiteral(value: string | number | null) {
  return renderSqlLiteral(value);
}

/**
 * Builds an atomic, resumable correction batch for one published article.
 *
 * Immutable semantics: the previous version row is never updated or deleted.
 * A new version row is inserted with the same content snapshot and only the
 * verified FECHA_REGISTRO decision date changed. The publication, heads,
 * freshness, audit, history, outbox and idempotency ledger move together.
 */
export async function buildSpainDateCorrectionStatements(
  proposal: SpainDateCorrectionProposal,
  options: { actorId: string; now: string },
): Promise<SpainDateCorrectionStatement[]> {
  if (proposal.status !== "repairable" || !proposal.newVersion || !proposal.evidence
    || !proposal.correctedOriginalPublishedAt || !proposal.evidenceSha256) {
    throw new Error("spain_date_correction.not_repairable");
  }
  if (proposal.protectedSource) throw new Error("spain_date_correction.protected_source");

  const version = proposal.newVersion;
  const evidence = proposal.evidence;
  const publicationRevision = String(Number(proposal.guard.publicationRevision) + 1);
  const reason = SPAIN_DATE_CORRECTION_REASON;
  const actorId = options.actorId;
  const now = options.now;
  const statements: SpainDateCorrectionStatement[] = [];

  if (proposal.coreUpdateRequired) {
    statements.push({
      id: "articles.date",
      sql: "UPDATE articles SET original_published_at=?,updated_at=? WHERE id=? AND original_published_at IS NULL AND content_hash IS ? AND updated_at IS ?",
      params: [
        proposal.correctedOriginalPublishedAt, now, proposal.articleId,
        proposal.guard.articleContentHash, proposal.guard.articleUpdatedAt,
      ],
    });
  }

  statements.push({
    id: "versions.insert",
    sql: `INSERT OR IGNORE INTO article_content_versions_p3 (
      id,article_id,revision,parent_version_id,content_hash,provenance_actor_type,provenance_actor_id,model_ref,prompt_ref,
      slug,source_key,jurisdiction,institution_name,content_type,original_url,canonical_url,original_language,original_title,korean_title,
      original_published_at,discovered_at,fetched_at,summarized_at,cleaned_text,summary_json,source_metadata,error_metadata,created_at,
      case_key,version_document_schema,version_role,case_metadata_snapshot,case_identifiers_snapshot,authority_evidence_hash,
      source_snapshot_id,source_snapshot_hash,source_content_hash,source_anchor_version_id,enrichment_source_content_hash,
      raw_text_storage_ref,raw_text_blob_hash,raw_text_blob_size,raw_text_externalized_at,raw_text_blob_contract_version
    ) SELECT ?,article_id,?,?,?,'import',?,'official:FECHA_REGISTRO',?,slug,source_key,jurisdiction,institution_name,content_type,
      original_url,canonical_url,original_language,original_title,korean_title,?,discovered_at,fetched_at,summarized_at,cleaned_text,
      summary_json,source_metadata,error_metadata,?,case_key,version_document_schema,version_role,case_metadata_snapshot,
      case_identifiers_snapshot,authority_evidence_hash,source_snapshot_id,source_snapshot_hash,source_content_hash,
      source_anchor_version_id,enrichment_source_content_hash,raw_text_storage_ref,raw_text_blob_hash,raw_text_blob_size,
      raw_text_externalized_at,raw_text_blob_contract_version
    FROM article_content_versions_p3
    WHERE id=? AND article_id=? AND original_published_at IS NULL AND content_hash=? AND CAST(revision AS INTEGER)=CAST(? AS INTEGER)`,
    params: [
      version.versionId, version.revision, version.parentVersionId, version.contentHash, actorId,
      SPAIN_DATE_CORRECTION_POLICY, proposal.correctedOriginalPublishedAt, now,
      proposal.guard.versionId, proposal.articleId, proposal.guard.versionContentHash,
      proposal.guard.versionRevision,
    ],
  });

  statements.push({
    id: "version_heads.upsert",
    sql: "INSERT INTO article_version_heads_p3 (article_id,current_version_id,current_revision,updated_at) VALUES (?,?,?,?) ON CONFLICT(article_id) DO UPDATE SET current_version_id=excluded.current_version_id,current_revision=excluded.current_revision,updated_at=excluded.updated_at WHERE article_version_heads_p3.current_version_id=? AND article_version_heads_p3.current_revision=?",
    params: [
      proposal.articleId, version.versionId, version.revision, now,
      proposal.guard.p3HeadVersionId ?? "", proposal.guard.p3HeadRevision ?? "0",
    ],
  });
  statements.push({
    id: "revision_heads_v4.upsert",
    sql: "INSERT INTO article_revision_heads_v4 (article_id,current_version_id,current_revision,updated_at) VALUES (?,?,?,?) ON CONFLICT(article_id) DO UPDATE SET current_version_id=excluded.current_version_id,current_revision=excluded.current_revision,updated_at=excluded.updated_at",
    params: [proposal.articleId, version.versionId, version.revision, now],
  });
  statements.push({
    id: "freshness.insert",
    sql: `INSERT OR IGNORE INTO legacy_version_freshness_classifications_v4
      (version_id,article_id,freshness,freshness_basis,source_anchor_version_id,source_content_hash,evidence,classified_at,classified_by)
      SELECT ?,?,'current','legacy_same_version',NULL,?,?,?,'spain-official-date-correction'
      WHERE EXISTS (SELECT 1 FROM article_content_versions_p3 WHERE id=? AND article_id=? AND original_published_at=?)`,
    params: [
      version.versionId, proposal.articleId, version.contentHash,
      canonicalJson({
        reason: "verified_official_fecha_registro_date_correction",
        policyVersion: SPAIN_DATE_CORRECTION_POLICY,
        evidenceSha256: proposal.evidenceSha256,
        previousVersionId: proposal.guard.versionId,
        fechaRegistro: evidence.decisionDate,
      }),
      now, version.versionId, proposal.articleId, proposal.correctedOriginalPublishedAt,
    ],
  });
  statements.push({
    id: "publications.update",
    sql: `UPDATE article_publications_p3 SET version_id=?,revision=?,decided_by_type='compatibility',decided_by_id=?,reason=?,
      published_at=COALESCE(published_at,?),updated_at=?
      WHERE id=? AND article_id=? AND state='published' AND version_id=? AND CAST(revision AS INTEGER)=CAST(? AS INTEGER)
        AND EXISTS (SELECT 1 FROM article_content_versions_p3 WHERE id=? AND article_id=? AND original_published_at=?)
        AND EXISTS (SELECT 1 FROM article_version_heads_p3 WHERE article_id=? AND current_version_id=? AND CAST(current_revision AS INTEGER)=CAST(? AS INTEGER))`,
    params: [
      version.versionId, publicationRevision, actorId, reason, now, now,
      proposal.guard.publicationId, proposal.articleId, proposal.guard.versionId,
      proposal.guard.publicationRevision, version.versionId, proposal.articleId,
      proposal.correctedOriginalPublishedAt, proposal.articleId, version.versionId, version.revision,
    ],
  });
  statements.push({
    id: "publication_history.insert",
    sql: `INSERT OR IGNORE INTO article_publication_history_p3
      (id,publication_id,article_id,publication_revision,from_state,to_state,from_version_id,to_version_id,idempotency_key,actor_type,actor_id,reason,request_id,correlation_id,occurred_at)
      SELECT ?,?,?,?,'published','published',?,?,?,'compatibility',?,?,?,?,?
      WHERE EXISTS (SELECT 1 FROM article_publications_p3 WHERE article_id=? AND version_id=? AND CAST(revision AS INTEGER)=CAST(? AS INTEGER))`,
    params: [
      `spain-date-history:${proposal.idempotencyKey}`, proposal.guard.publicationId, proposal.articleId,
      publicationRevision, proposal.guard.versionId, version.versionId, proposal.idempotencyKey ?? "",
      actorId, reason, proposal.idempotencyKey ?? null, proposal.evidenceSha256, now,
      proposal.articleId, version.versionId, publicationRevision,
    ],
  });
  statements.push({
    id: "cache_outbox.insert",
    sql: `INSERT OR IGNORE INTO article_cache_outbox_p3
      (id,event_key,event_type,article_id,publication_id,publication_revision,version_id,publication_state,article_slug,status,attempt_count,max_attempts,available_at,created_at,updated_at)
      SELECT ?,?,'publication.changed',?,?,?,?,'published',?,'pending',0,12,?,?,?
      WHERE EXISTS (SELECT 1 FROM article_publications_p3 WHERE article_id=? AND version_id=? AND CAST(revision AS INTEGER)=CAST(? AS INTEGER))`,
    params: [
      `spain-date-outbox:${proposal.idempotencyKey}`, `article-publication:${proposal.guard.publicationId}:${publicationRevision}`,
      proposal.articleId, proposal.guard.publicationId, publicationRevision, version.versionId,
      proposal.articleId, now, now, now, proposal.articleId, version.versionId, publicationRevision,
    ],
  });
  statements.push(...await auditStatements(proposal, { actorId, now, publicationRevision, reason }));
  statements.push({
    id: "publication_requests.insert",
    sql: `INSERT OR IGNORE INTO article_publication_requests_p3
      (id,article_id,idempotency_key,publication_id,publication_revision,version_id,version_revision,state,version_created,publication_applied,created_at)
      VALUES (?,?,?,?,?,?,?,'published',1,1,?)`,
    params: [
      `spain-date-request:${proposal.idempotencyKey}`, proposal.articleId, proposal.idempotencyKey ?? "",
      proposal.guard.publicationId, publicationRevision, version.versionId, version.revision, now,
    ],
  });
  return statements;
}

async function auditStatements(
  proposal: SpainDateCorrectionProposal,
  options: { actorId: string; now: string; publicationRevision: string; reason: string },
) {
  const version = proposal.newVersion!;
  let revision = Number(proposal.audit.previousRevision ?? 0);
  let previousHash = proposal.audit.previousHash;
  const statements: SpainDateCorrectionStatement[] = [];
  const events = [
    {
      id: `spain-date-audit-version:${proposal.idempotencyKey}`,
      eventType: "article.version.created",
      versionId: version.versionId,
      publicationId: null as string | null,
      publicationRevision: null as string | null,
      actorType: "import",
      metadata: {
        contentHash: version.contentHash,
        revision: version.revision,
        correctionPolicy: SPAIN_DATE_CORRECTION_POLICY,
        evidenceSha256: proposal.evidenceSha256,
        fechaRegistro: proposal.evidence?.decisionDate,
        previousVersionId: proposal.guard.versionId,
      },
    },
    {
      id: `spain-date-audit-publication:${proposal.idempotencyKey}`,
      eventType: "article.publication.published",
      versionId: version.versionId,
      publicationId: proposal.guard.publicationId,
      publicationRevision: options.publicationRevision,
      actorType: "compatibility",
      metadata: {
        fromState: "published",
        toState: "published",
        fromVersionId: proposal.guard.versionId,
        toVersionId: version.versionId,
        correctionPolicy: SPAIN_DATE_CORRECTION_POLICY,
        evidenceSha256: proposal.evidenceSha256,
      },
    },
  ];
  for (const event of events) {
    revision += 1;
    const metadata = canonicalJson(event.metadata);
    const entryHash = await sha256Hex([
      proposal.articleId, String(revision), event.eventType, event.versionId,
      event.publicationId ?? "", event.publicationRevision ?? "", event.actorType,
      options.actorId, options.reason, proposal.idempotencyKey ?? "", proposal.evidenceSha256 ?? "",
      metadata, previousHash ?? "", options.now,
    ].join("|"));
    statements.push({
      id: event.id,
      sql: "INSERT OR IGNORE INTO article_audit_ledger_p3 (id,article_id,ledger_revision,event_type,article_version_id,publication_id,publication_revision,actor_type,actor_id,reason,request_id,correlation_id,safe_metadata,previous_entry_hash,entry_hash,occurred_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      params: [
        event.id, proposal.articleId, String(revision), event.eventType, event.versionId,
        event.publicationId, event.publicationRevision, event.actorType, options.actorId,
        options.reason, proposal.idempotencyKey ?? null, proposal.evidenceSha256 ?? null,
        metadata, previousHash, entryHash, options.now,
      ],
    });
    previousHash = entryHash;
  }
  return statements;
}

/** Renders the parameterized batch as a literal `wrangler d1 execute --file` script. */
export function renderSpainDateCorrectionSql(
  statements: readonly SpainDateCorrectionStatement[],
) {
  return statements.map((statement) => {
    let index = 0;
    const sql = statement.sql.replace(/\?/g, () => sqlLiteral(statement.params[index++] ?? null));
    if (index !== statement.params.length) throw new Error("spain_date_correction.parameter_mismatch");
    return `${sql};`;
  }).join("\n");
}
