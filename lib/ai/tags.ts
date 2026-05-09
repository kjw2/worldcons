import type { TagType } from "@/lib/db/types";
import { normalizeTagSlug } from "@/lib/utils/slug";

const NORMALIZATION_MAP = new Map<string, string>([
  ["free speech", "Free Speech"],
  ["freedom of expression", "Freedom of Expression"],
  ["first amendment", "First Amendment"],
  ["표현의자유", "표현의 자유"],
]);

export function normalizeTagName(input: string) {
  const trimmed = input.trim().replace(/^#+/, "").replace(/\s+/g, " ");
  const key = trimmed.toLowerCase().replace(/\s+/g, " ");
  return NORMALIZATION_MAP.get(key) ?? trimmed;
}

export function normalizeTagForStorage(name: string, normalizedName = name, type: TagType = "topic") {
  const cleanName = normalizeTagName(name);
  const cleanNormalizedName = normalizeTagName(normalizedName);

  return {
    slug: normalizeTagSlug(cleanNormalizedName || cleanName),
    name: cleanName,
    normalizedName: cleanNormalizedName || cleanName,
    type,
  };
}
