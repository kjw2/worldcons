import { getRuntimeD1Binding, type D1RuntimeDatabase } from "@/lib/cloudflare/d1/runtime-binding";
import { boundedInteger } from "@/lib/utils/numbers";

export const SOURCE_URL_CANDIDATE_STATUSES = ["pending", "retrying", "fetched", "failed", "ignored"] as const;
export type SourceUrlCandidateStatus = (typeof SOURCE_URL_CANDIDATE_STATUSES)[number];

export interface SourceUrlCandidateInput {
  sourceKey: string;
  url: string;
  candidateType: string;
  discoveredBy: string;
  status?: SourceUrlCandidateStatus;
  lastErrorCode?: string;
  lastErrorMessage?: string;
}

export interface SourceUrlCandidateRecord {
  id: string;
  sourceKey: string;
  url: string;
  candidateType: string;
  discoveredBy: string;
  status: SourceUrlCandidateStatus;
  lastAttemptAt?: string | null;
  attemptCount: number;
  lastErrorCode?: string | null;
  lastErrorMessage?: string | null;
  firstSeenAt?: string | null;
  lastSeenAt?: string | null;
}

export interface SourceUrlCandidateRetryClaim {
  candidateId: string;
  sourceKey: string;
  url: string;
  candidateType: string;
  status: SourceUrlCandidateStatus;
  attemptCount: number;
  shouldFetch: boolean;
}

export interface ListSourceUrlCandidatesInput {
  sourceKey?: string;
  status?: string;
  candidateType?: string;
  q?: string;
  page?: number | string | null;
  pageSize?: number | string | null;
}

export interface ListSourceUrlCandidatesResult {
  items: SourceUrlCandidateRecord[];
  pageInfo: {
    page: number;
    pageSize: number;
    total: number;
    totalIsExact: boolean;
  };
}

export interface SourceUrlCandidateHealthMetrics {
  openCandidateCount: number;
  retryableCandidateCount: number;
  exhaustedCandidateCount: number;
  oldestOpenCandidateAt: string | null;
}

interface SourceUrlCandidateRow extends Record<string, unknown> {
  id: string;
  source_key: string;
  url: string;
  candidate_type: string;
  discovered_by: string;
  status: string;
  last_attempt_at?: string | null;
  attempt_count?: number | null;
  last_error_code?: string | null;
  last_error_message?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

const CANDIDATE_COLUMNS = "id, source_key, url, candidate_type, discovered_by, status, last_attempt_at, attempt_count, last_error_code, last_error_message, created_at, updated_at";

function candidateD1() {
  return getRuntimeD1Binding("worldcons_ingest");
}

function requireCandidateD1(): D1RuntimeDatabase {
  const binding = candidateD1();
  if (!binding) throw new Error("candidate_store_unavailable");
  return binding;
}

async function rows<T extends Record<string, unknown>>(binding: D1RuntimeDatabase, sql: string, values: unknown[] = []) {
  const statement = binding.prepare(sql).bind(...values);
  if (!statement.all) throw new Error("candidate_store_read_unavailable");
  const result = await statement.all<T>();
  if (!result || result.success === false || result.error || !Array.isArray(result.results)) {
    throw new Error(result?.error || "candidate_store_read_failed");
  }
  return result.results;
}

function isSourceUrlCandidateStatus(value?: string | null): value is SourceUrlCandidateStatus {
  return SOURCE_URL_CANDIDATE_STATUSES.includes(value as SourceUrlCandidateStatus);
}

export function parseSourceUrlCandidateStatus(value?: string | null) {
  return isSourceUrlCandidateStatus(value) ? value : null;
}

function normalizeCandidateRow(row: SourceUrlCandidateRow): SourceUrlCandidateRecord {
  return {
    id: row.id,
    sourceKey: row.source_key,
    url: row.url,
    candidateType: row.candidate_type,
    discoveredBy: row.discovered_by,
    status: isSourceUrlCandidateStatus(row.status) ? row.status : "pending",
    lastAttemptAt: row.last_attempt_at,
    attemptCount: Number(row.attempt_count ?? 0),
    lastErrorCode: row.last_error_code,
    lastErrorMessage: row.last_error_message,
    firstSeenAt: row.created_at,
    lastSeenAt: row.updated_at,
  };
}

function trimmed(value?: string | null) {
  const next = value?.trim();
  return next || undefined;
}

function firstNumber(value: unknown, fallback = 0) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : fallback;
}

export async function beginSourceUrlCandidateRetry(candidateId: string): Promise<SourceUrlCandidateRetryClaim> {
  const binding = requireCandidateD1();
  const now = new Date().toISOString();
  const updated = await rows<SourceUrlCandidateRow>(
    binding,
    `UPDATE source_url_candidates SET status = 'retrying', last_attempt_at = ?, attempt_count = attempt_count + 1, updated_at = ? WHERE id = ? AND status NOT IN ('fetched', 'ignored') RETURNING ${CANDIDATE_COLUMNS}`,
    [now, now, candidateId],
  );
  const row = updated[0] ?? (await rows<SourceUrlCandidateRow>(binding, `SELECT ${CANDIDATE_COLUMNS} FROM source_url_candidates WHERE id = ? LIMIT 1`, [candidateId]))[0];
  if (!row) throw new Error("candidate_not_found");
  const normalized = normalizeCandidateRow(row);
  return {
    candidateId: normalized.id,
    sourceKey: normalized.sourceKey,
    url: normalized.url,
    candidateType: normalized.candidateType,
    status: normalized.status,
    attemptCount: normalized.attemptCount,
    shouldFetch: updated.length === 1,
  };
}

