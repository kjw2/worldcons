import { createTextEmbedding } from "@/lib/ai/embeddings";
import { getSupabaseAdmin } from "@/lib/db/client";
import { listArticles } from "@/lib/db/queries";
import type { ArticleListFilters, ArticleListResult } from "@/lib/db/types";
import { normalizeRange } from "@/lib/utils/dates";
import { articlePublicationV4ReadsEnabled, observeArticlePublicationReadDecision } from "@/lib/article-publication";
import { exactCaseSearch } from "@/lib/search/exact-case";

interface MatchArticleRow {
  article_id: string;
  similarity?: number;
}

interface VectorArticleRow {
  id: string;
  embedding: number[] | string | null;
}

const MAX_RANKED_LOOKUP_BATCH_SIZE = 100;

export function rankedSearchWindow(filters: Pick<ArticleListFilters, "page" | "pageSize">, minimum = 0) {
  const page = Number.isFinite(filters.page) && (filters.page ?? 0) > 0 ? Math.floor(filters.page ?? 1) : 1;
  const pageSize = Number.isFinite(filters.pageSize) && (filters.pageSize ?? 0) > 0
    ? Math.min(Math.floor(filters.pageSize ?? 20), MAX_RANKED_LOOKUP_BATCH_SIZE)
    : 20;
  return Math.min(Math.max((page + 1) * pageSize, minimum, pageSize), MAX_RANKED_LOOKUP_BATCH_SIZE);
}

export function rankedLookupFilters(filters: ArticleListFilters, ids: string[]): ArticleListFilters {
  return {
    ...filters,
    ids,
    q: undefined,
    page: 1,
    pageSize: Math.min(Math.max(ids.length, 1), MAX_RANKED_LOOKUP_BATCH_SIZE),
    count: "none",
  };
}

export function paginateRankedArticleItems(
  items: ArticleListResult["items"],
  filters: Pick<ArticleListFilters, "page" | "pageSize">,
): ArticleListResult {
  const page = Number.isFinite(filters.page) && (filters.page ?? 0) > 0 ? Math.floor(filters.page ?? 1) : 1;
  const pageSize = Number.isFinite(filters.pageSize) && (filters.pageSize ?? 0) > 0
    ? Math.min(Math.floor(filters.pageSize ?? 20), MAX_RANKED_LOOKUP_BATCH_SIZE)
    : 20;
  const start = (page - 1) * pageSize;
  const end = start + pageSize;

  return {
    items: items.slice(start, end),
    pageInfo: {
      page,
      pageSize,
      total: items.length,
      hasMore: end < items.length,
      totalIsExact: false,
    },
  };
}

function reorderByIds(result: ArticleListResult, ids: string[]) {
  const order = new Map(ids.map((id, index) => [id, index]));
  return {
    ...result,
    items: [...result.items].sort((a, b) => (order.get(a.id ?? "") ?? 9999) - (order.get(b.id ?? "") ?? 9999)),
  };
}

function parseVector(value: VectorArticleRow["embedding"]) {
  if (Array.isArray(value)) return value;
  if (!value) return null;

  return value
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .split(",")
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isFinite(item));
}

function cosineSimilarity(a: number[], b: number[]) {
  let dot = 0;
  let magnitudeA = 0;
  let magnitudeB = 0;
  const length = Math.min(a.length, b.length);

  for (let index = 0; index < length; index += 1) {
    const left = a[index] ?? 0;
    const right = b[index] ?? 0;
    dot += left * right;
    magnitudeA += left * left;
    magnitudeB += right * right;
  }

  if (!magnitudeA || !magnitudeB) return 0;
  return dot / (Math.sqrt(magnitudeA) * Math.sqrt(magnitudeB));
}

async function rankedItemsByIds(filters: ArticleListFilters, ids: string[]) {
  const uniqueIds = Array.from(new Set(ids.filter(Boolean)));
  if (uniqueIds.length === 0) return [];

  const batches: string[][] = [];
  for (let index = 0; index < uniqueIds.length; index += MAX_RANKED_LOOKUP_BATCH_SIZE) {
    batches.push(uniqueIds.slice(index, index + MAX_RANKED_LOOKUP_BATCH_SIZE));
  }

  const results = await Promise.all(
    batches.map((batch) => listArticles(rankedLookupFilters(filters, batch))),
  );
  const combined: ArticleListResult = {
    items: results.flatMap((result) => result.items),
    pageInfo: { page: 1, pageSize: uniqueIds.length, total: uniqueIds.length },
  };
  return reorderByIds(combined, uniqueIds).items;
}

