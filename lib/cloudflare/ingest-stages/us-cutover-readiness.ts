/**
 * WorldCons P2-M4 United States (us-scotus) staged-cutover readiness gate.
 *
 * A pure, runtime-neutral, FAIL-CLOSED evaluator analogous to the Germany
 * P2-M3 guard, but US-specific. The US path has different provenance than the
 * German HTML/ECLI path: a genuine official `supremecourt.gov` slip-opinion
 * **PDF** is the sole acceptable source of record, and the US collection
 * policy deliberately holds every newly collected opinion at
 * `collection.publishable=false` / `review.required=true` (private review)
 * until a separate manual publication authorization exists. This guard exists
 * so the US ownership switchover (adding `us-scotus` to the staged source
 * allowlist and to the legacy M8 crawler exclusion *in the same deploy*) can
 * never be authorized by:
 *
 *   - the mere existence of a code path,
 *   - a mocked/in-memory probe,
 *   - legacy historical Production counts, or
 *   - an implicit/automatic publication that US policy does not permit.
 *
 * Every gate must be backed by a real, newly observed Production proof. The
 * module never reads the network or the database; callers supply the observed
 * proof. It is intentionally inert until an operator has genuine evidence.
 */

import { evaluateOwnershipPairing } from "./paired-ownership";

export const US_SOURCE_KEY = "us-scotus" as const;

/**
 * The only approval policy that may satisfy the US manual publication gate. This
 * is the *human review* policy recorded by `recordHumanApproval` under an
 * external actor identity, deliberately distinct from the automatic FR/ES
 * staged-approval ledger (`worldcons.fr-es-staged-approval.v1`) and from any
 * generic `published` flag.
 */
export const US_MANUAL_APPROVAL_POLICY = "worldcons.human-reviewed-publication.v1" as const;

/** The evidence document schema a genuine human approval receipt must carry. */
export const US_MANUAL_APPROVAL_DOCUMENT_SCHEMA = "worldcons.human-approval.v1" as const;

/**
 * One observed approval-ledger row, as read from `e2e_approval_evidence_v1`.
 * `articleId` must be the exact same-case Core UUID; `policyVersion` must be the
 * human-review policy; `evidenceDocument` is the immutable JSON receipt.
 */
export interface UsManualApprovalReceiptRow {
  articleId: string | null | undefined;
  policyVersion: string | null | undefined;
  evidenceDocument: string | null | undefined;
}

export interface UsManualApprovalAssessment {
  present: boolean;
  reason: string;
  actorId: string | null;
  policyVersion: string | null;
}

/**
 * Pure, fail-closed evaluation of whether an *immutable, same-case, human*
 * approval receipt exists for the given Core article.
 *
 * This replaces treating a caller-supplied `manualPublicationAuthorization`
 * boolean (or a generic `published`/`automatic` flag) as proof of review. A
 * receipt counts ONLY when ALL of the following hold:
 *
 *   - `articleId` equals the exact same-case Core UUID;
 *   - `policyVersion` is `worldcons.human-reviewed-publication.v1` (NOT the
 *     automatic FR/ES ledger);
 *   - `evidenceDocument` parses and its `schema` is
 *     `worldcons.human-approval.v1` with a non-empty external `actorId`.
 *
 * Anything else (missing article, other policy, missing/blank actor, malformed
 * document) fails closed. This function never reads the database or the network.
 */
