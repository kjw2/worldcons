export const TERMINOLOGY_RULES = [
  {
    sourceKey: "fr-conseil-constitutionnel",
    canonical: "프랑스 헌법위원회",
    patterns: [
      /Conseil constitutionnel/g,
      /French Constitutional Council/g,
      /프랑스\s*헌법\s*이사회/g,
      /헌법\s*이사회/g,
      /프랑스\s*헌법\s*재판소/g,
      /프랑스\s*헌법\s*위원회/g,
    ],
  },
  {
    sourceKey: "us-scotus",
    canonical: "미국 연방대법원",
    patterns: [
      /Supreme Court of the United States/g,
      /\bSCOTUS\b/g,
      /미국\s*연방\s*대법원/g,
      /미\s*연방\s*대법원/g,
      /미국\s*대법원/g,
      /미\s*대법원/g,
      /(?<!미국\s)(?<!미국)(?<!미\s)(?<!미)(?<!독일\s)(?<!독일)연방\s*대법원/g,
    ],
  },
] as const;

export function rulesForSource(sourceKey?: string | null) {
  return TERMINOLOGY_RULES.filter((rule) => rule.sourceKey === sourceKey);
}

export function terminologyRuleForSource(sourceKey?: string | null) {
  return TERMINOLOGY_RULES.find((rule) => rule.sourceKey === sourceKey) ?? null;
}

export function canonicalizeTerminologyText(text: string, sourceKey?: string | null): string;
export function canonicalizeTerminologyText(text: string | null | undefined, sourceKey?: string | null): string | null | undefined;
export function canonicalizeTerminologyText(text: string | null | undefined, sourceKey?: string | null) {
  if (!text) return text;

  return rulesForSource(sourceKey).reduce(
    (current, rule) => rule.patterns.reduce((next, pattern) => next.replace(pattern, rule.canonical), current),
    text,
  );
}

export function canonicalizeTerminologyValue<T>(value: T, sourceKey?: string | null): T {
  if (rulesForSource(sourceKey).length === 0) return value;

  if (typeof value === "string") {
    return canonicalizeTerminologyText(value, sourceKey) as T;
  }

  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeTerminologyValue(item, sourceKey)) as T;
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, canonicalizeTerminologyValue(entry, sourceKey)]),
    ) as T;
  }

  return value;
}
