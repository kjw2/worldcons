import "dotenv/config";
import { getSupabaseAdmin } from "@/lib/db/client";
import { normalizeTagForStorage } from "@/lib/ai/tags";
import { glossarySourceLanguageLabel } from "@/lib/glossary/languages";
import type { GlossaryTerm, TagType } from "@/lib/db/types";

const glossaryCandidateTypes = new Set<TagType>(["article", "right", "topic", "doctrine", "procedure", "law", "case_type"]);

function argValue(name: string) {
  return process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
}

function positiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function languageLabelFromCounts(counts: Map<string, number>) {
  if (counts.size === 0) return "확인 필요";
  const ordered = [...counts.entries()].sort((left, right) => right[1] - left[1]).map(([language]) => language);
  return ordered
    .map((language) => {
      if (language === "de") return "독일어";
      if (language === "en") return "영어";
      if (language === "fr") return "프랑스어";
      return language;
    })
    .join("·");
}

async function main() {
  const minCount = positiveInteger(argValue("min-count"), 5);
  const limit = positiveInteger(argValue("limit"), 50);
  const supabase = getSupabaseAdmin();
  if (!supabase) {
    throw new Error("Supabase 환경변수가 없어 용어 후보를 추출할 수 없습니다.");
  }

  const [{ data: glossaryRows, error: glossaryError }, { data: tagRows, error: tagError }] = await Promise.all([
    supabase.from("glossary_terms").select("slug,term,korean_term,jurisdiction,related_tags"),
    supabase
      .from("tags")
      .select("id,slug,name,type,article_count")
      .gte("article_count", minCount)
      .order("article_count", { ascending: false })
      .limit(limit * 3),
  ]);
  if (glossaryError) throw new Error(glossaryError.message);
  if (tagError) throw new Error(tagError.message);

  const glossaryTerms = (glossaryRows ?? []) as Array<Pick<GlossaryTerm, "slug" | "term" | "koreanTerm" | "jurisdiction" | "relatedTags"> & { korean_term?: string | null; related_tags?: string[] | null }>;
  const existingKeys = new Set<string>();
  for (const term of glossaryTerms) {
    existingKeys.add(term.slug);
    existingKeys.add(normalizeTagForStorage(term.term).slug);
    if (term.korean_term) existingKeys.add(normalizeTagForStorage(term.korean_term).slug);
    for (const tag of term.related_tags ?? []) {
      existingKeys.add(normalizeTagForStorage(tag).slug);
    }
  }

  const candidates = [];
  for (const tag of tagRows ?? []) {
    if (!glossaryCandidateTypes.has(tag.type as TagType)) continue;
    const suggested = normalizeTagForStorage(tag.name);
    if (existingKeys.has(tag.slug) || existingKeys.has(suggested.slug)) continue;

    const { data: articleRows } = await supabase
      .from("article_tags")
      .select("articles(original_language)")
      .eq("tag_id", tag.id)
      .limit(25);
    const languageCounts = new Map<string, number>();
    for (const row of articleRows ?? []) {
      const article = Array.isArray(row.articles) ? row.articles[0] : row.articles;
      const language = article?.original_language;
      if (language) languageCounts.set(language, (languageCounts.get(language) ?? 0) + 1);
    }

    candidates.push({
      name: tag.name,
      suggestedSlug: suggested.slug,
      type: tag.type,
      articleCount: tag.article_count,
      sourceLanguages: languageLabelFromCounts(languageCounts),
    });

    if (candidates.length >= limit) break;
  }

  console.log(
    JSON.stringify(
      {
        minCount,
        existingGlossaryTerms: glossaryTerms.length,
        candidates,
        commonLanguageLabel: glossarySourceLanguageLabel({
          slug: "common",
          term: "Common",
          definition: "",
          jurisdiction: null,
          relatedTags: [],
        }),
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
