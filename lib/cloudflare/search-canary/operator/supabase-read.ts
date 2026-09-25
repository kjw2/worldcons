import {
  createSupabaseLinkedQueryRunner,
  parseSupabaseLinkedRows,
  type SupabaseLinkedQueryRunner,
} from "@/lib/cloudflare/d1/convert/supabase-linked-source";
import { renderSqlLiteral } from "@/lib/cloudflare/d1/import/literal";
import type {
  SearchBaseArticleRow,
  SearchPublicationP3Row,
  SearchVersionP3Row,
} from "@/lib/cloudflare/search-projection";
import type { ArticleEmbeddingArtifactRow } from "@/lib/cloudflare/search-vector";
import type { RankedSearchPagePayload } from "@/lib/cloudflare/search-ranked";
import type { SearchCanaryCase } from "../types";

/**
 * Operator-only, read-only Supabase reader for the M7.5 canary.
 *
 * Supabase remains the sole production search authority; this module only reads.
 * It authors every SELECT/DML-free statement itself and inlines values through
 * `renderSqlLiteral` (or a finite-number-only vector literal), so no unguarded
 * text reaches the linked Supabase CLI. It never mutates a Supabase row and never
 * loads a vector value into a log or evidence report.
 */
export interface SupabaseCanarySourceBundle {
  publications: SearchPublicationP3Row[];
  versions: SearchVersionP3Row[];
  articles: SearchBaseArticleRow[];
  artifacts: ArticleEmbeddingArtifactRow[];
  /** Number of published publications returned (before any projection). */
  publishedCount: number;
}

const SOURCE_QUERY = `
select
  p.id as publication_id,
  p.article_id as publication_article_id,
  p.state as publication_state,
  p.version_id as publication_version_id,
  p.revision as publication_revision,
  p.published_at as publication_published_at,
  p.withdrawn_at as publication_withdrawn_at,
  p.created_at as publication_created_at,
  p.updated_at as publication_updated_at,
  v.id as version_id,
  v.article_id as version_article_id,
  v.revision as version_revision,
  v.slug as slug,
  v.source_key as source_key,
  v.jurisdiction as jurisdiction,
  v.institution_name as institution_name,
  v.content_type as content_type,
  v.original_language as original_language,
  v.original_title as original_title,
  v.korean_title as korean_title,
  v.original_published_at as original_published_at,
  v.cleaned_text as cleaned_text,
  v.summary_json as summary_json,
  v.source_metadata as source_metadata,
  v.case_key as case_key,
  v.created_at as version_created_at,
  v.fetched_at as fetched_at,
  v.summarized_at as summarized_at,
  v.content_hash as content_hash,
  a.review_state as article_review_state,
  e.article_version_id as artifact_article_version_id,
  e.article_id as artifact_article_id,
  e.content_hash as artifact_content_hash,
  e.provider as artifact_provider,
  e.model as artifact_model,
  e.dimensions as artifact_dimensions,
  e.input_hash as artifact_input_hash,
  e.generated_at as artifact_generated_at,
  e.updated_at as artifact_updated_at,
  e.embedding::text as artifact_embedding
from public.article_publications_p3 p
join public.article_content_versions_p3 v on v.id = p.version_id and v.article_id = p.article_id
left join public.articles a on a.id = p.article_id
left join public.article_embedding_artifacts e
  on e.article_version_id = v.id and e.article_id = p.article_id and e.content_hash = v.content_hash
where p.state = 'published'
order by p.article_id
limit %LIMIT%`;

