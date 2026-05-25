import { normalizeTagForStorage } from "@/lib/ai/tags";
import { getSupabaseAdmin } from "@/lib/db/client";
import type { GlossaryTerm, TagType } from "@/lib/db/types";
import { expandRelatedTagNames, glossaryCoveredTagKeys, tagAliasKey } from "@/lib/glossary/tag-aliases";
import { boundedInteger } from "@/lib/utils/numbers";

const glossaryCandidateTypes = new Set<TagType>(["article", "right", "topic", "doctrine", "procedure", "law", "case_type"]);

export interface GlossaryCandidate {
  id?: string;
  tagSlug: string;
  tagName: string;
  tagType: TagType;
  articleCount: number;
  suggestedSlug: string;
  sourceLanguages: string[];
  status: "pending" | "approved" | "ignored";
  generatedAt?: string | null;
  updatedAt?: string | null;
}

interface GlossaryCandidateRow {
  id?: string;
  tag_slug: string;
  tag_name: string;
  tag_type: string;
  article_count?: number | null;
  suggested_slug: string;
  source_languages?: string[] | null;
  status?: "pending" | "approved" | "ignored" | null;
  generated_at?: string | null;
  updated_at?: string | null;
}

interface TagRow {
  id: string;
  slug: string;
  name: string;
  type: string;
  article_count?: number | null;
}

function languageLabel(language: string) {
  if (language === "de") return "독일어";
  if (language === "en") return "영어";
  if (language === "fr") return "프랑스어";
  return language;
}

export function languageLabels(languages: string[]) {
  if (languages.length === 0) return "확인 필요";
  return languages.map(languageLabel).join("·");
}

export function jurisdictionFromLanguages(languages: string[]) {
  if (languages.length !== 1) return null;
  if (languages[0] === "de") return "Germany";
  if (languages[0] === "en") return "United States";
  if (languages[0] === "fr") return "France";
  return null;
}

function candidateRowToModel(row: GlossaryCandidateRow): GlossaryCandidate {
  return {
    id: row.id,
    tagSlug: row.tag_slug,
    tagName: row.tag_name,
    tagType: row.tag_type as TagType,
    articleCount: row.article_count ?? 0,
    suggestedSlug: row.suggested_slug,
    sourceLanguages: row.source_languages ?? [],
    status: row.status ?? "pending",
    generatedAt: row.generated_at,
    updatedAt: row.updated_at,
  };
}

function isMissingTableError(error: { message?: string; code?: string } | null | undefined) {
  return Boolean(error && (error.code === "42P01" || error.message?.includes("glossary_candidates")));
}

async function listExistingGlossaryTerms(supabase: NonNullable<ReturnType<typeof getSupabaseAdmin>>) {
  const { data, error } = await supabase.from("glossary_terms").select("slug,term,korean_term,jurisdiction,related_tags");
  if (error) throw new Error(error.message);

  return (data ?? []).map((row) => ({
    slug: row.slug,
    term: row.term,
    koreanTerm: row.korean_term,
    definition: "",
    jurisdiction: row.jurisdiction,
    relatedTags: row.related_tags ?? [],
  })) satisfies GlossaryTerm[];
}

async function languageCodesForTag(supabase: NonNullable<ReturnType<typeof getSupabaseAdmin>>, tagId: string) {
  const { data } = await supabase
    .from("article_tags")
    .select("articles(original_language)")
    .eq("tag_id", tagId)
    .limit(30);
  const counts = new Map<string, number>();
  for (const row of data ?? []) {
    const article = Array.isArray(row.articles) ? row.articles[0] : row.articles;
    const language = article?.original_language;
    if (language) counts.set(language, (counts.get(language) ?? 0) + 1);
  }
  return [...counts.entries()].sort((left, right) => right[1] - left[1]).map(([language]) => language);
}

