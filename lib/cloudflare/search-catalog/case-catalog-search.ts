import { d1Schema } from "@/lib/cloudflare/d1/schema";
import type { D1RuntimeDatabase } from "@/lib/cloudflare/d1/runtime-binding";
import {
  runD1RuntimeRead,
  type D1RuntimeReadOrder,
  type D1RuntimeReadPredicate,
} from "@/lib/cloudflare/d1/runtime-read";
import type { D1TableDefinition } from "@/lib/cloudflare/d1/types";
import type {
  CatalogCaseSearchRpcRequest,
  CatalogCaseSearchRpcResult,
} from "@/lib/search/repository/types";
import { authoritativeCaseMetadata, type ExactCaseReference } from "@/lib/search/case-number";
import { primaryCaseReference } from "@/lib/cloudflare/search-ranked/reference";
import { isWithinRange, type TimeRange } from "@/lib/utils/dates";

/**
 * D1-native source-only Case Catalog search.
 *
 * This is the Cloudflare equivalent of the `worldcons_case_search_page_v2`
 * Postgres RPC, but it deliberately reads the *authoritative* catalog tables
 * (`case_catalog_publications_v1`, `article_content_versions_p3`,
 * `case_identifiers_v1`, `case_metadata_v1`, `articles`, `article_tags`/`tags`)
 * instead of the `public_article_detail_v4` view. That keeps the generic
 * `worldcons_search` projection untouched: `authoritative_source` rows are never
 * indexed into `search_documents` (only `enrichment_full` never-before-published
 * content is), so a source-only catalog row is reachable here but never through
 * the generic P3/full-text projection.
 *
 * The payload is the exact `schemaVersion = 2` shape `lib/search/case-catalog.ts`
 * parses: `entries` (`id`), `retrievalMode`, `rankingVersion`, `nextCursor`,
 * `total`, `hasMore`, `totalIsExact`. Cursor failures surface Postgres-shaped
 * `22023` error evidence (`WORLDCONS_CASE_SEARCH_*`) so `CatalogSearchCursorError`
 * still parses `expired`/`mismatch`/`invalid` unchanged.
 *
 * Every read is a bounded, fully-parameterized single-table `SELECT` executed
 * through the guarded D1 runtime reader; user text never reaches SQL text.
 */

export const D1_CASE_CATALOG_RANKING_VERSION = "gate3-exact-lexical-v1";

const CASE_CATALOG_SEARCH_MAX_ROWS = 2000;
const D1_IN_BATCH_SIZE = 80;
const MAX_CURSOR_LENGTH = 2048;
const CURSOR_ALPHABET = /^[A-Za-z0-9_-]+$/;
const CURSOR_MODES = new Set(["exact-identity", "lexical", "latest"]);
const MIN_SORT_DATE = "0001-01-01T00:00:00.000Z";

const IDENTIFIER_PENALTIES: Record<string, number> = {
  source_record_id: 1,
  ecli: 1,
  hj_id: 1,
  reporter_citation: 2,
  decision_number: 3,
  docket: 4,
  case_key: 5,
};

interface CatalogCandidate {
  articleId: string;
  publicationId: string;
  sourceKey: string;
  jurisdiction: string | null;
  contentType: string | null;
  language: string | null;
  originalTitle: string | null;
  koreanTitle: string | null;
  cleanedText: string | null;
  caseKey: string | null;
  originalPublishedAt: string | null;
  enrichmentStatus: string | null;
  enrichmentFreshness: string | null;
  summaryStatus: string;
  summaryAvailable: boolean;
  identifiers: Array<{ type: string; normalized: string }>;
}

interface RankedCandidate {
  candidate: CatalogCandidate;
  score: number;
  sortDate: string;
  matchedBy: "exact-identity" | "lexical" | "latest";
}

interface CursorPayload {
  rankingVersion: string;
  fingerprint: string;
  mode: string;
  score: number;
  sortDate: string;
  articleId: string;
  position: number;
}

export interface D1CaseCatalogSearchRequest {
  binding: D1RuntimeDatabase;
  request: CatalogCaseSearchRpcRequest;
  /** Reference instant for range filters; defaults to now. */
  now?: Date;
}