function asString(value: unknown): string {
  return typeof value === "string" ? value : value === null || value === undefined ? "" : String(value);
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function renderVectorLiteral(values: readonly number[]): string {
  if (values.length === 0) throw new Error("cannot render an empty vector");
  const body = values.map((value) => {
    if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("vector literal must contain finite numbers");
    return String(value);
  });
  return `'[${body.join(",")}]'::extensions.vector`;
}

export interface SupabaseCanaryReader {
  readSources(maxArticles: number): Promise<SupabaseCanarySourceBundle>;
  isProductionSemanticOracleEligible(articleId: string): Promise<boolean>;
  readOraclePage(caseDef: SearchCanaryCase, allowedArticleIds?: ReadonlySet<string>): Promise<RankedSearchPagePayload>;
}

export function createSupabaseCanaryReader(options: { runner?: SupabaseLinkedQueryRunner } = {}): SupabaseCanaryReader {
  const query = options.runner ?? createSupabaseLinkedQueryRunner();

  return {
    async readSources(maxArticles) {
      if (!Number.isInteger(maxArticles) || maxArticles <= 0) throw new Error("maxArticles must be a positive integer");
      const rows = parseSupabaseLinkedRows(await query(SOURCE_QUERY.replace("%LIMIT%", String(maxArticles))));
      const publications: SearchPublicationP3Row[] = [];
      const versions: SearchVersionP3Row[] = [];
      const articles: SearchBaseArticleRow[] = [];
      const artifacts: ArticleEmbeddingArtifactRow[] = [];
      for (const row of rows) {
        publications.push({
          id: asString(row.publication_id),
          article_id: asString(row.publication_article_id),
          state: asString(row.publication_state),
          version_id: asString(row.publication_version_id),
          revision: asNullableString(row.publication_revision),
          published_at: asNullableString(row.publication_published_at),
          withdrawn_at: asNullableString(row.publication_withdrawn_at),
          created_at: asString(row.publication_created_at),
          updated_at: asNullableString(row.publication_updated_at),
        });
        versions.push({
          id: asString(row.version_id),
          article_id: asString(row.version_article_id),
          revision: asNullableString(row.version_revision),
          slug: asNullableString(row.slug),
          source_key: asString(row.source_key),
          jurisdiction: asString(row.jurisdiction),
          institution_name: asNullableString(row.institution_name),
          content_type: asString(row.content_type),
          original_language: asNullableString(row.original_language),
          original_title: asNullableString(row.original_title),
          korean_title: asNullableString(row.korean_title),
          original_published_at: asNullableString(row.original_published_at),
          cleaned_text: asNullableString(row.cleaned_text),
          summary_json: row.summary_json ?? null,
          source_metadata: row.source_metadata ?? null,
          case_key: asNullableString(row.case_key),
          created_at: asString(row.version_created_at),
          fetched_at: asNullableString(row.fetched_at),
          summarized_at: asNullableString(row.summarized_at),
          content_hash: asNullableString(row.content_hash),
        });
        articles.push({ id: asString(row.publication_article_id), review_state: asNullableString(row.article_review_state) });
        if (asNullableString(row.artifact_article_version_id) !== null) {
          artifacts.push({
            article_version_id: asNullableString(row.artifact_article_version_id),
            article_id: asNullableString(row.artifact_article_id),
            content_hash: asNullableString(row.artifact_content_hash),
            provider: asNullableString(row.artifact_provider),
            model: asNullableString(row.artifact_model),
            dimensions: asNumber(row.artifact_dimensions),
            input_hash: asNullableString(row.artifact_input_hash),
            embedding: row.artifact_embedding ?? null,
            generated_at: asNullableString(row.artifact_generated_at),
            updated_at: asNullableString(row.artifact_updated_at),
          });
        }
      }
      return { publications, versions, articles, artifacts, publishedCount: publications.length };
    },

    async isProductionSemanticOracleEligible(articleId) {
      const rows = parseSupabaseLinkedRows(
        await query(
          `select (embedding is not null) as eligible from public.public_article_projection_p3 ` +
            `where id = ${renderSqlLiteral(articleId)} limit 1`,
        ),
      );
      return rows[0]?.eligible === true;
    },

    async readOraclePage(caseDef, allowedArticleIds) {
      // A bounded canary must compare like-for-like. Fetch a wider production
      // window, then restrict the oracle to the article ids materialized in the
      // canary. Comparing the canary top-N directly with the full production
      // corpus top-N produces false mismatches whenever an out-of-canary article
      // ranks above an otherwise-correct canary result.
      const oracleLimit = allowedArticleIds ? 100 : caseDef.limit;
      const args: string[] = [
        `p_query => ${renderSqlLiteral(caseDef.query)}`,
        `p_mode => ${renderSqlLiteral(caseDef.mode)}`,
        `p_limit => ${renderSqlLiteral(oracleLimit)}`,
        `p_offset => ${renderSqlLiteral(allowedArticleIds ? 0 : caseDef.offset)}`,
        `p_range => ${renderSqlLiteral(caseDef.range ?? "latest")}`,
        `p_count => ${renderSqlLiteral(caseDef.count ?? "none")}`,
      ];
      if (caseDef.vectorId) {
        // Avoid placing a 1536-dimensional vector literal on the Windows
        // command line. The canary vector id is the article id, so resolve the
        // exact current published embedding inside Postgres instead. This stays
        // read-only and preserves the same provenance lock used by M7.4.
        args.push(
          `p_query_embedding => (` +
            `select e.embedding from public.article_publications_p3 p ` +
            `join public.article_content_versions_p3 v on v.id = p.version_id and v.article_id = p.article_id ` +
            `join public.article_embedding_artifacts e on e.article_version_id = v.id and e.article_id = p.article_id and e.content_hash = v.content_hash ` +
            `where p.state = 'published' and p.article_id = ${renderSqlLiteral(caseDef.vectorId)} ` +
            `limit 1)`,
        );
      } else if (caseDef.embedding && caseDef.embedding.length > 0) {
        args.push(`p_query_embedding => ${renderVectorLiteral(caseDef.embedding)}`);
      }
      if (caseDef.source) args.push(`p_source => ${renderSqlLiteral(caseDef.source)}`);
      if (caseDef.jurisdiction) args.push(`p_jurisdiction => ${renderSqlLiteral(caseDef.jurisdiction)}`);
      if (caseDef.contentType) args.push(`p_content_type => ${renderSqlLiteral(caseDef.contentType)}`);
      if (caseDef.language) args.push(`p_language => ${renderSqlLiteral(caseDef.language)}`);

      const rows = parseSupabaseLinkedRows(
        await query(`select public.worldcons_ranked_search_page_v1(${args.join(", ")}) as page`),
      );
      const page = rows[0]?.page;
      if (typeof page !== "object" || page === null || Array.isArray(page)) {
        throw new Error("oracle RPC did not return a page object");
      }
      const record = page as Record<string, unknown>;
      const entries = Array.isArray(record.entries) ? record.entries : [];
      const mappedEntries: RankedSearchPagePayload["entries"] = entries
        .filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null && !Array.isArray(entry))
        .map((entry) => {
          const mapped: RankedSearchPagePayload["entries"][number] = { id: asString(entry.id) };
          if (typeof entry.score === "number") mapped.score = entry.score;
          return mapped;
        });
      const scopedEntries = allowedArticleIds
        ? mappedEntries.filter((entry) => allowedArticleIds.has(entry.id)).slice(0, caseDef.limit)
        : mappedEntries;
      return {
        retrievalMode: (typeof record.retrievalMode === "string" ? record.retrievalMode : caseDef.mode) as RankedSearchPagePayload["retrievalMode"],
        total: allowedArticleIds ? scopedEntries.length : typeof record.total === "number" ? record.total : 0,
        hasMore: allowedArticleIds ? false : record.hasMore === true,
        totalIsExact: allowedArticleIds ? true : record.totalIsExact === true,
        entries: scopedEntries,
      };
    },
  };
}
