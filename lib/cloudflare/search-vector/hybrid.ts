import type { D1RuntimeDatabase } from "@/lib/cloudflare/d1/runtime-binding";
import {
  SearchFtsError,
  buildFtsExactTitleNeedle,
  compileSearchFtsQuery,
  ftsTitleHasExactTitle,
  runSearchFtsQuery,
  type SearchFtsQueryInput,
} from "@/lib/cloudflare/search-fts";
import { assembleRankedSearchPage } from "@/lib/cloudflare/search-ranked";
import type {
  RankedSearchPagePayload,
  RankedSearchPageRow,
  RankedSearchResolvedRequest,
} from "@/lib/cloudflare/search-ranked";
import { epochMsFromIso } from "./embedding";
import { vectorError } from "./errors";
import { SEARCH_VECTOR_WINDOW_EXCEEDED_MESSAGE } from "./errors";
import { buildVectorMetadataFilter } from "./metadata";
import {
  assertVectorDeferredUnsupported,
  compareSemanticMatches,
  hybridCandidateLimit,
  parseVectorizeMatches,
} from "./semantic";
import {
  VECTORIZE_QUERY_MAX_TOPK,
  type VectorizeIndexBinding,
  type VectorizeMatch,
  type VectorizeMetadataFilter,
} from "./types";

/**
 * M7.4 hybrid RRF foundation (local only).
 *
 * Reproduces `worldcons_ranked_search_page_v1`'s hybrid branch as closely as the
 * local ceilings allow: the RPC candidate-limit formula, a lexical top
 * candidateLimit from the M7.2/M7.3 FTS5 query, a semantic top candidateLimit
 * from Vectorize with the same scalar/range pre-filter, an article-id union, a
 * bounded/parameterized D1 metadata lookup (encoded FTS title +
 * original_published_at) and the exact RRF score
 * `1/(60+lexRank) + 1/(60+semRank)`. Both candidate lists are capped at 100 by
 * the current Vectorize no-values/indexed-metadata query, so a required
 * candidate limit above 100 fails closed rather than returning a different page.
 */

/** Bound parameters per metadata lookup chunk (D1 safe ceiling is 100). */
export const HYBRID_METADATA_BATCH_SIZE = 100;

const DOCUMENT_TABLE = "search_documents";
const FTS_TABLE = "search_fts";

export interface HybridVectorPageRequest {
  readonly d1: D1RuntimeDatabase;
  readonly vector: VectorizeIndexBinding;
  readonly resolved: RankedSearchResolvedRequest;
  readonly embedding: readonly number[];
}

interface Candidate {
  id: string;
  exactTitle: boolean;
  score: number;
  lexicalRank: number | null;
  semanticRank: number | null;
  semanticSimilarity: number | null;
  publishedEpoch: number | null;
}

interface CandidateMetadata {
  title: string;
  originalPublishedAt: string | null;
  publishedEpoch: number | null;
}

async function executeRows(
  binding: D1RuntimeDatabase,
  sql: string,
  params: readonly (string | number)[],
): Promise<Record<string, unknown>[]> {
  const prepared = binding.prepare(sql);
  if (typeof prepared?.bind !== "function") {
    throw vectorError("query_failed", "D1 binding did not provide prepare().bind().all()");
  }
  const bound = prepared.bind(...params);
  if (typeof bound?.all !== "function") {
    throw vectorError("query_failed", "D1 binding did not provide prepare().bind().all()");
  }
  const result = await bound.all<Record<string, unknown>>();
  if (result === null || typeof result !== "object") {
    throw vectorError("invalid_response", "D1 returned a non-object metadata result");
  }
  if (result.success === false) {
    throw vectorError("query_failed", result.error || "D1 hybrid metadata query failed");
  }
  if (!Array.isArray(result.results)) {
    throw vectorError("invalid_response", "D1 metadata result did not carry a row array");
  }
  return result.results;
}

