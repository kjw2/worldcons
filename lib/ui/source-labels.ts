const JURISDICTION_LABELS: Record<string, string> = {
  "United States": "미국",
  Germany: "독일",
  France: "프랑스",
  Spain: "스페인",
};

const JURISDICTION_FLAGS: Record<string, string> = {
  "United States": "🇺🇸",
  Germany: "🇩🇪",
  France: "🇫🇷",
  Spain: "🇪🇸",
};

const SOURCE_LABELS: Record<string, string> = {
  "de-bverfg": "독일 연방헌재",
  "us-scotus": "미국 연방대법원",
  "fr-conseil-constitutionnel": "프랑스 헌법위원회",
  "es-tribunal-constitucional": "스페인 헌법재판소",
};

const LANGUAGE_LABELS: Record<string, string> = {
  de: "독일어",
  en: "영어",
  fr: "프랑스어",
  es: "스페인어",
};

export function displayJurisdictionLabel(jurisdiction?: string | null) {
  if (!jurisdiction) return "";
  return JURISDICTION_LABELS[jurisdiction] ?? jurisdiction;
}

export function displayJurisdictionFlag(jurisdiction?: string | null) {
  if (!jurisdiction) return "🌐";
  return JURISDICTION_FLAGS[jurisdiction] ?? "🌐";
}

export function displaySourceLabel(source?: string | { sourceKey?: string | null; name?: string | null } | null) {
  if (!source) return "";
  if (typeof source === "string") return SOURCE_LABELS[source] ?? source;
  return source.sourceKey ? SOURCE_LABELS[source.sourceKey] ?? source.name ?? source.sourceKey : source.name ?? "";
}

export function displaySourceLanguageLabel(language?: string | null) {
  if (!language) return "";
  return LANGUAGE_LABELS[language] ?? language;
}
