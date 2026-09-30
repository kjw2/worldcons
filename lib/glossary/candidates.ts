import { normalizeTagForStorage } from "@/lib/ai/tags";
import { getRuntimeD1Binding, type D1RuntimeDatabase } from "@/lib/cloudflare/d1/runtime-binding";
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

export function glossaryCandidateRefreshSucceeded(result: {
  mode: string;
  candidates: readonly unknown[];
  persistedCount: number;
}) {
  return result.mode === "database" && result.candidates.length > 0 && result.persistedCount === result.candidates.length;
}

interface GlossaryCandidateRow extends Record<string, unknown> {
  id?: string;
  tag_slug: string;
  tag_name: string;
  tag_type: string;
  article_count?: number | null;
  suggested_slug: string;
  source_languages?: string | string[] | null;
  status?: "pending" | "approved" | "ignored" | null;
  generated_at?: string | null;
  updated_at?: string | null;
}

interface TagRow extends Record<string, unknown> {
  id: string;
  slug: string;
  name: string;
  type: string;
  article_count?: number | null;
}

function d1() {
  return getRuntimeD1Binding("worldcons_core");
}

async function rows<T extends Record<string, unknown>>(binding: D1RuntimeDatabase, sql: string, values: unknown[] = []) {
  const statement = binding.prepare(sql).bind(...values);
  if (!statement.all) throw new Error("glossary_d1.read_unavailable");
  const result = await statement.all<T>();
  if (!result || result.success === false || result.error || !Array.isArray(result.results)) {
    throw new Error(result?.error || "glossary_d1.read_failed");
  }
  return result.results;
}

async function run(binding: D1RuntimeDatabase, sql: string, values: unknown[] = []) {
  const statement = binding.prepare(sql).bind(...values);
  if (!statement.run) throw new Error("glossary_d1.write_unavailable");
  const result = await statement.run();
  if (!result || result.success === false || result.error) throw new Error(result?.error || "glossary_d1.write_failed");
  return result;
}

function parseStringArray(value: unknown) {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
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
    articleCount: Number(row.article_count ?? 0),
    suggestedSlug: row.suggested_slug,
    sourceLanguages: parseStringArray(row.source_languages),
    status: row.status ?? "pending",
    generatedAt: row.generated_at,
    updatedAt: row.updated_at,
  };
}

async function listExistingGlossaryTerms(binding: D1RuntimeDatabase) {
  const result = await rows<Record<string, unknown>>(
    binding,
    "SELECT slug,term,korean_term,jurisdiction,related_tags FROM glossary_terms ORDER BY slug",
  );
  return result.map((row) => ({
    slug: String(row.slug ?? ""),
    term: String(row.term ?? ""),
    koreanTerm: typeof row.korean_term === "string" ? row.korean_term : null,
    definition: "",
    jurisdiction: typeof row.jurisdiction === "string" ? row.jurisdiction : null,
    relatedTags: parseStringArray(row.related_tags),
  })) satisfies GlossaryTerm[];
}

async function languageCodesForTag(binding: D1RuntimeDatabase, tagId: string) {
  const result = await rows<{ original_language?: string | null }>(
    binding,
    "SELECT a.original_language FROM article_tags at JOIN articles a ON a.id=at.article_id WHERE at.tag_id=? AND a.original_language IS NOT NULL LIMIT 30",
    [tagId],
  );
  const counts = new Map<string, number>();
  for (const row of result) {
    const language = row.original_language;
    if (language) counts.set(language, (counts.get(language) ?? 0) + 1);
  }
  return [...counts.entries()].sort((left, right) => right[1] - left[1]).map(([language]) => language);
}