function tableMap(): Map<string, D1TableDefinition> {
  return new Map(d1Schema.tables.map((table) => [table.name, table]));
}

function errorEvidence(code: string, message: string): CatalogCaseSearchRpcResult {
  return { status: "error", error: { code, message } };
}

function requireTable(tables: Map<string, D1TableDefinition>, name: string): D1TableDefinition {
  const table = tables.get(name);
  if (!table) throw new Error(`D1 schema has no table ${name}`);
  return table;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asBoolean(value: unknown): boolean {
  if (value === true || value === 1) return true;
  if (typeof value === "string") return value === "true" || value === "1";
  return false;
}

function uniqueStrings(values: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (typeof value !== "string" || value.length === 0) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function batches<T>(values: readonly T[], size = D1_IN_BATCH_SIZE): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < values.length; index += size) out.push(values.slice(index, index + size));
  return out;
}

/**
 * Normalizes a query the same way `worldcons_legal_alias_normalize_v1` does:
 * NFKC + lower + trim, whitespace removed, then a fixed punctuation strip. This
 * is what `case_identifiers_v1.normalized_value` stores, so identity matching is
 * exact against the normalized identifier value.
 */
export function normalizeCaseCatalogQuery(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/\s+/gu, "")
    .replace(/[._\-#/.,;:()[\]{}'"]/gu, "");
}

function compactText(value: string | null | undefined): string {
  if (!value) return "";
  return value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}_]+/gu, "");
}

function queryTerms(value: string): string[] {
  return Array.from(
    new Set(
      Array.from(value.normalize("NFKC").matchAll(/[\p{L}\p{N}_]+/gu))
        .map((match) => compactText(match[0]))
        .filter((term) => term.length >= 2),
    ),
  ).slice(0, 8);
}

function fnv1a64(value: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, "0");
}

function rankingFingerprint(
  request: CatalogCaseSearchRpcRequest,
  rankingVersion: string,
): string {
  return fnv1a64(
    [
      request.query.trim().toLowerCase(),
      request.source ?? "",
      request.jurisdiction ?? "",
      request.contentType ?? "",
      request.language ?? "",
      request.tag ?? "",
      request.range ?? "latest",
      rankingVersion,
    ].join("\u001f"),
  );
}

