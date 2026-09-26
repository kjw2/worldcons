import { resolveSearchCanaryOracleMode } from "@/lib/cloudflare/search-canary/oracle";
import type { RankedSearchMode } from "@/lib/cloudflare/search-ranked";
import type { SearchCanaryOracleMode } from "@/lib/cloudflare/search-canary/types";

/**
 * M7.8-A bounded post-apply semantic/hybrid smoke (runtime-neutral).
 *
 * After the forward migration is applied, `public_article_projection_p3` must
 * expose the provenance-locked Gemini artifact embedding for every published
 * projection row. The smoke therefore runs a small, frozen set of semantic and
 * hybrid queries through the current production ranked RPC
 * (`worldcons_ranked_search_page_v1`, read-only) and resolves the M7.6 oracle
 * seam for each case. If the production projection embedding is still NULL, the
 * M7.6 seam selects `artifact-reference` with `drift=true`; a post-apply run with
 * any drift fails the rollout closed. `oracleDrift=0` is the gate.
 *
 * The gates carry article ids, counts and oracle modes only: query text and
 * vectors are never copied into the report.
 */

export const SEMANTIC_AUTHORITY_SMOKE_VERSION = 1 as const;

/** Bounded top-K ceiling for every smoke case; the smoke fails closed above it. */
export const SEMANTIC_AUTHORITY_SMOKE_LIMIT_CEILING = 5 as const;

/**
 * Frozen, bounded smoke cases. The `vectorId` is a published article id used to
 * resolve the exact current projection embedding inside Postgres (never a vector
 * literal on the command line). Selected deterministically from the M7.7 v4
 * authoritative anchors; MUST NOT be tuned to an observed result.
 */
export const SEMANTIC_AUTHORITY_SMOKE_CASES = [
  { id: "semantic-de-bverfg", mode: "semantic", query: "Verfassungsbeschwerde", vectorId: "00083deb-5bc9-4b28-bbcd-68076cd05514", limit: 5 },
  { id: "semantic-fr-conseil", mode: "semantic", query: "question prioritaire de constitutionnalité", vectorId: "0018a822-df15-4526-abd8-6c22e6ba7988", limit: 5 },
  { id: "hybrid-us-scotus", mode: "hybrid", query: "Fourth Amendment", vectorId: "0346769f-97d0-48e2-b2e2-3a371e7d2eee", limit: 5 },
  { id: "hybrid-de-bverfg", mode: "hybrid", query: "Grundrechte", vectorId: "00083deb-5bc9-4b28-bbcd-68076cd05514", limit: 5 },
] as const;

export interface SemanticAuthoritySmokeCase {
  id: string;
  mode: RankedSearchMode;
  /**
   * The authored query literal used for the bounded RPC call. It is never copied
   * into evidence: `SemanticAuthoritySmokeCaseResult` carries ids/counts only.
   */
  query: string;
  vectorId: string;
  limit: number;
}

export const SEMANTIC_AUTHORITY_SMOKE_ERROR_CODES = [
  "smoke_case_invalid",
  "smoke_page_missing",
  "smoke_oracle_drift",
] as const;

export type SemanticAuthoritySmokeErrorCode = (typeof SEMANTIC_AUTHORITY_SMOKE_ERROR_CODES)[number];

/** One read-only smoke observation: ids, counts and the M7.6 oracle mode only. */
export interface SemanticAuthoritySmokeCaseResult {
  caseId: string;
  mode: RankedSearchMode;
  /**
   * True only when the production projection reports a non-null embedding for
   * this case's anchor (a read-only `(embedding is not null)` probe).
   */
  productionSemanticEligible: boolean;
  /** True when the bounded production RPC returned a page without error. */
  pageRetrieved: boolean;
  /** Bounded observed ids (never query text or vectors). */
  topIds: string[];
}

export type SemanticAuthoritySmokeStatus = "pass" | "mismatch" | "error";

export interface SemanticAuthoritySmokeObservation {
  caseId: string;
  mode: RankedSearchMode;
  status: SemanticAuthoritySmokeStatus;
  oracleMode: SearchCanaryOracleMode;
  oracleDrift: boolean;
  topIds: string[];
}

export interface SemanticAuthoritySmokeReport {
  version: typeof SEMANTIC_AUTHORITY_SMOKE_VERSION;
  cases: number;
  compared: number;
  oracleDrift: number;
  errors: number;
  pass: boolean;
  observations: SemanticAuthoritySmokeObservation[];
}

function assertCase(caseDef: SemanticAuthoritySmokeCase): void {
  if (caseDef.mode !== "semantic" && caseDef.mode !== "hybrid") {
    throw new Error("smoke_case_invalid: mode must be semantic or hybrid");
  }
  if (!Number.isInteger(caseDef.limit) || caseDef.limit <= 0 || caseDef.limit > SEMANTIC_AUTHORITY_SMOKE_LIMIT_CEILING) {
    throw new Error("smoke_case_invalid: limit is outside the bounded smoke ceiling");
  }
  if (typeof caseDef.vectorId !== "string" || caseDef.vectorId.trim().length === 0) {
    throw new Error("smoke_case_invalid: vectorId anchor is required");
  }
  if (typeof caseDef.query !== "string" || caseDef.query.trim().length === 0) {
    throw new Error("smoke_case_invalid: an authored query is required");
  }
}

/**
 * Resolves every smoke case through the M7.6 oracle seam and accounts for drift.
 * `oracleDrift` counts the cases where the production semantic projection was not
 * eligible (so the seam would have to fall back to the artifact reference). A
 * non-zero drift fails the post-apply smoke closed.
 */
export function evaluateSemanticAuthoritySmoke(
  results: readonly SemanticAuthoritySmokeCaseResult[],
): SemanticAuthoritySmokeReport {
  if (results.length === 0) {
    return { version: SEMANTIC_AUTHORITY_SMOKE_VERSION, cases: 0, compared: 0, oracleDrift: 0, errors: 1, pass: false, observations: [] };
  }
  const observations: SemanticAuthoritySmokeObservation[] = results.map((result) => {
    const decision = resolveSearchCanaryOracleMode({
      mode: result.mode,
      productionOracleAvailable: true,
      productionSemanticEligible: result.productionSemanticEligible,
      artifactBacked: true,
    });
    const status: SemanticAuthoritySmokeStatus = !result.pageRetrieved ? "error" : decision.drift ? "mismatch" : "pass";
    return {
      caseId: result.caseId,
      mode: result.mode,
      status,
      oracleMode: decision.mode,
      oracleDrift: decision.drift,
      topIds: [...result.topIds],
    };
  });
  const compared = observations.filter((observation) => observation.status !== "error").length;
  const oracleDrift = observations.filter((observation) => observation.oracleDrift).length;
  const errors = observations.filter((observation) => observation.status === "error").length;
  const pass = compared > 0 && errors === 0 && oracleDrift === 0;
  return { version: SEMANTIC_AUTHORITY_SMOKE_VERSION, cases: results.length, compared, oracleDrift, errors, pass, observations };
}

/** Validates the authored smoke cases without executing anything. */
export function assertSemanticAuthoritySmokeCases(
  cases: readonly SemanticAuthoritySmokeCase[] = SEMANTIC_AUTHORITY_SMOKE_CASES,
): void {
  if (cases.length === 0) throw new Error("smoke_case_invalid: at least one case is required");
  for (const caseDef of cases) assertCase(caseDef);
}
