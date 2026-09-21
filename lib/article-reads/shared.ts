import { caseCatalogPublicReadsEnabled } from "@/lib/case-catalog/flags";
import { publicArticleRelation, publicProjectionReadsEnabled } from "@/lib/article-publication";
import type {
  ArticleContentType,
  ArticleDetail,
  ArticleRawBlobMetadata,
  SummaryJson,
} from "@/lib/db/types";
import { tagRowToSummary, type SupabaseTagRow } from "@/lib/reference-reads/shared";
import type { ArticleReadSelect } from "@/lib/article-reads/types";

export interface SupabaseArticleTagRow {
  confidence?: number | null;
  tags?: SupabaseTagRow | SupabaseTagRow[] | null;
}

export interface SupabaseArticleRow {
  id?: string;
  slug: string;
  source_key: string;
  jurisdiction: string;
  institution_name: string;
  content_type: string;
  original_url: string;
  canonical_url: string;
  original_language: string;
  original_title?: string | null;
  korean_title?: string | null;
  original_published_at?: string | null;
  discovered_at?: string | null;
  fetched_at?: string | null;
  summarized_at?: string | null;
  status: string;
  raw_text?: string | null;
  raw_text_storage_ref?: string | null;
  raw_text_blob_hash?: string | null;
  raw_text_blob_size?: number | null;
  raw_text_externalized_at?: string | null;
  raw_text_blob_contract_version?: string | null;
  cleaned_text?: string | null;
  summary_json?: SummaryJson | null;
  one_line_summary?: string | null;
  content_hash?: string | null;
  source_metadata?: Record<string, unknown> | null;
  resolution_type?: string | null;
  case_number?: string | null;
  error_metadata?: Record<string, unknown> | null;
  article_tags?: SupabaseArticleTagRow[] | null;
  enrichment_status?: string | null;
  enrichment_freshness?: string | null;
  summary_status?: string | null;
  summary_available?: boolean | null;
}

export const TAG_LIST_SELECT = "id,slug,name,normalized_name,type,description,article_count,latest_article_at";
export const ARTICLE_LIST_SELECT = [
  "id",
  "slug",
  "source_key",
  "jurisdiction",
  "institution_name",
  "content_type",
  "original_url",
  "canonical_url",
  "original_language",
  "original_title",
  "korean_title",
  "original_published_at",
  "discovered_at",
  "fetched_at",
  "summarized_at",
  "status",
  "one_line_summary:summary_json->summary->coreSummary->>0",
  "resolution_type:source_metadata->>resolutionType",
  "case_number:source_metadata->>caseNumber",
  `article_tags(confidence,tags(${TAG_LIST_SELECT}))`,
].join(",");
export const ARTICLE_LIST_WITH_TAG_FILTER_SELECT = `${ARTICLE_LIST_SELECT},article_tag_filter:article_tags!inner(tag_id)`;
export const ARTICLE_PAGE_SELECT = `${ARTICLE_LIST_SELECT},source_metadata,summary_json,content_hash,error_metadata`;
export const ARTICLE_RAW_BLOB_METADATA_SELECT = "raw_text_storage_ref,raw_text_blob_hash,raw_text_blob_size,raw_text_externalized_at,raw_text_blob_contract_version";
export const ARTICLE_DETAIL_SELECT = `${ARTICLE_PAGE_SELECT},raw_text,cleaned_text,${ARTICLE_RAW_BLOB_METADATA_SELECT}`;
export const ARTICLE_P3_LIST_SELECT = [
  "id",
  "slug",
  "source_key",
  "jurisdiction",
  "institution_name",
  "content_type",
  "original_url",
  "canonical_url",
  "original_language",
  "original_title",
  "korean_title",
  "original_published_at",
  "discovered_at",
  "fetched_at",
  "summarized_at",
  "status",
  "one_line_summary:summary_json->summary->coreSummary->>0",
  "resolution_type:source_metadata->>resolutionType",
  "case_number:source_metadata->>caseNumber",
  "article_tags",
].join(",");
export const ARTICLE_P3_PAGE_SELECT = `${ARTICLE_P3_LIST_SELECT},source_metadata,summary_json,content_hash,error_metadata`;
export const ARTICLE_P3_DETAIL_SELECT = `${ARTICLE_P3_PAGE_SELECT},raw_text,cleaned_text,${ARTICLE_RAW_BLOB_METADATA_SELECT}`;
export const ARTICLE_V4_STATE_SELECT = "enrichment_status,enrichment_freshness,summary_status,summary_available";
export const ARTICLE_V4_LIST_SELECT = `${ARTICLE_P3_LIST_SELECT},${ARTICLE_V4_STATE_SELECT}`;
export const ARTICLE_V4_PAGE_SELECT = `${ARTICLE_P3_PAGE_SELECT},${ARTICLE_V4_STATE_SELECT}`;
export const ARTICLE_V4_DETAIL_SELECT = `${ARTICLE_P3_DETAIL_SELECT},${ARTICLE_V4_STATE_SELECT}`;

export function publicationProjectionEnabled(
  includeUnpublished?: boolean,
  environment: Record<string, string | undefined> = process.env,
) {
  return publicProjectionReadsEnabled(Boolean(includeUnpublished), environment);
}

