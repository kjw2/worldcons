import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import type { SummaryJson } from "@/lib/db/types";
import {
  canonicalizeTerminologyText,
  canonicalizeTerminologyValue,
  terminologyRuleForSource,
} from "@/lib/ai/terminology";
import { normalizeTagSlug } from "@/lib/utils/slug";

const sourceArg = process.argv.find((arg) => arg.startsWith("--source="))?.slice("--source=".length);
const SOURCE_KEY = sourceArg || "fr-conseil-constitutionnel";
const RULE = terminologyRuleForSource(SOURCE_KEY);
if (!RULE) {
  throw new Error(`No terminology rule configured for source: ${SOURCE_KEY}`);
}

const CANONICAL_TAG_NAME = RULE.canonical;
const CANONICAL_TAG_SLUG = normalizeTagSlug(CANONICAL_TAG_NAME);
const APPLY = process.argv.includes("--apply");

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

async function fetchSourceArticles(supabase: ReturnType<typeof getSupabase>) {
  const rows: Array<{ id: string; korean_title?: string | null; summary_json?: SummaryJson | null }> = [];
  const pageSize = 1_000;

  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from("articles")
      .select("id,korean_title,summary_json")
      .eq("source_key", SOURCE_KEY)
      .order("id", { ascending: true })
      .range(from, from + pageSize - 1);

    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as Array<{ id: string; korean_title?: string | null; summary_json?: SummaryJson | null }>));
    if (!data || data.length < pageSize) break;
  }

  return rows;
}

async function canonicalizeArticles() {
  const supabase = getSupabase();
  const rows = await fetchSourceArticles(supabase);

  let checked = 0;
  let changed = 0;

  for (const row of rows) {
    checked += 1;
    const nextTitle = canonicalizeTerminologyText(row.korean_title, SOURCE_KEY);
    const nextSummary = canonicalizeTerminologyValue(row.summary_json as SummaryJson | null, SOURCE_KEY);
    const titleChanged = nextTitle !== row.korean_title;
    const summaryChanged = JSON.stringify(nextSummary) !== JSON.stringify(row.summary_json);

    if (!titleChanged && !summaryChanged) continue;
    changed += 1;

    if (APPLY) {
      const { error: updateError } = await supabase
        .from("articles")
        .update({
          korean_title: nextTitle,
          summary_json: nextSummary,
        })
        .eq("id", row.id);
      if (updateError) throw new Error(updateError.message);
    }
  }

  return { checked, changed, applied: APPLY };
}

async function canonicalizeTags() {
  const supabase = getSupabase();
  const sourceArticleIds = new Set((await fetchSourceArticles(supabase)).map((article) => article.id));
  const { data: target, error: targetFetchError } = await supabase
    .from("tags")
    .select("id,slug,name,normalized_name,type,description")
    .eq("slug", CANONICAL_TAG_SLUG)
    .maybeSingle();

  if (targetFetchError) throw new Error(targetFetchError.message);
  if (!target) {
    throw new Error(`Canonical tag ${CANONICAL_TAG_SLUG} does not exist. Run a summary refresh first or create the canonical tag explicitly.`);
  }

  const data: Array<{
    id: string;
    slug: string;
    name: string;
    normalized_name: string;
    type: string;
    description?: string | null;
  }> = [];
  const pageSize = 1_000;
  for (let from = 0; ; from += pageSize) {
    const { data: page, error } = await supabase
      .from("tags")
      .select("id,slug,name,normalized_name,type,description")
      .order("slug", { ascending: true })
      .range(from, from + pageSize - 1);

    if (error) throw new Error(error.message);
    data.push(...(page ?? []));
    if (!page || page.length < pageSize) break;
  }

  let checked = 0;
  let changed = 0;
  let rewiredArticleTags = 0;
  let deletedTags = 0;
  const mergeSources: string[] = [];

  for (const row of data) {
    checked += 1;
    const nextName = canonicalizeTerminologyText(row.name, SOURCE_KEY);
    const nextNormalizedName = canonicalizeTerminologyText(row.normalized_name, SOURCE_KEY);
    const nextDescription = canonicalizeTerminologyText(row.description, SOURCE_KEY);

    if (row.id !== target.id && (nextName === CANONICAL_TAG_NAME || nextNormalizedName === CANONICAL_TAG_NAME)) {
      const { data: articleTags, error: articleTagError } = await supabase
        .from("article_tags")
        .select("article_id")
        .eq("tag_id", row.id);
      if (articleTagError) throw new Error(articleTagError.message);
      const sourceLinkCount = (articleTags ?? []).filter((articleTag) => sourceArticleIds.has(articleTag.article_id)).length;
      if (sourceLinkCount === 0) continue;

      mergeSources.push(row.id);
      changed += 1;
      continue;
    }

    if (nextName === row.name && nextNormalizedName === row.normalized_name && nextDescription === row.description) continue;
    changed += 1;

    if (APPLY) {
      const { error: updateError } = await supabase
        .from("tags")
        .update({
          name: nextName,
          normalized_name: nextNormalizedName,
          description: nextDescription,
        })
        .eq("id", row.id);
      if (updateError) throw new Error(updateError.message);
    }
  }

  if (APPLY) {
    const { error: targetError } = await supabase
      .from("tags")
      .update({
        name: CANONICAL_TAG_NAME,
        normalized_name: CANONICAL_TAG_NAME,
        type: target.type,
      })
      .eq("id", target.id);
    if (targetError) throw new Error(targetError.message);
  }

  for (const sourceTagId of mergeSources) {
    const { data: articleTags, error: articleTagError } = await supabase
      .from("article_tags")
      .select("article_id,confidence")
      .eq("tag_id", sourceTagId);
    if (articleTagError) throw new Error(articleTagError.message);

    const sourceLinks = (articleTags ?? []).filter((articleTag) => sourceArticleIds.has(articleTag.article_id));
    rewiredArticleTags += sourceLinks.length;

    if (APPLY) {
      for (const articleTag of sourceLinks) {
        const { error: upsertError } = await supabase.from("article_tags").upsert(
          {
            article_id: articleTag.article_id,
            tag_id: target.id,
            confidence: articleTag.confidence,
          },
          { onConflict: "article_id,tag_id" },
        );
        if (upsertError) throw new Error(upsertError.message);
      }

      if (sourceLinks.length > 0) {
        const { error: deleteLinksError } = await supabase
          .from("article_tags")
          .delete()
          .eq("tag_id", sourceTagId)
          .in("article_id", sourceLinks.map((articleTag) => articleTag.article_id));
        if (deleteLinksError) throw new Error(deleteLinksError.message);
      }

      const { count: remainingLinks, error: remainingError } = await supabase
        .from("article_tags")
        .select("article_id", { count: "exact", head: true })
        .eq("tag_id", sourceTagId);
      if (remainingError) throw new Error(remainingError.message);

      if ((remainingLinks ?? 0) === 0) {
        const { error: deleteTagError } = await supabase.from("tags").delete().eq("id", sourceTagId);
        if (deleteTagError) throw new Error(deleteTagError.message);
        deletedTags += 1;
      }
    }
  }

  return {
    checked,
    changed,
    applied: APPLY,
    canonicalTagSlug: CANONICAL_TAG_SLUG,
    mergedTags: mergeSources.length,
    rewiredArticleTags,
    deletedTags,
  };
}

async function main() {
  const articles = await canonicalizeArticles();
  const tags = await canonicalizeTags();
  console.log(JSON.stringify({ mode: APPLY ? "apply" : "dry-run", sourceKey: SOURCE_KEY, articles, tags }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
