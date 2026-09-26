import { nullableTrim } from "./canonical";
import { sortProjectionTags } from "./tags";
import { projectionError } from "./errors";
import type {
  SearchArticleTagRow,
  SearchBaseArticleRow,
  SearchCatalogPublicationV1Row,
  SearchProjectionSourceInput,
  SearchPublicationP3Row,
  SearchTagRow,
  SearchVersionP3Row,
  SelectedSearchProjectionSource,
} from "./types";

/**
 * P3 public search source selection contract.
 *
 * Base selection mirrors the `public_article_projection_p3` publication/version
 * join: only a `published` `article_publications_p3` row joined to the
 * `article_content_versions_p3` snapshot where
 * `v.id = p.version_id AND v.article_id = p.article_id` becomes searchable.
 *
 * When `SearchProjectionSourceInput.gate2Eligibility` is supplied, the latest
 * gate2 public eligibility predicate is applied exactly:
 *
 * - `version_role is null`: eligible only when a
 *   `legacy_version_freshness_classifications_v4` row with `freshness='current'`
 *   exists AND no `case_catalog_publications_v1` row is published for the article;
 * - `version_role='enrichment_full'`: eligible only when a published
 *   `case_catalog_publications_v1` row exists whose `source_anchor_version_id`
 *   matches the version and whose anchor `source_content_hash` equals the
 *   version's `enrichment_source_content_hash`;
 * - any other role (e.g. `authoritative_source`) is not part of
 *   `public_article_projection_p3` and is never selected here.
 *
 * Without `gate2Eligibility`, the historical published-only selection is kept so
 * existing local fixtures and canary plans are unchanged; exact gate2 parity is
 * only claimed when the eligibility rows are supplied. Base `articles` rows are
 * joined only for the non-authoritative `review_state`; a missing base row leaves
 * it null and never changes content authority. Every ambiguity fails closed.
 */

function requireUniquePublicationIds(publications: readonly SearchPublicationP3Row[]): void {
  const seen = new Set<string>();
  for (const publication of publications) {
    if (seen.has(publication.id)) {
      throw projectionError(
        "duplicate_publication_id",
        `duplicate article_publications_p3 id ${publication.id}`,
        publication.article_id,
      );
    }
    seen.add(publication.id);
  }
}

function indexVersions(versions: readonly SearchVersionP3Row[]): Map<string, SearchVersionP3Row> {
  const byId = new Map<string, SearchVersionP3Row>();
  for (const version of versions) {
    if (byId.has(version.id)) {
      throw projectionError(
        "duplicate_version_id",
        `duplicate article_content_versions_p3 id ${version.id}`,
        version.article_id,
      );
    }
    byId.set(version.id, version);
  }
  return byId;
}

function indexReviewStates(articles: readonly SearchBaseArticleRow[]): Map<string, string | null> {
  const byId = new Map<string, string | null>();
  for (const article of articles) {
    if (byId.has(article.id)) {
      throw projectionError("duplicate_base_article_id", `duplicate base articles id ${article.id}`, article.id);
    }
    byId.set(article.id, nullableTrim(article.review_state));
  }
  return byId;
}

function indexTags(tags: readonly SearchTagRow[]): Map<string, SearchTagRow> {
  const byId = new Map<string, SearchTagRow>();
  for (const tag of tags) {
    if (byId.has(tag.id)) {
      throw projectionError("duplicate_tag_id", `duplicate tags id ${tag.id}`, null);
    }
    byId.set(tag.id, tag);
  }
  return byId;
}

function indexArticleTags(
  articleTags: readonly SearchArticleTagRow[],
  tagById: Map<string, SearchTagRow>,
): Map<string, SearchTagRow[]> {
  const byArticle = new Map<string, SearchTagRow[]>();
  const seen = new Set<string>();
  for (const articleTag of articleTags) {
    const key = `${articleTag.article_id}:${articleTag.tag_id}`;
    if (seen.has(key)) {
      throw projectionError(
        "duplicate_article_tag",
        `duplicate article_tags (${articleTag.article_id}, ${articleTag.tag_id})`,
        articleTag.article_id,
      );
    }
    seen.add(key);
    const tag = tagById.get(articleTag.tag_id);
    if (!tag) {
      throw projectionError(
        "missing_tag",
        `article_tags references missing tags id ${articleTag.tag_id}`,
        articleTag.article_id,
      );
    }
    const list = byArticle.get(articleTag.article_id);
    if (list) list.push(tag);
    else byArticle.set(articleTag.article_id, [tag]);
  }
  return byArticle;
}

function indexPublishedAuthority(
  publications: readonly SearchPublicationP3Row[],
): Map<string, SearchPublicationP3Row> {
  const byArticle = new Map<string, SearchPublicationP3Row>();
  for (const publication of publications) {
    if (publication.state !== "published") continue;
    if (byArticle.has(publication.article_id)) {
      throw projectionError(
        "duplicate_published_authority",
        `multiple published article_publications_p3 rows for article ${publication.article_id}`,
        publication.article_id,
      );
    }
    byArticle.set(publication.article_id, publication);
  }
  return byArticle;
}

