import type { RankedSearchMode, RankedSearchPagePayload } from "@/lib/cloudflare/search-ranked";
import { evaluateExpectation } from "./evaluate";
import type {
  SearchCanaryCase,
  SearchCanaryObservation,
  SearchCanaryOracleMode,
  SearchCanaryOracleModeSummary,
  SearchCanaryOracleParity,
} from "./types";

/**
 * M7.6 explicit canary oracle modes (runtime-neutral).
 *
 * M7.5 implicitly treated the Supabase `worldcons_ranked_search_page_v1` RPC as
 * the only oracle, then discovered that the current `public_article_projection_p3`
 * exposes `article_content_versions_p3.embedding`, which can be NULL for an
 * artifact-backed row. Comparing against that RPC would create false failures.
 *
 * M7.6 makes the oracle mode EXPLICIT and never fabricates parity:
 *
 * - `production-rpc`      the RPC is a valid oracle for this case;
 * - `artifact-reference`  the RPC is not a valid semantic oracle (production
 *                         embedding drift) or was not requested, so the case is
 *                         compared against the provenance-locked
 *                         `article_embedding_artifacts` projection the M7.4
 *                         Vectorize index was built from;
 * - `none`                no oracle is available and none is claimed.
 */
export interface SearchCanaryOracleDecision {
  mode: SearchCanaryOracleMode;
  /** True when artifact-reference was forced by production embedding drift. */
  drift: boolean;
  detail: string;
}

export interface ResolveSearchCanaryOracleModeInput {
  mode: RankedSearchMode;
  /** True when a production RPC reader is available for this run. */
  productionOracleAvailable: boolean;
  /** True only when the production projection embedding is present. */
  productionSemanticEligible: boolean;
  /** True when the case has a provenance-locked artifact/vector id. */
  artifactBacked: boolean;
}

export function resolveSearchCanaryOracleMode(
  input: ResolveSearchCanaryOracleModeInput,
): SearchCanaryOracleDecision {
  if (input.mode === "fulltext") {
    return input.productionOracleAvailable
      ? { mode: "production-rpc", drift: false, detail: "lexical production RPC oracle" }
      : { mode: "none", drift: false, detail: "no production oracle requested" };
  }
  if (input.productionOracleAvailable && input.productionSemanticEligible) {
    return {
      mode: "production-rpc",
      drift: false,
      detail: "production semantic projection embedding present",
    };
  }
  if (input.artifactBacked) {
    return {
      mode: "artifact-reference",
      drift: input.productionOracleAvailable && !input.productionSemanticEligible,
      detail:
        input.productionOracleAvailable && !input.productionSemanticEligible
          ? "production projection embedding is NULL; comparing against the artifact projection instead"
          : "production oracle not requested; comparing against the artifact projection",
    };
  }
  return { mode: "none", drift: false, detail: "no production or artifact oracle available" };
}

/**
 * The artifact-reference parity: the case's own frozen expectation (derived from
 * the provenance-locked artifact projection) must be satisfied. No production
 * call is made and no production parity is claimed.
 */
export function artifactReferenceParity(
  caseDef: SearchCanaryCase,
  payload: RankedSearchPagePayload,
): SearchCanaryOracleParity {
  return evaluateExpectation(caseDef.expectation, payload).ok ? "match" : "mismatch";
}

export function summarizeOracleModes(
  observations: readonly SearchCanaryObservation[],
): SearchCanaryOracleModeSummary {
  const compared = observations.filter(
    (observation) => observation.status === "pass" || observation.status === "mismatch",
  );
  return {
    productionRpc: compared.filter((observation) => observation.oracleMode === "production-rpc").length,
    artifactReference: compared.filter((observation) => observation.oracleMode === "artifact-reference").length,
    none: compared.filter((observation) => observation.oracleMode === "none").length,
    drift: compared.filter((observation) => observation.oracleDrift).length,
  };
}
