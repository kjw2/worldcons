import { articlePublicationV4ReadsEnabled } from "@/lib/article-publication";
import { getSupabaseAdmin } from "@/lib/db/client";
import { listArticles } from "@/lib/db/queries";
import type { ArticleListFilters, ArticleListResult } from "@/lib/db/types";

export type ExactCaseReference = {
  sourceKey?: "de-bverfg" | "fr-conseil-constitutionnel" | "es-tribunal-constitucional" | "us-scotus";
  caseNumber: string;
};

const BVERFG_CASE_NUMBER_PATTERN = /\b(\d{1,2})\s+Bv([A-Za-z]+)\s+(\d{1,7})\s*\/\s*(\d{2,4})\b/giu;
const LANDMARK_CASE_ALIASES: Array<{
  pattern: RegExp;
  reference: ExactCaseReference;
}> = [
  {
    pattern: /\bneubauer\b|\bklimabeschluss\b/iu,
    reference: {
      sourceKey: "de-bverfg",
      caseNumber: "1 BvR 2656/18",
    },
  },
];

export function extractExactCaseReferences(query: string): ExactCaseReference[] {
  const references: ExactCaseReference[] = [];

  for (const match of query.normalize("NFKC").matchAll(BVERFG_CASE_NUMBER_PATTERN)) {
    const suffix = match[2];
    references.push({
      sourceKey: "de-bverfg",
      caseNumber: `${match[1]} Bv${suffix.slice(0, 1).toUpperCase()}${suffix.slice(1).toLowerCase()} ${match[3]}/${match[4]}`,
    });
  }

  for (const alias of LANDMARK_CASE_ALIASES) {
    if (alias.pattern.test(query)) references.push(alias.reference);
  }

  const normalized = query.normalize("NFKC");
  for (const match of normalized.matchAll(/\b(\d{4}-\d+(?:[/_-]\d+)*(?:\s+(?:QPC|DC|AN|SEN))?)\b/giu)) {
    references.push({ sourceKey: "fr-conseil-constitutionnel", caseNumber: match[1].trim() });
  }
  for (const match of normalized.matchAll(/\b(\d{1,3}\/\d{4})\b/gu)) {
    references.push({ sourceKey: "es-tribunal-constitucional", caseNumber: match[1] });
  }
  for (const match of normalized.matchAll(/\b(?:No\.\s*)?(\d{2,3}-\d+)\b/gu)) {
    references.push({ sourceKey: "us-scotus", caseNumber: match[1] });
  }

  const seen = new Set<string>();
  return references.filter((reference) => {
    const key = `${reference.sourceKey}:${reference.caseNumber.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function exactCaseSearch(filters: ArticleListFilters): Promise<ArticleListResult> {
  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? 20;
  const empty = { items: [], pageInfo: { page, pageSize, total: 0 } };
  if (!filters.q) return empty;

  const references = extractExactCaseReferences(filters.q).filter(
    (reference) => !filters.source || filters.source === reference.sourceKey,
  );
  if (references.length === 0) return empty;

  const supabase = getSupabaseAdmin();
  if (!supabase) return empty;

  const relation = articlePublicationV4ReadsEnabled() ? "public_article_projection_p3" : "articles";
  const ids: string[] = [];

  for (const reference of references) {
    const compactUrlToken = reference.caseNumber.toLowerCase().replace(/[^a-z0-9]/gu, "");
    const baseQuery = () => {
      let query = supabase.from(relation).select("id");
      if (reference.sourceKey) query = query.eq("source_key", reference.sourceKey);
      if (!articlePublicationV4ReadsEnabled()) {
        query = query.eq("status", "summarized").filter("source_metadata->collection->>publishable", "eq", "true");
      }
      if (filters.jurisdiction) query = query.eq("jurisdiction", filters.jurisdiction);
      if (filters.type) query = query.eq("content_type", filters.type);
      if (filters.language) query = query.eq("original_language", filters.language);
      return query;
    };

    const metadataResult = await baseQuery().eq("source_metadata->>caseNumber", reference.caseNumber).limit(10);
    const urlResult = reference.sourceKey === "de-bverfg"
      ? await baseQuery().ilike("original_url", `%${compactUrlToken}%`).limit(10)
      : { data: [], error: null };

    for (const result of [metadataResult, urlResult]) {
      if (result.error || !Array.isArray(result.data)) continue;
      for (const row of result.data as Array<{ id?: string }>) {
        if (row.id && !ids.includes(row.id)) ids.push(row.id);
      }
    }
  }

  if (ids.length === 0) return empty;

  const result = await listArticles({
    ...filters,
    ids,
    q: undefined,
    page: 1,
    pageSize: Math.min(Math.max(ids.length, pageSize), 100),
    count: "none",
  });
  const order = new Map(ids.map((id, index) => [id, index]));
  const items = [...result.items].sort(
    (left, right) => (order.get(left.id ?? "") ?? Number.MAX_SAFE_INTEGER) - (order.get(right.id ?? "") ?? Number.MAX_SAFE_INTEGER),
  );

  return {
    items,
    pageInfo: {
      page: 1,
      pageSize,
      total: items.length,
      hasMore: false,
      totalIsExact: true,
    },
  };
}