export async function finishSourceUrlCandidateRetry(input: {
  candidateId: string;
  attemptCount: number;
  status: Extract<SourceUrlCandidateStatus, "fetched" | "failed">;
  errorCode?: string;
  errorMessage?: string;
}) {
  const binding = requireCandidateD1();
  if (input.status !== "fetched" && input.status !== "failed") throw new Error("candidate_status_invalid");
  const errorCode = input.status === "fetched" ? null : trimmed(input.errorCode)?.slice(0, 160) ?? null;
  const errorMessage = input.status === "fetched" ? null : trimmed(input.errorMessage)?.slice(0, 500) ?? null;
  const updated = await rows<{ id: string; status: string; attempt_count: number }>(
    binding,
    "UPDATE source_url_candidates SET status = ?, last_error_code = ?, last_error_message = ?, updated_at = ? WHERE id = ? AND attempt_count = ? AND status = 'retrying' RETURNING id, status, attempt_count",
    [input.status, errorCode, errorMessage, new Date().toISOString(), input.candidateId, input.attemptCount],
  );
  if (updated[0]) {
    return { candidateId: updated[0].id, status: updated[0].status as SourceUrlCandidateStatus, attemptCount: Number(updated[0].attempt_count ?? 0) };
  }
  const existing = (await rows<{ id: string; status: string; attempt_count: number }>(
    binding,
    "SELECT id, status, attempt_count FROM source_url_candidates WHERE id = ? LIMIT 1",
    [input.candidateId],
  ))[0];
  if (!existing) throw new Error("candidate_not_found");
  if (Number(existing.attempt_count) !== input.attemptCount) throw new Error("candidate_stale_attempt");
  if (existing.status === input.status) {
    return { candidateId: existing.id, status: existing.status as SourceUrlCandidateStatus, attemptCount: Number(existing.attempt_count) };
  }
  throw new Error("candidate_state_conflict");
}