export function evaluateSameCaseManualApprovalReceipt(
  coreArticleId: string | null | undefined,
  rows: ReadonlyArray<UsManualApprovalReceiptRow>,
): UsManualApprovalAssessment {
  const target = (coreArticleId ?? "").trim();
  if (!target) return { present: false, reason: "us_manual_approval.no_core_article", actorId: null, policyVersion: null };
  for (const row of rows) {
    if (String(row.articleId ?? "") !== target) continue;
    if (String(row.policyVersion ?? "") !== US_MANUAL_APPROVAL_POLICY) continue;
    let document: Record<string, unknown>;
    try {
      const parsed = JSON.parse(String(row.evidenceDocument ?? "")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      document = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    const actorId = typeof document.actorId === "string" ? document.actorId.trim() : "";
    if (document.schema !== US_MANUAL_APPROVAL_DOCUMENT_SCHEMA || actorId.length === 0) continue;
    return { present: true, reason: "us_manual_approval.same_case_human_receipt", actorId, policyVersion: US_MANUAL_APPROVAL_POLICY };
  }
  return { present: false, reason: "us_manual_approval.no_same_case_human_receipt", actorId: null, policyVersion: null };
}

export interface UsCutoverProof {
  /** A genuine new official `supremecourt.gov` slip-opinion PDF was fetched through the crawl path. */
  officialPdfFetched: boolean;
  /** The PDF body docket exactly matched the discovered docket (application or cert form). */
  docketIdentityVerified: boolean;
  /** The original PDF bytes were stored in R2 and the stored SHA-256 equals the provenance hash. */
  r2OriginalBytes: boolean;
  /** Core `source_metadata.officialPdf` (url/r2Key/sha256/docketVerified) was persisted for that case. */
  coreProvenance: boolean;
  /** The article still carries the private review hold: `collection.publishable=false` and `review.required=true`. */
  privateReviewHold: boolean;
  /** One bounded Discovery->Search staged Production E2E completed for the US article. */
  stagedE2E: boolean;
  /**
   * Explicit MANUAL publication authorization evidence exists. US policy does
   * not permit automatic publication, so when this is absent/false the cutover
   * planner refuses to authorize (it never substitutes an automatic approval).
   */
  manualPublicationAuthorization: boolean;
  /** An immutable P3 `published` version exists for the SAME case lineage. */
  p3Published: boolean;
  /** The Search projection (and FTS) row exists for the SAME case lineage. */
  searchProjected: boolean;
}

export const US_CUTOVER_GATES = [
  "official_pdf_fetched",
  "docket_identity_verified",
  "r2_original_bytes",
  "core_provenance",
  "private_review_hold",
  "staged_e2e",
  "manual_publication_authorization",
  "p3_published",
  "search_projected",
] as const;

export type UsCutoverGate = (typeof US_CUTOVER_GATES)[number];

const GATE_TO_PROOF: Readonly<Record<UsCutoverGate, keyof UsCutoverProof>> = {
  official_pdf_fetched: "officialPdfFetched",
  docket_identity_verified: "docketIdentityVerified",
  r2_original_bytes: "r2OriginalBytes",
  core_provenance: "coreProvenance",
  private_review_hold: "privateReviewHold",
  staged_e2e: "stagedE2E",
  manual_publication_authorization: "manualPublicationAuthorization",
  p3_published: "p3Published",
  search_projected: "searchProjected",
};

/**
 * Production fields that are *legacy historical counts*, not proof. Their
 * presence (as numbers) without the explicit boolean gates must never be read
 * as readiness, so the evaluator rejects such a proof explicitly.
 */
export const US_LEGACY_HISTORICAL_FIELDS = [
  "coreArticles",
  "publishedP3",
  "searchEligible",
  "discovered",
  "fetched",
] as const;

export interface UsCutoverReadiness {
  source: typeof US_SOURCE_KEY;
  ready: boolean;
  gates: ReadonlyArray<{ id: UsCutoverGate; required: true; passed: boolean }>;
  blockers: readonly string[];
  /** True when a proof was dominated by legacy historical counts rather than fresh evidence. */
  legacyHistoricalCountsOnly: boolean;
}

function hasLegacyHistoricalCounts(proof: unknown): boolean {
  if (!proof || typeof proof !== "object" || Array.isArray(proof)) return false;
  const record = proof as Record<string, unknown>;
  const hasHistorical = US_LEGACY_HISTORICAL_FIELDS.some((field) => typeof record[field] === "number");
  const hasExplicitGate = US_CUTOVER_GATES.some((gate) => record[GATE_TO_PROOF[gate]] === true);
  return hasHistorical && !hasExplicitGate;
}

/**
 * Evaluates the US cutover proof. Anything other than an explicit `true` on
 * every gate (including a missing/partial/undefined object) fails closed. A
 * proof made only of legacy historical counts is explicitly rejected.
 */
export function evaluateUsCutoverReadiness(
  proof: Partial<UsCutoverProof> | null | undefined,
): UsCutoverReadiness {
  const gates = US_CUTOVER_GATES.map((id) => ({
    id,
    required: true as const,
    passed: proof?.[GATE_TO_PROOF[id]] === true,
  }));
  const legacyHistoricalCountsOnly = hasLegacyHistoricalCounts(proof);
  const blockers = gates.filter((gate) => !gate.passed).map((gate) => `us_cutover.${gate.id}_not_observed`);
  if (legacyHistoricalCountsOnly) blockers.unshift("us_cutover.legacy_historical_counts_rejected");
  return {
    source: US_SOURCE_KEY,
    ready: blockers.length === 0,
    gates,
    blockers,
    legacyHistoricalCountsOnly,
  };
}

export interface UsCutoverOwnership {
  /** Current staged source allowlist (exact native keys). */
  stagedAllowlist: readonly string[];
  /** Current legacy M8 crawler exclusion (exact native keys). */
  m8Exclude: readonly string[];
}

function appendOnce(list: readonly string[], value: string): string[] {
  return [...new Set([...list, value])];
}

export interface UsCutoverPlan {
  source: typeof US_SOURCE_KEY;
  authorized: boolean;
  readiness: UsCutoverReadiness;
  /** Paired staged allowlist value to apply (empty when not authorized). */
  plannedAllowlist: string;
  /** Paired M8 crawler exclusion value to apply (empty when not authorized). */
  plannedExclude: string;
  /** Exact values to restore on rollback (captured regardless of authorization). */
  rollback: { allowlist: string; exclude: string };
  reason?: string;
}

/**
 * Computes the exact paired allowlist/exclude mutation for a US cutover.
 *
 * The cutover is authorized ONLY when the readiness gate is fully satisfied AND
 * a genuine, immutable, same-case human-review receipt is supplied through
 * `options.manualApprovalReceipt`. A caller-supplied
 * `manualPublicationAuthorization: true` boolean is NEVER sufficient on its own:
 * the planner refuses to mutate ownership without the observed receipt, because
 * a plain boolean (and the automatic FR/ES ledger) is not evidence of a real
 * per-article review. Otherwise it returns `authorized=false`, emits no planned
 * mutation, and still captures the current values as the rollback target. The
 * staged allowlist and the M8 exclusion always move together to the same value.
 */
export function planUsCutover(
  proof: Partial<UsCutoverProof> | null | undefined,
  current: UsCutoverOwnership,
  options: { manualApprovalReceipt?: UsManualApprovalAssessment } = {},
): UsCutoverPlan {
  const readiness = evaluateUsCutoverReadiness(proof);
  const receiptPresent = options.manualApprovalReceipt?.present === true;
  const rollback = {
    allowlist: current.stagedAllowlist.join(","),
    exclude: current.m8Exclude.join(","),
  };
  // A cutover requires the current staged allowlist and M8 exclusion to already
  // be exact paired. A mis-paired input would produce non-byte-identical planned
  // strings, so it fails closed with no planned mutation.
  const pairing = evaluateOwnershipPairing(current.stagedAllowlist, current.m8Exclude);
  if (!pairing.paired) {
    return {
      source: US_SOURCE_KEY,
      authorized: false,
      readiness,
      plannedAllowlist: "",
      plannedExclude: "",
      rollback,
      reason: `us_cutover.ownership_not_paired_${pairing.reason}`,
    };
  }
  if (!readiness.ready) {
    return {
      source: US_SOURCE_KEY,
      authorized: false,
      readiness,
      plannedAllowlist: "",
      plannedExclude: "",
      rollback,
      reason: readiness.blockers[0],
    };
  }
  // Even with every readiness gate true, a caller-supplied boolean is not proof
  // of per-article human review. The immutable same-case receipt is mandatory.
  if (!receiptPresent) {
    return {
      source: US_SOURCE_KEY,
      authorized: false,
      readiness,
      plannedAllowlist: "",
      plannedExclude: "",
      rollback,
      reason: "us_cutover.manual_approval_receipt_not_observed",
    };
  }
  return {
    source: US_SOURCE_KEY,
    authorized: true,
    readiness,
    plannedAllowlist: appendOnce(current.stagedAllowlist, US_SOURCE_KEY).join(","),
    plannedExclude: appendOnce(current.m8Exclude, US_SOURCE_KEY).join(","),
    rollback,
  };
}