async function reorderAndPage(filters: ArticleListFilters, ids: string[]) {
  const ordered = await rankedItemsByIds(filters, ids);
  return paginateRankedArticleItems(ordered, filters);
}

async function localSemanticSearch(filters: ArticleListFilters, embedding: number[], matchCount: number) {
  if (filters.tag) {
    return listArticles(filters);
  }

  const supabase = getSupabaseAdmin();
  if (!supabase) {
    return listArticles(filters);
  }

  let query = supabase
    .from(articlePublicationV4ReadsEnabled() ? "public_article_projection_p3" : "articles")
    .select("id, embedding")
    .not("embedding", "is", null)
    .eq("status", "summarized")
    .limit(Math.max(matchCount, 100));

  if (!articlePublicationV4ReadsEnabled()) {
    query = query.filter("source_metadata->collection->>publishable", "eq", "true");
  }

  if (filters.source) query = query.eq("source_key", filters.source);
  if (filters.jurisdiction) query = query.eq("jurisdiction", filters.jurisdiction);
  if (filters.type) query = query.eq("content_type", filters.type);
  if (filters.language) query = query.eq("original_language", filters.language);

  const range = normalizeRange(filters.range);
  if (range === "today") {
    const now = new Date();
    query = query.gte("original_published_at", new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString());
  } else if (range === "week" || range === "month") {
    const days = range === "week" ? 7 : 30;
    query = query.gte("original_published_at", new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString());
  }

  const { data, error } = await query;
  if (error || !Array.isArray(data)) {
    return listArticles(filters);
  }

  const ids = (data as VectorArticleRow[])
    .map((row) => {
      const vector = parseVector(row.embedding);
      return vector && vector.length ? { id: row.id, score: cosineSimilarity(embedding, vector) } : null;
    })
    .filter((row): row is { id: string; score: number } => Boolean(row))
    .sort((a, b) => b.score - a.score)
    .slice(0, matchCount)
    .map((row) => row.id);

  if (ids.length === 0) {
    return { items: [], pageInfo: { page: filters.page ?? 1, pageSize: filters.pageSize ?? 20, total: 0 } };
  }

  return reorderAndPage(filters, ids);
}

export async function semanticSearch(filters: ArticleListFilters): Promise<ArticleListResult> {
  observeArticlePublicationReadDecision("vector_search");
  if (!filters.q) {
    return listArticles(filters);
  }

  const supabase = getSupabaseAdmin();
  if (!supabase) {
    return listArticles(filters);
  }

  const embedding = await createTextEmbedding(filters.q).catch(() => null);
  if (!embedding) {
    return listArticles(filters);
  }

  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? 20;
  const matchCount = Math.min(Math.max(page * pageSize * 3, 20), 200);
  const searchRpc = articlePublicationV4ReadsEnabled() ? "match_public_article_versions_p3" : "match_articles";
  const { data, error } = await supabase.rpc(searchRpc, {
    query_embedding: embedding,
    match_count: matchCount,
    source_filter: filters.source ?? null,
    jurisdiction_filter: filters.jurisdiction ?? null,
    content_type_filter: filters.type ?? null,
    language_filter: filters.language ?? null,
  });

  if (error || !Array.isArray(data)) {
    return localSemanticSearch(filters, embedding, matchCount);
  }

  const ids = (data as MatchArticleRow[]).map((row) => row.article_id).filter(Boolean);
  if (ids.length === 0) {
    return { items: [], pageInfo: { page: filters.page ?? 1, pageSize, total: 0 } };
  }

  return reorderAndPage(filters, ids);
}

export async function hybridSearch(filters: ArticleListFilters): Promise<ArticleListResult> {
  if (!filters.q) {
    return listArticles(filters);
  }

  const exact = await exactCaseSearch(filters);
  if (exact.items.length > 0) {
    return exact;
  }

  const windowSize = rankedSearchWindow(filters, 50);
  const candidateFilters = { ...filters, page: 1, pageSize: windowSize };
  const [fulltext, semantic] = await Promise.all([
    listArticles(candidateFilters),
    semanticSearch(candidateFilters),
  ]);
  const merged = mergeRankedArticleItems(fulltext.items, semantic.items);
  return paginateRankedArticleItems(merged, filters);
}

export function mergeRankedArticleItems(
  ...groups: ArticleListResult["items"][]
): ArticleListResult["items"] {
  const seen = new Set<string>();
  return groups.flat().filter((item) => {
    const key = item.id ?? item.slug;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
