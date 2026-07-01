import { getSupabaseAdmin } from "@/lib/db/client";

export interface SourceUrlCandidateInput {
  sourceKey: string;
  url: string;
  candidateType: string;
  discoveredBy: string;
  status?: "pending" | "retrying" | "fetched" | "failed" | "ignored";
  lastErrorCode?: string;
  lastErrorMessage?: string;
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
