import type { D1RuntimeDatabase } from "@/lib/cloudflare/d1/runtime-binding";
import { rankedError } from "./errors";
import { assembleRankedSearchPage } from "./page";
import { buildRankedSearchQueryPlan } from "./queries";
import {
  type RankedSearchPageInput,
  type RankedSearchPagePayload,
  type RankedSearchPageRow,
  type RankedSearchQueryPlan,
  type RankedSearchStatement,
} from "./types";
import { resolveRankedSearchInput } from "./validate";

/**
 * Runtime reader for the local ranked-search page.
 *
 * It accepts an injected `D1RuntimeDatabase` (or any structural equivalent) and
 * executes exactly `prepare(sql).bind(...values).all()` for the page query and,
 * only when `count = exact`, a separate parameterized COUNT. Malformed envelopes,
 * non-object rows, a missing string `article_id`, a non-finite fulltext `score`
 * or an invalid COUNT fail closed with a stable code.
 *
 * This adapter is intentionally NOT selected by `lib/search/repository/index.ts`;
 * Supabase remains the sole search authority.
 */
export interface RankedSearchReaderRequest {
  readonly binding: D1RuntimeDatabase;
  readonly input: RankedSearchPageInput;
}

export interface RankedSearchReadResult {
  readonly page: RankedSearchPagePayload;
  readonly plan: RankedSearchQueryPlan;
}

async function executeStatement(
  binding: D1RuntimeDatabase,
  statement: RankedSearchStatement,
): Promise<Record<string, unknown>[]> {
  const prepared = binding.prepare(statement.sql);
  if (typeof prepared?.bind !== "function") {
    throw rankedError("unavailable", "D1 binding did not provide prepare().bind().all()");
  }
  const bound = prepared.bind(...statement.params);
  if (typeof bound?.all !== "function") {
    throw rankedError("unavailable", "D1 binding did not provide prepare().bind().all()");
  }
  const result = await bound.all<Record<string, unknown>>();
  if (result === null || typeof result !== "object") {
    throw rankedError("invalid_response", "D1 returned a non-object result");
  }
  if (result.success === false) {
    throw rankedError("query_failed", result.error || "D1 ranked-search query failed");
  }
  const rows = result.results;
  if (!Array.isArray(rows)) {
    throw rankedError("invalid_response", "D1 result did not carry a row array");
  }
  return rows;
}

function validatePageRow(row: unknown, requireScore: boolean): RankedSearchPageRow {
  if (typeof row !== "object" || row === null || Array.isArray(row)) {
    throw rankedError("invalid_response", "D1 returned a non-object ranked row");
  }
  const record = row as Record<string, unknown>;
  const id = record.article_id;
  if (typeof id !== "string" || id.length === 0) {
    throw rankedError("invalid_response", "D1 ranked row is missing a string article_id");
  }
  if (!requireScore) return { id };
  const score = record.score;
  if (typeof score !== "number" || !Number.isFinite(score)) {
    throw rankedError("invalid_response", "D1 fulltext row is missing a finite score");
  }
  return { id, score };
}

function validateCountRow(rows: readonly Record<string, unknown>[]): number {
  if (rows.length !== 1) {
    throw rankedError("invalid_response", "D1 COUNT did not return exactly one row");
  }
  const total = rows[0]?.total;
  if (typeof total !== "number" || !Number.isInteger(total) || total < 0) {
    throw rankedError("invalid_response", "D1 COUNT did not return a non-negative integer");
  }
  return total;
}

/** Runs one ranked-search page and returns the payload plus the resolved plan. */
export async function readRankedSearchPage(request: RankedSearchReaderRequest): Promise<RankedSearchReadResult> {
  const resolved = resolveRankedSearchInput(request.input);
  const plan = buildRankedSearchQueryPlan(resolved);

  if (plan.sourceConflict) {
    return {
      plan,
      page: {
        entries: [],
        retrievalMode: "exact-case",
        total: 0,
        hasMore: false,
        totalIsExact: resolved.count === "exact",
      },
    };
  }

  if (plan.page === null) {
    throw rankedError("invalid_response", "ranked query plan produced no page statement");
  }

  const rawPageRows = await executeStatement(request.binding, plan.page);
  const rows = rawPageRows.map((row) => validatePageRow(row, plan.retrievalMode === "fulltext"));

  let exactTotal: number | null = null;
  if (resolved.count === "exact") {
    if (plan.count === null) {
      throw rankedError("invalid_response", "ranked query plan produced no COUNT statement");
    }
    exactTotal = validateCountRow(await executeStatement(request.binding, plan.count));
  }

  return {
    plan,
    page: assembleRankedSearchPage({
      retrievalMode: plan.retrievalMode,
      rows,
      limit: resolved.limit,
      offset: resolved.offset,
      exactTotal,
    }),
  };
}

/** Runs one ranked-search page and returns only the validated payload. */
export async function runRankedSearchPage(request: RankedSearchReaderRequest): Promise<RankedSearchPagePayload> {
  return (await readRankedSearchPage(request)).page;
}