function base64UrlEncode(value: string): string {
  const base64 = btoa(value);
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

function base64UrlDecode(value: string): string {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  return atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
}

function encodeCursor(payload: CursorPayload): string {
  return base64UrlEncode(JSON.stringify(payload));
}

function decodeCursor(cursor: string): CursorPayload | null {
  if (typeof cursor !== "string" || cursor.length === 0 || cursor.length > MAX_CURSOR_LENGTH) return null;
  if (!CURSOR_ALPHABET.test(cursor)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(base64UrlDecode(cursor));
  } catch {
    return null;
  }
  const record = asRecord(parsed);
  if (!record) return null;
  const rankingVersion = record.rankingVersion;
  const fingerprint = record.fingerprint;
  const mode = record.mode;
  const score = record.score;
  const sortDate = record.sortDate;
  const articleId = record.articleId;
  const position = record.position;
  if (
    typeof rankingVersion !== "string" || rankingVersion.length === 0
    || typeof fingerprint !== "string" || fingerprint.length === 0
    || typeof mode !== "string" || !CURSOR_MODES.has(mode)
    || typeof score !== "number" || !Number.isFinite(score)
    || typeof sortDate !== "string" || Number.isNaN(Date.parse(sortDate))
    || typeof articleId !== "string" || articleId.length === 0
    || typeof position !== "number" || !Number.isSafeInteger(position) || position < 0
  ) {
    return null;
  }
  return { rankingVersion, fingerprint, mode, score, sortDate, articleId, position };
}

function scoreLexical(query: string, candidate: CatalogCandidate): number {
  const queryCompact = compactText(query);
  if (!queryCompact) return 0;
  const title = compactText(candidate.originalTitle);
  const body = compactText(candidate.cleanedText);
  const terms = queryTerms(query);

  let score = 0;
  if (title && title === queryCompact) score += 500;
  else if (queryCompact.length >= 3 && title.includes(queryCompact)) score += 180;

  const titleMatches = terms.filter((term) => title.includes(term)).length;
  const bodyMatches = terms.filter((term) => body.includes(term)).length;
  if (terms.length > 0 && titleMatches === terms.length) score += 120;
  score += titleMatches * 24;
  score += bodyMatches * 6;
  return score;
}

/**
 * Recovers the canonical BVerfG case key for a source-only catalog row whose
 * immutable `article_content_versions_p3.case_key` was never populated (legacy
 * or D1-backfilled rows). It reads only the authoritative, pipeline-owned
 * metadata payloads - the version's `case_metadata_snapshot` (whose
 * `sourceMetadata` carries the sealed `sourceInventory`) and `source_metadata`,
 * then the article's `source_metadata` - never arbitrary article text. D1 JSON
 * text and revived objects are both accepted.
 */
function authoritativeVersionCaseKey(
  sourceKey: string,
  caseMetadataSnapshot: unknown,
  versionSourceMetadata: unknown,
  articleSourceMetadata: unknown,
): string | null {
  if (sourceKey !== "de-bverfg") return null;
  return authoritativeCaseMetadata(
    sourceKey,
    caseMetadataSnapshot,
    versionSourceMetadata,
    articleSourceMetadata,
  )?.caseKey ?? null;
}

function identityScore(reference: ExactCaseReference | null, candidate: CatalogCandidate, normalizedQuery: string) {
  let penalty: number | null = null;
  if (normalizedQuery) {
    for (const identifier of candidate.identifiers) {
      if (identifier.normalized !== normalizedQuery) continue;
      const value = IDENTIFIER_PENALTIES[identifier.type] ?? 9;
      penalty = penalty === null ? value : Math.min(penalty, value);
    }
  }
  const referenceMatch =
    reference !== null
    && candidate.sourceKey === reference.sourceKey
    && candidate.caseKey === reference.caseKey;
  if (penalty === null && !referenceMatch) return null;
  return 1000 - (penalty ?? 5);
}

function compareRanked(left: RankedCandidate, right: RankedCandidate): number {
  if (left.score !== right.score) return right.score - left.score;
  if (left.sortDate !== right.sortDate) return right.sortDate.localeCompare(left.sortDate);
  return left.candidate.articleId.localeCompare(right.candidate.articleId);
}

function cursorExcludes(cursor: CursorPayload, entry: RankedCandidate): boolean {
  if (entry.matchedBy !== cursor.mode) return true;
  if (entry.score < cursor.score) return false;
  if (entry.score > cursor.score) return true;
  if (entry.sortDate < cursor.sortDate) return false;
  if (entry.sortDate > cursor.sortDate) return true;
  return entry.candidate.articleId <= cursor.articleId;
}

/**
 * Runs the D1 source-only Case Catalog search and returns either the exact
 * `schemaVersion=2` payload or Postgres-shaped error evidence. Read failures
 * never fall through as a silently empty result.
 */
export async function runD1CaseCatalogSearch(
  input: D1CaseCatalogSearchRequest,
): Promise<CatalogCaseSearchRpcResult> {
  const { binding } = input;
  const request = input.request;
  const now = input.now ?? new Date();

  const query = request.query ?? "";
  if (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > 100) {
    return errorEvidence("22023", "WORLDCONS_CASE_SEARCH_INVALID_LIMIT");
  }
  if (query.length > 200) {
    return errorEvidence("22023", "WORLDCONS_CASE_SEARCH_INVALID_QUERY");
  }
  const rawRange = request.range ?? "latest";
  if (rawRange !== "latest" && rawRange !== "today" && rawRange !== "week" && rawRange !== "month") {
    return errorEvidence("22023", "WORLDCONS_CASE_SEARCH_INVALID_RANGE");
  }
  const range: TimeRange = rawRange;

  const tables = tableMap();
  const rankingVersion = D1_CASE_CATALOG_RANKING_VERSION;
  const fingerprint = rankingFingerprint(request, rankingVersion);

  let cursor: CursorPayload | null = null;
  if (request.cursor !== null && request.cursor !== undefined) {
    cursor = decodeCursor(request.cursor);
    if (!cursor) return errorEvidence("22023", "WORLDCONS_CASE_SEARCH_INVALID_CURSOR");
    if (cursor.rankingVersion !== rankingVersion) {
      return errorEvidence("22023", "WORLDCONS_CASE_SEARCH_CURSOR_RANKING_VERSION_EXPIRED");
    }
    if (cursor.fingerprint !== fingerprint) {
      return errorEvidence("22023", "WORLDCONS_CASE_SEARCH_CURSOR_MISMATCH");
    }
  }

  const read = async (
    table: string,
    execution: {
      select?: readonly string[];
      where?: readonly D1RuntimeReadPredicate[];
      orderBy?: readonly (string | D1RuntimeReadOrder)[];
      limit: number;
    },
  ) => runD1RuntimeRead({ binding, table: requireTable(tables, table), ...execution });

  const readInBatches = async (
    table: string,
    column: string,
    values: readonly string[],
    execution: {
      select?: readonly string[];
      orderBy?: readonly (string | D1RuntimeReadOrder)[];
      limit: number;
    },
  ): Promise<Record<string, unknown>[]> => {
    if (values.length === 0) return [];
    const rows: Record<string, unknown>[] = [];
    for (const batch of batches(values)) {
      rows.push(
        ...(await read(table, {
          ...execution,
          where: [{ column, op: "in", value: batch }],
        })),
      );
    }
    return rows;
  };

  try {
    let tagArticleIds: Set<string> | null = null;
    if (request.tag) {
      const tagRows = uniqueStrings(
        [
          ...(await read("tags", { select: ["id"], where: [{ column: "slug", value: request.tag }], limit: CASE_CATALOG_SEARCH_MAX_ROWS + 1 })),
          ...(await read("tags", { select: ["id"], where: [{ column: "name", value: request.tag }], limit: CASE_CATALOG_SEARCH_MAX_ROWS + 1 })),
        ].map((row) => row.id),
      );
      if (tagRows.length === 0) {
        return okPayload([], rankingVersion);
      }
      const links = await readInBatches("article_tags", "tag_id", tagRows, {
        select: ["article_id"],
        limit: CASE_CATALOG_SEARCH_MAX_ROWS + 1,
      });
      tagArticleIds = new Set(uniqueStrings(links.map((row) => row.article_id)));
      if (tagArticleIds.size === 0) {
        return okPayload([], rankingVersion);
      }
    }

    const publications = await read("case_catalog_publications_v1", {
      select: ["id", "article_id", "state", "source_anchor_version_id"],
      where: [{ column: "state", value: "published" }],
      limit: CASE_CATALOG_SEARCH_MAX_ROWS + 1,
    });
    if (publications.length > CASE_CATALOG_SEARCH_MAX_ROWS) {
      return errorEvidence("54000", "WORLDCONS_CASE_SEARCH_CANDIDATE_OVERFLOW");
    }

    const articleIds = uniqueStrings(publications.map((row) => row.article_id));
    if (articleIds.length === 0) return okPayload([], rankingVersion);

    const metadataRows = await readInBatches("case_metadata_v1", "article_id", articleIds, {
      select: [
        "article_id",
        "authority_status",
        "constitutional_relevance_status",
        "enrichment_status",
        "enrichment_freshness",
      ],
      limit: CASE_CATALOG_SEARCH_MAX_ROWS + 1,
    });
    const metadataByArticle = new Map(metadataRows.map((row) => [String(row.article_id), row]));

    const anchorIds = uniqueStrings(publications.map((row) => row.source_anchor_version_id));
    const versionRows = await readInBatches("article_content_versions_p3", "id", anchorIds, {
      select: [
        "id",
        "article_id",
        "source_key",
        "jurisdiction",
        "content_type",
        "original_language",
        "original_title",
        "korean_title",
        "cleaned_text",
        "case_key",
        "case_metadata_snapshot",
        "source_metadata",
        "original_published_at",
        "version_role",
        "source_anchor_version_id",
      ],
      limit: CASE_CATALOG_SEARCH_MAX_ROWS + 1,
    });
    const versionById = new Map(versionRows.map((row) => [String(row.id), row]));

    const baseRows = await readInBatches("articles", "id", articleIds, {
      select: ["id", "catalog_ai_stale_v4", "source_metadata"],
      limit: CASE_CATALOG_SEARCH_MAX_ROWS + 1,
    });
    const baseById = new Map(baseRows.map((row) => [String(row.id), row]));

    const identifierRows = await readInBatches("case_identifiers_v1", "article_id", articleIds, {
      select: ["article_id", "identifier_type", "normalized_value"],
      limit: CASE_CATALOG_SEARCH_MAX_ROWS + 1,
    });
    const identifiersByArticle = new Map<string, Array<{ type: string; normalized: string }>>();
    for (const row of identifierRows) {
      const articleId = asString(row.article_id);
      const type = asString(row.identifier_type);
      const normalized = asString(row.normalized_value);
      if (!articleId || !type || !normalized) continue;
      const list = identifiersByArticle.get(articleId) ?? [];
      list.push({ type, normalized });
      identifiersByArticle.set(articleId, list);
    }

    // Any published article_publications_p3 row means enrichment is being
    // reprocessed, matching the public_article_detail_v4 summary_status rule.
    const reprocessingRows = await readInBatches("article_publications_p3", "article_id", articleIds, {
      select: ["article_id"],
      limit: CASE_CATALOG_SEARCH_MAX_ROWS + 1,
    });
    const reprocessing = new Set(
      reprocessingRows.filter((row) => asString(row.article_id)).map((row) => String(row.article_id)),
    );

    const normalizedQuery = normalizeCaseCatalogQuery(query);
    const reference = query.trim() ? primaryCaseReference(query) : null;

    const candidates: CatalogCandidate[] = [];
    for (const publication of publications) {
      const articleId = asString(publication.article_id);
      if (!articleId) continue;
      if (tagArticleIds && !tagArticleIds.has(articleId)) continue;

      const metadata = metadataByArticle.get(articleId);
      if (!metadata) continue;
      if (asString(metadata.authority_status) !== "verified") continue;
      if (asString(metadata.constitutional_relevance_status) !== "verified") continue;

      const anchorId = asString(publication.source_anchor_version_id);
      const version = anchorId ? versionById.get(anchorId) : undefined;
      if (!version) continue;
      if (asString(version.version_role) !== "authoritative_source") continue;
      if (asString(version.article_id) !== articleId) continue;
      if (asString(version.source_anchor_version_id) !== asString(version.id)) continue;

      if (request.source && asString(version.source_key) !== request.source) continue;
      if (request.jurisdiction && asString(version.jurisdiction) !== request.jurisdiction) continue;
      if (request.contentType && asString(version.content_type) !== request.contentType) continue;
      if (request.language && asString(version.original_language) !== request.language) continue;
      const publishedAt = asString(version.original_published_at);
      // Postgres range predicates compare against a timestamp, so an undated
      // row is excluded from every non-latest range (NULL >= date is NULL).
      if (range !== "latest" && !publishedAt) continue;
      if (!isWithinRange(publishedAt, range, now)) continue;

      const base = baseById.get(articleId);
      const stale = base ? asBoolean(base.catalog_ai_stale_v4) : false;
      const sourceKey = asString(version.source_key) ?? "";
      const caseKey = asString(version.case_key)
        ?? authoritativeVersionCaseKey(
          sourceKey,
          version.case_metadata_snapshot,
          version.source_metadata,
          base?.source_metadata,
        );
      candidates.push({
        articleId,
        publicationId: String(publication.id ?? ""),
        sourceKey,
        jurisdiction: asString(version.jurisdiction),
        contentType: asString(version.content_type),
        language: asString(version.original_language),
        originalTitle: asString(version.original_title),
        koreanTitle: asString(version.korean_title),
        cleanedText: asString(version.cleaned_text),
        caseKey,
        originalPublishedAt: publishedAt,
        enrichmentStatus: asString(metadata.enrichment_status),
        enrichmentFreshness: asString(metadata.enrichment_freshness),
        summaryStatus: stale || reprocessing.has(articleId) ? "reprocessing" : "pending",
        summaryAvailable: false,
        identifiers: identifiersByArticle.get(articleId) ?? [],
      });
    }

    const exactMatches: RankedCandidate[] = [];
    for (const candidate of candidates) {
      const identity = identityScore(reference, candidate, normalizedQuery);
      if (identity === null) continue;
      exactMatches.push({
        candidate,
        score: identity,
        sortDate: candidate.originalPublishedAt ?? MIN_SORT_DATE,
        matchedBy: "exact-identity",
      });
    }

    let ranked: RankedCandidate[];
    let mode: string;
    if (exactMatches.length > 0) {
      ranked = exactMatches;
      mode = "exact-identity";
    } else if (query.trim() === "") {
      ranked = candidates.map((candidate) => ({
        candidate,
        score: 0,
        sortDate: candidate.originalPublishedAt ?? MIN_SORT_DATE,
        matchedBy: "latest" as const,
      }));
      mode = "latest";
    } else {
      ranked = candidates
        .map((candidate) => ({
          candidate,
          score: scoreLexical(query, candidate),
          sortDate: candidate.originalPublishedAt ?? MIN_SORT_DATE,
          matchedBy: "lexical" as const,
        }))
        .filter((entry) => entry.score > 0);
      mode = "lexical";
    }

    ranked.sort(compareRanked);

    const eligible = cursor ? ranked.filter((entry) => !cursorExcludes(cursor, entry)) : ranked;
    const pageEntries = eligible.slice(0, request.limit + 1);
    const hasMore = pageEntries.length > request.limit;
    const returned = pageEntries.slice(0, request.limit);
    const position = cursor ? cursor.position : 0;

    if (cursor && returned.length > 0 && returned[0].matchedBy !== cursor.mode) {
      return errorEvidence("22023", "WORLDCONS_CASE_SEARCH_CURSOR_MODE_CHANGED");
    }

    // A cursor page that returns no rows keeps the cursor's mode, matching the
    // Postgres page function instead of re-deriving it from the strategy.
    const retrievalMode = returned.length > 0 ? returned[0].matchedBy : cursor ? cursor.mode : mode;

    const last = returned[returned.length - 1];
    const nextCursor = hasMore && last
      ? encodeCursor({
          rankingVersion,
          fingerprint,
          mode: last.matchedBy,
          score: last.score,
          sortDate: last.sortDate,
          articleId: last.candidate.articleId,
          position: position + returned.length,
        })
      : null;

    const entries = returned.map((entry) => ({
      id: entry.candidate.articleId,
      score: entry.score,
      matchType: entry.matchedBy,
      enrichmentStatus: entry.candidate.enrichmentStatus,
      enrichmentFreshness: entry.candidate.enrichmentFreshness,
      summaryStatus: entry.candidate.summaryStatus,
      summaryAvailable: entry.candidate.summaryAvailable,
    }));

    return {
      status: "ok",
      data: {
        schemaVersion: 2,
        rankingVersion,
        entries,
        retrievalMode,
        nextCursor,
        total: position + returned.length + (hasMore ? 1 : 0),
        hasMore,
        totalIsExact: !hasMore,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "D1 case catalog search failed";
    return errorEvidence("XX000", `WORLDCONS_CASE_SEARCH_D1_FAILED:${message.slice(0, 200)}`);
  }
}

function okPayload(
  entries: unknown[],
  rankingVersion: string,
): CatalogCaseSearchRpcResult {
  return {
    status: "ok",
    data: {
      schemaVersion: 2,
      rankingVersion,
      entries,
      retrievalMode: "latest",
      nextCursor: null,
      total: 0,
      hasMore: false,
      totalIsExact: true,
    },
  };
}