function metadataLookupSql(boundCount: number): string {
  const placeholders = Array.from({ length: boundCount }, () => "?").join(", ");
  return [
    `select ${DOCUMENT_TABLE}.article_id as article_id`,
    `, ${DOCUMENT_TABLE}.original_published_at as original_published_at`,
    `, ${FTS_TABLE}.title as title`,
    `from ${DOCUMENT_TABLE}`,
    `join ${FTS_TABLE} on ${FTS_TABLE}.article_id = ${DOCUMENT_TABLE}.article_id`,
    `where ${DOCUMENT_TABLE}.article_id in (${placeholders})`,
  ].join("\n");
}

function validateMetadataRow(row: unknown): { articleId: string; metadata: CandidateMetadata } {
  if (typeof row !== "object" || row === null || Array.isArray(row)) {
    throw vectorError("invalid_response", "D1 hybrid metadata row is not an object");
  }
  const record = row as Record<string, unknown>;
  const articleId = record.article_id;
  if (typeof articleId !== "string" || articleId.length === 0) {
    throw vectorError("invalid_response", "D1 hybrid metadata row is missing a string article_id");
  }
  const title = record.title;
  if (typeof title !== "string") {
    throw vectorError("invalid_response", `D1 hybrid metadata row ${articleId} is missing an encoded title`);
  }
  const published = record.original_published_at;
  if (published !== undefined && published !== null && typeof published !== "string") {
    throw vectorError("invalid_response", `D1 hybrid metadata row ${articleId} has a non-string published date`);
  }
  const originalPublishedAt = typeof published === "string" ? published : null;
  return {
    articleId,
    metadata: {
      title,
      originalPublishedAt,
      publishedEpoch: epochMsFromIso(originalPublishedAt),
    },
  };
}

async function loadCandidateMetadata(
  d1: D1RuntimeDatabase,
  ids: readonly string[],
): Promise<Map<string, CandidateMetadata>> {
  const sortedUnique = [...new Set(ids)].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  const byId = new Map<string, CandidateMetadata>();
  for (let index = 0; index < sortedUnique.length; index += HYBRID_METADATA_BATCH_SIZE) {
    const batch = sortedUnique.slice(index, index + HYBRID_METADATA_BATCH_SIZE);
    const rows = await executeRows(d1, metadataLookupSql(batch.length), batch);
    for (const row of rows) {
      const validated = validateMetadataRow(row);
      if (byId.has(validated.articleId)) {
        throw vectorError("invalid_response", `D1 hybrid metadata returned duplicate id ${validated.articleId}`);
      }
      byId.set(validated.articleId, validated.metadata);
    }
  }
  return byId;
}

function requireMetadata(byId: Map<string, CandidateMetadata>, id: string): CandidateMetadata {
  const metadata = byId.get(id);
  if (!metadata) {
    throw vectorError("invalid_response", `hybrid candidate ${id} has no D1 projection metadata`);
  }
  return metadata;
}