export async function generateGlossaryCandidates(options: { minCount?: number; limit?: number; persist?: boolean } = {}) {
  const supabase = getSupabaseAdmin();
  if (!supabase) return { mode: "no-database" as const, candidates: [], persistedCount: 0 };

  const minCount = boundedInteger(options.minCount ?? process.env.GLOSSARY_CANDIDATE_MIN_COUNT, 5, { min: 1, max: 1000 });
  const limit = boundedInteger(options.limit ?? process.env.GLOSSARY_CANDIDATE_LIMIT, 50, { min: 1, max: 500 });
  const terms = await listExistingGlossaryTerms(supabase);
  const coveredKeys = glossaryCoveredTagKeys(terms);

  const { data: existingRows, error: existingError } = options.persist
    ? await supabase.from("glossary_candidates").select("tag_slug,status")
    : { data: null, error: null };
  if (existingError && !isMissingTableError(existingError)) throw new Error(existingError.message);
  const existingTerminal = new Set(
    ((existingRows ?? []) as Array<{ tag_slug?: string | null; status?: string | null }>)
      .filter((row) => row.tag_slug && (row.status === "approved" || row.status === "ignored"))
      .map((row) => String(row.tag_slug)),
  );

  const { data: tagRows, error: tagError } = await supabase
    .from("tags")
    .select("id,slug,name,type,article_count")
    .gte("article_count", minCount)
    .order("article_count", { ascending: false })
    .limit(limit * 4);
  if (tagError) throw new Error(tagError.message);

  const candidates: GlossaryCandidate[] = [];
  const seenCandidateKeys = new Set<string>();
  for (const tag of (tagRows ?? []) as TagRow[]) {
    if (!glossaryCandidateTypes.has(tag.type as TagType)) continue;
    if (existingTerminal.has(tag.slug)) continue;
    const candidateKey = tagAliasKey(tag.name);
    if (coveredKeys.has(candidateKey) || seenCandidateKeys.has(candidateKey)) continue;

    const normalized = normalizeTagForStorage(tag.name);
    const sourceLanguages = await languageCodesForTag(supabase, tag.id);
    candidates.push({
      tagSlug: tag.slug,
      tagName: tag.name,
      tagType: tag.type as TagType,
      articleCount: tag.article_count ?? 0,
      suggestedSlug: normalized.slug,
      sourceLanguages,
      status: "pending",
    });
    seenCandidateKeys.add(candidateKey);
    if (candidates.length >= limit) break;
  }

  let persistedCount = 0;
  if (options.persist && candidates.length > 0 && !existingError) {
    const { error } = await supabase.from("glossary_candidates").upsert(
      candidates.map((candidate) => ({
        tag_slug: candidate.tagSlug,
        tag_name: candidate.tagName,
        tag_type: candidate.tagType,
        article_count: candidate.articleCount,
        suggested_slug: candidate.suggestedSlug,
        source_languages: candidate.sourceLanguages,
        status: "pending",
        generated_at: new Date().toISOString(),
      })),
      { onConflict: "tag_slug" },
    );
    if (error) throw new Error(error.message);
    persistedCount = candidates.length;
  }

  return { mode: "database" as const, minCount, limit, existingGlossaryTerms: terms.length, candidates, persistedCount };
}

export async function listGlossaryCandidates(options: { limit?: number; includeNonPending?: boolean } = {}) {
  const supabase = getSupabaseAdmin();
  if (!supabase) return { mode: "no-database" as const, candidates: [] };

  const limit = boundedInteger(options.limit, 50, { min: 1, max: 500 });
  let query = supabase
    .from("glossary_candidates")
    .select("*")
    .order("article_count", { ascending: false })
    .order("generated_at", { ascending: false })
    .limit(limit);
  if (!options.includeNonPending) query = query.eq("status", "pending");

  const { data, error } = await query;
  if (isMissingTableError(error)) {
    const generated = await generateGlossaryCandidates({ limit });
    return { mode: "generated" as const, candidates: generated.candidates };
  }
  if (error) throw new Error(error.message);
  return { mode: "database" as const, candidates: ((data ?? []) as GlossaryCandidateRow[]).map(candidateRowToModel) };
}

export async function approveGlossaryCandidate(input: {
  candidateId?: string;
  slug: string;
  term: string;
  koreanTerm?: string | null;
  definition: string;
  jurisdiction?: string | null;
  relatedTags: string[];
}) {
  const supabase = getSupabaseAdmin();
  if (!supabase) return { mode: "no-database" as const, status: "skipped" as const };

  const relatedTags = expandRelatedTagNames(input.relatedTags.map((tag) => tag.trim()).filter(Boolean));
  const { error } = await supabase.from("glossary_terms").upsert(
    {
      slug: input.slug,
      term: input.term,
      korean_term: input.koreanTerm || null,
      definition: input.definition,
      jurisdiction: input.jurisdiction || null,
      related_tags: relatedTags,
    },
    { onConflict: "slug" },
  );
  if (error) throw new Error(error.message);

  if (input.candidateId) {
    await supabase
      .from("glossary_candidates")
      .update({ status: "approved", reviewed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("id", input.candidateId);
  }

  return { mode: "database" as const, status: "approved" as const, slug: input.slug };
}

export async function ignoreGlossaryCandidate(candidateId: string) {
  const supabase = getSupabaseAdmin();
  if (!supabase) return { mode: "no-database" as const, status: "skipped" as const };

  const { error } = await supabase
    .from("glossary_candidates")
    .update({ status: "ignored", reviewed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", candidateId);
  if (error) throw new Error(error.message);
  return { mode: "database" as const, status: "ignored" as const };
}