function indexCurrentLegacyFreshness(rows: readonly { version_id: string; freshness: string }[]): Set<string> {
  const current = new Set<string>();
  for (const row of rows) {
    if (row.freshness === "current") current.add(row.version_id);
  }
  return current;
}

/**
 * Indexes published `case_catalog_publications_v1` rows by article. The gate2
 * predicate uses `exists`, but the catalog schema permits at most one
 * publication head per article, so a duplicate published head is ambiguous and
 * fails closed rather than silently choosing one anchor.
 */
function indexPublishedCatalogPublications(
  rows: readonly SearchCatalogPublicationV1Row[],
): Map<string, SearchCatalogPublicationV1Row> {
  const byArticle = new Map<string, SearchCatalogPublicationV1Row>();
  for (const row of rows) {
    if (row.state !== "published") continue;
    if (byArticle.has(row.article_id)) {
      throw projectionError(
        "duplicate_published_catalog_publication",
        `multiple published case_catalog_publications_v1 rows for article ${row.article_id}`,
        row.article_id,
      );
    }
    byArticle.set(row.article_id, row);
  }
  return byArticle;
}

/**
 * Applies the exact gate2 `public_article_projection_p3` eligibility predicate to
 * one published version. The anchor hash comparison uses the anchor version's
 * `source_content_hash`, matching the SQL predicate
 * `anchor.source_content_hash = v.enrichment_source_content_hash`.
 */
function gate2Eligible(
  version: SearchVersionP3Row,
  versionById: Map<string, SearchVersionP3Row>,
  currentLegacyFreshness: Set<string>,
  publishedCatalogByArticle: Map<string, SearchCatalogPublicationV1Row>,
): boolean {
  const role = version.version_role ?? null;
  if (role === null) {
    return (
      currentLegacyFreshness.has(version.id) &&
      !publishedCatalogByArticle.has(version.article_id)
    );
  }
  if (role === "enrichment_full") {
    const catalog = publishedCatalogByArticle.get(version.article_id);
    if (!catalog) return false;
    if (catalog.source_anchor_version_id !== (version.source_anchor_version_id ?? null)) return false;
    const anchor = versionById.get(catalog.source_anchor_version_id);
    if (!anchor) return false;
    return anchor.source_content_hash === (version.enrichment_source_content_hash ?? null);
  }
  return false;
}

/**
 * Selects the authoritative published sources. Unpublished/withdrawn/draft
 * publications are omitted; a published publication whose version is missing
 * or belongs to a different article, a duplicate published authority, or an
 * ambiguous tag row fails closed. When `gate2Eligibility` is supplied, the
 * gate2 freshness/catalog predicate is additionally applied exactly.
 */
export function selectPublishedSearchProjectionSources(
  input: SearchProjectionSourceInput,
): SelectedSearchProjectionSource[] {
  const publications = input.publications ?? [];
  const versions = input.versions ?? [];
  const articles = input.articles ?? [];
  const tags = input.tags ?? [];
  const articleTags = input.articleTags ?? [];

  requireUniquePublicationIds(publications);
  const versionById = indexVersions(versions);
  const reviewStateByArticle = indexReviewStates(articles);
  const tagById = indexTags(tags);
  const tagsByArticle = indexArticleTags(articleTags, tagById);
  const publishedByArticle = indexPublishedAuthority(publications);
  const gate2 = input.gate2Eligibility;
  const currentLegacyFreshness = gate2 ? indexCurrentLegacyFreshness(gate2.legacyFreshnessClassifications) : null;
  const publishedCatalogByArticle = gate2
    ? indexPublishedCatalogPublications(gate2.catalogPublications)
    : null;

  const selected: SelectedSearchProjectionSource[] = [];
  for (const publication of publishedByArticle.values()) {
    const version = versionById.get(publication.version_id);
    if (!version) {
      throw projectionError(
        "missing_publication_version",
        `published publication ${publication.id} references missing version ${publication.version_id}`,
        publication.article_id,
      );
    }
    if (version.article_id !== publication.article_id) {
      throw projectionError(
        "publication_version_mismatch",
        `publication article ${publication.article_id} does not match version article ${version.article_id}`,
        publication.article_id,
      );
    }
    if (
      gate2 &&
      !gate2Eligible(
        version,
        versionById,
        currentLegacyFreshness as Set<string>,
        publishedCatalogByArticle as Map<string, SearchCatalogPublicationV1Row>,
      )
    ) {
      continue;
    }
    selected.push({
      publication,
      version,
      reviewState: reviewStateByArticle.get(publication.article_id) ?? null,
      tags: sortProjectionTags(tagsByArticle.get(publication.article_id) ?? []),
    });
  }

  selected.sort((left, right) =>
    left.version.article_id < right.version.article_id ? -1 : left.version.article_id > right.version.article_id ? 1 : 0,
  );
  return selected;
}
