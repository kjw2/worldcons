import { getSupabaseAdmin, getSupabaseServiceRoleAdmin } from "@/lib/db/client";
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

interface SourceUrlCandidateRow {
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

function firstRpcRow(value: unknown) {
  const row = Array.isArray(value) ? value[0] : value;
  return typeof row === "object" && row !== null ? row as Record<string, unknown> : null;
}

export async function beginSourceUrlCandidateRetry(candidateId: string): Promise<SourceUrlCandidateRetryClaim> {
  const supabase = getSupabaseServiceRoleAdmin();
  if (!supabase) throw new Error("candidate_store_unavailable");
  const { data, error } = await supabase.rpc("admin_begin_source_url_candidate_retry_p1", { p_candidate_id: candidateId });
  if (error) throw new Error(error.message);
  const row = firstRpcRow(data);
  if (!row) throw new Error("candidate_not_found");
  const status = parseSourceUrlCandidateStatus(typeof row.candidate_status === "string" ? row.candidate_status : null);
  if (!status) throw new Error("candidate_status_invalid");
  return {
    candidateId: String(row.candidate_id ?? ""),
    sourceKey: String(row.source_key ?? ""),
    url: String(row.candidate_url ?? ""),
    candidateType: String(row.candidate_type ?? ""),
    status,
    attemptCount: Number(row.attempt_count ?? 0),
    shouldFetch: row.should_fetch === true,
  };
}

export async function finishSourceUrlCandidateRetry(input: {
  candidateId: string;
  attemptCount: number;
  status: Extract<SourceUrlCandidateStatus, "fetched" | "failed">;
  errorCode?: string;
  errorMessage?: string;
}) {
  const supabase = getSupabaseServiceRoleAdmin();
  if (!supabase) throw new Error("candidate_store_unavailable");
  const { data, error } = await supabase.rpc("admin_finish_source_url_candidate_retry_p1", {
    p_candidate_id: input.candidateId,
    p_attempt_count: input.attemptCount,
    p_status: input.status,
    p_error_code: input.errorCode?.slice(0, 160) ?? null,
    p_error_message: input.errorMessage?.slice(0, 500) ?? null,
  });
  if (error) throw new Error(error.message);
  const row = firstRpcRow(data);
  if (!row) throw new Error("candidate_transition_failed");
  return {
    candidateId: String(row.candidate_id ?? ""),
    status: String(row.candidate_status ?? "") as SourceUrlCandidateStatus,
    attemptCount: Number(row.attempt_count ?? 0),
  };
}

function trimmed(value?: string | null) {
  const next = value?.trim();
  return next || undefined;
}

function matchesCandidateSearch(row: SourceUrlCandidateRecord, query: string) {
  const needle = query.toLowerCase();
  return [row.sourceKey, row.candidateType, row.status, row.discoveredBy, row.lastErrorCode, row.lastErrorMessage, row.url]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes(needle));
}

export async function upsertSourceUrlCandidates(candidates: SourceUrlCandidateInput[]) {
  const supabase = getSupabaseAdmin();
  if (!supabase || candidates.length === 0) return { inserted: 0, skipped: candidates.length };

  const existingCounts = new Map<string, number>();
  await Promise.all(
    candidates.map(async (candidate) => {
      const { data } = await supabase
        .from("source_url_candidates")
        .select("attempt_count")
        .eq("source_key", candidate.sourceKey)
        .eq("url", candidate.url)
        .maybeSingle();
      const count = Number(data?.attempt_count ?? 0);
      existingCounts.set(`${candidate.sourceKey}\n${candidate.url}`, Number.isFinite(count) && count > 0 ? Math.floor(count) : 0);
    }),
  );

  const rows = candidates.map((candidate) => ({
    source_key: candidate.sourceKey,
    url: candidate.url,
    candidate_type: candidate.candidateType,
    discovered_by: candidate.discoveredBy,
    status: candidate.status ?? "pending",
    last_error_code: candidate.lastErrorCode,
    last_error_message: candidate.lastErrorMessage,
    last_attempt_at: new Date().toISOString(),
    attempt_count: (existingCounts.get(`${candidate.sourceKey}\n${candidate.url}`) ?? 0) + 1,
  }));

  const { error } = await supabase.from("source_url_candidates").upsert(rows, { onConflict: "source_key,url" });
  if (error) {
    return { inserted: 0, skipped: candidates.length, error: error.message };
  }

  return { inserted: rows.length, skipped: 0 };
}