export function articleRelation(
  includeUnpublished?: boolean,
  environment: Record<string, string | undefined> = process.env,
) {
  return publicArticleRelation(Boolean(includeUnpublished), environment);
}

export function articleDetailRelation(
  includeUnpublished?: boolean,
  environment: Record<string, string | undefined> = process.env,
) {
  if (!includeUnpublished && caseCatalogPublicReadsEnabled(environment)) return "public_article_detail_v4";
  return articleRelation(includeUnpublished, environment);
}

export function projectionSelect(
  select: string,
  includeUnpublished?: boolean,
  environment: Record<string, string | undefined> = process.env,
) {
  if (!publicationProjectionEnabled(includeUnpublished, environment)) return select;
  if (select === ARTICLE_DETAIL_SELECT) return ARTICLE_P3_DETAIL_SELECT;
  if (select === ARTICLE_PAGE_SELECT) return ARTICLE_P3_PAGE_SELECT;
  return ARTICLE_P3_LIST_SELECT;
}

export function detailProjectionSelect(
  select: string,
  includeUnpublished?: boolean,
  environment: Record<string, string | undefined> = process.env,
) {
  if (!includeUnpublished && caseCatalogPublicReadsEnabled(environment)) {
    if (select === ARTICLE_DETAIL_SELECT) return ARTICLE_V4_DETAIL_SELECT;
    if (select === ARTICLE_PAGE_SELECT) return ARTICLE_V4_PAGE_SELECT;
    return ARTICLE_V4_LIST_SELECT;
  }
  return projectionSelect(select, includeUnpublished, environment);
}

export function articleSelectForKind(select: ArticleReadSelect): string {
  if (select === "detail") return ARTICLE_DETAIL_SELECT;
  if (select === "page") return ARTICLE_PAGE_SELECT;
  return ARTICLE_LIST_SELECT;
}

export function articleMappingOptions(select: ArticleReadSelect) {
  return {
    includeSummaryJson: select === "detail" || select === "page",
    includeDetailFields: select === "detail",
  };
}

function minimalSourceMetadata(row: SupabaseArticleRow) {
  const metadata: Record<string, unknown> = {};
  if (row.resolution_type) metadata.resolutionType = row.resolution_type;
  if (row.case_number) metadata.caseNumber = row.case_number;
  return Object.keys(metadata).length > 0 ? metadata : null;
}

export function articleRawBlobMetadataFromRow(row: SupabaseArticleRow): ArticleRawBlobMetadata | null {
  const storageRef = row.raw_text_storage_ref?.trim();
  if (!storageRef) return null;
  const blobHash = row.raw_text_blob_hash;
  const blobSize = row.raw_text_blob_size;
  const externalizedAt = row.raw_text_externalized_at;
  const contractVersion = row.raw_text_blob_contract_version;
  if (!blobHash || typeof blobSize !== "number" || !externalizedAt || !contractVersion) return null;
  return { storageRef, blobHash, blobSize, externalizedAt, contractVersion };
}

export function articleRowToItem(
  row: SupabaseArticleRow,
  options: { includeSummaryJson?: boolean; includeDetailFields?: boolean } = {},
): ArticleDetail {
  const includeSummaryJson = options.includeSummaryJson ?? true;
  const includeDetailFields = options.includeDetailFields ?? true;
  const tags =
    row.article_tags
      ?.flatMap((articleTag) => {
        const tagRows = Array.isArray(articleTag.tags) ? articleTag.tags : articleTag.tags ? [articleTag.tags] : [];
        return tagRows.map((tag) => tagRowToSummary(tag, articleTag.confidence));
      })
      .filter(Boolean) ?? [];
  const summary = row.summary_json ?? null;

  const item: ArticleDetail = {
    id: row.id,
    slug: row.slug,
    sourceKey: row.source_key,
    jurisdiction: row.jurisdiction,
    institutionName: row.institution_name,
    contentType: row.content_type as ArticleContentType,
    originalUrl: row.original_url,
    canonicalUrl: row.canonical_url,
    originalLanguage: row.original_language,
    originalTitle: row.original_title,
    koreanTitle: row.korean_title || summary?.koreanTitle || row.original_title,
    originalPublishedAt: row.original_published_at,
    discoveredAt: row.discovered_at,
    fetchedAt: row.fetched_at,
    summarizedAt: row.summarized_at,
    status: row.status as ArticleDetail["status"],
    caseNumber: row.case_number ?? null,
    summaryJson: includeSummaryJson ? summary : null,
    tags,
    sourceMetadata: row.source_metadata ?? minimalSourceMetadata(row),
    oneLineSummary: row.one_line_summary || summary?.summary.coreSummary[0] || "요약이 아직 생성되지 않았습니다.",
    viewCount: 0,
    enrichmentStatus: row.enrichment_status as ArticleDetail["enrichmentStatus"],
    enrichmentFreshness: row.enrichment_freshness as ArticleDetail["enrichmentFreshness"],
    summaryStatus: row.summary_status as ArticleDetail["summaryStatus"],
    summaryAvailable: row.summary_available ?? Boolean(summary),
  };

  if (includeDetailFields) {
    item.rawText = row.raw_text;
    item.cleanedText = row.cleaned_text;
    item.contentHash = row.content_hash;
    item.errorMetadata = row.error_metadata;
    item.rawTextBlob = articleRawBlobMetadataFromRow(row);
  }

  return item;
}