function compareCandidates(left: Candidate, right: Candidate): number {
  if (left.exactTitle !== right.exactTitle) return left.exactTitle ? -1 : 1;
  if (left.score !== right.score) return right.score - left.score;
  if (left.publishedEpoch !== right.publishedEpoch) {
    if (left.publishedEpoch === null) return 1;
    if (right.publishedEpoch === null) return -1;
    return right.publishedEpoch - left.publishedEpoch;
  }
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/** Exact RRF contribution: `1/(60+rank)` when the rank exists, else `0`. */
export function rrfScore(lexicalRank: number | null, semanticRank: number | null): number {
  const lexical = lexicalRank === null ? 0 : 1 / (60 + lexicalRank);
  const semantic = semanticRank === null ? 0 : 1 / (60 + semanticRank);
  return lexical + semantic;
}

async function loadSemanticCandidates(
  vector: VectorizeIndexBinding,
  candidateLimit: number,
  filter: VectorizeMetadataFilter | null,
  embedding: readonly number[],
): Promise<VectorizeMatch[]> {
  const result = await vector.query(embedding, {
    topK: candidateLimit,
    // Omit the property entirely when unconstrained: Vectorize rejects `{}` and a
    // real binding must never see `filter: null`.
    ...(filter === null ? {} : { filter }),
    returnValues: false,
    returnMetadata: "indexed",
  });
  return parseVectorizeMatches(result, "hybrid-semantic").sort(compareSemanticMatches);
}

/**
 * Runs the local hybrid RRF page. Requires a D1 binding, a Vectorize binding and
 * a 1536-d embedding; a required candidate limit above 100 fails closed.
 */
export async function runHybridVectorPage(request: HybridVectorPageRequest): Promise<RankedSearchPagePayload> {
  const { d1, vector, resolved } = request;
  assertVectorDeferredUnsupported(resolved);

  const candidateLimit = hybridCandidateLimit(resolved);
  if (candidateLimit > VECTORIZE_QUERY_MAX_TOPK) {
    throw vectorError("vector_window_exceeded", SEARCH_VECTOR_WINDOW_EXCEEDED_MESSAGE);
  }
  const filter = buildVectorMetadataFilter(resolved);

  const ftsInput: SearchFtsQueryInput = {
    query: resolved.queryText,
    limit: candidateLimit,
    range: resolved.range,
    source: resolved.source,
    jurisdiction: resolved.jurisdiction,
    contentType: resolved.contentType,
    language: resolved.language,
    referenceNow: resolved.referenceNow,
  };

  let lexicalRows;
  let exactQueryText: string;
  try {
    lexicalRows = await runSearchFtsQuery({ binding: d1, input: ftsInput });
    exactQueryText = compileSearchFtsQuery(resolved.queryText).exactQueryText;
  } catch (error) {
    if (error instanceof SearchFtsError) {
      throw vectorError("invalid_response", `${error.code}: ${error.message}`);
    }
    throw error;
  }

  const lexicalRankById = new Map<string, number>();
  lexicalRows.forEach((row, index) => lexicalRankById.set(row.article_id, index + 1));

  const semanticMatches = await loadSemanticCandidates(vector, candidateLimit, filter, request.embedding);
  const semanticRankById = new Map<string, number>();
  const semanticById = new Map<string, VectorizeMatch>();
  semanticMatches.forEach((match, index) => {
    semanticRankById.set(match.id, index + 1);
    semanticById.set(match.id, match);
  });

  const unionIds = [...new Set<string>([...lexicalRankById.keys(), ...semanticRankById.keys()])];
  if (unionIds.length === 0) {
    return assembleRankedSearchPage({
      retrievalMode: "hybrid",
      rows: [],
      limit: resolved.limit,
      offset: resolved.offset,
      exactTotal: null,
    });
  }

  const metadataById = await loadCandidateMetadata(d1, unionIds);
  const needletest = buildFtsExactTitleNeedle(exactQueryText);

  const candidates: Candidate[] = unionIds.map((id) => {
    const metadata = requireMetadata(metadataById, id);
    const lexicalRank = lexicalRankById.get(id) ?? null;
    const semanticRank = semanticRankById.get(id) ?? null;
    const semantic = semanticById.get(id);
    const exactTitle = needletest.length > 0 && ftsTitleHasExactTitle(metadata.title, exactQueryText);
    return {
      id,
      exactTitle,
      score: rrfScore(lexicalRank, semanticRank),
      lexicalRank,
      semanticRank,
      semanticSimilarity: semantic ? semantic.score : null,
      publishedEpoch: metadata.publishedEpoch,
    };
  });

  candidates.sort(compareCandidates);
  const window: RankedSearchPageRow[] = candidates.slice(resolved.offset, resolved.offset + resolved.limit + 1).map((candidate) => ({
    id: candidate.id,
    score: candidate.score,
    lexicalRank: candidate.lexicalRank,
    semanticRank: candidate.semanticRank,
    semanticSimilarity: candidate.semanticSimilarity,
  }));

  return assembleRankedSearchPage({
    retrievalMode: "hybrid",
    rows: window,
    limit: resolved.limit,
    offset: resolved.offset,
    exactTotal: null,
  });
}
