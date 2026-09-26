import {
  planSearchProjectionIncrementalSync,
  type SearchProjectionDocument,
  type SearchProjectionDocumentRow,
  type SearchProjectionFtsDocument,
} from "@/lib/cloudflare/search-projection";
import { buildSearchCanaryWritePlan } from "./writer";
import type { SearchCanaryWritePlan } from "./types";

/**
 * M7.6 append-only canary projection expansion (runtime-neutral).
 *
 * The isolated canary may already hold a verified subset of the desired bounded
 * projection (for example 15 of 100 rows). Expanding it must never delete,
 * rebuild or truncate: this module compares the materialized canary rows against
 * the desired projection and, when every overlapping row already matches,
 * produces a parameterized plan that INSERTs only the ids missing from BOTH
 * `search_documents` and `search_fts`.
 *
 * Any current row that is not in the desired projection (remote-only), any
 * overlapping checksum/projection-version mismatch, any duplicate identity, or
 * any `search_documents`/`search_fts` identity divergence fails closed: the
 * returned assessment is `ok: false`, `missingDocumentIds` is empty and the plan
 * carries no statements. The caller must refuse the run rather than attempt a
 * destructive repair.
 *
 * This module imports no Node builtin and performs no remote call. It never
 * emits document text or bound parameter values: the executable plan keeps the
 * values out of band exactly like `writer.ts`, and issues carry only the affected
 * `article_id` (an identifier, never content).
 */

export type SearchCanaryExpansionIssueCode =
  | "remote_only_document"
  | "remote_only_fts"
  | "duplicate_document"
  | "duplicate_fts"
  | "checksum_mismatch"
  | "projection_version_mismatch"
  | "fts_identity_mismatch";

export interface SearchCanaryExpansionIssue {
  code: SearchCanaryExpansionIssueCode;
  articleId: string | null;
}

export interface SearchCanaryProjectionExtensionInput {
  /** The desired bounded projection (authoritative, deterministic). */
  documents: readonly SearchProjectionDocument[];
  ftsDocuments: readonly SearchProjectionFtsDocument[];
  /** Materialized `search_documents` rows read back from the isolated canary. */
  currentDocuments: readonly SearchProjectionDocumentRow[];
  /** Materialized `search_fts.article_id` values read back from the canary. */
  currentFtsArticleIds: readonly string[];
}

export interface SearchCanaryProjectionExtensionPlan {
  version: 1;
  destructive: false;
  /** True only when the current canary is an append-only subset of desired. */
  ok: boolean;
  /** True when the current canary already equals the desired projection. */
  noop: boolean;
  desiredDocumentCount: number;
  currentDocumentCount: number;
  currentFtsCount: number;
  /** Desired ids missing from BOTH `search_documents` and `search_fts`. */
  missingDocumentIds: string[];
  /** Number of `search_documents` rows the plan inserts (0 for no-op/refusal). */
  insertedDocuments: number;
  issues: SearchCanaryExpansionIssue[];
  /** Executable parameterized insert-only plan; empty when no-op or refused. */
  plan: SearchCanaryWritePlan;
}

function emptyPlan(): SearchCanaryWritePlan {
  return buildSearchCanaryWritePlan([]);
}

