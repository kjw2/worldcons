import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import type { SummaryJson } from "@/lib/db/types";
import { normalizeTagSlug } from "@/lib/utils/slug";
import {
  classifyJudicialComplaint,
  CONSTITUTIONAL_COMPLAINT_TAG_NAME,
  ensureJudicialComplaintTags,
  JUDICIAL_COMPLAINT_TAG_DESCRIPTION,
  JUDICIAL_COMPLAINT_TAG_NAME,
  JUDICIAL_COMPLAINT_TAG_SLUG,
} from "@/lib/tags/judicial-complaint";

const APPLY = process.argv.includes("--apply");
const SOURCE_KEYS = ["de-bverfg", "es-tribunal-constitucional"] as const;
const PAGE_SIZE = 500;
const WRITE_BATCH_SIZE = 20;
const LINK_BATCH_SIZE = 500;

interface ArticleRow {
  id: string;
  slug: string;
  source_key: string;
  canonical_url?: string | null;
  cleaned_text?: string | null;
  source_metadata?: unknown;
  summary_json?: SummaryJson | null;
}

interface CandidateRow extends ArticleRow {
  nextSummary: SummaryJson;
  summaryChanged: boolean;
  reason: string;
}

function getSupabase() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");

  return createClient(url, key, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

async function fetchArticles(supabase: ReturnType<typeof getSupabase>) {
  const rows: ArticleRow[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from("articles")
      .select("id,slug,source_key,canonical_url,cleaned_text,source_metadata,summary_json")
      .in("source_key", [...SOURCE_KEYS])
      .eq("status", "summarized")
      .order("id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(error.message);

    rows.push(...((data ?? []) as ArticleRow[]));
    if (!data || data.length < PAGE_SIZE) break;
  }
  return rows;
}

function classifyCandidates(rows: ArticleRow[]) {
  return rows.flatMap((row): CandidateRow[] => {
    if (!row.summary_json) return [];
    const input = {
      sourceKey: row.source_key,
      canonicalUrl: row.canonical_url,
      cleanedText: row.cleaned_text,
      sourceMetadata: row.source_metadata,
    };
    const classification = classifyJudicialComplaint(input);
    if (!classification.matched || !classification.reason) return [];

    const nextSummary = ensureJudicialComplaintTags(row.summary_json, input);
    return [{
      ...row,
      nextSummary,
      summaryChanged: JSON.stringify(nextSummary) !== JSON.stringify(row.summary_json),
      reason: classification.reason,
    }];
  });
}

async function updateSummaries(supabase: ReturnType<typeof getSupabase>, candidates: CandidateRow[]) {
  const changed = candidates.filter((candidate) => candidate.summaryChanged);
  for (let start = 0; start < changed.length; start += WRITE_BATCH_SIZE) {
    const batch = changed.slice(start, start + WRITE_BATCH_SIZE);
    await Promise.all(batch.map(async (candidate) => {
      const { error } = await supabase
        .from("articles")
        .update({ summary_json: candidate.nextSummary })
        .eq("id", candidate.id);
      if (error) throw new Error(`${candidate.slug}: ${error.message}`);
    }));
  }
  return changed.length;
}

async function upsertCanonicalTags(supabase: ReturnType<typeof getSupabase>) {
  const constitutionalComplaintSlug = normalizeTagSlug(CONSTITUTIONAL_COMPLAINT_TAG_NAME);
  const { data: constitutionalComplaintTag, error: constitutionalComplaintError } = await supabase
    .from("tags")
    .upsert(
      {
        slug: constitutionalComplaintSlug,
        name: CONSTITUTIONAL_COMPLAINT_TAG_NAME,
        normalized_name: CONSTITUTIONAL_COMPLAINT_TAG_NAME,
        type: "topic",
      },
      { onConflict: "slug" },
    )
    .select("id")
    .single();
  if (constitutionalComplaintError) throw new Error(constitutionalComplaintError.message);

  const { data: judicialComplaintTag, error: judicialComplaintError } = await supabase
    .from("tags")
    .upsert(
      {
        slug: JUDICIAL_COMPLAINT_TAG_SLUG,
        name: JUDICIAL_COMPLAINT_TAG_NAME,
        normalized_name: JUDICIAL_COMPLAINT_TAG_NAME,
        type: "topic",
        description: JUDICIAL_COMPLAINT_TAG_DESCRIPTION,
      },
      { onConflict: "slug" },
    )
    .select("id")
    .single();
  if (judicialComplaintError) throw new Error(judicialComplaintError.message);

  const constitutionalComplaintTagId = String(constitutionalComplaintTag.id);
  const judicialComplaintTagId = String(judicialComplaintTag.id);
  return { constitutionalComplaintTagId, judicialComplaintTagId };
}

async function upsertArticleTagLinks(
  supabase: ReturnType<typeof getSupabase>,
  candidates: CandidateRow[],
  tagIds: { constitutionalComplaintTagId: string; judicialComplaintTagId: string },
) {
  const links = candidates.flatMap((candidate) => [
    { article_id: candidate.id, tag_id: tagIds.constitutionalComplaintTagId, confidence: 0.95 },
    { article_id: candidate.id, tag_id: tagIds.judicialComplaintTagId, confidence: 0.95 },
  ]);

  for (let start = 0; start < links.length; start += LINK_BATCH_SIZE) {
    const { error } = await supabase
      .from("article_tags")
      .upsert(links.slice(start, start + LINK_BATCH_SIZE), { onConflict: "article_id,tag_id" });
    if (error) throw new Error(error.message);
  }
  return links.length;
}

function countBySource(candidates: CandidateRow[]) {
  return Object.fromEntries(
    SOURCE_KEYS.map((sourceKey) => [sourceKey, candidates.filter((candidate) => candidate.source_key === sourceKey).length]),
  );
}

async function main() {
  const supabase = getSupabase();
  const rows = await fetchArticles(supabase);
  const candidates = classifyCandidates(rows);
  const summary = {
    mode: APPLY ? "apply" : "dry-run",
    checked: rows.length,
    candidates: candidates.length,
    candidatesBySource: countBySource(candidates),
    summaryChanges: candidates.filter((candidate) => candidate.summaryChanged).length,
  };

  if (!APPLY) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  const updatedSummaries = await updateSummaries(supabase, candidates);
  const tagIds = await upsertCanonicalTags(supabase);
  const upsertedLinks = await upsertArticleTagLinks(supabase, candidates, tagIds);
  const { error: refreshError } = await supabase.rpc("refresh_tag_counts");
  if (refreshError) throw new Error(`refresh_tag_counts RPC failed: ${refreshError.message}`);

  const { data: tag, error: tagError } = await supabase
    .from("tags")
    .select("slug,name,type,article_count,latest_article_at")
    .eq("slug", JUDICIAL_COMPLAINT_TAG_SLUG)
    .single();
  if (tagError) throw new Error(tagError.message);

  console.log(JSON.stringify({ ...summary, updatedSummaries, upsertedLinks, tag }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
