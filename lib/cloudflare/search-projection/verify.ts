import { hashSearchProjectionDocuments } from "./checksum";
import { searchDocumentChecksum } from "./checksum";
import {
  SEARCH_PROJECTION_VERSION,
  type SearchProjectionDocument,
  type SearchProjectionDocumentRow,
  type SearchProjectionVerificationInput,
  type SearchProjectionVerificationIssue,
  type SearchProjectionVerificationIssueCode,
  type SearchProjectionVerificationReport,
} from "./types";

/**
 * Verification helpers over a projected corpus and (optionally) materialized
 * `search_documents` / `search_fts` rows.
 *
 * The report emits only counts, a corpus hash and offending `article_id`s; it
 * never emits document text. Results are order-independent and deterministic.
 */

function issue(code: SearchProjectionVerificationIssueCode, articleId: string | null): SearchProjectionVerificationIssue {
  return { code, articleId };
}

function issueKey(entry: SearchProjectionVerificationIssue): string {
  return `${entry.code}\u0000${entry.articleId ?? ""}`;
}

function sortAndDedupe(issues: readonly SearchProjectionVerificationIssue[]): SearchProjectionVerificationIssue[] {
  const seen = new Set<string>();
  const unique: SearchProjectionVerificationIssue[] = [];
  for (const entry of issues) {
    const key = issueKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(entry);
  }
  return unique.sort((left, right) => {
    if (left.code !== right.code) return left.code < right.code ? -1 : 1;
    const a = left.articleId ?? "";
    const b = right.articleId ?? "";
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

function indexProjected(
  documents: readonly SearchProjectionDocument[],
): { byId: Map<string, SearchProjectionDocument>; issues: SearchProjectionVerificationIssue[] } {
  const byId = new Map<string, SearchProjectionDocument>();
  const issues: SearchProjectionVerificationIssue[] = [];
  for (const document of documents) {
    if (byId.has(document.article_id)) {
      issues.push(issue("duplicate_projected_id", document.article_id));
      continue;
    }
    byId.set(document.article_id, document);
    const { checksum, ...body } = document;
    if (searchDocumentChecksum(body) !== checksum) {
      issues.push(issue("checksum_mismatch", document.article_id));
    }
    if (document.projection_version !== SEARCH_PROJECTION_VERSION) {
      issues.push(issue("projection_version_mismatch", document.article_id));
    }
  }
  return { byId, issues };
}

function verifyDocuments(
  byId: Map<string, SearchProjectionDocument>,
  rows: readonly SearchProjectionDocumentRow[],
): SearchProjectionVerificationIssue[] {
  const issues: SearchProjectionVerificationIssue[] = [];
  const byIdRows = new Map<string, SearchProjectionDocumentRow>();
  for (const row of rows) {
    if (byIdRows.has(row.article_id)) {
      issues.push(issue("duplicate_document", row.article_id));
      continue;
    }
    byIdRows.set(row.article_id, row);
  }
  for (const [articleId, document] of byId) {
    const row = byIdRows.get(articleId);
    if (!row) {
      issues.push(issue("missing_document", articleId));
      continue;
    }
    if ((row.checksum ?? null) !== document.checksum) {
      issues.push(issue("checksum_mismatch", articleId));
    }
    if ((row.projection_version ?? null) !== document.projection_version) {
      issues.push(issue("projection_version_mismatch", articleId));
    }
  }
  for (const articleId of byIdRows.keys()) {
    if (!byId.has(articleId)) issues.push(issue("extra_document", articleId));
  }
  return issues;
}

function verifyFts(
  byId: Map<string, SearchProjectionDocument>,
  articleIds: readonly string[],
): SearchProjectionVerificationIssue[] {
  const issues: SearchProjectionVerificationIssue[] = [];
  const seen = new Set<string>();
  for (const articleId of articleIds) {
    if (seen.has(articleId)) {
      issues.push(issue("duplicate_fts", articleId));
      continue;
    }
    seen.add(articleId);
  }
  for (const articleId of byId.keys()) {
    if (!seen.has(articleId)) issues.push(issue("missing_fts", articleId));
  }
  for (const articleId of seen) {
    if (!byId.has(articleId)) issues.push(issue("extra_fts", articleId));
  }
  return issues;
}

export function verifySearchProjection(input: SearchProjectionVerificationInput): SearchProjectionVerificationReport {
  const projected = indexProjected(input.projected);
  const issues: SearchProjectionVerificationIssue[] = [...projected.issues];
  if (input.documents) issues.push(...verifyDocuments(projected.byId, input.documents));
  if (input.ftsArticleIds) issues.push(...verifyFts(projected.byId, input.ftsArticleIds));
  const finalIssues = sortAndDedupe(issues);
  return {
    version: 1,
    ok: finalIssues.length === 0,
    projectedCount: input.projected.length,
    documentCount: input.documents?.length ?? 0,
    ftsCount: input.ftsArticleIds?.length ?? 0,
    hash: hashSearchProjectionDocuments(input.projected),
    issues: finalIssues,
  };
}
