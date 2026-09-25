import { CASE_NUMBER_SEPARATOR, type SearchProjectionDocument } from "@/lib/cloudflare/search-projection";
import { primaryCaseReference } from "@/lib/cloudflare/search-ranked";
import type { VectorizeProjectionRecord } from "@/lib/cloudflare/search-vector";
import type { SearchCanaryCase } from "./types";

/**
 * Deterministic frozen-canary case selection (runtime-neutral).
 *
 * There is deliberately NO production oracle here: Supabase is not linked in the
 * current operator environment, so M7.5 cannot claim production result parity.
 * Instead these cases assert self-consistent, contract-level invariants that a
 * correct canary must satisfy on the projected corpus:
 *
 * - `exact-case-*`: a recognized primary case reference must return its own
 *   article first (source filter taken from the same article);
 * - `fulltext-*`: a distinctive title token must retrieve its own article;
 * - `semantic-*`: querying with an indexed record's own vector must return that
 *   id first with a near-unit cosine score;
 * - `hybrid-*`: the RRF union must contain the lexical article.
 *
 * Every case is derived from the same projected documents/records that are
 * written to the canary, so a case is a closed loop, not a fabricated result.
 * No search text is ever placed in an observation; only ids and scores.
 */
export interface BuildSearchCanaryCasesInput {
  documents: readonly SearchProjectionDocument[];
  records: readonly VectorizeProjectionRecord[];
  /** Maximum cases emitted per mode. Defaults to 3. */
  maxCasesPerMode?: number;
}

const DEFAULT_MAX_CASES_PER_MODE = 3;

function sortedDocuments(documents: readonly SearchProjectionDocument[]): SearchProjectionDocument[] {
  return [...documents].sort((left, right) => (left.article_id < right.article_id ? -1 : left.article_id > right.article_id ? 1 : 0));
}

/** First case-number token recognized by the primary-reference parser, or null. */
function exactCaseToken(document: SearchProjectionDocument): string | null {
  if (!document.case_numbers) return null;
  for (const token of document.case_numbers.split(CASE_NUMBER_SEPARATOR)) {
    const trimmed = token.trim();
    if (trimmed.length === 0) continue;
    const reference = primaryCaseReference(trimmed);
    if (reference === null) continue;
    if (document.source_key !== null && reference.sourceKey !== document.source_key) continue;
    return trimmed;
  }
  return null;
}

/** First distinctive ASCII-alphanumeric title token (length >= 4), or null. */
function titleToken(document: SearchProjectionDocument): string | null {
  const title = document.display_title ?? "";
  for (const raw of title.split(/[^\p{L}\p{N}]+/u)) {
    const token = raw.trim();
    if (token.length >= 4 && /[A-Za-z]/.test(token)) return token;
  }
  return null;
}

export function buildSearchCanaryCases(input: BuildSearchCanaryCasesInput): SearchCanaryCase[] {
  const maxPerMode = input.maxCasesPerMode ?? DEFAULT_MAX_CASES_PER_MODE;
  if (!Number.isInteger(maxPerMode) || maxPerMode <= 0) throw new Error("maxCasesPerMode must be a positive integer");
  const documents = sortedDocuments(input.documents);
  const recordById = new Map(input.records.map((record) => [record.id, record]));
  const cases: SearchCanaryCase[] = [];

  let exactCount = 0;
  for (const document of documents) {
    if (exactCount >= maxPerMode) break;
    const token = exactCaseToken(document);
    if (token === null) continue;
    exactCount += 1;
    cases.push({
      id: `exact-case-${document.article_id}`,
      mode: "fulltext",
      query: token,
      source: document.source_key,
      limit: 5,
      offset: 0,
      expectation: { kind: "top-id", id: document.article_id },
    });
  }

  let fulltextCount = 0;
  for (const document of documents) {
    if (fulltextCount >= maxPerMode) break;
    const token = titleToken(document);
    if (token === null) continue;
    fulltextCount += 1;
    cases.push({
      id: `fulltext-${document.article_id}`,
      mode: "fulltext",
      query: token,
      limit: 10,
      offset: 0,
      expectation: { kind: "contains", id: document.article_id, withinTop: 10 },
    });
  }

  let semanticCount = 0;
  let hybridCount = 0;
  for (const document of documents) {
    const record = recordById.get(document.article_id);
    if (!record) continue;
    const token = titleToken(document);
    if (semanticCount < maxPerMode) {
      semanticCount += 1;
      cases.push({
        id: `semantic-${document.article_id}`,
        mode: "semantic",
        query: token ?? "constitution",
        limit: 5,
        offset: 0,
        embedding: [...record.values],
        vectorId: record.id,
        expectation: { kind: "self-top", id: record.id, minScore: 0.999 },
      });
    }
    if (hybridCount < maxPerMode && token !== null) {
      hybridCount += 1;
      cases.push({
        id: `hybrid-${document.article_id}`,
        mode: "hybrid",
        query: token,
        limit: 10,
        offset: 0,
        embedding: [...record.values],
        vectorId: record.id,
        expectation: { kind: "contains", id: document.article_id, withinTop: 10 },
      });
    }
    if (semanticCount >= maxPerMode && hybridCount >= maxPerMode) break;
  }

  return cases;
}