export async function findSourceUrlCandidatesByUrls(sourceKey: string, urls: string[]) {
  const supabase = getSupabaseAdmin();
  const uniqueUrls = [...new Set(urls.map((url) => url.trim()).filter(Boolean))];
  if (!supabase || uniqueUrls.length === 0) return [];

  const { data, error } = await supabase
    .from("source_url_candidates")
    .select("id, source_key, url, candidate_type, discovered_by, status, last_attempt_at, attempt_count, last_error_code, last_error_message, created_at, updated_at")
    .eq("source_key", sourceKey)
    .in("url", uniqueUrls);
  if (error) throw new Error(error.message);
  return ((data ?? []) as SourceUrlCandidateRow[]).map(normalizeCandidateRow);
}

export async function markSourceUrlCandidatesFetched(sourceKey: string, urls: string[]) {
  const supabase = getSupabaseAdmin();
  const uniqueUrls = [...new Set(urls.map((url) => url.trim()).filter(Boolean))];
  if (!supabase || uniqueUrls.length === 0) return { updated: 0 };

  const { data, error } = await supabase
    .from("source_url_candidates")
    .update({
      status: "fetched",
      last_attempt_at: new Date().toISOString(),
      last_error_code: null,
      last_error_message: null,
    })
    .eq("source_key", sourceKey)
    .in("url", uniqueUrls)
    .neq("status", "fetched")
    .select("id");
  if (error) return { updated: 0, error: error.message };
  return { updated: data?.length ?? 0 };
}

export async function listSourceUrlCandidates(input: ListSourceUrlCandidatesInput = {}): Promise<ListSourceUrlCandidatesResult> {
  const supabase = getSupabaseAdmin();
  const page = boundedInteger(input.page, 1, { min: 1, max: 10_000 });
  const pageSize = boundedInteger(input.pageSize, 50, { min: 1, max: 100 });
  const sourceKey = trimmed(input.sourceKey);
  const candidateType = trimmed(input.candidateType);
  const status = parseSourceUrlCandidateStatus(trimmed(input.status));
  const q = trimmed(input.q);

  if (!supabase) {
    return { items: [], pageInfo: { page, pageSize, total: 0, totalIsExact: true } };
  }

  const selectColumns =
    "id, source_key, url, candidate_type, discovered_by, status, last_attempt_at, attempt_count, last_error_code, last_error_message, created_at, updated_at";

  if (q) {
    let query = supabase.from("source_url_candidates").select(selectColumns);
    if (sourceKey) query = query.eq("source_key", sourceKey);
    if (status) query = query.eq("status", status);
    if (candidateType) query = query.eq("candidate_type", candidateType);

    const { data, error } = await query.order("updated_at", { ascending: false }).limit(5000);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as SourceUrlCandidateRow[];
    const filtered = rows.map(normalizeCandidateRow).filter((row) => matchesCandidateSearch(row, q));
    const start = (page - 1) * pageSize;
    return {
      items: filtered.slice(start, start + pageSize),
      pageInfo: { page, pageSize, total: filtered.length, totalIsExact: rows.length < 5000 },
    };
  }

  const start = (page - 1) * pageSize;
  let query = supabase.from("source_url_candidates").select(selectColumns, { count: "exact" });
  if (sourceKey) query = query.eq("source_key", sourceKey);
  if (status) query = query.eq("status", status);
  if (candidateType) query = query.eq("candidate_type", candidateType);

  const { data, count, error } = await query.order("updated_at", { ascending: false }).range(start, start + pageSize - 1);
  if (error) throw new Error(error.message);

  return {
    items: ((data ?? []) as SourceUrlCandidateRow[]).map(normalizeCandidateRow),
    pageInfo: { page, pageSize, total: count ?? 0, totalIsExact: true },
  };
}

export async function updateSourceUrlCandidateStatus(id: string, status: SourceUrlCandidateStatus) {
  const supabase = getSupabaseAdmin();
  if (!supabase) return { ok: false, error: "Source URL candidate store is not configured." };
  const updates: { status: SourceUrlCandidateStatus; last_attempt_at?: string } = { status };
  if (status === "retrying") updates.last_attempt_at = new Date().toISOString();

  const { data, error } = await supabase
    .from("source_url_candidates")
    .update(updates)
    .eq("id", id)
    .select("id, source_key, url, candidate_type, discovered_by, status, last_attempt_at, attempt_count, last_error_code, last_error_message, created_at, updated_at")
    .maybeSingle();

  if (error) return { ok: false, error: error.message };
  if (!data) return { ok: false, error: "Candidate not found." };
  return { ok: true, item: normalizeCandidateRow(data as SourceUrlCandidateRow) };
}