export async function generateGlossaryCandidates(options: { minCount?: number; limit?: number; persist?: boolean } = {}) {
  const binding = d1();
  if (!binding) return { mode: "no-database" as const, candidates: [], persistedCount: 0 };

  const minCount = boundedInteger(options.minCount ?? process.env.GLOSSARY_CANDIDATE_MIN_COUNT, 5, { min: 1, max: 1000 });
  const limit = boundedInteger(options.limit ?? process.env.GLOSSARY_CANDIDATE_LIMIT, 50, { min: 1, max: 500 });
  const terms = await listExistingGlossaryTerms(binding);
  const coveredKeys = glossaryCoveredTagKeys(terms);
  const existingTerminal = new Set<string>();
  if (options.persist) {
    const existingRows = await rows<{ tag_slug: string; status: string }>(
      binding,
      "SELECT tag_slug,status FROM glossary_candidates WHERE status IN ('approved','ignored')",
    );
    for (const row of existingRows) if (row.tag_slug) existingTerminal.add(row.tag_slug);
  }

  const tagRows = await rows<TagRow>(
    binding,
    "SELECT id,slug,name,type,article_count FROM tags WHERE article_count>=? ORDER BY article_count DESC,slug ASC LIMIT ?",
    [minCount, limit * 4],
  );
  const candidates: GlossaryCandidate[] = [];
  const seenCandidateKeys = new Set<string>();
  for (const tag of tagRows) {
    if (!glossaryCandidateTypes.has(tag.type as TagType)) continue;
    if (existingTerminal.has(tag.slug)) continue;
    const candidateKey = tagAliasKey(tag.name);
    if (coveredKeys.has(candidateKey) || seenCandidateKeys.has(candidateKey)) continue;
    const normalized = normalizeTagForStorage(tag.name);
    candidates.push({
      tagSlug: tag.slug,
      tagName: tag.name,
      tagType: tag.type as TagType,
      articleCount: Number(tag.article_count ?? 0),
      suggestedSlug: normalized.slug,
      sourceLanguages: await languageCodesForTag(binding, tag.id),
      status: "pending",
    });
    seenCandidateKeys.add(candidateKey);
    if (candidates.length >= limit) break;
  }

  let persistedCount = 0;
  if (options.persist) {
    const now = new Date().toISOString();
    for (const candidate of candidates) {
      await run(
        binding,
        [
          "INSERT INTO glossary_candidates",
          "(id,tag_slug,tag_name,tag_type,article_count,suggested_slug,source_languages,status,generated_at,reviewed_at,created_at,updated_at)",
          "VALUES (?,?,?,?,?,?,?,'pending',?,NULL,?,?)",
          "ON CONFLICT(tag_slug) DO UPDATE SET tag_name=excluded.tag_name,tag_type=excluded.tag_type,article_count=excluded.article_count,",
          "suggested_slug=excluded.suggested_slug,source_languages=excluded.source_languages,generated_at=excluded.generated_at,updated_at=excluded.updated_at",
          "WHERE glossary_candidates.status='pending'",
        ].join(" "),
        [crypto.randomUUID(), candidate.tagSlug, candidate.tagName, candidate.tagType, candidate.articleCount, candidate.suggestedSlug, JSON.stringify(candidate.sourceLanguages), now, now, now],
      );
      persistedCount += 1;
    }
  }

  return { mode: "database" as const, minCount, limit, existingGlossaryTerms: terms.length, candidates, persistedCount };
}

export async function listGlossaryCandidates(options: { limit?: number; includeNonPending?: boolean } = {}) {
  const binding = d1();
  if (!binding) return { mode: "no-database" as const, candidates: [] };
  const limit = boundedInteger(options.limit, 50, { min: 1, max: 500 });
  const result = await rows<GlossaryCandidateRow>(
    binding,
    `SELECT id,tag_slug,tag_name,tag_type,article_count,suggested_slug,source_languages,status,generated_at,updated_at FROM glossary_candidates${options.includeNonPending ? "" : " WHERE status='pending'"} ORDER BY article_count DESC,generated_at DESC LIMIT ?`,
    [limit],
  );
  return { mode: "database" as const, candidates: result.map(candidateRowToModel) };
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
  const binding = d1();
  if (!binding) return { mode: "no-database" as const, status: "skipped" as const };
  const relatedTags = expandRelatedTagNames(input.relatedTags.map((tag) => tag.trim()).filter(Boolean));
  const now = new Date().toISOString();
  await run(
    binding,
    [
      "INSERT INTO glossary_terms (id,slug,term,korean_term,definition,jurisdiction,related_tags,created_at,updated_at)",
      "VALUES (?,?,?,?,?,?,?,?,?)",
      "ON CONFLICT(slug) DO UPDATE SET term=excluded.term,korean_term=excluded.korean_term,definition=excluded.definition,",
      "jurisdiction=excluded.jurisdiction,related_tags=excluded.related_tags,updated_at=excluded.updated_at",
    ].join(" "),
    [crypto.randomUUID(), input.slug, input.term, input.koreanTerm || null, input.definition, input.jurisdiction || null, JSON.stringify(relatedTags), now, now],
  );
  if (input.candidateId) {
    await run(binding, "UPDATE glossary_candidates SET status='approved',reviewed_at=?,updated_at=? WHERE id=?", [now, now, input.candidateId]);
  }
  return { mode: "database" as const, status: "approved" as const, slug: input.slug };
}

export async function ignoreGlossaryCandidate(candidateId: string) {
  const binding = d1();
  if (!binding) return { mode: "no-database" as const, status: "skipped" as const };
  const now = new Date().toISOString();
  await run(binding, "UPDATE glossary_candidates SET status='ignored',reviewed_at=?,updated_at=? WHERE id=?", [now, now, candidateId]);
  return { mode: "database" as const, status: "ignored" as const };
}
