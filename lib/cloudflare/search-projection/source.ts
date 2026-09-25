import { nullableTrim } from "./canonical";
import { sortProjectionTags } from "./tags";
import { projectionError } from "./errors";
import type {
  SearchArticleTagRow,
  SearchBaseArticleRow,
  SearchProjectionSourceInput,
  SearchPublicationP3Row,
  SearchTagRow,
  SearchVersionP3Row,
  SelectedSearchProjectionSource,
} from "./types";

/**
 * P3 public search source selection contract.
 *
 * Exactly mirrors `public_article_projection_p3`: only a `published`
 * `article_publications_p3` row joined to the `article_content_versions_p3`
 * snapshot where `v.id = p.version_id AND v.article_id = p.article_id` becomes
 * searchable. Base `articles` rows are joined only for the non-authoritative
 * `review_state`; a missing base row leaves it null and never changes content
 * authority. Every ambiguity fails closed.
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

/**
 * Selects the authoritative published sources. Unpublished/withdrawn/draft
 * publications are omitted; a published publication whose version is missing
 * or belongs to a different article, a duplicate published authority, or an
 * ambiguous tag row fails closed.
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
