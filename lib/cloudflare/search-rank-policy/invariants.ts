import { CASE_NUMBER_SEPARATOR, type SearchProjectionDocument, type SearchProjectionFtsDocument } from "@/lib/cloudflare/search-projection";
import { ftsTitleHasExactTitle } from "@/lib/cloudflare/search-fts";
import { primaryCaseReference } from "@/lib/cloudflare/search-ranked";
import type { RankCorpusCase } from "./types";

/**
 * M7.7-B strict exact-match invariant target resolution (runtime-neutral).
 *
 * The exact-case and exact-title invariants are exact-match, not numeric: they
 * must hold for 100% of the corpus cases that can be resolved against the
 * bounded projected corpus. There is deliberately no threshold knob here.
 *
 * Resolution is deterministic and reads only the local (D1) projected corpus:
 * the same corpus always yields the same expected article id.
 */

export interface RankInvariantTarget {
  /** Sorted, unique exact-match article ids. Empty when nothing resolved. */
  expectedIds: string[];
  /** How many documents matched. */
  matchCount: number;
}

/**
 * The frozen strict target for one exact-case/exact-title case.
 *
 * `expectedIds` is the frozen authoritative target set from the v4 corpus
 * manifest. The target is only evaluable when the local authoritative projection
 * still resolves the query to exactly that same set: `frozenValidated` is true
 * only then, and `evaluateRankPolicyCase` fails closed on a frozen-but-unvalidated
 * target.
 */
export interface RankStrictTarget {
  /** Authoritative frozen target set, or an empty set for an informational case. */
  expectedIds: string[];
  /** How many documents the query currently resolves in the local projection. */
  matchCount: number;
  /** True when the case carries a frozen manifest expected id. */
  frozen: boolean;
  /**
   * True when the frozen expected target set still resolves exactly against the
   * local authoritative projection. A frozen strict case whose target set can no
   * longer be reproduced (a missing member or a new ambiguity) fails closed.
   */
  frozenValidated: boolean;
}

export interface RankLocalCorpus {
  documents: readonly SearchProjectionDocument[];
  ftsDocuments: readonly SearchProjectionFtsDocument[];
}

/**
 * Resolves and validates the frozen strict target for one case against the local
 * authoritative projection. The frozen `expectedIds` set is authoritative: it is
 * never replaced by whatever the current corpus happens to resolve. When the
 * query no longer resolves to exactly the frozen set (the projection drifted or
 * a new ambiguity appeared), the target is returned with `frozenValidated=false`
 * so the policy fails closed instead of silently passing.
 */
export function resolveFrozenStrictTarget(caseDef: RankCorpusCase, corpus: RankLocalCorpus): RankStrictTarget {
  const frozenIds = normalizeIds(caseDef.expectedIds ?? []);
  const local =
    caseDef.invariant === "exact-case"
      ? resolveExactCaseTarget(caseDef, corpus.documents)
      : caseDef.invariant === "exact-title"
        ? resolveExactTitleTarget(caseDef, corpus.ftsDocuments)
        : { expectedIds: [], matchCount: 0 };
  if (frozenIds.length === 0) {
    return {
      expectedIds: local.expectedIds,
      matchCount: local.matchCount,
      frozen: false,
      frozenValidated: local.expectedIds.length > 0,
    };
  }
  return {
    expectedIds: frozenIds,
    matchCount: local.matchCount,
    frozen: true,
    frozenValidated: sameIds(local.expectedIds, frozenIds),
  };
}

function normalizeIds(ids: readonly string[]): string[] {
  return [...new Set(ids)].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  const a = normalizeIds(left);
  const b = normalizeIds(right);
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

/**
 * Resolves the exact-case target: the corpus document whose `source_key`
 * matches the recognized primary case reference and whose `case_numbers` holds
 * the reference `caseKey` as an exact separator-delimited token (the same
 * `instr(char(10) || case_numbers || char(10), char(10) || key || char(10))`
 * test the M7.3 exact-case branch uses).
 */
export function resolveExactCaseTarget(
  caseDef: RankCorpusCase,
  documents: readonly SearchProjectionDocument[],
): RankInvariantTarget {
  const reference = primaryCaseReference(caseDef.query);
  if (reference === null) return { expectedIds: [], matchCount: 0 };
  const matches: string[] = [];
  for (const document of documents) {
    if (document.source_key !== reference.sourceKey) continue;
    const caseNumbers = document.case_numbers ?? "";
    if (caseNumbers.length === 0) continue;
    const padded = `${CASE_NUMBER_SEPARATOR}${caseNumbers}${CASE_NUMBER_SEPARATOR}`;
    if (padded.includes(`${CASE_NUMBER_SEPARATOR}${reference.caseKey}${CASE_NUMBER_SEPARATOR}`)) {
      matches.push(document.article_id);
    }
  }
  const expectedIds = normalizeIds(matches);
  return { expectedIds, matchCount: expectedIds.length };
}

/**
 * Resolves the exact-title target: the corpus document whose encoded FTS title
 * exactly matches the query under the M7.2 title normalization. It reads the
 * sidecar `search_fts.title` encoding, so both the original and Korean titles
 * are represented.
 */
export function resolveExactTitleTarget(
  caseDef: RankCorpusCase,
  ftsDocuments: readonly SearchProjectionFtsDocument[],
): RankInvariantTarget {
  const matches: string[] = [];
  for (const document of ftsDocuments) {
    if (ftsTitleHasExactTitle(document.title, caseDef.query)) matches.push(document.article_id);
  }
  const expectedIds = normalizeIds(matches);
  return { expectedIds, matchCount: expectedIds.length };
}
