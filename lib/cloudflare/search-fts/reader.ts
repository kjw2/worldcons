import type { D1RuntimeDatabase } from "@/lib/cloudflare/d1/runtime-binding";
import { ftsError } from "./errors";
import { buildSearchFtsQuery } from "./query";
import type { SearchFtsQueryInput, SearchFtsRankedRow, SearchFtsStatement } from "./types";

/**
 * Runtime reader for the local FTS5 lexical query.
 *
 * It accepts an injected `D1RuntimeDatabase` (or any structural equivalent) and
 * executes exactly `prepare(sql).bind(...values).all()`. The response is
 * validated fail-closed: a malformed envelope, a non-object row, a missing
 * `article_id` or a non-finite `relevance_score` is an error, never a silently
 * shorter result.
 *
 * This adapter is intentionally NOT selected by `lib/search/repository/index.ts`;
 * Supabase remains the sole search authority.
 */
export interface SearchFtsReaderRequest {
  readonly binding: D1RuntimeDatabase;
  readonly input: SearchFtsQueryInput;
}

export interface SearchFtsReadResult {
  readonly rows: SearchFtsRankedRow[];
  readonly statement: SearchFtsStatement;
}

function validateRankedRow(row: unknown): SearchFtsRankedRow {
  if (typeof row !== "object" || row === null || Array.isArray(row)) {
    throw ftsError("invalid_response", "D1 returned a non-object FTS row");
  }
  const record = row as Record<string, unknown>;
  const articleId = record.article_id;
  if (typeof articleId !== "string" || articleId.length === 0) {
    throw ftsError("invalid_response", "D1 FTS row is missing a string article_id");
  }
  const relevanceScore = record.relevance_score;
  if (typeof relevanceScore !== "number" || !Number.isFinite(relevanceScore)) {
    throw ftsError("invalid_response", "D1 FTS row is missing a finite relevance_score");
  }
  return { article_id: articleId, relevance_score: relevanceScore };
}

/** Runs one bounded FTS5 query and returns validated ranked rows. */
export async function runSearchFtsQuery(request: SearchFtsReaderRequest): Promise<SearchFtsRankedRow[]> {
  return (await readSearchFtsQuery(request)).rows;
}

/** Runs one bounded FTS5 query and returns the validated rows plus the statement. */
export async function readSearchFtsQuery(request: SearchFtsReaderRequest): Promise<SearchFtsReadResult> {
  const statement = buildSearchFtsQuery(request.input);
  const preparedStatement = request.binding.prepare(statement.sql);
  if (typeof preparedStatement?.bind !== "function") {
    throw ftsError("unavailable", "D1 binding did not provide prepare().bind().all()");
  }
  const prepared = preparedStatement.bind(...statement.params);
  if (typeof prepared?.all !== "function") {
    throw ftsError("unavailable", "D1 binding did not provide prepare().bind().all()");
  }
  const result = await prepared.all<Record<string, unknown>>();
  if (result === null || typeof result !== "object") {
    throw ftsError("invalid_response", "D1 returned a non-object result");
  }
  if (result.success === false) {
    throw ftsError("query_failed", result.error || "D1 FTS query failed");
  }
  const rows = result.results;
  if (!Array.isArray(rows)) {
    throw ftsError("invalid_response", "D1 result did not carry a row array");
  }
  return { rows: rows.map(validateRankedRow), statement };
}
