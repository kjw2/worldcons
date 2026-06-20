import { normalizeTagForStorage } from "@/lib/ai/tags";
import { getSupabaseAdmin } from "@/lib/db/client";
import type { SummaryJson } from "@/lib/db/types";

interface SyncSummaryTagsOptions {
  replace?: boolean;
}

function uniqueTagInputs(summary: SummaryJson) {
  const inputs = [
    ...summary.entities.map((entity) => ({
      name: entity.name,
      normalizedName: entity.normalizedName,
      type: entity.type,
    })),
    ...summary.tags.map((tag) => ({
      name: tag,
      normalizedName: tag,
      type: "topic" as const,
    })),
  ];

  const seen = new Set<string>();
  return inputs.filter((input) => {
    const normalized = normalizeTagForStorage(input.name, input.normalizedName, input.type);
    if (seen.has(normalized.slug)) return false;
    seen.add(normalized.slug);
    return true;
  });
}

export async function syncSummaryTags(
  articleId: string,
  summary: SummaryJson,
  originalPublishedAt?: string | null,
  options: SyncSummaryTagsOptions = {},
) {
  const supabase = getSupabaseAdmin();
  if (!supabase) return { synced: false, upsertedTags: 0, removedArticleTags: 0 };

  const desiredTagIds = new Set<string>();

  for (const input of uniqueTagInputs(summary)) {
    const normalized = normalizeTagForStorage(input.name, input.normalizedName, input.type);
    const { data: tag, error } = await supabase
      .from("tags")
      .upsert(
        {
          slug: normalized.slug,
          name: normalized.name,
          normalized_name: normalized.normalizedName,
          type: normalized.type,
          latest_article_at: originalPublishedAt,
        },
        { onConflict: "slug" },
      )
      .select("id")
      .single();

    if (error) throw new Error(error.message);
    desiredTagIds.add(String(tag.id));

    const { error: articleTagError } = await supabase.from("article_tags").upsert(
      {
        article_id: articleId,
        tag_id: tag.id,
        confidence: 0.8,
      },
      { onConflict: "article_id,tag_id" },
    );
    if (articleTagError) throw new Error(articleTagError.message);
  }

  let removedArticleTags = 0;
  if (options.replace) {
    const { data: currentLinks, error: currentLinksError } = await supabase
      .from("article_tags")
      .select("tag_id")
      .eq("article_id", articleId);
    if (currentLinksError) throw new Error(currentLinksError.message);

    const staleTagIds = (currentLinks ?? [])
      .map((link) => String(link.tag_id))
      .filter((tagId) => !desiredTagIds.has(tagId));
    removedArticleTags = staleTagIds.length;

    if (staleTagIds.length > 0) {
      const { error: deleteError } = await supabase
        .from("article_tags")
        .delete()
        .eq("article_id", articleId)
        .in("tag_id", staleTagIds);
      if (deleteError) throw new Error(deleteError.message);
    }
  }

  return { synced: true, upsertedTags: desiredTagIds.size, removedArticleTags };
}