export async function upsertSourceUrlCandidates(candidates: SourceUrlCandidateInput[]) {
  if (candidates.length === 0) return { inserted: 0, skipped: 0 };
  const binding = requireCandidateD1();
  const now = new Date().toISOString();
  try {
    for (const candidate of candidates) {
      await rows<{ id: string }>(
        binding,
        [
          "INSERT INTO source_url_candidates",
          "(id, source_key, url, candidate_type, discovered_by, status, last_attempt_at, attempt_count, last_error_code, last_error_message, created_at, updated_at)",
          "VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)",
          "ON CONFLICT(source_key, url) DO UPDATE SET",
          "candidate_type = excluded.candidate_type, discovered_by = excluded.discovered_by, status = excluded.status,",
          "last_attempt_at = excluded.last_attempt_at, attempt_count = source_url_candidates.attempt_count + 1,",
          "last_error_code = excluded.last_error_code, last_error_message = excluded.last_error_message, updated_at = excluded.updated_at",
          "RETURNING id",
        ].join(" "),
        [crypto.randomUUID(), candidate.sourceKey, candidate.url, candidate.candidateType, candidate.discoveredBy, candidate.status ?? "pending", now, candidate.lastErrorCode ?? null, candidate.lastErrorMessage ?? null, now, now],
      );
    }
    return { inserted: candidates.length, skipped: 0 };
  } catch (error) {
    return { inserted: 0, skipped: candidates.length, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function findSourceUrlCandidatesByUrls(sourceKey: string, urls: string[]) {
  const uniqueUrls = [...new Set(urls.map((url) => url.trim()).filter(Boolean))];
  if (uniqueUrls.length === 0) return [];
  const binding = requireCandidateD1();
  const placeholders = uniqueUrls.map(() => "?").join(", ");
  const result = await rows<SourceUrlCandidateRow>(binding, `SELECT ${CANDIDATE_COLUMNS} FROM source_url_candidates WHERE source_key = ? AND url IN (${placeholders})`, [sourceKey, ...uniqueUrls]);
  return result.map(normalizeCandidateRow);
}

export async function countOpenSourceUrlCandidates(sourceKey?: string) {
  const binding = requireCandidateD1();
  const where = sourceKey ? " AND source_key = ?" : "";
  const result = await rows<{ count: number | string }>(binding, `SELECT COUNT(*) AS count FROM source_url_candidates WHERE status IN ('pending', 'retrying')${where}`, sourceKey ? [sourceKey] : []);
  return firstNumber(result[0]?.count);
}

export async function getSourceUrlCandidateHealthMetrics(): Promise<SourceUrlCandidateHealthMetrics | null> {
  const binding = candidateD1();
  if (!binding) return null;
  const [row] = await rows<Record<string, unknown>>(
    binding,
    [
      "SELECT",
      "SUM(CASE WHEN status IN ('pending','retrying') THEN 1 ELSE 0 END) AS open_count,",
      "SUM(CASE WHEN status = 'retrying' THEN 1 ELSE 0 END) AS retryable_count,",
      "SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS exhausted_count,",
      "MIN(CASE WHEN status IN ('pending','retrying') THEN created_at ELSE NULL END) AS oldest_open_at",
      "FROM source_url_candidates",
    ].join(" "),
  );
  return {
    openCandidateCount: firstNumber(row?.open_count),
    retryableCandidateCount: firstNumber(row?.retryable_count),
    exhaustedCandidateCount: firstNumber(row?.exhausted_count),
    oldestOpenCandidateAt: typeof row?.oldest_open_at === "string" ? row.oldest_open_at : null,
  };
}

export async function listSourceUrlCandidatesForRetry(sourceKey: string, limit = 100) {
  const binding = requireCandidateD1();
  const boundedLimit = boundedInteger(limit, 100, { min: 1, max: 500 });
  const result = await rows<SourceUrlCandidateRow>(
    binding,
    `SELECT ${CANDIDATE_COLUMNS} FROM source_url_candidates WHERE source_key = ? AND status = 'retrying' ORDER BY CASE WHEN last_attempt_at IS NULL THEN 0 ELSE 1 END, last_attempt_at ASC LIMIT ?`,
    [sourceKey, boundedLimit],
  );
  return result.map(normalizeCandidateRow);
}

export async function markSourceUrlCandidatesFetched(sourceKey: string, urls: string[]) {
  const uniqueUrls = [...new Set(urls.map((url) => url.trim()).filter(Boolean))];
  if (uniqueUrls.length === 0) return { updated: 0 };
  const binding = requireCandidateD1();
  const placeholders = uniqueUrls.map(() => "?").join(", ");
  try {
    const result = await rows<{ id: string }>(
      binding,
      `UPDATE source_url_candidates SET status = 'fetched', last_attempt_at = ?, last_error_code = NULL, last_error_message = NULL, updated_at = ? WHERE source_key = ? AND url IN (${placeholders}) AND status != 'fetched' RETURNING id`,
      [new Date().toISOString(), new Date().toISOString(), sourceKey, ...uniqueUrls],
    );
    return { updated: result.length };
  } catch (error) {
    return { updated: 0, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function listSourceUrlCandidates(input: ListSourceUrlCandidatesInput = {}): Promise<ListSourceUrlCandidatesResult> {
  const binding = requireCandidateD1();
  const page = boundedInteger(input.page, 1, { min: 1, max: 10_000 });
  const pageSize = boundedInteger(input.pageSize, 50, { min: 1, max: 100 });
  const sourceKey = trimmed(input.sourceKey);
  const candidateType = trimmed(input.candidateType);
  const status = parseSourceUrlCandidateStatus(trimmed(input.status));
  const q = trimmed(input.q)?.toLowerCase();
  const predicates: string[] = [];
  const values: unknown[] = [];
  if (sourceKey) { predicates.push("source_key = ?"); values.push(sourceKey); }
  if (status) { predicates.push("status = ?"); values.push(status); }
  if (candidateType) { predicates.push("candidate_type = ?"); values.push(candidateType); }
  if (q) {
    const columns = ["source_key", "candidate_type", "status", "discovered_by", "last_error_code", "last_error_message", "url"];
    predicates.push(`(${columns.map((column) => `instr(lower(coalesce(${column}, '')), ?) > 0`).join(" OR ")})`);
    values.push(...columns.map(() => q));
  }
  const where = predicates.length ? ` WHERE ${predicates.join(" AND ")}` : "";
  const [countRow] = await rows<{ count: number | string }>(binding, `SELECT COUNT(*) AS count FROM source_url_candidates${where}`, values);
  const total = firstNumber(countRow?.count);
  const start = (page - 1) * pageSize;
  const result = await rows<SourceUrlCandidateRow>(binding, `SELECT ${CANDIDATE_COLUMNS} FROM source_url_candidates${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`, [...values, pageSize, start]);
  return { items: result.map(normalizeCandidateRow), pageInfo: { page, pageSize, total, totalIsExact: true } };
}

export async function updateSourceUrlCandidateStatus(id: string, status: SourceUrlCandidateStatus) {
  const binding = candidateD1();
  if (!binding) return { ok: false, error: "Source URL candidate D1 binding is not configured." };
  try {
    const now = new Date().toISOString();
    const result = await rows<SourceUrlCandidateRow>(
      binding,
      `UPDATE source_url_candidates SET status = ?, last_attempt_at = CASE WHEN ? = 'retrying' THEN ? ELSE last_attempt_at END, updated_at = ? WHERE id = ? RETURNING ${CANDIDATE_COLUMNS}`,
      [status, status, now, now, id],
    );
    const row = result[0];
    return row ? { ok: true, item: normalizeCandidateRow(row) } : { ok: false, error: "Candidate not found." };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