function sortDedupeIssues(issues: readonly SearchCanaryExpansionIssue[]): SearchCanaryExpansionIssue[] {
  const seen = new Set<string>();
  const unique: SearchCanaryExpansionIssue[] = [];
  for (const entry of issues) {
    const key = `${entry.code}\u0000${entry.articleId ?? ""}`;
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

/** Deterministic, content-free issue accounting for operator error messages. */
export function summarizeSearchCanaryExpansionIssues(issues: readonly SearchCanaryExpansionIssue[]): string {
  const counts = new Map<SearchCanaryExpansionIssueCode, number>();
  for (const issue of issues) counts.set(issue.code, (counts.get(issue.code) ?? 0) + 1);
  return [...counts.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([code, count]) => `${code}=${count}`)
    .join(", ");
}

/**
 * Assesses whether the materialized canary is an append-only subset of the
 * desired bounded projection and plans the missing inserts. Fails closed on any
 * remote-only id, overlap mismatch, duplicate identity or FTS divergence.
 */
export function planSearchCanaryProjectionExtension(
  input: SearchCanaryProjectionExtensionInput,
): SearchCanaryProjectionExtensionPlan {
  const desiredById = new Map<string, SearchProjectionDocument>();
  for (const document of input.documents) {
    if (!desiredById.has(document.article_id)) desiredById.set(document.article_id, document);
  }

  const issues: SearchCanaryExpansionIssue[] = [];
  const currentById = new Map<string, SearchProjectionDocumentRow>();
  for (const row of input.currentDocuments) {
    if (currentById.has(row.article_id)) {
      issues.push({ code: "duplicate_document", articleId: row.article_id });
      continue;
    }
    currentById.set(row.article_id, row);
  }

  const currentFtsIds = new Set<string>();
  for (const articleId of input.currentFtsArticleIds) {
    if (currentFtsIds.has(articleId)) {
      issues.push({ code: "duplicate_fts", articleId });
      continue;
    }
    currentFtsIds.add(articleId);
  }

  for (const [articleId, row] of currentById) {
    const desired = desiredById.get(articleId);
    if (!desired) {
      issues.push({ code: "remote_only_document", articleId });
      continue;
    }
    if ((row.checksum ?? null) !== desired.checksum) {
      issues.push({ code: "checksum_mismatch", articleId });
    }
    if ((row.projection_version ?? null) !== desired.projection_version) {
      issues.push({ code: "projection_version_mismatch", articleId });
    }
  }
  for (const articleId of currentFtsIds) {
    if (!desiredById.has(articleId)) issues.push({ code: "remote_only_fts", articleId });
  }
  for (const articleId of currentById.keys()) {
    if (!currentFtsIds.has(articleId)) issues.push({ code: "fts_identity_mismatch", articleId });
  }
  for (const articleId of currentFtsIds) {
    if (!currentById.has(articleId)) issues.push({ code: "fts_identity_mismatch", articleId });
  }
  const finalIssues = sortDedupeIssues(issues);

  if (finalIssues.length > 0) {
    return {
      version: 1,
      destructive: false,
      ok: false,
      noop: false,
      desiredDocumentCount: desiredById.size,
      currentDocumentCount: currentById.size,
      currentFtsCount: currentFtsIds.size,
      missingDocumentIds: [],
      insertedDocuments: 0,
      issues: finalIssues,
      plan: emptyPlan(),
    };
  }

  const missingDocumentIds = [...desiredById.keys()]
    .filter((articleId) => !currentById.has(articleId) && !currentFtsIds.has(articleId))
    .sort();

  if (missingDocumentIds.length === 0) {
    return {
      version: 1,
      destructive: false,
      ok: true,
      noop: true,
      desiredDocumentCount: desiredById.size,
      currentDocumentCount: currentById.size,
      currentFtsCount: currentFtsIds.size,
      missingDocumentIds: [],
      insertedDocuments: 0,
      issues: [],
      plan: emptyPlan(),
    };
  }

  const missingIds = new Set(missingDocumentIds);
  const missingDocuments = input.documents.filter((document) => missingIds.has(document.article_id));
  const missingFtsDocuments = input.ftsDocuments.filter((ftsDocument) => missingIds.has(ftsDocument.article_id));
  // Current is empty, so the incremental emitter can only produce INSERTs for
  // the missing subset; `buildSearchCanaryWritePlan` re-asserts insert-only.
  const insertOnly = planSearchProjectionIncrementalSync([], missingDocuments, missingFtsDocuments);
  if (insertOnly.destructive) {
    throw new Error("canary expansion unexpectedly planned a destructive statement");
  }
  const plan = buildSearchCanaryWritePlan(insertOnly.statements);

  return {
    version: 1,
    destructive: false,
    ok: true,
    noop: false,
    desiredDocumentCount: desiredById.size,
    currentDocumentCount: currentById.size,
    currentFtsCount: currentFtsIds.size,
    missingDocumentIds,
    insertedDocuments: missingDocuments.length,
    issues: [],
    plan,
  };
}
